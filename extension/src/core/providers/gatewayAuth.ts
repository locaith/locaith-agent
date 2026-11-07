/**
 * Xử lý 401 của cổng Locaith ĐÚNG CÁCH (lane:gateway-client, H01).
 *
 * Log cổng: 74/83 lỗi là 401, trong đó 12 lỗi là dùng lại một token đã biết là hỏng. Quy tắc:
 *   • cổng trả 401 → đánh dấu token đó HỎNG (không dùng lại tới khi làm mới thành công), xin làm mới ĐÚNG MỘT LẦN, gửi lại ĐÚNG MỘT LẦN;
 *   • vẫn 401 → KHÔNG thử lần ba: ném lỗi (accountAuth) để engine hiện «Phiên đăng nhập hết hạn — Đăng nhập lại»;
 *   • nhiều yêu cầu 401 cùng lúc chỉ gây MỘT lần làm mới (việc khử trùng lặp nằm ở `GatewayAuth.onUnauthorized`, xem account/gatewayToken.ts).
 * Tệp thuần, dùng chung cho mọi bản (không import `vscode` / `node:*`).
 */

import { ProviderError, type ProviderEvent } from '../types';
import { isContentEvent } from './http';

/** Hợp đồng giữa adapter và nơi giữ token tài khoản. */
export interface GatewayAuth {
  /** Token dùng cho yêu cầu kế tiếp; nếu token hiện tại đang bị đánh dấu hỏng thì thử làm mới trước. `undefined` = không có token dùng được. */
  acquire(): Promise<string | undefined>;
  /** Cổng vừa trả 401 cho `stale`: đánh dấu hỏng, làm mới (gộp lời gọi trùng). Trả token để gửi lại, hoặc `undefined` nếu không làm mới được. */
  onUnauthorized(stale: string): Promise<string | undefined>;
  /** Đã gửi lại bằng token vừa làm mới mà cổng VẪN từ chối: token này hết dùng được (host khoá phiên để người dùng đăng nhập lại). */
  onRetryRejected(token: string): void;
}

/** 401 của một nhà cung cấp dùng token tài khoản (kể cả khi thân phản hồi không mang mã `locaith_unauthorized`, ví dụ lỗi của proxy). */
export function isAccountAuthError(err: ProviderError, credential: 'account' | undefined): boolean {
  if (err.accountAuth) return true;
  return credential === 'account' && err.kind === 'auth' && err.status === 401;
}

/** Lỗi 401 chuẩn hoá: luôn mang `accountAuth` để engine hiện đúng thông điệp hành động và nhờ host khoá/kiểm tra lại tài khoản. */
export function asAccountAuthError(err: ProviderError, message: string): ProviderError {
  if (err.accountAuth) return err;
  return new ProviderError(message, { kind: 'auth', providerId: err.providerId, status: err.status ?? 401, retryable: false, accountAuth: true, details: err.details });
}

export interface AuthRefreshConfig {
  auth: GatewayAuth;
  providerId: string;
  signal: AbortSignal;
  /** Token đang dùng cho lần gọi hiện tại. */
  getKey(): string | undefined;
  /** Nhận token mới: lần chạy lại phải dùng nó. */
  setKey(key: string): void;
  /** Thông điệp khi buộc phải chuẩn hoá lỗi 401 không có mã cổng. */
  message: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Chạy `run()`; gặp 401 (khi CHƯA có nội dung nào đến tay người dùng) thì làm mới token MỘT lần rồi chạy lại MỘT lần.
 * Không bao giờ chạy quá 2 lần, kể cả khi bộ làm mới trả lại đúng token cũ.
 */
export async function* withAuthRefresh(
  cfg: AuthRefreshConfig,
  run: () => AsyncGenerator<ProviderEvent, void, void>,
  credential: 'account' | undefined = 'account',
): AsyncGenerator<ProviderEvent, void, void> {
  let retried = false;
  for (;;) {
    let yielded = false;
    try {
      for await (const ev of run()) {
        if (isContentEvent(ev)) yielded = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (!(err instanceof ProviderError) || yielded || cfg.signal.aborted || !isAccountAuthError(err, credential)) throw err;
      const stale = cfg.getKey();
      if (!stale) throw asAccountAuthError(err, cfg.message);
      if (retried) {
        // Đã làm mới + gửi lại mà vẫn 401: dừng hẳn.
        cfg.log?.('warn', `[${cfg.providerId}] 401 lần hai sau khi làm mới token — dừng, yêu cầu đăng nhập lại.`);
        cfg.auth.onRetryRejected(stale);
        throw asAccountAuthError(err, cfg.message);
      }
      retried = true;
      let fresh: string | undefined;
      try {
        fresh = await cfg.auth.onUnauthorized(stale);
      } catch {
        fresh = undefined;
      }
      if (cfg.signal.aborted) throw err;
      if (!fresh) {
        cfg.log?.('warn', `[${cfg.providerId}] 401 và không làm mới được token — yêu cầu đăng nhập lại.`);
        throw asAccountAuthError(err, cfg.message);
      }
      cfg.log?.('info', `[${cfg.providerId}] 401 — đã làm mới token tài khoản, gửi lại đúng một lần.`);
      cfg.setKey(fresh);
    }
  }
}
