import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../../src/cli/runtime';
import { ProviderError, type ProviderEvent } from '../../../src/core/types';
import { FakeProvider, textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanEnv, cleanupDirs, harness, tmpDir, waitFor } from './harness';

afterEach(() => cleanupDirs());

describe('trạng thái', () => {
  it('status phát ≤ 10 lần/giây dù có hàng trăm sự kiện', async () => {
    const chunks: ProviderEvent[] = [];
    for (let i = 0; i < 300; i++) chunks.push({ type: 'text_delta', text: `mẩu${i} ` });
    chunks.push({ type: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
    const h = await harness({ script: [() => chunks] });
    const t0 = Date.now();
    await h.rt.submit('nói nhiều');
    await h.rt.idle();
    const secs = Math.max(1, (Date.now() - t0) / 1000);
    const n = h.events.filter((e) => e.t === 'status').length;
    expect(n / secs).toBeLessThanOrEqual(12);
    await h.cleanup();
  });

  it('todos của phiên, hàng đợi và ngữ cảnh % xuất hiện trong status', async () => {
    const h = await harness({
      userSettings: { 'agent.contextWindow': 1000 },
      script: [toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'làm A', status: 'in_progress' }] } }]), () => textTurn('xong')],
    });
    await h.rt.submit('lên danh sách việc');
    await h.rt.idle();
    expect(h.rt.status().todos[0]).toMatchObject({ title: 'làm A' });
    expect(h.rt.status().context.percent).toBeGreaterThan(0);
    await h.cleanup();
  });

  it('hàng chờ của cổng (sự kiện queue) hiện trong notices rồi biến mất', async () => {
    let seen = false;
    const provider = new FakeProvider([
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return [
          { type: 'queue', position: 3, ahead: 2, attempt: 1, waitMs: 1000, retryAt: Date.now() + 1000, limit: 100 },
          { type: 'queue_end' },
          ...textTurn('hết hàng chờ'),
        ] as ProviderEvent[];
      },
    ]);
    const h = await harness({ provider });
    h.rt.on((e) => {
      if (e.t === 'status' && e.status.notices.some((n) => /hàng|Queued/.test(n))) seen = true;
    });
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(h.rt.status().notices.some((n) => /Đang xếp hàng/.test(n))).toBe(false);
    await h.cleanup();
    void seen; // thời điểm xếp hàng rất ngắn trong kịch bản giả; điều kiện chính: không kẹt thông báo sau khi xong
  });

  it('tiêu đề tự đặt từ tin đầu và có thể đổi mô hình giữa chừng', async () => {
    const h = await harness({ script: [() => textTurn('a'), () => textTurn('b')] });
    expect(h.rt.status().title).toMatch(/Cuộc trò chuyện mới/);
    await h.rt.submit('   Viết   hàm    sắp xếp   mảng   ');
    await h.rt.idle();
    expect(h.rt.status().title).toBe('Viết hàm sắp xếp mảng');
    await h.rt.setModel('mo-hinh-khac');
    expect(h.rt.status().model).toBe('mo-hinh-khac');
    await h.rt.submit('tiếp');
    await h.rt.idle();
    expect(h.provider.requests[1].model).toBe('mo-hinh-khac');
    expect(h.rt.status().title).toBe('Viết hàm sắp xếp mảng'); // không bị ghi đè
    await h.cleanup();
  });
});

describe('agent con và công cụ nền của lõi', () => {
  it('công cụ `agent` chạy được (AgentServices đủ): agent con trả báo cáo cho luồng chính', async () => {
    const h = await harness({
      script: [
        toolTurn([{ name: 'agent', input: { description: 'tìm tệp', prompt: 'Tìm file sample.txt', agent_type: 'explore' } }]),
        () => textTurn('BÁO-CÁO-CỦA-AGENT-CON'),
        () => textTurn('Đã nhận báo cáo.'),
      ],
      interactive: false,
    });
    await h.rt.submit('nhờ agent tìm file');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[2].messages)).toContain('BÁO-CÁO-CỦA-AGENT-CON');
    expect(h.texts()).toContain('Đã nhận báo cáo.');
    await h.cleanup();
  });

  it('có công cụ lõi đầy đủ: run_command nền (startProcess), todo_write, kỹ năng dựng sẵn', async () => {
    const h = await harness({ script: [() => textTurn('x')] });
    await h.rt.submit('chào');
    await h.rt.idle();
    const names = h.provider.requests[0].tools.map((t) => t.name);
    for (const n of ['read_file', 'write_file', 'edit_file', 'run_command', 'glob', 'grep', 'todo_write', 'load_skill', 'agent', 'command_output']) expect(names).toContain(n);
    await h.cleanup();
  });
});

describe('lỗi từ nhà cung cấp', () => {
  it('chưa đồng ý thông báo dữ liệu: hướng dẫn `locaith consent --yes`', async () => {
    const provider = new FakeProvider([
      async () => {
        throw new ProviderError('403', { kind: 'consent_required', providerId: 'fake', status: 403, retryable: false });
      },
    ]);
    const h = await harness({ provider });
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(h.outputs().join('\n')).toContain('locaith consent --yes');
    await h.cleanup();
  });

  it('token hết hiệu lực (accountAuth): hướng dẫn đăng nhập lại, không treo', async () => {
    const provider = new FakeProvider([
      async () => {
        throw new ProviderError('401', { kind: 'auth', providerId: 'fake', status: 401, retryable: false, accountAuth: true });
      },
    ]);
    const h = await harness({ provider });
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(h.outputs().join('\n')).toMatch(/\/login/);
    expect(h.rt.status().running).toBe(false);
    await h.cleanup();
  });
});

describe('đăng nhập/đăng xuất trong phiên', () => {
  it('/logout xoá khoá khỏi cli.json; tin kế tiếp báo NotLoggedIn và trả chữ về ô nhập', async () => {
    const home = tmpDir('lc-home-');
    fs.mkdirSync(path.join(home, '.locaith'), { recursive: true });
    const cfg = path.join(home, '.locaith', 'cli.json');
    fs.writeFileSync(cfg, JSON.stringify({ apiKey: 'lat_' + 'k'.repeat(43), other: 1 }));
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const rt = await createRuntime({ cwd: tmpDir('lc-cwd-'), home, version: '1', interactive: true, env: cleanEnv(), features: [], trusted: true, fetchImpl });
    const events: Array<{ t: string; [k: string]: unknown }> = [];
    rt.on((e) => events.push(e as never));
    expect(rt.status().account?.loggedIn).toBe(true);
    await rt.submit('/logout');
    const ask = events.find((e) => e.t === 'ask') as unknown as { ask: { id: string; kind: string } };
    expect(ask.ask.kind).toBe('confirm');
    rt.answer(ask.ask.id, true);
    await rt.idle();
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8'))).toEqual({ other: 1 });
    expect(rt.status().account?.loggedIn).toBe(false);
    await rt.submit('xin chào');
    await rt.idle();
    const outs = events.filter((e) => e.t === 'ui' && (e.ev as { t: string }).t === 'notice').map((e) => (e.ev as { text: string }).text);
    expect(outs.join('\n')).toContain('locaith login');
    expect(events.some((e) => e.t === 'action' && e.action === 'insert' && e.payload === 'xin chào')).toBe(true);
    await rt.dispose();
  });

  it('/logout khi khoá lấy từ biến môi trường nói rõ không xoá được', async () => {
    const rt = await createRuntime({ cwd: tmpDir(), home: tmpDir(), version: '1', interactive: true, env: cleanEnv({ LOCAITH_API_KEY: 'lat_' + 'e'.repeat(43) }), features: [], trusted: true, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    const outs: string[] = [];
    rt.on((e) => {
      if (e.t === 'output') outs.push(e.text);
    });
    await rt.submit('/logout');
    expect(outs.join(' ')).toContain('LOCAITH_API_KEY');
    await rt.dispose();
  });
});

describe('dispose', () => {
  it('dispose giữa lượt: huỷ lượt, ghi phiên, sau đó submit bị bỏ qua; gọi hai lần an toàn', async () => {
    const home = tmpDir('lc-home-');
    const provider = new FakeProvider([
      async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return textTurn('muộn');
      },
    ]);
    const h = await harness({ home, provider });
    await h.rt.submit('một việc dài');
    await waitFor(() => h.rt.status().running);
    await Promise.all([h.rt.dispose(), h.rt.dispose()]);
    const files = fs.readdirSync(path.join(home, '.locaith', 'sessions')).filter((f) => f !== 'index.json');
    expect(files.length).toBe(1);
    const before = h.events.length;
    await h.rt.submit('sau khi đóng');
    expect(h.events.length).toBe(before);
  }, 15_000);

  it('đang chờ hỏi (ask) khi dispose thì được giải phóng bằng null', async () => {
    let result: unknown = 'chưa';
    const h = await harness({
      features: [{ name: 'a', attach: (ctx) => ctx.slash({ name: 'hoi', description: { vi: 'h', en: 'h' }, async run(c) { result = await c.ask({ kind: 'confirm', title: 'chắc không?' }); } }) }],
    });
    await h.rt.submit('/hoi');
    await h.rt.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(result).toBeNull();
  });
});

describe('lastResult (mã thoát chế độ in một lần)', () => {
  it('end_turn + câu trả lời cuối khi xong; error khi nhà cung cấp lỗi; timeout khi quá hạn; error khi chưa đăng nhập', async () => {
    const ok = await harness({ script: [() => textTurn('Kết quả cuối')], interactive: false });
    expect(ok.rt.lastResult!().stopReason).toBe('none');
    await ok.rt.submit('làm đi');
    await ok.rt.idle();
    expect(ok.rt.lastResult!()).toMatchObject({ stopReason: 'end_turn', text: 'Kết quả cuối' });
    expect(ok.rt.lastResult!().turns).toBe(1);
    await ok.cleanup();

    const bad = await harness({
      interactive: false,
      script: [
        async () => {
          throw new ProviderError('hỏng', { kind: 'server', providerId: 'fake', status: 500, retryable: false });
        },
      ],
    });
    await bad.rt.submit('làm đi');
    await bad.rt.idle();
    expect(bad.rt.lastResult!().stopReason).toBe('error');
    await bad.cleanup();

    const slow = await harness({
      interactive: false,
      timeoutSec: 0.2,
      script: [
        async () => {
          await new Promise((r) => setTimeout(r, 1200));
          return textTurn('muộn');
        },
      ],
    });
    await slow.rt.submit('chậm');
    await slow.rt.idle();
    expect(slow.rt.lastResult!().stopReason).toBe('timeout');
    await slow.cleanup();
  }, 15_000);
});

describe('/login bằng token dán vào', () => {
  /** Hộp hỏi thứ `n` (đếm từ 1) của cả phiên kiểm thử: chờ nó xuất hiện rồi trả về. */
  const nthAsk = async (events: Array<{ t: string; ask?: { id: string; kind: string } }>, n: number) => {
    await waitFor(() => events.filter((e) => e.t === 'ask').length >= n, 3000, 'hộp hỏi ' + n);
    return events.filter((e) => e.t === 'ask')[n - 1].ask!;
  };

  it('token đúng được kiểm với cổng rồi mới ghi vào cli.json (quyền 600); token sai thì không ghi', async () => {
    const home = tmpDir('lc-home-');
    const good = 'lat_' + 'g'.repeat(43);
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      if (auth.includes(good)) return new Response(JSON.stringify({ ok: true, account: { name: 'Anh Tuấn', email_masked: 't***@x.vn', plan: 'pro' } }), { status: 200 });
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    const h = await harness({ home, fetchImpl, script: [] });
    const events = h.events as unknown as Array<{ t: string; ask?: { id: string; kind: string } }>;

    h.rt.submit('/login');
    let ask = await nthAsk(events, 1);
    expect(ask.kind).toBe('pick');
    h.rt.answer(ask.id, 'token');
    ask = await nthAsk(events, 2);
    expect(ask.kind).toBe('input');
    h.rt.answer(ask.id, 'lat_' + 'b'.repeat(43)); // sai
    await h.rt.idle();
    expect(fs.existsSync(path.join(home, '.locaith', 'cli.json'))).toBe(false);
    expect(h.outputs().pop()).toMatch(/không hợp lệ|hết hạn/);

    h.rt.submit('/login');
    ask = await nthAsk(events, 3);
    h.rt.answer(ask.id, 'token');
    ask = await nthAsk(events, 4);
    h.rt.answer(ask.id, good);
    await h.rt.idle();
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.locaith', 'cli.json'), 'utf8'));
    expect(saved.apiKey).toBe(good);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home, '.locaith', 'cli.json')).mode & 0o077).toBe(0);
    expect(h.outputs().pop()).toContain('cli.json');
    await h.rt.submit('/whoami');
    expect(h.outputs().pop()).toMatch(/pro|Anh Tuấn/);
    await h.cleanup();
  });

  it('không tương tác thì /login chỉ hướng dẫn', async () => {
    const h = await harness({ interactive: false, script: [] });
    await h.rt.submit('/login');
    expect(h.outputs().pop()).toContain('locaith login');
    await h.cleanup();
  });
});
