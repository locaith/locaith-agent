import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionDecision } from '../src/core/engine/types';
import { ConfigService } from '../src/host/config';
import { PERM_KEYS, TRUSTED_KEY } from '../src/host/permissionRulesService';
import { attachPermissionsFeature } from '../src/host/permissionsFeature';
import { SlashRegistry, type SlashContext } from '../src/host/slashRegistry';
import type { ViewState, WebviewMessage } from '../src/shared/protocol';
import { hashRules } from '../src/shared/permissionRules';
import { settingsStub, workspace } from './helpers/vscode-stub';

function setup() {
  settingsStub.reset();
  workspace.isTrusted = true;
  const slash = new SlashRegistry();
  const patches: Partial<ViewState>[] = [];
  const notices: { level: string; text: string }[] = [];
  const resolved: { id: string; d: PermissionDecision }[] = [];
  const screens: string[] = [];
  const feature = attachPermissionsFeature(slash, {
    config: new ConfigService(),
    lang: () => 'vi',
    patch: (p) => patches.push(p),
    notice: (level, text) => notices.push({ level, text }),
    resolvePermission: (id, d) => {
      resolved.push({ id, d });
      return true;
    },
    showScreen: async (s) => void screens.push(s),
  });
  const run = async (args: string) => {
    const infos: string[] = [];
    const ctx: SlashContext = { args, lang: 'vi', info: (t) => infos.push(t), warn: (t) => infos.push('WARN:' + t), runPrompt: async () => {}, busy: false };
    await slash.get('permissions')!.run(ctx);
    return infos;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { slash, feature, patches, notices, resolved, screens, run, tick, send: (m: WebviewMessage) => feature.handle(m) };
}

describe('/permissions và tin nhắn luật quyền (host)', () => {
  beforeEach(() => settingsStub.reset());

  it('đăng ký lệnh /permissions chạy được cả khi đang bận; không đối số → mở Cài đặt + tóm tắt', async () => {
    const s = setup();
    const def = s.slash.get('permissions')!;
    expect(def.needsIdle).toBe(false);
    settingsStub.global[PERM_KEYS.deny] = ['read_file(.env*)'];
    const out = await s.run('');
    expect(s.screens).toEqual(['settings']);
    expect(out[0]).toContain('read_file(.env*)');
    expect(s.feature.view().focus).toBe(true);
    s.send({ type: 'perm_rules_open' });
    expect(s.feature.view().focus).toBeUndefined();
  });

  it('/permissions allow|ask|deny <luật> ghi vào cài đặt NGƯỜI DÙNG; remove xoá; test khớp lệnh', async () => {
    const s = setup();
    await s.run('allow run_command(npm test:*)');
    await s.run('deny run_command(rm -rf*)');
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual(['run_command(npm test:*)']);
    expect(settingsStub.global[PERM_KEYS.deny]).toEqual(['run_command(rm -rf*)']);
    expect(settingsStub.workspace[PERM_KEYS.allow]).toBeUndefined();
    expect((await s.run('test npm test -- --ci'))[0]).toContain('**allow**');
    expect((await s.run('test npm test && rm -rf /'))[0]).toContain('**deny**');
    expect((await s.run('test git log'))[0]).toContain('không khớp');
    await s.run('remove run_command(npm test:*)');
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual([]);
    expect((await s.run('allow bad('))[0] ?? '').not.toContain('Đã thêm');
    expect(s.notices.some((n) => n.level === 'warn' && n.text.includes('không hợp lệ'))).toBe(true);
  });

  it('/permissions trust chấp nhận đúng danh sách allow của workspace', async () => {
    const s = setup();
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(npm run build:*)'];
    expect((await s.run(''))[0]).toContain('/permissions trust');
    await s.run('trust');
    expect(settingsStub.global[TRUSTED_KEY]).toEqual([hashRules(['run_command(npm run build:*)'])]);
    expect(s.feature.view().rules).toEqual([{ action: 'allow', text: 'run_command(npm run build:*)', source: 'workspace' }]);
  });

  it('permission_always: lưu luật (đã sửa) vào phạm vi chọn rồi cho lệnh đang chờ chạy; vá ViewState', async () => {
    const s = setup();
    expect(s.send({ type: 'permission_always', id: 'perm_1', rule: 'run_command(npm run lint:*)', scope: 'user' })).toBe(true);
    await s.tick();
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual(['run_command(npm run lint:*)']);
    expect(s.resolved).toEqual([{ id: 'perm_1', d: { decision: 'allow' } }]);
    expect(s.patches.some((p) => p.permissions?.rules.some((r) => r.text === 'run_command(npm run lint:*)'))).toBe(true);
    s.send({ type: 'permission_always', id: 'perm_2', rule: 'edit_file(src/**)', scope: 'workspace' });
    await s.tick();
    expect(settingsStub.workspace[PERM_KEYS.allow]).toEqual(['edit_file(src/**)']);
    expect(s.resolved).toHaveLength(2);
  });

  it('permission_always từ chối luật quá rộng / hỏng — không lưu, KHÔNG cho lệnh chạy', async () => {
    const s = setup();
    for (const rule of ['run_command', 'run_command(*)', 'run_command(**)', 'edit_file(**)', 'bad(', '']) {
      s.send({ type: 'permission_always', id: 'p', rule, scope: 'user' });
    }
    await s.tick();
    expect(settingsStub.global[PERM_KEYS.allow]).toBeUndefined();
    expect(s.resolved).toEqual([]);
    expect(s.notices.filter((n) => n.level === 'warn')).toHaveLength(6);
    // tên MCP trần thì được (đó là đặc tả đề xuất cho công cụ MCP)
    s.send({ type: 'permission_always', id: 'p2', rule: 'mcp__github__list_issues', scope: 'user' });
    await s.tick();
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual(['mcp__github__list_issues']);
    expect(s.resolved).toHaveLength(1);
  });

  it('workspace chưa tin cậy: không ghi luật vào .vscode/settings.json', async () => {
    const s = setup();
    workspace.isTrusted = false;
    s.send({ type: 'permission_always', id: 'p', rule: 'run_command(npm test:*)', scope: 'workspace' });
    await s.tick();
    expect(settingsStub.workspace[PERM_KEYS.allow]).toBeUndefined();
    expect(s.resolved).toEqual([]);
    workspace.isTrusted = true;
  });

  it('perm_rules_add / perm_rules_remove / perm_rules_trust_workspace; tin lạ trả false', async () => {
    const s = setup();
    expect(s.send({ type: 'perm_rules_add', action: 'deny', rule: 'read_file(.env*)', scope: 'workspace' })).toBe(true);
    await s.tick();
    expect(settingsStub.workspace[PERM_KEYS.deny]).toEqual(['read_file(.env*)']);
    s.send({ type: 'perm_rules_remove', action: 'deny', rule: 'read_file(.env*)', scope: 'workspace' });
    await s.tick();
    expect(settingsStub.workspace[PERM_KEYS.deny]).toEqual([]);
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(x)'];
    s.send({ type: 'perm_rules_trust_workspace', hash: 'nope' });
    await s.tick();
    expect(settingsStub.global[TRUSTED_KEY]).toBeUndefined();
    s.send({ type: 'perm_rules_trust_workspace', hash: hashRules(['run_command(x)']) });
    await s.tick();
    expect(settingsStub.global[TRUSTED_KEY]).toHaveLength(1);
    expect(s.send({ type: 'stop' })).toBe(false);
    expect(s.send({ type: 'perm_rules_add', action: 'evil' as never, rule: 'x', scope: 'user' })).toBe(true);
    await s.tick();
    expect(settingsStub.global[PERM_KEYS.allow]).toBeUndefined();
  });
});
