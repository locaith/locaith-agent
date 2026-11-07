/** (lane:bg-tasks) Báo model khi tác vụ nền kết thúc — logic dùng chung ở src/core/tasks/notifyExtension.ts. */
import type { RunExtension } from '../../core/engine/seams';
import { backgroundNotifyExtension } from '../../core/tasks/notifyExtension';
import type { HostExtensionContext } from '../hostExtensions';

export function backgroundTasksExtension(ctx: HostExtensionContext): RunExtension {
  void ctx;
  return backgroundNotifyExtension();
}
