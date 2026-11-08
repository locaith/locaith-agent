import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callHook } from '../../../src/core/engine/seams';
import { hookServiceOf, hooksFeature, approvalsFile } from '../../../src/cli/runtime/features/hooks';
import { script, exits, printsJson, recordStdin, TEST_SHELL } from '../../helpers/hookKit';
import { FakeFeatureContext, fakeToolDef, toolCall } from './helpers';

let ctx: FakeFeatureContext;
const mk = (o: ConstructorParameters<typeof FakeFeatureContext>[0] = {}) =>
  (ctx = new FakeFeatureContext({ ...o, user: { 'terminal.shell': TEST_SHELL, ...(o.user ?? {}) } }));

afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

const hooksOf = (event: string, command: string, matcher?: string) => ({ [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }] });
const noop = () => undefined;

async function run(c: FakeFeatureContext, call: ReturnType<typeof toolCall>, def = fakeToolDef(call.name)) {
  const active = c.begin(c.scope());
  const res = await callHook(active, 'toolBefore', noop, call, def, {} as never);
  return res.map((r) => r.value).find(Boolean);
}

describe('hooks', () => {
  beforeEach(() => undefined);

  it('hook người dùng thoát mã 2 chặn công cụ, mã 0 thì cho qua', async () => {
    mk({ user: { hooks: hooksOf('PreToolUse', exits(2, 'cấm chạy lệnh này'), 'run_command') } });
    await ctx.attach(hooksFeature);
    const blocked = (await run(ctx, toolCall('run_command', { command: 'rm -rf /' }))) as { block: string; state: string };
    expect(blocked.block).toContain('cấm chạy lệnh này');
    expect(blocked.state).toBe('denied');
    // matcher khác tên công cụ → không chạy hook
    expect(await run(ctx, toolCall('read_file', { path: 'a.txt' }))).toBeUndefined();
  });

  it('PreToolUse chỉnh sửa đối số qua JSON updatedInput', async () => {
    mk({ user: { hooks: hooksOf('PreToolUse', printsJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'echo an toan' } } })) } });
    await ctx.attach(hooksFeature);
    const r = (await run(ctx, toolCall('run_command', { command: 'echo nguy hiem' }))) as { input: Record<string, unknown> };
    expect(r.input).toEqual({ command: 'echo an toan' });
  });

  it('stdin của hook là JSON kiểu Claude Code và môi trường KHÔNG chứa khoá API', async () => {
    const out = path.join(os.tmpdir(), `hook-stdin-${Date.now()}.log`);
    const envOut = path.join(os.tmpdir(), `hook-env-${Date.now()}.log`);
    const cmd = script(
      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},d);fs.writeFileSync(${JSON.stringify(envOut)},JSON.stringify({k:process.env.OPENAI_API_KEY||null,p:process.env.LOCAITH_PROJECT_DIR||null}));process.exit(0);});`,
    );
    process.env.OPENAI_API_KEY = 'sk-bi-mat';
    try {
      mk({ user: { hooks: hooksOf('PreToolUse', cmd) } });
      await ctx.attach(hooksFeature);
      await run(ctx, toolCall('read_file', { path: 'x.ts' }, 'tu1'));
      const stdin = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(stdin.tool_name).toBe('read_file');
      expect(stdin.tool_input).toEqual({ path: 'x.ts' });
      expect(stdin.session_id).toBe(ctx.session().id);
      const env = JSON.parse(fs.readFileSync(envOut, 'utf8'));
      expect(env.k).toBeNull();
      expect(env.p).toBe(ctx.cwd);
    } finally {
      delete process.env.OPENAI_API_KEY;
      fs.rmSync(out, { force: true });
      fs.rmSync(envOut, { force: true });
    }
  });

  it('hook DỰ ÁN chưa duyệt không chạy khi không tương tác; không bị hỏi khi thư mục chưa tin cậy', async () => {
    const marker = path.join(os.tmpdir(), `hook-proj-${Date.now()}.log`);
    const project = { hooks: hooksOf('PreToolUse', recordStdin(marker, 2, '')) };
    // không tương tác → ask trả null → không chạy
    mk({ interactive: false, project });
    await ctx.attach(hooksFeature);
    expect(await run(ctx, toolCall('run_command', { command: 'ls' }))).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(approvalsFile(ctx.home))).toBe(false);
    await ctx.dispose();
    ctx.cleanup();

    // thư mục chưa tin cậy → không hỏi, không chạy
    mk({ trusted: false, project });
    await ctx.attach(hooksFeature);
    expect(await run(ctx, toolCall('run_command', { command: 'ls' }))).toBeUndefined();
    expect(ctx.asks).toHaveLength(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('hook dự án: người dùng duyệt (liệt kê đủ lệnh) → chạy + ghi băm; sửa nội dung → hỏi lại', async () => {
    const cmd1 = exits(2, 'dự án cấm');
    mk({ project: { hooks: hooksOf('PreToolUse', cmd1) } });
    ctx.askAnswers = [true];
    await ctx.attach(hooksFeature);
    const r = (await run(ctx, toolCall('run_command', { command: 'ls' }))) as { block: string };
    expect(r.block).toContain('dự án cấm');
    expect(ctx.asks).toHaveLength(1);
    const ask = ctx.asks[0] as { kind: string; detail?: string };
    expect(ask.kind).toBe('confirm');
    expect(ask.detail).toContain(cmd1); // phải thấy đúng lệnh sẽ chạy
    const saved = JSON.parse(fs.readFileSync(approvalsFile(ctx.home), 'utf8'));
    expect(Object.keys(saved)[0]).toContain('settings.json');
    // lần kế: đã duyệt nên không hỏi lại (nạp lại sau khi hết bộ đệm 1,5 giây)
    const svc = hookServiceOf(ctx)!;
    svc.invalidate();
    await run(ctx, toolCall('run_command', { command: 'ls' }));
    expect(ctx.asks).toHaveLength(1);
    // đổi nội dung hook → băm khác → hỏi lại (người dùng từ chối → không chạy)
    const cmd2 = exits(2, 'bản mới');
    fs.writeFileSync(ctx.settings.file('project'), JSON.stringify({ hooks: hooksOf('PreToolUse', cmd2) }));
    svc.invalidate();
    ctx.askAnswers = [false];
    expect(await run(ctx, toolCall('run_command', { command: 'ls' }))).toBeUndefined();
    expect(ctx.asks).toHaveLength(2);
  });

  it('PostToolUse nối ngữ cảnh vào kết quả; Stop có thể ép làm tiếp', async () => {
    mk({
      user: {
        hooks: {
          ...hooksOf('PostToolUse', printsJson({ additionalContext: 'nhớ chạy test' })),
          ...hooksOf('Stop', exits(2, 'chưa chạy test')),
        },
      },
    });
    await ctx.attach(hooksFeature);
    const active = ctx.begin(ctx.scope());
    const after = await callHook(active, 'toolAfter', noop, toolCall('write_file', { path: 'a' }), fakeToolDef('write_file'), {} as never, { content: 'ok' });
    expect((after.map((r) => r.value).find(Boolean) as { content: string }).content).toContain('nhớ chạy test');
    const fin = await callHook(active, 'finalize', noop, { turn: { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false }, message: { role: 'assistant', content: [] }, text: 'xong', stop: 'end_turn', pendingTodos: [], aborted: false } as never);
    const d = fin.map((r) => r.value).find((v) => v && (v as { action: string }).action !== 'accept') as { action: string; message: string };
    expect(d.action).toBe('continue');
    expect(d.message).toContain('chưa chạy test');
  });

  it('agent con chỉ nhận PreToolUse/PostToolUse, không có Stop; vẫn bị chặn như luồng chính', async () => {
    mk({ user: { hooks: { ...hooksOf('PreToolUse', exits(2, 'không')), ...hooksOf('Stop', exits(2, 'tiếp')) } } });
    await ctx.attach(hooksFeature);
    expect(ctx.extensions[0].opts?.subAgents).toBe(true);
    // phiên khác phiên chính = agent con
    const subSession = { ...ctx.session(), id: 'sa_con' } as never;
    const active = ctx.begin(ctx.scope({ session: subSession }));
    const b = await callHook(active, 'toolBefore', noop, toolCall('run_command', { command: 'x' }), fakeToolDef('run_command'), {} as never);
    expect((b[0].value as { block: string }).block).toContain('không');
    const fin = await callHook(active, 'finalize', noop, { turn: { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false }, message: { role: 'assistant', content: [] }, text: 'xong', stop: 'end_turn', pendingTodos: [], aborted: false } as never);
    expect((fin[0].value as { action: string }).action).toBe('accept');
  });

  it('UserPromptSubmit chặn qua onBeforeSubmit của lõi; SessionStart chạy một lần mỗi phiên', async () => {
    const log = path.join(os.tmpdir(), `hook-ss-${Date.now()}.log`);
    mk({
      user: {
        hooks: {
          ...hooksOf('SessionStart', recordStdin(log, 0)),
          ...hooksOf('UserPromptSubmit', script(`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('tin bị cấm');process.exit(2);});`)),
        },
      },
    });
    await ctx.attach(hooksFeature);
    expect(ctx.beforeSubmit).toHaveLength(1);
    const r = await ctx.beforeSubmit[0]('hello', new AbortController().signal);
    expect(r).toMatchObject({ blocked: true });
    expect((r as { reason: string }).reason).toContain('tin bị cấm');
    await ctx.beforeSubmit[0]('again', new AbortController().signal);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1); // SessionStart một lần
    expect(JSON.parse(lines[0]).source).toBe('startup');
    fs.rmSync(log, { force: true });
  });

  it('khi lõi chưa có onBeforeSubmit: chặn ở beforeModel và buộc dừng', async () => {
    mk({ user: { hooks: hooksOf('UserPromptSubmit', exits(2, 'cấm tin này')) } });
    (ctx as unknown as { onBeforeSubmit: undefined }).onBeforeSubmit = undefined;
    await ctx.attach(hooksFeature);
    const active = ctx.begin(ctx.scope());
    const turn = { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false };
    const bm = await callHook(active, 'beforeModel', noop, turn);
    expect(JSON.stringify(bm)).toContain('cấm tin này');
    const tb = await callHook(active, 'toolBefore', noop, toolCall('run_command', { command: 'x' }), fakeToolDef('run_command'), {} as never);
    expect((tb[0].value as { block: string }).block).toContain('cấm tin này');
    const fin = await callHook(active, 'finalize', noop, { turn, message: { role: 'assistant', content: [] }, text: '', stop: 'end_turn', pendingTodos: [], aborted: false } as never);
    expect((fin[0].value as { action: string }).action).toBe('halt');
  });

  it('PreCompact và SessionEnd chạy; /hooks liệt kê nguồn và kết quả gần nhất', async () => {
    const log = path.join(os.tmpdir(), `hook-pc-${Date.now()}.log`);
    mk({ user: { hooks: { ...hooksOf('PreCompact', recordStdin(log, 0)), ...hooksOf('SessionEnd', recordStdin(log, 0)) } } });
    await ctx.attach(hooksFeature);
    await ctx.beforeCompact[0]('manual', new AbortController().signal);
    const text = await ctx.runSlash('hooks');
    expect(text).toContain('PreCompact');
    expect(text).toContain('SessionEnd');
    // phiên bắt đầu rồi đóng → SessionEnd
    await ctx.beforeSubmit[0]('x', new AbortController().signal);
    await ctx.dispose();
    const ev = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ev.some((e) => e.trigger === 'manual')).toBe(true);
    expect(ev.some((e) => e.reason === 'close')).toBe(true);
    fs.rmSync(log, { force: true });
  });

  it('/hooks open tạo tệp và yêu cầu mở bằng trình soạn thảo', async () => {
    mk();
    await ctx.attach(hooksFeature);
    await ctx.runSlash('hooks', 'open');
    expect(fs.existsSync(ctx.settings.file('project'))).toBe(true);
    expect(ctx.events.find((e) => e.t === 'action')).toMatchObject({ action: 'open_editor', payload: ctx.settings.file('project') });
  });
});
