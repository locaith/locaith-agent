import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../../src/cli/runtime';
import type { ToolDef } from '../../../src/core/engine/types';
import { textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, tmpDir } from './harness';

afterEach(() => cleanupDirs());

describe('FeatureModule cắm vào lõi', () => {
  it('lệnh gạch chéo: đăng ký, hiện trong menu, chạy, output/toast, runPrompt chạy một lượt agent', async () => {
    const mod: FeatureModule = {
      name: 'demo',
      attach(ctx) {
        ctx.slash({ name: 'xin', description: { vi: 'Chào thử', en: 'Hello' }, argHint: '<tên>', needsIdle: true, run: (c) => c.output(`chào ${c.args}`) });
        ctx.slash({
          name: 'lam',
          description: { vi: 'Chạy một lượt', en: 'Run a turn' },
          async run(c) {
            await c.runPrompt(`hãy làm việc ${c.args}`);
            c.toast('info', 'xong lượt');
          },
        });
      },
    };
    const h = await harness({ features: [mod], script: [() => textTurn('đã làm')] });
    expect(h.rt.slashCommands().find((c) => c.name === 'xin')!.description).toContain('Chào thử');
    await h.rt.submit('/xin Tuấn Anh');
    expect(h.outputs().pop()).toBe('chào Tuấn Anh');
    await h.rt.submit('/lam gấp');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[0].messages)).toContain('hãy làm việc gấp');
    expect(h.toasts()).toContain('xong lượt');
    // dòng lệnh `/lam gấp` không bị lưu như tin người dùng
    const users = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'user').map((e) => (e as unknown as { ev: { text: string } }).ev.text);
    expect(users).toEqual(['hãy làm việc gấp']);
    await h.cleanup();
  });

  it('replaceSlashSource thay cả nhóm lệnh nạp động; nguồn ưu tiên thấp không đè lệnh dựng sẵn', async () => {
    let swap!: (names: string[]) => void;
    const mod: FeatureModule = {
      name: 'dyn',
      attach(ctx) {
        swap = (names) => ctx.replaceSlashSource('project', names.map((n) => ({ name: n, description: { vi: n, en: n }, run: (c) => c.output(`project:${n}`) })));
      },
    };
    const h = await harness({ features: [mod], script: [] });
    swap(['deploy', 'help']);
    expect(h.rt.slashCommands().map((c) => c.name)).toContain('deploy');
    await h.rt.submit('/deploy');
    expect(h.outputs().pop()).toBe('project:deploy');
    await h.rt.submit('/help'); // lệnh dựng sẵn thắng lệnh dự án trùng tên
    expect(h.outputs().pop()).toContain('Locaith CLI');
    swap(['khac']);
    expect(h.rt.slashCommands().map((c) => c.name)).not.toContain('deploy');
    await h.cleanup();
  });

  it('ask: tương tác thì chờ answer(); không tương tác thì trả null', async () => {
    let asked: unknown = 'chưa';
    const mod: FeatureModule = {
      name: 'ask',
      attach(ctx) {
        ctx.slash({
          name: 'hoi',
          description: { vi: 'h', en: 'h' },
          async run(c) {
            asked = await c.ask({ kind: 'pick', title: 'Chọn', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
          },
        });
      },
    };
    const h = await harness({ features: [mod], script: [] });
    const p = h.rt.submit('/hoi');
    await p; // trả về khi lệnh trao quyền cho người dùng
    const ev = h.events.find((e) => e.t === 'ask') as { ask: { id: string; title: string } };
    expect(ev.ask.title).toBe('Chọn');
    h.rt.answer(ev.ask.id, 'b');
    await h.rt.idle();
    expect(asked).toBe('b');
    await h.cleanup();

    const h2 = await harness({ features: [mod], script: [], interactive: false });
    asked = 'chưa';
    await h2.rt.submit('/hoi');
    await h2.rt.idle();
    expect(asked).toBeNull();
    await h2.cleanup();
  });

  it('RunExtension: beforeModel thêm ghi chú vào lịch sử; thứ tự đăng ký, last:true đứng cuối', async () => {
    const order: string[] = [];
    const mk = (id: string, note?: string): FeatureModule['attach'] => (ctx) => {
      ctx.addRunExtension(
        {
          id,
          begin() {
            order.push(id);
            return note ? { beforeModel: () => [note] } : undefined;
          },
        },
        id === 'verifier' ? { last: true } : undefined,
      );
    };
    const h = await harness({
      features: [
        { name: 'v', attach: mk('verifier') },
        { name: 'a', attach: mk('hook-a', 'GHI-CHÚ-TỪ-HOOK') },
        { name: 'b', attach: mk('hook-b') },
      ],
      script: [() => textTurn('ok')],
    });
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(order).toEqual(['hook-a', 'hook-b', 'verifier']);
    expect(JSON.stringify(h.provider.requests[0].messages)).toContain('GHI-CHÚ-TỪ-HOOK');
    await h.cleanup();
  });

  it('addToolContributor: công cụ do tính năng thêm được model gọi; trùng tên không làm hỏng', async () => {
    const tool: ToolDef = {
      name: 'dem_so',
      description: 'đếm',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      risk: 'meta',
      concurrencySafe: true,
      async execute(input: { n: number }) {
        return { content: `KẾT-QUẢ-ĐẾM-${input.n * 2}` };
      },
    };
    const mod: FeatureModule = {
      name: 'tools',
      attach(ctx) {
        ctx.addToolContributor((add) => {
          add(tool);
          add(tool); // trùng → bị bỏ qua, không ném
          add({ name: 'read_file' }); // trùng với công cụ lõi → bỏ qua
        });
      },
    };
    const h = await harness({ features: [mod], script: [toolTurn([{ name: 'dem_so', input: { n: 21 } }]), textTurn('xong')] });
    await h.rt.submit('đếm giúp');
    await h.rt.idle();
    expect(h.provider.requests[0].tools.map((t) => t.name)).toContain('dem_so');
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('KẾT-QUẢ-ĐẾM-42');
    await h.cleanup();
  });

  it('addPromptContributor và appendSystemPrompt vào system prompt', async () => {
    const mod: FeatureModule = { name: 'p', attach: (ctx) => ctx.addPromptContributor(() => 'ĐOẠN-MCP-CỦA-TÍNH-NĂNG') };
    const h = await harness({ features: [mod], appendSystemPrompt: 'ĐOẠN-DÒNG-LỆNH', script: [() => textTurn('ok')] });
    await h.rt.submit('chào');
    await h.rt.idle();
    const sys = h.provider.requests[0].system;
    expect(sys).toContain('ĐOẠN-MCP-CỦA-TÍNH-NĂNG');
    expect(sys).toContain('ĐOẠN-DÒNG-LỆNH');
    await h.cleanup();
  });

  it('addStatusContributor: sửa RuntimeStatus và refresh() phát status mới', async () => {
    let refresh!: () => void;
    let n = 0;
    const mod: FeatureModule = {
      name: 's',
      attach(ctx) {
        const c = ctx.addStatusContributor((s) => {
          s.bgTasks = { running: n, total: 5 };
          s.changedFiles = 3;
          s.notices.push('ghi chú tính năng');
        });
        refresh = c.refresh;
      },
    };
    const h = await harness({ features: [mod], script: [] });
    expect(h.rt.status().bgTasks).toEqual({ running: 0, total: 5 });
    expect(h.rt.status().changedFiles).toBe(3);
    n = 2;
    const before = h.events.filter((e) => e.t === 'status').length;
    refresh();
    await new Promise((r) => setTimeout(r, 200));
    const st = h.events.filter((e) => e.t === 'status');
    expect(st.length).toBeGreaterThan(before);
    expect((st[st.length - 1] as { status: { bgTasks: { running: number }; notices: string[] } }).status.bgTasks.running).toBe(2);
    expect(h.rt.status().notices).toContain('ghi chú tính năng');
    await h.cleanup();
  });

  it('onDispose / hàm dọn trả về từ attach chạy khi dispose (ngược thứ tự); onSessionChange khi /new và resume', async () => {
    const log: string[] = [];
    const mods: FeatureModule[] = [
      {
        name: 'm1',
        attach(ctx) {
          ctx.onDispose(() => void log.push('dispose-m1'));
          ctx.onSessionChange((s) => void log.push(`session:${s.id.slice(0, 3)}`));
          return () => void log.push('cleanup-m1');
        },
      },
      { name: 'm2', attach: (ctx) => ctx.onDispose(async () => void log.push('dispose-m2')) },
    ];
    const h = await harness({ features: mods, script: [() => textTurn('x')] });
    await h.rt.submit('/new');
    expect(log.some((l) => l.startsWith('session:'))).toBe(true);
    await h.cleanup();
    expect(log.filter((l) => l.startsWith('dispose') || l.startsWith('cleanup'))).toEqual(['dispose-m2', 'cleanup-m1', 'dispose-m1']);
  });

  it('beforeSend chặn tin (hook UserPromptSubmit): không gửi model và trả chữ về ô nhập', async () => {
    const mod: FeatureModule = { name: 'hook', attach: (ctx) => ctx.beforeSend?.(({ text }) => (text.includes('cấm') ? { blocked: true, reason: 'chứa từ cấm' } : undefined)) };
    const h = await harness({ features: [mod], script: [() => textTurn('ok')] });
    await h.rt.submit('đây là từ cấm');
    await h.rt.idle();
    expect(h.provider.requests).toHaveLength(0);
    const ins = h.events.find((e) => e.t === 'action' && e.action === 'insert') as { payload?: string };
    expect(ins.payload).toBe('đây là từ cấm');
    await h.rt.submit('tin bình thường');
    await h.rt.idle();
    expect(h.provider.requests).toHaveLength(1);
    await h.cleanup();
  });

  it('onFileWrite (checkpoints) nhận nội dung trước/sau; onPermissionRequest (Notification) được gọi', async () => {
    const writes: Array<{ abs: string; before: unknown; after: string }> = [];
    const perms: string[] = [];
    const mod: FeatureModule = {
      name: 'cp',
      attach(ctx) {
        ctx.onFileWrite?.((abs, before, after) => void writes.push({ abs, before, after }));
        ctx.onPermissionRequest?.((r) => void perms.push(r.tool));
      },
    };
    const h = await harness({
      features: [mod],
      files: { 'a.txt': 'cũ' },
      script: [toolTurn([{ id: 'r1', name: 'read_file', input: { path: 'a.txt' } }]), toolTurn([{ id: 'w1', name: 'write_file', input: { path: 'a.txt', content: 'mới' } }]), textTurn('xong')],
      autoPermission: () => ({ decision: 'allow' }),
    });
    await h.rt.submit('sửa a.txt');
    await h.rt.idle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ before: 'cũ', after: 'mới' });
    expect(path.basename(writes[0].abs)).toBe('a.txt');
    expect(perms).toContain('write_file');
    await h.cleanup();
  });

  it('addReadRoot cho phép đọc thư mục ngoài workspace không cần hỏi', async () => {
    const outside = tmpDir('lc-outside-');
    fs.writeFileSync(path.join(outside, 'skill.md'), 'NỘI-DUNG-NGOÀI-WORKSPACE');
    const mod: FeatureModule = { name: 'skills', attach: (ctx) => ctx.addReadRoot(outside) };
    const h = await harness({ features: [mod], interactive: false, script: [toolTurn([{ name: 'read_file', input: { path: path.join(outside, 'skill.md') } }]), textTurn('ok')] });
    await h.rt.submit('đọc kỹ năng');
    await h.rt.idle();
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('NỘI-DUNG-NGOÀI-WORKSPACE');
    await h.cleanup();
  });

  it('replaceSession (fork/rewind): thay phiên, phát replay + status, gọi onSessionChange', async () => {
    let fork!: () => Promise<void>;
    const changes: string[] = [];
    const mod: FeatureModule = {
      name: 'fork',
      attach(ctx) {
        ctx.onSessionChange((s) => void changes.push(s.id));
        fork = async () => {
          const cur = ctx.session();
          await ctx.replaceSession?.({ ...cur, id: 'cli_fork_test', title: 'Bản rẽ nhánh', messages: cur.messages.slice(0, 2) }, { reason: 'fork' });
        };
      },
    };
    const h = await harness({ features: [mod], script: [() => textTurn('một'), () => textTurn('hai')] });
    await h.rt.submit('câu một');
    await h.rt.idle();
    await h.rt.submit('câu hai');
    await h.rt.idle();
    await fork();
    expect(h.rt.status().sessionId).toBe('cli_fork_test');
    expect(changes).toEqual(['cli_fork_test']);
    const rep = h.events.filter((e) => e.t === 'replay').pop() as { reason: string; items: unknown[] };
    expect(rep.reason).toBe('fork');
    expect(rep.items.length).toBeGreaterThan(0);
    await h.cleanup();
  });
});

describe('cô lập lỗi của mô-đun tính năng', () => {
  it('mô-đun ném lỗi lúc attach (đồng bộ hoặc bất đồng bộ) không làm sập runtime; các mô-đun khác vẫn gắn', async () => {
    const good: FeatureModule = { name: 'tot', attach: (ctx) => ctx.slash({ name: 'tot', description: { vi: 't', en: 't' }, run: (c) => c.output('còn sống') }) };
    const h = await harness({
      features: [
        {
          name: 'hong-dong-bo',
          attach() {
            throw new Error('nổ ngay');
          },
        },
        {
          name: 'hong-bat-dong-bo',
          async attach() {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('nổ muộn');
          },
        },
        good,
      ],
      script: [() => textTurn('vẫn chạy')],
    });
    // cảnh báo được giao cho người nghe đầu tiên dù xảy ra trước khi có ai nghe
    await new Promise((r) => setTimeout(r, 10));
    const warns = h.toasts().filter((t) => /không khởi động được|failed to start/.test(t));
    expect(warns.length).toBe(2);
    expect(warns.join(' ')).toContain('hong-dong-bo');
    expect(h.rt.status().notices.join(' ')).toMatch(/2 mô-đun/);
    await h.rt.submit('/tot');
    expect(h.outputs().pop()).toBe('còn sống');
    await h.rt.submit('chạy đi');
    await h.rt.idle();
    expect(h.texts()).toContain('vẫn chạy');
    await h.cleanup();
  });

  it('lệnh gạch chéo của tính năng ném lỗi → in lỗi, runtime còn dùng được', async () => {
    const mod: FeatureModule = {
      name: 'boom',
      attach(ctx) {
        ctx.slash({
          name: 'no',
          description: { vi: 'n', en: 'n' },
          run() {
            throw new Error('lệnh hỏng');
          },
        });
        ctx.slash({
          name: 'no2',
          description: { vi: 'n', en: 'n' },
          async run() {
            await Promise.reject(new Error('lệnh hỏng bất đồng bộ'));
          },
        });
      },
    };
    const h = await harness({ features: [mod], script: [() => textTurn('ok')] });
    await h.rt.submit('/no');
    expect(h.outputs().pop()).toContain('lệnh hỏng');
    await h.rt.submit('/no2');
    expect(h.outputs().pop()).toContain('bất đồng bộ');
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(h.texts()).toContain('ok');
    await h.cleanup();
  });

  it('RunExtension / đóng góp trạng thái / đóng góp prompt / đóng góp công cụ / người nghe phiên ném lỗi → lượt vẫn chạy xong', async () => {
    const mod: FeatureModule = {
      name: 'chaos',
      attach(ctx) {
        ctx.addRunExtension({
          id: 'chaos',
          begin() {
            throw new Error('begin nổ');
          },
        });
        ctx.addRunExtension({
          id: 'chaos2',
          begin: () => ({
            beforeModel() {
              throw new Error('beforeModel nổ');
            },
            finalize() {
              throw new Error('finalize nổ');
            },
          }),
        });
        ctx.addStatusContributor(() => {
          throw new Error('status nổ');
        });
        ctx.addPromptContributor(() => {
          throw new Error('prompt nổ');
        });
        ctx.addToolContributor(() => {
          throw new Error('tool nổ');
        });
        ctx.onSessionChange(() => {
          throw new Error('session nổ');
        });
        ctx.onDispose(() => {
          throw new Error('dispose nổ');
        });
      },
    };
    const h = await harness({ features: [mod], script: [() => textTurn('sống sót')] });
    h.rt.on(() => {
      throw new Error('người nghe nổ'); // người nghe giao diện lỗi cũng không được làm sập lõi
    });
    await h.rt.submit('chào');
    await h.rt.idle();
    expect(h.texts()).toContain('sống sót');
    expect(h.rt.status().title).toContain('chào');
    await h.rt.submit('/new');
    await h.cleanup(); // dispose nổ không chặn đóng
  });

  it('attach treo vô hạn không chặn khởi động mãi mãi (đã có hạn giờ) — kiểm bằng mô-đun chậm nhưng hữu hạn', async () => {
    const mod: FeatureModule = {
      name: 'cham',
      async attach(ctx) {
        await new Promise((r) => setTimeout(r, 100));
        ctx.slash({ name: 'cham', description: { vi: 'c', en: 'c' }, run: (c) => c.output('đã xong chậm') });
      },
    };
    const h = await harness({ features: [mod], script: [] });
    await h.rt.submit('/cham');
    expect(h.outputs().pop()).toBe('đã xong chậm');
    await h.cleanup();
  });
});
