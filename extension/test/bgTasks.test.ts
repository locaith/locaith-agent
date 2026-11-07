/**
 * (lane:bg-tasks) Tác vụ nền: tiến trình node THẬT qua NodeToolHost (shell mặc định của máy: PowerShell trên Windows).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { liveBackgroundProcessCount } from '../src/core/host/bgProcess';
import { BackgroundTaskManager, detectReady, getTaskManager, MAX_RUNNING, OutputBuffer } from '../src/core/tasks/backgroundTasks';
import { formatEndedNotice } from '../src/core/tasks/notifyExtension';
import { coreRunExtensions } from '../src/core/engine/extensions';
import { backgroundNotifyExtension } from '../src/core/tasks/notifyExtension';
import type { ToolResultBlock } from '../src/core/types';
import { makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

const TICK = `let i = 0; const n = Number(process.argv[2] || 1e9); const t = setInterval(() => { console.log('tick ' + (++i)); if (i >= n) { clearInterval(t); process.exit(Number(process.argv[3] || 0)); } }, 60); console.log('Local: http://localhost:5173/');`;
const PARENT = `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' }); console.log('CHILD ' + c.pid); setInterval(() => {}, 1000);`;
const FLOOD = `const s = 'x'.repeat(1000) + '\\n'; for (let i = 0; i < 1200; i++) process.stdout.write(s); console.log('END-MARK'); setInterval(()=>{}, 1000);`;

// cmd khởi động tức thì; PowerShell 5.1 trên máy tải nặng mất 30–90 s mỗi lần — chỉ một test riêng chạy PowerShell thật (xem cuối tệp).
const SHELL = process.platform === 'win32' ? 'cmd' : 'auto';
const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg tasks thư mục '));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'tick.js'), TICK);
  fs.writeFileSync(path.join(dir, 'parent.js'), PARENT);
  fs.writeFileSync(path.join(dir, 'flood.js'), FLOOD);
  return dir;
}
const managers: BackgroundTaskManager[] = [];
function setup(): { dir: string; host: NodeToolHost; mgr: BackgroundTaskManager } {
  const dir = workspace();
  const host = new NodeToolHost({ roots: [dir], shellPreference: SHELL });
  const mgr = getTaskManager(host);
  managers.push(mgr);
  return { dir, host, mgr };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('OutputBuffer', () => {
  it('giữ đầu + đuôi, con trỏ tuyệt đối, báo phần giữa bị lược', () => {
    const b = new OutputBuffer(10, 20);
    b.push('0123456789'); // đầy phần đầu
    b.push('a'.repeat(30) + 'TAIL');
    expect(b.total).toBe(44);
    expect(b.dropped).toBe(14);
    const all = b.read(0);
    expect(all.text.startsWith('0123456789')).toBe(true);
    expect(all.text).toContain('đã lược 14');
    expect(all.text.endsWith('TAIL')).toBe(true);
    expect(all.next).toBe(44);
    expect(b.read(44).text).toBe('');
    expect(b.read(42).text).toBe('IL');
    // since nằm trong phần đã lược → báo gap, trả phần đuôi
    const mid = b.read(15);
    expect(mid.gap).toBe(9);
  });

  it('5 dòng cuối bỏ mã màu và dòng trống', () => {
    const b = new OutputBuffer();
    b.push('a\nb\n\u001b[32mc\u001b[0m\nd\ne\nf\n\n');
    expect(b.lastLines(5)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });
});

describe('detectReady', () => {
  it('bắt URL cục bộ và câu "ready"', () => {
    expect(detectReady('  ➜  Local:   http://localhost:5173/\n')).toBe('http://localhost:5173/');
    expect(detectReady('Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C)')).toBe('http://localhost:8000');
    expect(detectReady('Server listening on port 3000')).toContain('listening on');
    expect(detectReady('compiling...')).toBeUndefined();
  });
});

describe('BackgroundTaskManager — tiến trình thật', () => {
  it('khởi chạy, đọc tăng dần theo con trỏ, thoát tự nhiên mã 0, phát hiện sẵn sàng; cwd có dấu cách + tiếng Việt', async () => {
    const { dir, mgr } = setup();
    const res = mgr.start({ sessionId: 's1', command: 'node tick.js 5 0', cwdAbs: dir, cwdRel: '.' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const t = res.task;
    expect(t.id).toMatch(/^bg\d+$/);
    expect(await until(() => t.buffer.read(0).text.includes('tick 2'))).toBe(true);
    const first = t.buffer.read(0);
    expect(t.ready).toBe('http://localhost:5173/');
    expect(await until(() => t.status !== 'running')).toBe(true);
    const rest = t.buffer.read(first.next);
    expect(rest.text).toContain('tick 5');
    expect(rest.text).not.toContain('tick 1\n');
    expect(t.status).toBe('exited');
    expect(t.exitCode).toBe(0);
  }, 30000);

  it('thoát lỗi → failed + mã thoát', async () => {
    const { dir, mgr } = setup();
    const res = mgr.start({ sessionId: 's1', command: 'node tick.js 2 3', cwdAbs: dir, cwdRel: '.' });
    if (!res.ok) throw new Error(res.error);
    expect(await until(() => res.task.status !== 'running')).toBe(true);
    expect(res.task.status).toBe('failed');
    expect(res.task.exitCode).toBe(3);
  }, 30000);

  it('dừng CẢ CÂY tiến trình (có tiến trình con) theo PID, không rò', async () => {
    const { dir, mgr } = setup();
    const res = mgr.start({ sessionId: 's1', command: 'node parent.js', cwdAbs: dir, cwdRel: '.' });
    if (!res.ok) throw new Error(res.error);
    const t = res.task;
    expect(await until(() => /CHILD \d+/.test(t.buffer.all()))).toBe(true);
    const childPid = Number(/CHILD (\d+)/.exec(t.buffer.all())![1]);
    const shellPid = t.handle!.pid!;
    expect(alive(childPid)).toBe(true);
    await mgr.stop(t.id, 'agent');
    expect(t.status).toBe('killed');
    expect(await until(() => !alive(childPid) && !alive(shellPid), 8000)).toBe(true);
    expect(t.notified).toBe(true); // agent tự dừng → không báo lại
  }, 30000);

  it('bộ đệm tràn (>1,2 MB đầu ra) vẫn ≤ giới hạn, giữ đầu + đuôi', async () => {
    const { dir, mgr } = setup();
    const res = mgr.start({ sessionId: 's1', command: 'node flood.js', cwdAbs: dir, cwdRel: '.' });
    if (!res.ok) throw new Error(res.error);
    const t = res.task;
    expect(await until(() => t.buffer.all().includes('END-MARK'))).toBe(true);
    expect(t.buffer.dropped).toBeGreaterThan(0);
    const all = t.buffer.all();
    expect(all.length).toBeLessThan(64 * 1024 + 448 * 1024 + 200);
    expect(all.startsWith('x')).toBe(true);
    expect(t.buffer.read(0).gap).toBeGreaterThan(0);
  }, 30000);

  it(`tối đa ${MAX_RUNNING} tác vụ đang chạy mỗi phiên; phiên khác không bị tính`, async () => {
    const { dir, mgr } = setup();
    for (let i = 0; i < MAX_RUNNING; i++) expect(mgr.start({ sessionId: 's1', command: 'node tick.js', cwdAbs: dir, cwdRel: '.' }).ok).toBe(true);
    const ninth = mgr.start({ sessionId: 's1', command: 'node tick.js', cwdAbs: dir, cwdRel: '.' });
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.error).toContain(String(MAX_RUNNING));
    expect(mgr.start({ sessionId: 's2', command: 'node tick.js', cwdAbs: dir, cwdRel: '.' }).ok).toBe(true);
  }, 60000);

  it('huỷ phiên dừng mọi tác vụ của phiên đó (giữ phiên khác); dọn hết thì không còn tiến trình sống', async () => {
    const { dir, mgr } = setup();
    const a = mgr.start({ sessionId: 's1', command: 'node tick.js', cwdAbs: dir, cwdRel: '.' });
    const b = mgr.start({ sessionId: 's2', command: 'node tick.js', cwdAbs: dir, cwdRel: '.' });
    if (!a.ok || !b.ok) throw new Error('start');
    const pidA = a.task.handle!.pid!;
    await until(() => a.task.buffer.all().includes('tick 1') && b.task.buffer.all().includes('tick 1'));
    await mgr.disposeSession('s1');
    expect(mgr.list('s1')).toEqual([]);
    expect(await until(() => !alive(pidA), 8000)).toBe(true);
    expect(b.task.status).toBe('running');
    await mgr.disposeAll();
    expect(b.task.status).toBe('killed');
    expect(await until(() => liveBackgroundProcessCount() === 0, 8000)).toBe(true);
  }, 30000);
});

describe('formatEndedNotice', () => {
  it('gộp nhiều tác vụ, có trạng thái + dòng cuối', async () => {
    const { dir, mgr } = setup();
    const r = mgr.start({ sessionId: 's1', command: 'node tick.js 3 1', cwdAbs: dir, cwdRel: '.' });
    if (!r.ok) throw new Error(r.error);
    await until(() => r.task.status !== 'running');
    const text = formatEndedNotice(mgr.takeUnnotified('s1'), 'vi');
    expect(text).toMatch(/\[Tác vụ nền bg\d+ \(node tick\.js 3 1\) đã kết thúc: exit 1 sau \d+s\. \d+ dòng cuối:\n[\s\S]*tick 3/);
    expect(mgr.takeUnnotified('s1')).toEqual([]); // chỉ báo một lần
  }, 30000);
});

const toolResults = (h: ReturnType<typeof makeHarness>, i: number): ToolResultBlock[] =>
  h.provider.requests[i].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));

describe('engine + công cụ (fakeProvider)', () => {
  it('run_command background:true trả id ngay; command_output đọc tiếp; kết thúc → tin synthetic ở vòng sau (lưu vào lịch sử, một lần)', async () => {
    let hostRef: NodeToolHost | undefined;
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'run_command', input: { command: 'node tick.js 60 2', background: true, description: 'chạy thử' } }]),
        async () => {
          const t = getTaskManager(hostRef!).list('s1')[0]!;
          await until(() => t.status !== 'running');
          return toolTurn([{ name: 'read_file', input: { path: 'tick.js' } }]);
        },
        () => textTurn('xong'),
      ],
      { files: { 'tick.js': TICK }, shellPreference: SHELL, engineDeps: { extensions: [...coreRunExtensions(), backgroundNotifyExtension()] } },
    );
    hostRef = h.host;
    managers.push(getTaskManager(h.host));
    await h.run('chạy nền');
    const r1 = toolResults(h, 1)[0]!;
    expect(r1.isError).toBeFalsy();
    expect(JSON.stringify(r1.content)).toMatch(/Đã chạy nền: bg\d+/);
    expect(h.permissionRequests.length).toBe(1); // cùng cổng quyền như run_command
    // vòng 3: thông báo kết thúc nằm trong lịch sử gửi cho model
    const third = JSON.stringify(h.provider.requests[2].messages);
    expect(third).toMatch(/Tác vụ nền bg\d+ \(node tick\.js 60 2\) đã kết thúc: exit 2/);
    expect(JSON.stringify(h.session.messages)).toContain('đã kết thúc: exit 2');
    expect(third.match(/đã kết thúc: exit 2/g)!.length).toBe(1);
  }, 60000);

  it('command_output với since + wait_ms, command_list, command_stop', async () => {
    let hostRef: NodeToolHost | undefined;
    let id = '';
    const h = makeHarness(
      [
        () => toolTurn([{ name: 'run_command', input: { command: 'node tick.js', background: true } }]),
        () => {
          id = getTaskManager(hostRef!).list('s1')[0]!.id;
          return toolTurn([{ name: 'command_output', input: { id, since: 0, wait_ms: 3000, filter: 'tick [0-9]+' } }]);
        },
        () => toolTurn([{ name: 'command_list', input: {} }]),
        () => toolTurn([{ name: 'command_stop', input: { id } }]),
        () => textTurn('xong'),
      ],
      { files: { 'tick.js': TICK }, shellPreference: SHELL, engineDeps: { extensions: [...coreRunExtensions(), backgroundNotifyExtension()] } },
    );
    hostRef = h.host;
    managers.push(getTaskManager(h.host));
    await h.run('x');
    const out = JSON.stringify(toolResults(h, 2).at(-1)!.content);
    expect(out).toContain('đang chạy');
    expect(out).toMatch(/cursor: \d+/);
    expect(out).toContain('tick 1');
    expect(out).not.toContain('Local:'); // filter bỏ dòng không khớp
    expect(JSON.stringify(toolResults(h, 3).at(-1)!.content)).toContain('lệnh: node tick.js');
    expect(JSON.stringify(toolResults(h, 4).at(-1)!.content)).toContain('Đã dừng cả cây');
    expect(getTaskManager(h.host).get(id)!.status).toBe('killed');
    // agent tự dừng → không có tin "đã kết thúc" ở vòng cuối
    expect(JSON.stringify(h.provider.requests[4].messages)).not.toContain('đã kết thúc');
  }, 60000);

  it('quyền: bị từ chối thì KHÔNG khởi tiến trình nào', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'run_command', input: { command: 'node tick.js', background: true } }]), () => textTurn('ok')], {
      files: { 'tick.js': TICK },
      shellPreference: SHELL,
      decide: () => 'deny',
    });
    managers.push(getTaskManager(h.host));
    await h.run('x');
    expect(h.permissionRequests.length).toBe(1);
    expect(h.permissionRequests[0]!.detail ?? '').toContain('Chạy nền');
    expect(getTaskManager(h.host).list()).toEqual([]);
  }, 30000);

  it('lỗi khởi động sớm được báo ngay trong kết quả run_command', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'run_command', input: { command: 'node khong-co-tep.js', background: true } }]), () => textTurn('ok')], {
      shellPreference: SHELL,
      engineDeps: { extensions: [...coreRunExtensions(), backgroundNotifyExtension()] },
    });
    managers.push(getTaskManager(h.host));
    await h.run('x');
    const r = toolResults(h, 1)[0]!;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('kết thúc ngay khi khởi động');
    expect(JSON.stringify(r.content)).toMatch(/Cannot find module|khong-co-tep/);
  }, 30000);

  it('host không có startProcess (bản trình duyệt) → không có tham số background và công cụ command_*', async () => {
    const h = makeHarness([() => textTurn('ok')]);
    const defs = h.provider; // dùng registry qua yêu cầu đầu tiên
    await h.run('x');
    const names = (h.provider.requests[0].tools ?? []).map((t) => t.name);
    expect(names).toContain('command_output');
    expect(names).toContain('command_stop');
    void defs;
    const { createTerminalTool } = await import('../src/core/tools/terminal');
    const fakeHost = { ...h.host, platform: h.host.platform, startProcess: undefined } as unknown as NodeToolHost;
    const tool = createTerminalTool(fakeHost);
    expect(JSON.stringify(tool.inputSchema)).not.toContain('background');
  });
});

describe('mã hoá + hết giờ + PowerShell thật', () => {
  it('đầu ra UTF-8 tiếng Việt được giải mã đúng (cmd)', async () => {
    const { dir, mgr } = setup();
    fs.writeFileSync(path.join(dir, 'vi.js'), "console.log('Xin chào, Việt Nam — đường dẫn có dấu');");
    const res = mgr.start({ sessionId: 's1', command: 'node vi.js', cwdAbs: dir, cwdRel: '.' });
    if (!res.ok) throw new Error(res.error);
    expect(await until(() => res.task.status !== 'running')).toBe(true);
    expect(res.task.buffer.all()).toContain('Xin chào, Việt Nam — đường dẫn có dấu');
  }, 30000);

  it('lệnh đồng bộ hết giờ → kết quả gợi ý chạy lại với background:true', async () => {
    const h = makeHarness(
      [() => toolTurn([{ name: 'run_command', input: { command: 'node -e "setTimeout(()=>{},30000)"', timeout_seconds: 1 } }]), () => textTurn('ok')],
      { shellPreference: SHELL },
    );
    managers.push(getTaskManager(h.host));
    await h.run('x');
    const r = toolResults(h, 1)[0]!;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('background:true');
  }, 60000);

  // Windows PowerShell 5.1 là shell mặc định của người dùng: kiểm tra cả khởi chạy, tiếng Việt trong cwd và giết cả cây qua nó.
  it.skipIf(process.platform !== 'win32')(
    'PowerShell 5.1 thật: chạy, đọc đầu ra, dừng cả cây',
    async () => {
      const dir = workspace();
      const host = new NodeToolHost({ roots: [dir], shellPreference: 'powershell' });
      const mgr = getTaskManager(host);
      managers.push(mgr);
      const res = mgr.start({ sessionId: 'ps', command: 'node parent.js', cwdAbs: dir, cwdRel: '.' });
      if (!res.ok) throw new Error(res.error);
      const t = res.task;
      expect(await until(() => /CHILD \d+/.test(t.buffer.all()), 170000)).toBe(true);
      const childPid = Number(/CHILD (\d+)/.exec(t.buffer.all())![1]);
      expect(alive(childPid)).toBe(true);
      await mgr.stop(t.id, 'user');
      expect(t.status).toBe('killed');
      expect(await until(() => !alive(childPid), 10000)).toBe(true);
    },
    240000,
  );
});
