import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callHook } from '../../../src/core/engine/seams';
import { getTaskManager } from '../../../src/core/tasks/backgroundTasks';
import { bgTasksFeature } from '../../../src/cli/runtime/features/bgTasks';
import { FakeFeatureContext } from './helpers';

let ctx: FakeFeatureContext;
const scripts: string[] = [];
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
  for (const f of scripts.splice(0)) fs.rmSync(f, { force: true });
});

function nodeCmd(body: string): string {
  const file = path.join(os.tmpdir(), `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
  fs.writeFileSync(file, body);
  scripts.push(file);
  return `node "${file}"`;
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  if (!pred()) throw new Error('hết giờ chờ điều kiện');
}

function start(c: FakeFeatureContext, command: string) {
  const r = getTaskManager(c.host).start({ sessionId: c.session().id, command, cwdAbs: c.cwd, cwdRel: '.' });
  if (!r.ok) throw new Error(r.error);
  return r.task;
}

describe('tác vụ nền', () => {
  it('khởi chạy tiến trình thật → /tasks liệt kê → xem đuôi đầu ra → dừng', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(bgTasksFeature);
    expect(await ctx.runSlash('tasks')).toMatch(/Chưa có tác vụ nền/);

    const t = start(ctx, nodeCmd("console.log('xin chao tu nen');console.log('dong hai');setInterval(()=>{},1000);"));
    await waitFor(() => t.buffer.lastLines(5).join('\n').includes('dong hai'));
    expect(ctx.status().bgTasks).toEqual({ running: 1, total: 1 });

    const list = await ctx.runSlash('tasks');
    expect(list).toContain(t.id);
    expect(list).toMatch(/đang chạy/);

    const tail = await ctx.runSlash('tasks', t.id);
    expect(tail).toContain('xin chao tu nen');
    expect(tail).toContain('dong hai');

    const stopped = await ctx.runSlash('tasks', `stop ${t.id}`);
    expect(stopped).toMatch(/Đã dừng 1/);
    expect(t.status).toBe('killed');
    expect(ctx.status().bgTasks).toEqual({ running: 0, total: 1 });
    expect(await ctx.runSlash('tasks', 'stop all')).toMatch(/Không có tác vụ nào đang chạy/);
    expect(await ctx.runSlash('tasks', 'bg99')).toMatch(/Không có tác vụ/);
  });

  it('lệnh chỉ đọc: chạy được khi đang bận', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(bgTasksFeature);
    expect(ctx.slashNamed('tasks').needsIdle).toBe(false);
  });

  it('báo model «tác vụ đã xong» đúng MỘT lần; tác vụ do agent dừng thì không báo', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(bgTasksFeature);
    const t = start(ctx, nodeCmd("console.log('in ra roi thoat');process.exit(3);"));
    await waitFor(() => t.status !== 'running');
    const turn = { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false };
    const active = ctx.begin(ctx.scope());
    const first = await callHook(active, 'beforeModel', () => undefined, turn);
    const txt = JSON.stringify(first);
    expect(txt).toContain(t.id);
    expect(txt).toContain('in ra roi thoat');
    const second = await callHook(ctx.begin(ctx.scope()), 'beforeModel', () => undefined, turn);
    expect(JSON.stringify(second)).not.toContain(t.id);

    const t2 = start(ctx, nodeCmd('setInterval(()=>{},1000);'));
    await getTaskManager(ctx.host).stop(t2.id, 'agent');
    const third = await callHook(ctx.begin(ctx.scope()), 'beforeModel', () => undefined, turn);
    expect(JSON.stringify(third)).not.toContain(t2.id);
  });

  it('đóng phiên làm việc: dừng sạch mọi tác vụ đang chạy', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(bgTasksFeature);
    const t = start(ctx, nodeCmd('setInterval(()=>{},1000);'));
    await waitFor(() => t.status === 'running');
    await ctx.dispose();
    expect(getTaskManager(ctx.host).list()).toHaveLength(0);
    expect(t.status).not.toBe('running');
  });
});
