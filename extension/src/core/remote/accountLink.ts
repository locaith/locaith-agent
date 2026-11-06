/**
 * Liên kết mở trang Remote trên locaith.ai bằng TÀI KHOẢN (0.6.5): `#remote?h=<mã máy>`. Không mang bí mật nào — chỉ nói «mở máy này»; trang tự lấy khoá bằng phiên đăng nhập
 * của người dùng (RPC ext_hosts_list chỉ trả máy của chính chủ tài khoản). Nằm sau dấu # nên không bao giờ gửi tới máy chủ web.
 * Phía web đọc bằng relay/accountLink.ts (`parseAccountHash`); liên kết ghép đôi cũ (`#remote?r=…&k=…`) luôn thắng nếu hai kiểu cùng có mặt.
 */

/** Mã máy = 16 byte base64url không đệm (22 ký tự), cùng định dạng với `hostId` trong e2e.ts. */
const HOST_ID = /^[A-Za-z0-9_-]{22}$/;

export function accountLink(web: string, hostId: string): string {
  if (!HOST_ID.test(hostId)) throw new Error('hostId không hợp lệ');
  return `${web.replace(/\/+$/, '')}/#remote?h=${hostId}`;
}
