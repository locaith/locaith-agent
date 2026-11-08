import { afterEach, describe, expect, it } from 'vitest';
import { callHook } from '../../../src/core/engine/seams';
import { DEFAULT_ENGINE_SETTINGS } from '../../../src/core/engine/types';
import { hooksFeature } from '../../../src/cli/runtime/features/hooks';
import { permissionsFeature } from '../../../src/cli/runtime/features/permissions';
import { verifyFeature, verifyStateOf } from '../../../src/cli/runtime/features/verify';
import { FakeProvider, textTurn, toolTurn, type Step } from '../../helpers/fakeProvider';
import { FakeFeatureContext } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

const turn = { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false };
const fin = (text = 'đã làm X') => ({ turn, message: { role: 'assistant', content: [] }, text, stop: 'end_turn', pendingTodos: [], aborted: false }) as never;
const verdict = (v: 'pass' | 'fail', extra: Record<string, unknown> = {}): Step => () => toolTurn([{ name: 'submit_verdict', input: { verdict: v, ...extra } }]);

async function boot(script: Step[], user: Record<string, unknown> = { agent: { verify: 'always' } }) {
  ctx = new FakeFeatureContext({ user });
  await ctx.attach(permissionsFeature);
  await ctx.attach(verifyFeature);
  const provider = new FakeProvider(script);
  ctx.session().messages.push({ role: 'user', content: [{ type: 'text', text: 'làm X' }] } as never);
  const scope = ctx.scope({ provider, settings: { ...DEFAULT_ENGINE_SETTINGS } as never });
  return { provider, scope };
}

describe('kiểm chứng độc lập', () => {
  it('đăng ký CUỐI (last:true) và đứng sau các extension khác', async () => {
    ctx = new FakeFeatureContext();
    await ctx.attach(verifyFeature);
    await ctx.attach(permissionsFeature);
    expect(ctx.extensions.find((e) => e.ext.id === 'verifier')?.opts?.last).toBe(true);
    const order = [...ctx.extensions.filter((e) => !e.opts?.last), ...ctx.extensions.filter((e) => e.opts?.last)].map((e) => e.ext.id);
    expect(order[order.length - 1]).toBe('verifier');
  });

  it('agent.verify=always: reviewer chạy qua provider kịch bản; fail → ép model chính làm tiếp với phản hồi đánh số', async () => {
    const { provider, scope } = await boot([verdict('fail', { missing: ['thiếu bước Y'] }), () => textTurn('.')]);
    const active = ctx.begin(scope);
    const res = await callHook(active, 'finalize', () => undefined, fin());
    const d = res.map((r) => r.value).find((v) => (v as { action: string }).action !== 'accept') as { action: string; message: string };
    expect(d.action).toBe('continue');
    expect(d.message).toContain('thiếu bước Y');
    // reviewer nhận yêu cầu gốc + câu trả lời cuối, có công cụ submit_verdict, và là agent riêng (không có agent/workflow_run)
    const sent = JSON.stringify(provider.requests[0].messages);
    expect(sent).toContain('làm X');
    expect(sent).toContain('đã làm X');
    const tools = provider.requests[0].tools.map((t) => t.name);
    expect(tools).toContain('submit_verdict');
    expect(tools).not.toContain('agent');
    expect(ctx.session().usageTotals.input).toBeGreaterThan(0); // chi phí token của kiểm tra tính vào phiên
    const notices = scope.ui.filter((e) => e.t === 'notice' && (e as { verify?: unknown }).verify) as { verify: { state: string } }[];
    expect(notices.map((n) => n.verify.state)).toEqual(['running', 'fail']);
  });

  it('pass → chấp nhận; agent.verify=off → không gọi provider; auto + hỏi-đáp thuần → không kích hoạt', async () => {
    let r = await boot([verdict('pass'), () => textTurn('.')]);
    let res = await callHook(ctx.begin(r.scope), 'finalize', () => undefined, fin());
    expect((res[0].value as { action: string }).action).toBe('accept');
    expect(r.provider.requests).toHaveLength(2);
    await ctx.dispose();
    ctx.cleanup();

    r = await boot([], { agent: { verify: 'off' } });
    res = await callHook(ctx.begin(r.scope), 'finalize', () => undefined, fin());
    expect((res[0].value as { action: string }).action).toBe('accept');
    expect(r.provider.requests).toHaveLength(0);
    await ctx.dispose();
    ctx.cleanup();

    r = await boot([], { agent: { verify: 'auto' } });
    res = await callHook(ctx.begin(r.scope), 'finalize', () => undefined, fin());
    expect((res[0].value as { action: string }).action).toBe('accept');
    expect(r.provider.requests).toHaveLength(0);
  });

  it('/verify: chưa có lần chạy → báo; off → báo tắt; có gói dữ liệu → chạy reviewer, phát sự kiện ui, không buộc model làm tiếp', async () => {
    const r = await boot([verdict('fail', { missing: ['thiếu X'] }), () => textTurn('.')], { agent: { verify: 'auto' } });
    expect(await ctx.runSlash('verify')).toMatch(/Chưa có lần chạy nào/);
    // lần chạy hỏi-đáp thuần: auto không kích hoạt nhưng gói dữ liệu vẫn được lưu
    const active = ctx.begin(r.scope);
    const d = await callHook(active, 'finalize', () => undefined, fin());
    expect((d[0].value as { action: string }).action).toBe('accept');
    expect(verifyStateOf(ctx)!.last?.sessionId).toBe(ctx.session().id);

    await ctx.runSlash('verify');
    const uiEvents = ctx.events.filter((e) => e.t === 'ui').map((e) => (e as { ev: { t: string; verify?: { state: string; missing?: string[] } } }).ev);
    expect(uiEvents[0].t).toBe('assistant_start');
    const notices = uiEvents.filter((e) => e.verify);
    expect(notices.map((n) => n.verify!.state)).toEqual(['running', 'fail']);
    expect(notices[1].verify!.missing).toEqual(['thiếu X']);
    expect(uiEvents.at(-1)).toMatchObject({ t: 'assistant_end', stopReason: 'end_turn' });
    expect(r.provider.requests[0].tools.map((t) => t.name)).toContain('submit_verdict');
    expect(ctx.slashNamed('verify').needsIdle).toBe(true);

    ctx.settings.set('agent.verify', 'off', 'user');
    expect(await ctx.runSlash('verify')).toMatch(/TẮT/);
  });

  it('/verify: gói dữ liệu của phiên khác thì không dùng; lần chạy bị dừng giữa chừng được nói rõ', async () => {
    const r = await boot([verdict('pass'), () => textTurn('.')], { agent: { verify: 'always' } });
    const active = ctx.begin(r.scope);
    await callHook(active, 'end', () => undefined, { stopReason: 'aborted', turns: 1 });
    ctx.setSession({ ...ctx.session(), id: 'phien_khac' });
    expect(await ctx.runSlash('verify')).toMatch(/Chưa có lần chạy nào/);
    ctx.setSession(verifyStateOf(ctx) ? { ...ctx.session(), id: verifyStateOf(ctx)!.last!.sessionId } : ctx.session());
    const out = await ctx.runSlash('verify');
    expect(out).toMatch(/dừng giữa chừng/);
  });

  it('luật deny áp cho reviewer: đọc tệp bị cấm thất bại bên trong agent kiểm tra', async () => {
    const { provider, scope } = await boot(
      [() => toolTurn([{ name: 'read_file', input: { path: 'notes.txt' } }]), verdict('pass'), () => textTurn('.')],
      { agent: { verify: 'always' }, permissions: { deny: ['read_file(notes.txt)'] } },
    );
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    fsx.writeFileSync(pathx.join(ctx.cwd, 'notes.txt'), 'SECRET=hunter2');
    await callHook(ctx.begin(scope), 'finalize', () => undefined, fin());
    const second = JSON.stringify(provider.requests[1].messages);
    expect(second).not.toContain('hunter2');
  });

  it('không có provider của lần chạy và lõi không cấp dịch vụ → /verify báo rõ thay vì sập', async () => {
    ctx = new FakeFeatureContext({ user: { agent: { verify: 'always' } } });
    await ctx.attach(verifyFeature);
    expect(await ctx.runSlash('verify')).toMatch(/Chưa có lần chạy nào/);
  });

  it('hooks + verify cùng đăng ký không đụng nhau', async () => {
    ctx = new FakeFeatureContext({ user: { agent: { verify: 'always' } } });
    await ctx.attach(hooksFeature);
    await ctx.attach(verifyFeature);
    expect(ctx.extensions.map((e) => e.ext.id)).toEqual(['hooks', 'verifier']);
  });
});
