import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../src/host/config';
import { PermissionRulesService, PERM_KEYS, TRUSTED_KEY } from '../src/host/permissionRulesService';
import { hashRules } from '../src/shared/permissionRules';
import { settingsStub, workspace } from './helpers/vscode-stub';

const texts = (s: PermissionRulesService, action: 'allow' | 'ask' | 'deny') =>
  s
    .snapshot()
    .rules.filter((r) => r.action === action)
    .map((r) => `${r.source}:${r.text}`);

describe('PermissionRulesService — nguồn luật theo cấp cài đặt và Workspace Trust', () => {
  let svc: PermissionRulesService;
  beforeEach(() => {
    settingsStub.reset();
    workspace.isTrusted = true;
    svc = new PermissionRulesService(new ConfigService());
  });

  it('deny/ask nhận từ cả người dùng và workspace; allow chỉ từ người dùng', () => {
    settingsStub.global[PERM_KEYS.allow] = ['run_command(npm test:*)'];
    settingsStub.global[PERM_KEYS.deny] = ['read_file(.env*)'];
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(rm -rf*)'];
    settingsStub.workspace[PERM_KEYS.ask] = ['write_file(docs/**)'];
    settingsStub.workspace[PERM_KEYS.deny] = ['run_command(git push*)'];
    expect(texts(svc, 'allow')).toEqual(['user:run_command(npm test:*)']);
    expect(texts(svc, 'ask')).toEqual(['workspace:write_file(docs/**)']);
    expect(texts(svc, 'deny')).toEqual(['user:read_file(.env*)', 'workspace:run_command(git push*)']);
    expect(svc.snapshot().workspaceAllowPending).toBe(1);
    expect(svc.view().workspaceAllowPending).toEqual({ hash: hashRules(['run_command(rm -rf*)']), rules: ['run_command(rm -rf*)'] });
  });

  it('luật allow của workspace có hiệu lực sau khi xác nhận ĐÚNG băm; đổi danh sách thì phải xác nhận lại', async () => {
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(npm run build:*)'];
    expect(await svc.trustWorkspaceAllow('deadbeef')).toBe(false);
    expect(texts(svc, 'allow')).toEqual([]);
    const hash = svc.view().workspaceAllowPending!.hash;
    expect(await svc.trustWorkspaceAllow(hash)).toBe(true);
    expect(settingsStub.global[TRUSTED_KEY]).toEqual([hash]);
    expect(texts(svc, 'allow')).toEqual(['workspace:run_command(npm run build:*)']);
    expect(svc.snapshot().workspaceAllowPending).toBeUndefined();
    // workspace lén thêm luật → băm khác → không còn hiệu lực cho tới khi xác nhận lại
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(npm run build:*)', 'run_command(curl*)'];
    expect(texts(svc, 'allow')).toEqual([]);
    expect(svc.snapshot().workspaceAllowPending).toBe(2);
  });

  it('workspace chưa tin cậy: bỏ qua MỌI luật allow (kể cả người dùng), deny/ask vẫn còn', () => {
    workspace.isTrusted = false;
    settingsStub.global[PERM_KEYS.allow] = ['run_command(npm test:*)'];
    settingsStub.global[PERM_KEYS.deny] = ['read_file(.env*)'];
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(x)'];
    settingsStub.global[TRUSTED_KEY] = [hashRules(['run_command(x)'])];
    const snap = svc.snapshot();
    expect(snap.untrusted).toBe(true);
    expect(snap.rules.map((r) => r.action)).toEqual(['deny']);
    expect(snap.workspaceAllowPending).toBeUndefined();
    expect(svc.view().untrusted).toBe(true);
  });

  it('add/remove ghi vào ĐÚNG phạm vi và chuẩn hoá chữ luật; luật hỏng bị từ chối', async () => {
    expect(await svc.add('allow', ' run_command( npm test:* ) ', 'user')).toBe('run_command(npm test:*)');
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual(['run_command(npm test:*)']);
    expect(settingsStub.workspace[PERM_KEYS.allow]).toBeUndefined();
    expect(await svc.add('allow', 'run_command(npm test:*)', 'user')).toBe('run_command(npm test:*)'); // không nhân đôi
    expect(settingsStub.global[PERM_KEYS.allow]).toHaveLength(1);
    expect(await svc.add('deny', 'read_file(.env*)', 'workspace')).toBe('read_file(.env*)');
    expect(settingsStub.workspace[PERM_KEYS.deny]).toEqual(['read_file(.env*)']);
    expect(await svc.add('allow', 'bad(', 'user')).toBeNull();
    expect(await svc.add('allow', 'edit_file(../x)', 'user')).toBeNull();
    expect(await svc.remove('allow', 'run_command(npm test:*)', 'user')).toBe(true);
    expect(settingsStub.global[PERM_KEYS.allow]).toEqual([]);
    expect(await svc.remove('allow', 'run_command(npm test:*)', 'user')).toBe(false);
  });

  it('allow ghi vào workspace theo yêu cầu người dùng thì tự xác nhận băm mới', async () => {
    expect(await svc.add('allow', 'run_command(npm test:*)', 'workspace')).toBe('run_command(npm test:*)');
    expect(settingsStub.workspace[PERM_KEYS.allow]).toEqual(['run_command(npm test:*)']);
    expect(texts(svc, 'allow')).toEqual(['workspace:run_command(npm test:*)']);
    expect(svc.snapshot().workspaceAllowPending).toBeUndefined();
  });

  it('bỏ mục không phải chuỗi / không hợp lệ trong cài đặt, báo thay đổi cho người nghe', async () => {
    settingsStub.global[PERM_KEYS.deny] = ['read_file(.env*)', 42, 'bad(', null];
    expect(texts(svc, 'deny')).toEqual(['user:read_file(.env*)']);
    let n = 0;
    svc.onChange(() => n++);
    await svc.add('ask', 'run_command(git push*)', 'user');
    svc.setFocus(true);
    svc.setFocus(true);
    expect(n).toBe(2);
    expect(svc.view().focus).toBe(true);
  });

  it('ConfigService.get bỏ qua giá trị workspace của permissions.allow (SECURE_KEYS)', () => {
    settingsStub.workspace[PERM_KEYS.allow] = ['run_command(x)'];
    expect(new ConfigService().get<string[]>(PERM_KEYS.allow, [])).toEqual([]);
    settingsStub.workspace[PERM_KEYS.deny] = ['run_command(y)'];
    expect(new ConfigService().get<string[]>(PERM_KEYS.deny, [])).toEqual(['run_command(y)']);
  });
});
