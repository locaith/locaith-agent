/**
 * Cổng kiểm LỆNH TỪ XA cho CLI — nơi quyết định tin `send` từ trình duyệt được phép làm gì.
 *
 * Vì sao cần riêng cho CLI: extension chuyển tin `send` từ xa vào khung chat (nơi `!lệnh` không có nghĩa), còn `Runtime.submit()` của CLI hiểu
 *   • `!lệnh`  → CHẠY SHELL NGAY, KHÔNG qua hệ thống quyền (đó là ý nghĩa của «chế độ shell» trong terminal: người đang ngồi gõ);
 *   • `/lệnh`  → lệnh gạch chéo, nhiều lệnh MỞ HỘP HỎI (`/resume`, `/model`, `/mode`, `/rewind`, `/login`, `/init` khi đã có LOCAITH.md…) mà trên máy không ai ngồi trả lời → treo lượt;
 *   • `/mode bypass`, `/permissions allow …`, `/hooks trust` … → đổi quyền / chạy hook, đường vòng quanh các chốt của Remote.
 * Cho phép những điều đó từ trình duyệt = biến «điều khiển trợ lý» thành «có shell không cần xin phép». Nên với CLI:
 *   • tin bắt đầu bằng `!` → TỪ CHỐI (`shell_not_remote`);
 *   • tin bắt đầu bằng `/` → chỉ cho các lệnh trong DANH SÁCH TRẮNG (không hỏi, không đổi quyền/cấu hình/tài khoản), còn lại `slash_local_only`;
 *   • `/mode bypass` (kể cả viết hoa/có dấu) khi chưa cho phép bypass từ xa → `bypass_not_allowed` (đổi chế độ từ xa dùng lệnh `set_mode`, không dùng `/mode`).
 * Thuần (không đụng đĩa/mạng) để kiểm thử từng dòng.
 */

import { isBypassSlash, isLocalOnlySlash } from '../../shared/slashMode';

/**
 * Lệnh gạch chéo được chạy từ xa. Mỗi lệnh ở đây: không mở hộp hỏi, không đổi quyền/cấu hình/tài khoản, không chạy mã người dùng ngoài vòng quyền.
 *   /compact /context /cost /status /help /tasks /doctor — chỉ đọc hoặc nén ngữ cảnh;
 *   /review /simplify /security-review /verify — chạy một lượt agent như tin thường (vẫn qua hệ thống quyền);
 *   /new /clear — phiên mới (có lệnh `new_session` riêng nhưng gõ tay vẫn được).
 * KHÔNG có: /resume /sessions /mode /model /thinking /theme /init /rewind /fork /mcp /memory /skills /agents /hooks /permissions /plugins /config /login /logout /provider (mở hộp hỏi hoặc đổi
 * quyền/thực thi/khoá — mỗi cái có lệnh Remote riêng nếu cần), /exit /quit (tắt CLI từ xa!), /remote (tự tắt Remote), /update (cài mã), /copy /paste /image (chỉ có nghĩa ở terminal).
 */
export const REMOTE_SLASH_ALLOW: readonly string[] = ['compact', 'context', 'cost', 'status', 'help', 'tasks', 'doctor', 'review', 'simplify', 'security-review', 'verify', 'new', 'clear'];

export type RemoteSendError = 'shell_not_remote' | 'slash_local_only' | 'bypass_not_allowed' | 'empty';
export type RemoteSendVerdict = { ok: true; text: string } | { ok: false; error: RemoteSendError };

/** Có được chuyển nội dung `send` này vào `runtime.submit` không? `allowBypass`: cài đặt cho phép Remote đổi sang chế độ bỏ qua mọi xác nhận. */
export function vetRemoteSend(text: unknown, o: { allowBypass: boolean }): RemoteSendVerdict {
  const raw = String(text ?? '');
  const t = raw.trim();
  if (!t) return { ok: false, error: 'empty' };
  if (t.startsWith('!')) return { ok: false, error: 'shell_not_remote' };
  if (!t.startsWith('/')) return { ok: true, text: raw };
  // Xét bypass TRƯỚC danh sách trắng: thông báo cho `/mode bypass` phải là «bypass_not_allowed» (rõ nguyên nhân) chứ không phải «slash_local_only».
  if (isBypassSlash(t) && !o.allowBypass) return { ok: false, error: 'bypass_not_allowed' };
  if (isLocalOnlySlash(t)) return { ok: false, error: 'slash_local_only' };
  const name = (/^\/(\S*)/.exec(t)?.[1] ?? '').toLowerCase();
  // `/usr/bin/x`, `/tmp/a.txt`: trông như đường dẫn → là tin thường (đúng cách `Runtime.submit` phân loại).
  if (name && /[\\/.]/.test(name)) return { ok: true, text: raw };
  return REMOTE_SLASH_ALLOW.includes(name) ? { ok: true, text: raw } : { ok: false, error: 'slash_local_only' };
}
