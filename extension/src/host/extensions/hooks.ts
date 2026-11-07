/**
 * Hook của người dùng (lane:hooks) như một RunExtension phía VS Code. Toàn bộ logic ở `src/core/hooks/*`;
 * ở đây chỉ nối dịch vụ hook của controller hiện tại vào vòng lặp agent.
 */

import { hooksRunExtension } from '../../core/hooks/runExtension';
import type { HookService } from '../../core/hooks/service';
import type { RunExtension } from '../../core/engine/seams';
import { hookServiceFor } from '../hooks/hostHooks';
import type { HostExtensionContext } from '../hostExtensions';

/** Phiên bản cho agent con (`agent`, `workflow_run`): chỉ PreToolUse/PostToolUse, không đụng liên kết hiển thị của luồng chính. */
export function hooksSubAgentExtension(getService: () => HookService): RunExtension {
  return hooksRunExtension(getService, { subAgent: true });
}

export function hooksExtension(ctx: HostExtensionContext): RunExtension {
  return hooksRunExtension(() => hookServiceFor(ctx));
}
