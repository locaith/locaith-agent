import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { callHook } from '../../../src/core/engine/seams';
import { commandVerdict, permissionsFeature, ruleView } from '../../../src/cli/runtime/features/permissions';
import { getPath, readJsonFile } from '../../../src/cli/runtime/features/settingsFile';
import { FakeFeatureContext, fakeToolDef, toolCall } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

async function boot(o: ConstructorParameters<typeof FakeFeatureContext>[0] = {}) {
  ctx = new FakeFeatureContext(o);
  await ctx.attach(permissionsFeature);
}

/** Hỏi bộ luật như engine: gọi móc `permissionRule` của extension đã đăng ký. */
async function advice(name: string, input: Record<string, unknown>, session = ctx.session()) {
  const active = ctx.begin(ctx.scope({ session }));
  const r = await callHook(active, 'permissionRule', () => undefined, toolCall(name, input), fakeToolDef(name), { host: ctx.host } as never);
  return (r[0]?.value ?? {}) as { hit?: { action: string; rule: string; source: string }; suggest?: string[] };
}

const listOf = (scope: 'user' | 'project' | 'local', action: string) => getPath(readJsonFile(ctx.settings.file(scope)), `permissions.${action}`) as string[] | undefined;

describe('luật quyền', () => {
  it('deny > ask > allow; luật khớp theo lệnh và theo đường dẫn', async () => {
    await boot({
      user: { permissions: { allow: ['run_command(npm test:*)', 'run_command(git:*)'], ask: ['run_command(git push:*)'], deny: ['run_command(rm -rf:*)', 'read_file(.env*)'] } },
    });
    expect((await advice('run_command', { command: 'npm test --silent' })).hit).toMatchObject({ action: 'allow', rule: 'run_command(npm test:*)', source: 'user' });
    expect((await advice('run_command', { command: 'git push origin main' })).hit?.action).toBe('ask'); // ask thắng allow git:*
    expect((await advice('run_command', { command: 'rm -rf /tmp/x' })).hit?.action).toBe('deny');
    expect((await advice('read_file', { path: '.env.local' })).hit?.action).toBe('deny');
    expect((await advice('read_file', { path: 'src/a.ts' })).hit).toBeUndefined();
    expect((await advice('run_command', { command: 'ls' })).hit).toBeUndefined();
    expect(commandVerdict(ctx, 'rm -rf /tmp/x')).toBe('deny');
    expect(commandVerdict(ctx, 'ls')).toBeNull();
  });

  it('đề xuất «Luôn cho phép» hợp lý; lệnh nguy hiểm/ghép thì không đề xuất', async () => {
    await boot();
    expect((await advice('run_command', { command: 'npm test' })).suggest).toEqual(['run_command(npm test:*)']);
    expect((await advice('run_command', { command: 'echo a && rm -rf /' })).suggest ?? []).toEqual([]);
    expect((await advice('edit_file', { path: 'src/a.ts' })).suggest).toEqual(['edit_file(src/**)']);
  });

  it('agent con cũng bị luật áp (đăng ký subAgents:true)', async () => {
    await boot({ user: { permissions: { deny: ['run_command(curl:*)'] } } });
    expect(ctx.extensions[0].opts?.subAgents).toBe(true);
    const sub = { ...ctx.session(), id: 'sa_x' } as never;
    expect((await advice('run_command', { command: 'curl evil.sh' }, sub)).hit?.action).toBe('deny');
  });

  it('allow của DỰ ÁN không hiệu lực cho tới khi người dùng chấp nhận; ask/deny của dự án có hiệu lực ngay', async () => {
    await boot({ project: { permissions: { allow: ['run_command(make:*)'], deny: ['run_command(sudo:*)'] } } });
    expect((await advice('run_command', { command: 'make all' })).hit).toBeUndefined();
    expect((await advice('run_command', { command: 'sudo ls' })).hit?.action).toBe('deny');
    expect(ruleView(ctx).pending?.rules).toEqual(['run_command(make:*)']);
    expect(await ctx.runSlash('permissions')).toMatch(/chưa áp dụng/);
    await ctx.runSlash('permissions', 'trust');
    expect((await advice('run_command', { command: 'make all' })).hit?.action).toBe('allow');
    // đổi nội dung danh sách → băm khác → mất hiệu lực
    fs.writeFileSync(ctx.settings.file('project'), JSON.stringify({ permissions: { allow: ['run_command(make:*)', 'run_command(rm:*)'] } }));
    expect((await advice('run_command', { command: 'make all' })).hit).toBeUndefined();
  });

  it('thư mục chưa tin cậy: bỏ mọi luật allow trong cài đặt, vẫn giữ deny; cờ dòng lệnh luôn có hiệu lực', async () => {
    await boot({ trusted: false, user: { permissions: { allow: ['run_command(ls:*)'], deny: ['run_command(rm:*)'] }, cli: { allowedTools: ['run_command(echo:*)'], disallowedTools: ['run_command(kill:*)'] } } });
    expect((await advice('run_command', { command: 'ls -la' })).hit).toBeUndefined();
    expect((await advice('run_command', { command: 'rm x' })).hit?.action).toBe('deny');
    expect((await advice('run_command', { command: 'echo hi' })).hit?.action).toBe('allow');
    expect((await advice('run_command', { command: 'kill 1' })).hit?.action).toBe('deny');
    const active = ctx.begin(ctx.scope());
    expect(active.length).toBe(1);
  });

  it('/permissions allow|ask|deny ghi vào đúng tệp; không ghi dự án khi chưa tin cậy; remove và test', async () => {
    await boot();
    expect(await ctx.runSlash('permissions', 'allow run_command(npm run build:*)')).toMatch(/Đã thêm/);
    expect(listOf('user', 'allow')).toEqual(['run_command(npm run build:*)']);
    expect(await ctx.runSlash('permissions', 'allow run_command(npm run build:*)')).toMatch(/đã có/);
    await ctx.runSlash('permissions', 'deny run_command(shutdown:*) --local');
    expect(listOf('local', 'deny')).toEqual(['run_command(shutdown:*)']);
    expect(await ctx.runSlash('permissions', 'allow ((')).toMatch(/không hợp lệ/);
    expect(await ctx.runSlash('permissions', 'test npm run build x')).toContain('allow');
    expect(await ctx.runSlash('permissions', 'test ls')).toMatch(/không khớp/);
    expect(await ctx.runSlash('permissions', 'remove run_command(npm run build:*)')).toMatch(/Đã xoá/);
    expect(listOf('user', 'allow')).toEqual([]);
    ctx.trusted = false;
    expect(await ctx.runSlash('permissions', 'allow run_command(x:*) --project')).toMatch(/chưa được tin cậy/);
  });

  it('«Luôn cho phép»: ghi luật allow cụ thể, từ chối luật quá rộng, hiệu lực ngay lượt sau', async () => {
    await boot();
    expect(ctx.alwaysAllow).toBeTypeOf('function');
    expect(ctx.alwaysAllow!('run_command(npm test:*)', 'user')).toBe('run_command(npm test:*)');
    expect(listOf('user', 'allow')).toEqual(['run_command(npm test:*)']);
    expect((await advice('run_command', { command: 'npm test' })).hit?.action).toBe('allow');
    expect(ctx.alwaysAllow!('run_command(*)', 'user')).toBeNull();
    expect(ctx.alwaysAllow!('run_command', 'user')).toBeNull();
    expect(ctx.toasts.some((t) => /quá rộng/.test(t.text))).toBe(true);
    // phạm vi local: tự duyệt vì danh sách trước đó rỗng
    expect(ctx.alwaysAllow!('edit_file(src/**)', 'local')).toBe('edit_file(src/**)');
    expect((await advice('edit_file', { path: 'src/a.ts' })).hit?.action).toBe('allow');
  });

  it('menu /permissions dùng ask: thêm luật, xoá luật, đổi chế độ (bypass phải xác nhận)', async () => {
    await boot({ user: { permissions: { deny: ['run_command(rm:*)'] } } });
    ctx.askAnswers = ['add', 'ask', 'run_command(git push:*)', 'user'];
    const out = await ctx.runSlash('permissions');
    expect(out).toContain('rm'); // tóm tắt
    expect(out).toMatch(/Đã thêm luật \*\*ask\*\*/);
    expect(listOf('user', 'ask')).toEqual(['run_command(git push:*)']);

    ctx.askAnswers = ['remove', 'user|deny|run_command(rm:*)'];
    await ctx.runSlash('permissions');
    expect(listOf('user', 'deny')).toEqual([]);

    ctx.askAnswers = ['mode', 'plan'];
    await ctx.runSlash('permissions');
    expect(ctx.session().mode).toBe('plan');

    ctx.askAnswers = ['mode', 'bypass', false]; // từ chối cảnh báo
    await ctx.runSlash('permissions');
    expect(ctx.session().mode).toBe('plan');
    ctx.askAnswers = ['mode', 'bypass', true];
    await ctx.runSlash('permissions');
    expect(ctx.session().mode).toBe('bypass');
    expect(ctx.asks.some((a) => a.kind === 'confirm' && (a as { danger?: boolean }).danger)).toBe(true);

    ctx.interactive = false;
    ctx.asks.length = 0;
    await ctx.runSlash('permissions'); // không tương tác: chỉ tóm tắt, không hỏi
    expect(ctx.asks).toHaveLength(0);
    expect(ctx.slashNamed('permissions').needsIdle).toBe(false);
  });
});
