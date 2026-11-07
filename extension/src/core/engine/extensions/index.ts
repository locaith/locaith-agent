/**
 * Đăng ký các RunExtension DÙNG CHUNG mọi bề mặt (VS Code, Chrome, CLI, agent con): không phụ thuộc `vscode`.
 *
 * Quy ước thêm tính năng (để nhiều người sửa song song mà git gộp không xung đột):
 *   • viết extension trong tệp riêng ở thư mục này;
 *   • mỗi tính năng đã có SẴN MỘT DÒNG DÀNH RIÊNG bên dưới (đang là chú thích) — bỏ dấu `//` ở dòng của mình
 *     và thêm đúng một dòng import ở khối import của mình. Đừng đụng dòng của người khác.
 * Tính năng chỉ chạy trong VS Code (cần cấu hình, workspace trust, host…) đăng ký ở `src/host/hostExtensions.ts`.
 */

import type { RunExtension } from '../seams';
import { completionGateExtension } from './gate';
// ── import của từng tính năng (mỗi lane một dòng, bỏ dấu // khi dùng) ──
import { loopGuardsExtension } from './loopGuards'; // (lane:loop-guards)

/** Thứ tự = thứ tự gọi móc; `finalize`: extension đầu tiên không 'accept' thắng. */
export function coreRunExtensions(): RunExtension[] {
  return [
    completionGateExtension(),
    loopGuardsExtension(), // (lane:loop-guards)
  ];
}
