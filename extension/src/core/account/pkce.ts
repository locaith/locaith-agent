/**
 * PKCE (RFC 7636) cho luồng đăng nhập extension ↔ locaith.ai: extension giữ `code_verifier` bí mật, chỉ gửi `code_challenge = base64url(sha256(verifier))`
 * qua trình duyệt. Lấy được mã uỷ quyền mà không có verifier thì vô dụng. Không import `vscode`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** 256 bit ngẫu nhiên → 43 ký tự base64url (đúng độ dài tối thiểu RFC 7636). */
export const newVerifier = (): string => b64u(randomBytes(32));

export const challengeOf = (verifier: string): string => b64u(createHash('sha256').update(verifier, 'utf8').digest());

/** `state` chống giả mạo yêu cầu (CSRF đăng nhập): chỉ chấp nhận callback mang đúng giá trị ta đã sinh. */
export const newState = (): string => b64u(randomBytes(16));

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
