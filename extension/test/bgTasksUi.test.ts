/**
 * (lane:bg-tasks) Giao diện + Remote của tác vụ nền: cắt kích thước, lệnh Dừng từ xa, /tasks, kết nối vào App, i18n đủ hai ngôn ngữ.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/core/remote/protocol';
import { sanitizePatch, toRemoteState } from '../src/core/remote/sanitize';
import { capBgTasks, type BgTaskView } from '../src/shared/bgTasks';
import { BackgroundTaskManager, toView } from '../src/core/tasks/backgroundTasks';
import type { ToolHost } from '../src/core/engine/types';

const W = path.resolve(__dirname, '../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');

const view = (o: Partial<BgTaskView> = {}): BgTaskView => ({ id: 'bg1', command: 'npm run dev', cwd: '.', status: 'running', startedAt: 1, tail: ['a', 'b'], ...o });

describe('Remote: bgTasks', () => {
  it('capBgTasks cắt lệnh/dòng/số lượng; vắng → []', () => {
    expect(capBgTasks(undefined)).toEqual([]);
    const big = Array.from({ length: 30 }, (_, i) => view({ id: `bg${i}`, command: 'x'.repeat(1000), tail: Array.from({ length: 12 }, () => 'y'.repeat(900)) }));
    const out = capBgTasks(big);
    expect(out.length).toBe(20);
    expect(out[0]!.command.length).toBe(300);
    expect(out[0]!.tail.length).toBe(5);
    expect(out[0]!.tail[0]!.length).toBe(300);
  });

  it('sanitizePatch: bgTasks đi qua (đã cắt); bgTasks undefined → [] để Remote xoá chip', () => {
    expect(sanitizePatch({ bgTasks: [view()] })!.bgTasks).toEqual([view()]);
    expect(sanitizePatch({ running: true })!.bgTasks).toBeUndefined(); // không có khoá → không đổi
    expect(sanitizePatch({ ['bgTasks']: undefined } as never)!.bgTasks).toEqual([]);
  });

  it('toRemoteState chỉ thêm bgTasks khi có tác vụ', () => {
    const base = { transcript: [], settings: {}, models: [], options: {}, mode: 'default', running: false, allowBypass: false } as never;
    const host = { name: 'pc', version: '0', platform: 'win32' } as never;
    expect('bgTasks' in toRemoteState(base, host, { canBypass: false })).toBe(false);
    expect(toRemoteState({ ...(base as object), bgTasks: [view()] } as never, host, { canBypass: false }).bgTasks?.length).toBe(1);
  });

  it('parseCommand: Remote chỉ được DỪNG tác vụ nền (id dạng bgN)', () => {
    const o = { canBypass: false };
    expect(parseCommand({ type: 'bg_task', id: 'bg3', action: 'stop' }, o)).toEqual({ ok: true, cmd: { type: 'bg_task', id: 'bg3', action: 'stop' } });
    expect(parseCommand({ type: 'bg_task', id: 'bg3', action: 'copy' }, o)).toEqual({ ok: false, error: 'bad_action' });
    expect(parseCommand({ type: 'bg_task', id: 'bg3', action: 'open' }, o)).toEqual({ ok: false, error: 'bad_action' });
    expect(parseCommand({ type: 'bg_task', id: '../x', action: 'stop' }, o)).toEqual({ ok: false, error: 'bad_id' });
    expect(parseCommand({ type: 'bg_task', id: 5, action: 'stop' }, o)).toEqual({ ok: false, error: 'bad_id' });
  });
});

describe('toView', () => {
  it('bản hiển thị: 5 dòng cuối, không lộ bộ đệm; ready + mã thoát', async () => {
    const host = { startProcess: () => ({ pid: 1, kill: async () => undefined }) } as unknown as ToolHost;
    const mgr = new BackgroundTaskManager(host);
    const r = mgr.start({ sessionId: 's', command: 'npm run dev', cwdAbs: '/w', cwdRel: '.' });
    if (!r.ok) throw new Error(r.error);
    r.task.buffer.push('1\n2\n3\n4\n5\n6\n7\n');
    const v = toView(r.task);
    expect(v.tail).toEqual(['3', '4', '5', '6', '7']);
    expect(v.status).toBe('running');
    expect(mgr.views('s').length).toBe(1);
    expect(mgr.views('khac')).toEqual([]);
  });
});

describe('webview: chip tác vụ nền', () => {
  const i18n = read('i18n.ts');
  const defs = (k: string) => i18n.split(`'${k}':`).length - 1;

  it('mọi khoá có đủ vi + en', () => {
    for (const k of ['chip.running', 'chip.done', 'running', 'exited', 'killed', 'failed', 'failedCode', 'ready', 'stop', 'copy', 'open']) expect(defs(`bgt.${k}`), k).toBe(2);
  });

  it('App gắn chip trong footer phía trên ô nhập; chip có chấm, mũi tên, nút Thu gọn ở cuối; dùng postMessage bg_task', () => {
    const app = read('App.tsx');
    expect(app).toContain('<BgTasksStrip tasks={view.bgTasks} />');
    expect(app.indexOf('<BgTasksStrip')).toBeLessThan(app.indexOf('<Composer'));
    const tsx = read('components/BgTasksStrip.tsx');
    expect(tsx).toContain('CollapseFoot');
    expect(tsx).toContain("type: 'bg_task'");
    expect(tsx).toContain('aria-expanded');
    const css = read('styles/bgtasks.css');
    expect(css).toContain('border-left'); // thanh dọc mảnh
    expect(css).not.toMatch(/\.bgt(-[a-z]+)?\s*\{[^}]*background:\s*var\(--surface/); // không tô nền kín
    expect(read('styles/main.css')).toContain("bgtasks.css");
  });
});
