/**
 * Hook của người dùng (lane:hooks) như một RunExtension phía VS Code. Toàn bộ logic ở `src/core/hooks/*`;
 * ở đây chỉ nối dịch vụ hook của controller hiện tại vào vòng lặp agent.
 */

import { hooksRunExtension } from '../../core/hooks/runExtension';
import type { RunExtension } from '../../core/engine/seams';
import { hookServiceFor } from '../hooks/hostHooks';
import type { HostExtensionContext } from '../hostExtensions';

export function hooksExtension(ctx: HostExtensionContext): RunExtension {
  return hooksRunExtension(() => hookServiceFor(ctx));
}
