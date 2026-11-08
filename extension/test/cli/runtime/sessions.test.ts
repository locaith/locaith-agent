import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../../../src/cli/runtime';
import { FakeProvider, textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanEnv, cleanupDirs, harness, tmpDir } from './harness';

afterEach(() => cleanupDirs());

const sessionFiles = (home: string) =>
  fs.existsSync(path.join(home, '.locaith', 'sessions')) ? fs.readdirSync(path.join(home, '.locaith', 'sessions')).filter((f) => /^[\w-]+\.json$/.test(f) && f !== 'index.json') : [];

describe('nén ngữ cảnh', () => {
  const small = { 'agent.contextWindow': 5000, 'agent.compactAtPercent': 50, 'agent.keepRecentMessages': 4 };

  it('tự nén khi vượt ngưỡng (cửa sổ nhỏ) bằng bản tóm tắt thật của model', async () => {
    const provider = new FakeProvider(Array.from({ length: 8 }, (_, i) => () => textTurn(`trả lời ${i + 1} ${'x'.repeat(400)}`)));
    provider.completeImpl = async () => 'TÓM TẮT-THẬT: người dùng hỏi nhiều câu, trợ lý đã trả lời.';
    const h = await harness({ provider, userSettings: small });
    for (let i = 0; i < 5; i++) {
      await h.rt.submit(`câu hỏi số ${i + 1} ${'y'.repeat(400)}`);
      await h.rt.idle();
    }
    const compacted = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'notice' && (e.ev as { compact?: unknown }).compact);
    expect(compacted.length).toBeGreaterThan(0);
    // Sau khi nén, lịch sử gửi model mở đầu bằng bản tóm tắt
    const last = provider.requests[provider.requests.length - 1];
    expect(JSON.stringify(last.messages[0])).toContain('TÓM TẮT-THẬT');
    await h.cleanup();
  });

  it('/compact nén thủ công bằng summarizer và hiện kết quả; không có gì để nén thì nói rõ', async () => {
    const provider = new FakeProvider(Array.from({ length: 6 }, (_, i) => () => textTurn(`đáp ${i + 1}`)));
    provider.completeImpl = async () => 'BẢN-TÓM-TẮT-THỦ-CÔNG';
    const h = await harness({ provider });
    await h.rt.submit('/compact');
    await h.rt.idle();
    expect(h.outputs().join('\n')).toMatch(/Không có gì để nén|Nothing to compact/);
    for (let i = 0; i < 4; i++) {
      await h.rt.submit(`hỏi ${i + 1}`);
      await h.rt.idle();
    }
    await h.rt.submit('/compact giữ lại tên tệp');
    await h.rt.idle();
    expect(provider.completes.some((c) => String(c.prompt ?? '').includes('giữ lại tên tệp') || String(c.system ?? '').includes('giữ lại tên tệp'))).toBe(true);
    const notices = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'notice' && (e.ev as { compact?: unknown }).compact);
    expect(notices.length).toBe(1);
    // lượt kế tiếp thấy bản tóm tắt
    await h.rt.submit('tiếp');
    await h.rt.idle();
    expect(JSON.stringify(provider.requests[provider.requests.length - 1].messages)).toContain('BẢN-TÓM-TẮT-THỦ-CÔNG');
    await h.cleanup();
  });

  it('móc beforeCompact/onCompacted của tính năng được gọi', async () => {
    const provider = new FakeProvider(Array.from({ length: 6 }, (_, i) => () => textTurn(`đáp ${i + 1}`)));
    provider.completeImpl = async () => 'TT';
    const calls: string[] = [];
    const h = await harness({
      provider,
      features: [
        {
          name: 't',
          attach(ctx) {
            ctx.onBeforeCompact?.((i) => void calls.push(`before:${i.trigger}`));
            ctx.onCompacted?.((i) => void calls.push(`after:${i.summary}`));
          },
        },
      ],
    });
    for (let i = 0; i < 4; i++) {
      await h.rt.submit(`hỏi ${i + 1}`);
      await h.rt.idle();
    }
    await h.rt.submit('/compact');
    await h.rt.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain('before:manual');
    expect(calls.some((c) => c.startsWith('after:'))).toBe(true);
    await h.cleanup();
  });
});

describe('lưu và mở lại phiên', () => {
  it('ghi phiên ở ~/.locaith/sessions rồi resume:true ở runtime mới, kèm replay transcript', async () => {
    const home = tmpDir('lc-home-');
    const cwd = tmpDir('lc-cwd-');
    const h1 = await harness({ home, cwd, script: [toolTurn([{ name: 'read_file', input: { path: 'sample.txt' } }]), textTurn('Đã đọc xong.')] });
    await h1.rt.submit('đọc tệp mẫu');
    await h1.rt.idle();
    const id = h1.rt.status().sessionId;
    await h1.cleanup();
    expect(sessionFiles(home)).toContain(`${id}.json`);
    const st = fs.statSync(path.join(home, '.locaith', 'sessions', `${id}.json`));
    if (process.platform !== 'win32') expect(st.mode & 0o077).toBe(0);

    const h2 = await harness({ home, cwd, resume: true, script: [textTurn('nhớ rồi')] });
    expect(h2.rt.status().sessionId).toBe(id);
    expect(h2.rt.status().title).toContain('đọc tệp mẫu');
    const list = await h2.rt.sessions('cwd');
    expect(list.map((s) => s.id)).toContain(id);
    await h2.rt.submit('còn nhớ không?');
    await h2.rt.idle();
    // lịch sử cũ được gửi lại cho model
    const sent = JSON.stringify(h2.provider.requests[0].messages);
    expect(sent).toContain('đọc tệp mẫu');
    expect(sent).toContain('ALPHA');
    await h2.cleanup();
  });

  it('resume(prefix) trong runtime đang chạy phát replay và khôi phục tiêu đề', async () => {
    const home = tmpDir('lc-home-');
    const cwd = tmpDir('lc-cwd-');
    const a = await harness({ home, cwd, script: [textTurn('A')] });
    await a.rt.submit('phiên một');
    await a.rt.idle();
    const idA = a.rt.status().sessionId;
    await a.rt.newSession();
    await a.rt.submit('phiên hai');
    await a.rt.idle();
    expect(a.rt.status().sessionId).not.toBe(idA);
    // provider đã hết kịch bản nên lượt hai lỗi, nhưng phiên vẫn được lưu; chuyển lại phiên một
    await a.rt.resume(idA);
    expect(a.rt.status().sessionId).toBe(idA);
    const replay = a.events.filter((e) => e.t === 'replay').pop() as { items: unknown[]; reason: string };
    expect(replay.reason).toBe('resume');
    expect(replay.items.length).toBeGreaterThan(0);
    await expect(a.rt.resume('khong-co-phien-nay')).rejects.toThrow();
    await a.cleanup();
  });

  it('đọc được phiên định dạng CLI 0.3.x ({id,title,model,cwd,messages}) và chuyển lên định dạng mới', async () => {
    const home = tmpDir('lc-home-');
    const cwd = tmpDir('lc-cwd-');
    const dir = path.join(home, '.locaith', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      id: 'cli_old123',
      title: 'Phiên cũ của anh',
      model: 'locaith-v5-flash',
      cwd,
      updatedAt: 1_700_000_000_000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'chào bản cũ' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'xin chào từ quá khứ' }] },
      ],
      usage: { input: 11, output: 7 },
    };
    fs.writeFileSync(path.join(dir, 'cli_old123.json'), JSON.stringify(legacy));
    const h = await harness({ home, cwd, resume: 'cli_old', script: [textTurn('tiếp nối')] });
    expect(h.rt.status().sessionId).toBe('cli_old123');
    expect(h.rt.status().usage).toEqual({ input: 11, output: 7 });
    await h.rt.submit('nói tiếp');
    await h.rt.idle();
    const sent = JSON.stringify(h.provider.requests[0].messages);
    expect(sent).toContain('chào bản cũ');
    expect(sent).toContain('xin chào từ quá khứ');
    await h.cleanup();
    // tệp đã ở định dạng mới + bản gốc được giữ
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'cli_old123.json'), 'utf8'));
    expect(j.version).toBe(1);
    expect(j.session.messages.length).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(path.join(dir, 'cli_old123.legacy.json'))).toBe(true);
  });

  it('sessions("cwd") chỉ liệt kê phiên của thư mục này; "all" liệt kê cả thư mục khác', async () => {
    const home = tmpDir('lc-home-');
    const cwdA = tmpDir('lc-cwdA-');
    const cwdB = tmpDir('lc-cwdB-');
    const a = await harness({ home, cwd: cwdA, script: [textTurn('a')] });
    await a.rt.submit('ở thư mục A');
    await a.rt.idle();
    await a.cleanup();
    const b = await harness({ home, cwd: cwdB, script: [textTurn('b')] });
    await b.rt.submit('ở thư mục B');
    await b.rt.idle();
    const here = await b.rt.sessions('cwd');
    const all = await b.rt.sessions('all');
    expect(here.map((s) => s.title).join('|')).toContain('ở thư mục B');
    expect(here.map((s) => s.title).join('|')).not.toContain('ở thư mục A');
    expect(all.length).toBe(2);
    await b.cleanup();
  });

  it('noPersist không ghi gì ra đĩa', async () => {
    const home = tmpDir('lc-home-');
    const h = await harness({ home, noPersist: true, script: [textTurn('x')] });
    await h.rt.submit('đừng lưu');
    await h.rt.idle();
    await h.cleanup();
    expect(sessionFiles(home)).toEqual([]);
  });

  it('resume:true khi chưa có phiên nào thì bắt đầu phiên mới, không ném lỗi', async () => {
    const h = await harness({ resume: true, script: [textTurn('x')] });
    expect(h.rt.status().messages ?? 0).toBe(0);
    expect(h.rt.status().title.length).toBeGreaterThan(0);
    await h.cleanup();
  });

  it('createRuntime với resume là mã không tồn tại thì ném lỗi rõ', async () => {
    await expect(
      createRuntime({ cwd: tmpDir(), home: tmpDir(), version: '1', interactive: false, providerOverride: new FakeProvider([]), env: cleanEnv(), features: [], resume: 'khong-co' }),
    ).rejects.toThrow(/Không thấy phiên/);
  });
});
