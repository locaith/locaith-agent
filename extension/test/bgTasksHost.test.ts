/**
 * (lane:bg-tasks) Phía VS Code: /tasks, đẩy ViewState.bgTasks, nút Dừng / Sao chép / Xem đầy đủ. Tiến trình là đồ giả điều khiển được.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const clip: string[] = [];
const opened: { content: string; language: string }[] = [];
vi.mock('vscode', () => ({
  env: { clipboard: { writeText: async (s: string) => void clip.push(s) } },
  workspace: {
    openTextDocument: async (o: { content: string; language: string }) => (opened.push(o), o),
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { showTextDocument: async () => undefined },
}));

import type { ProcessHandle, StartProcessOptions, ToolHost } from '../src/core/engine/types';
import { getTaskManager } from '../src/core/tasks/backgroundTasks';
import { handleBgTaskMessage, registerTasksSlash, tasksReport, type BgTasksBridge } from '../src/host/tasksSlash';
import { SlashRegistry } from '../src/host/slashRegistry';
import type { HostMessage, ViewState } from '../src/shared/protocol';

interface Fake {
  host: ToolHost;
  procs: { opts: StartProcessOptions; killed: boolean }[];
}
function fakeHost(): Fake {
  const procs: Fake['procs'] = [];
  const host = {
    startProcess(opts: StartProcessOptions): ProcessHandle {
      const p = { opts, killed: false };
      procs.push(p);
      return {
        pid: 100 + procs.length,
        kill: async () => {
          p.killed = true;
          opts.onExit({ exitCode: null, signal: 'SIGTERM' });
        },
      };
    },
  } as unknown as ToolHost;
  return { host, procs };
}

function bridge(host: ToolHost, sessionId = 's1') {
  const patches: Partial<ViewState>[] = [];
  const mirrors: ((m: HostMessage) => void)[] = [];
  const b: BgTasksBridge = {
    host,
    sessionId: () => sessionId,
    patch: (p) => patches.push(p),
    lang: () => 'vi',
    disposed: () => false,
    addMirror: (m) => (mirrors.push(m), { dispose() {} }),
  };
  return { b, patches, mirrors };
}

afterEach(() => {
  clip.length = 0;
  opened.length = 0;
});

describe('tasksReport + /tasks', () => {
  it('báo trống / liệt kê tác vụ với trạng thái, thời gian, sẵn sàng', async () => {
    const { host } = fakeHost();
    const mgr = getTaskManager(host);
    expect(tasksReport([], 'vi')).toContain('Chưa có tác vụ nền');
    expect(tasksReport([], 'en')).toContain('No background tasks');
    const r = mgr.start({ sessionId: 's1', command: 'npm run dev', cwdAbs: '/w', cwdRel: '.' });
    if (!r.ok) throw new Error(r.error);
    r.task.ready = 'http://localhost:5173/';
    const txt = tasksReport(mgr.list('s1'), 'vi', r.task.startedAt + 65_000);
    expect(txt).toContain('1 đang chạy / 1');
    expect(txt).toContain('`bg');
    expect(txt).toContain('1m05s');
    expect(txt).toContain('http://localhost:5173/');
    expect(txt).toContain('npm run dev');
  });

  it('lệnh /tasks đã đăng ký và in danh sách của đúng cuộc trò chuyện', async () => {
    const { host } = fakeHost();
    const { b } = bridge(host, 'sA');
    const slash = new SlashRegistry();
    registerTasksSlash(slash, { bgTasksBridge: () => b });
    const def = slash.get('tasks');
    expect(def).toBeDefined();
    getTaskManager(host).start({ sessionId: 'sA', command: 'node a.js', cwdAbs: '/w', cwdRel: '.' });
    getTaskManager(host).start({ sessionId: 'sB', command: 'node b.js', cwdAbs: '/w', cwdRel: '.' });
    const out: string[] = [];
    await def!.run({ args: '', lang: 'vi', info: (t: string) => out.push(t), warn: () => {}, runPrompt: async () => {}, busy: false } as never);
    expect(out[0]).toContain('node a.js');
    expect(out[0]).not.toContain('node b.js');
    await getTaskManager(host).disposeAll();
  });
});

describe('ViewState.bgTasks', () => {
  it('đẩy tác vụ lên giao diện khi đổi; gỡ khi hết (undefined)', async () => {
    const { host, procs } = fakeHost();
    const { b, patches, mirrors } = bridge(host);
    registerTasksSlash(new SlashRegistry(), { bgTasksBridge: () => b });
    await Promise.resolve();
    await Promise.resolve();
    const mgr = getTaskManager(host);
    mgr.start({ sessionId: 's1', command: 'npm run dev', cwdAbs: '/w', cwdRel: '.' });
    procs[0]!.opts.onData('VITE ready\nLocal: http://localhost:5173/\n');
    await new Promise((r) => setTimeout(r, 450));
    const last = patches.at(-1)!;
    expect(last.bgTasks?.[0]).toMatchObject({ status: 'running', ready: 'http://localhost:5173/' });
    expect(last.bgTasks?.[0]!.tail).toContain('VITE ready');
    // mở lại cuộc trò chuyện (init) → bổ sung ngay
    const before = patches.length;
    mirrors[0]!({ type: 'init' } as HostMessage);
    await Promise.resolve();
    expect(patches.length).toBe(before + 1);
    // huỷ phiên → danh sách rỗng → patch undefined
    await mgr.disposeSession('s1');
    await new Promise((r) => setTimeout(r, 450));
    expect(patches.at(-1)).toEqual({ bgTasks: undefined });
  });
});

describe('handleBgTaskMessage', () => {
  async function setup() {
    const f = fakeHost();
    const { b } = bridge(f.host);
    const r = getTaskManager(f.host).start({ sessionId: 's1', command: 'npm run dev', cwdAbs: '/w', cwdRel: '.' });
    if (!r.ok) throw new Error(r.error);
    f.procs[0]!.opts.onData('\u001b[32mhello\u001b[0m\n');
    return { ...f, b, task: r.task, ctl: { bgTasksBridge: () => b } };
  }

  it('stop: giết tiến trình, trạng thái killed do người dùng (sẽ được báo cho model)', async () => {
    const { ctl, task, procs } = await setup();
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'stop' });
    expect(procs[0]!.killed).toBe(true);
    expect(task.status).toBe('killed');
    expect(task.stoppedBy).toBe('user');
    expect(task.notified).toBe(false);
  });

  it('copy: sao chép đầu ra đã bỏ mã màu; open: mở tab log có tiêu đề lệnh', async () => {
    const { ctl, task } = await setup();
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'copy' });
    expect(clip).toEqual(['hello\n']);
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'open' });
    expect(opened[0]!.language).toBe('log');
    expect(opened[0]!.content).toContain('npm run dev');
    expect(opened[0]!.content).toContain('hello');
  });

  it('id không thuộc cuộc trò chuyện này → bỏ qua; từ xa không được copy/open', async () => {
    const { ctl, task, procs } = await setup();
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: 'bg999', action: 'stop' });
    expect(procs[0]!.killed).toBe(false);
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'copy' }, true);
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'open' }, true);
    expect(clip).toEqual([]);
    expect(opened).toEqual([]);
    await handleBgTaskMessage(ctl, { type: 'bg_task', id: task.id, action: 'stop' }, true);
    expect(procs[0]!.killed).toBe(true);
  });
});
