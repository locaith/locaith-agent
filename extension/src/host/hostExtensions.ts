/**
 * Đăng ký các RunExtension CHỈ chạy trong VS Code (cần cấu hình người dùng, workspace trust, tiến trình nền, chẩn đoán IDE…).
 * Những extension dùng chung mọi bề mặt nằm ở `src/core/engine/extensions/index.ts`.
 *
 * Quy ước (xem ghi chú ở tệp kia): mỗi tính năng có sẵn một dòng riêng bên dưới (đang là chú thích); bỏ dấu `//` ở dòng của
 * mình và thêm một dòng import. Đừng sửa dòng của người khác.
 */

import type { RunExtension } from '../core/engine/seams';
import type { ToolRegistry } from '../core/engine/toolRegistry';
import type { SessionState } from '../core/engine/types';
import type { VsCodeToolHost } from './vscodeHost';
import type { ControllerDeps } from './chatController';
// ── import của từng tính năng (mỗi lane một dòng, bỏ dấu // khi dùng) ──
// import { verifierExtension } from './extensions/verifier'; // (lane:blind-verifier)
// import { hooksExtension } from './extensions/hooks'; // (lane:hooks)
import { backgroundTasksExtension } from './extensions/backgroundTasks'; // (lane:bg-tasks)
// import { ideDiagnosticsExtension } from './extensions/ideDiagnostics'; // (lane:ide-context)
// import { instructionsExtension } from './extensions/instructions'; // (lane:instructions-memory)
// import { permissionRulesExtension } from './extensions/permissionRules'; // (lane:perm-rules)
// import { checkpointsExtension } from './extensions/checkpoints'; // (lane:checkpoints-rewind)

/** Mọi thứ một extension phía host có thể cần. Cần thêm gì thì lấy từ `deps` (ControllerDeps) — đừng sửa interface này. */
export interface HostExtensionContext {
  deps: ControllerDeps;
  host: VsCodeToolHost;
  registry: ToolRegistry;
  /** Phiên đang chạy (thay đổi khi chuyển cuộc trò chuyện) — luôn gọi hàm, đừng giữ lại giá trị. */
  session(): SessionState;
}

export function hostRunExtensions(ctx: HostExtensionContext): RunExtension[] {
  void ctx;
  return [
    // permissionRulesExtension(ctx), // (lane:perm-rules)
    // hooksExtension(ctx), // (lane:hooks)
    // ideDiagnosticsExtension(ctx), // (lane:ide-context)
    // instructionsExtension(ctx), // (lane:instructions-memory)
    // checkpointsExtension(ctx), // (lane:checkpoints-rewind)
    backgroundTasksExtension(ctx), // (lane:bg-tasks)
    // verifierExtension(ctx), // (lane:blind-verifier)  — luôn ĐỨNG CUỐI: kiểm tra sau khi mọi cổng khác đã chấp nhận
  ];
}
