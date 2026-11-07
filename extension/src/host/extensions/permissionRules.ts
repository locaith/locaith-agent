/**
 * (lane:perm-rules) Đăng ký luật quyền bền cho engine của bản VS Code: nguồn luật = PermissionRulesService (cài đặt người dùng/workspace + Workspace Trust),
 * chuẩn hoá đường dẫn thật qua resolveUserPathReal (symlink, tên ngắn, hoa/thường).
 */

import { permissionRulesExtension as coreExtension } from '../../core/engine/extensions/permissionRules';
import type { RunExtension } from '../../core/engine/seams';
import { resolveUserPathReal } from '../../core/fsutil/paths';
import type { HostExtensionContext } from '../hostExtensions';
import { PermissionRulesService } from '../permissionRulesService';

export function permissionRulesExtension(ctx: HostExtensionContext): RunExtension {
  const svc = PermissionRulesService.for(ctx.deps.config);
  return coreExtension({
    source: () => svc.snapshot(),
    resolvePath: async (host, raw) => {
      const r = await resolveUserPathReal(host, raw);
      return { rel: r.rel, abs: r.abs, inWorkspace: r.zone === 'workspace' && !r.suspicious };
    },
  });
}
