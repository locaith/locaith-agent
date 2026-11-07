/**
 * Người giữ token thiết bị cho cổng Locaith (lane:gateway-client, H01): cờ «hỏng cho tới khi làm mới» + khử trùng lặp việc làm mới.
 *
 *  • `onUnauthorized(stale)`: cổng trả 401 cho `stale` → đánh dấu HỎNG; làm mới; nhiều yêu cầu 401 cùng lúc (hoặc ngay sau nhau) chỉ gây MỘT lần làm mới.
 *  • `acquire()`: token cho yêu cầu mới. Token đang bị đánh dấu hỏng KHÔNG BAO GIỜ được trả ra; thay vào đó thử làm mới (tối đa một lần mỗi `cooldownMs`).
 *    Làm mới thành công = máy chủ tài khoản xác nhận lại token (hoặc cửa sổ khác đã đăng nhập lại và có token mới); khi đó cờ hỏng được gỡ.
 *  • `onRetryRejected(token)`: gửi lại bằng token vừa làm mới mà cổng vẫn 401 → token hết dùng được; host (onDead) khoá phiên để người dùng đăng nhập lại.
 *
 * Không import `vscode`. Không bao giờ ghi token vào log.
 */

import type { GatewayAuth } from '../providers/gatewayAuth';

export interface GatewayTokenDeps {
  /** Token của phiên đang đăng nhập (undefined = chưa đăng nhập / phiên đã khoá). */
  current(): string | undefined;
  /** Làm mới bằng cơ chế tài khoản hiện có. Trả token dùng được (có thể là chính `stale` nếu máy chủ xác nhận còn hiệu lực) hoặc undefined. */
  refresh(stale: string): Promise<string | undefined>;
  /** Cổng vẫn từ chối token sau khi đã làm mới. */
  onDead?(token: string): void;
  now?(): number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Sau một lần làm mới thất bại, chưa thử lại ngay (mặc định 30 giây — khớp thời gian cổng nhớ token hỏng). */
  cooldownMs?: number;
  /** Trong khoảng này, kết quả làm mới gần nhất được dùng lại cho các 401 đến muộn một chút (mặc định 5 giây). */
  memoMs?: number;
}

const MAX_TRACKED = 16;

export class GatewayTokenManager implements GatewayAuth {
  private readonly invalid = new Set<string>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly memo = new Map<string, { at: number; result: string | undefined }>();
  private readonly failedAt = new Map<string, number>();
  /** Số lần gọi `deps.refresh` (cho kiểm thử). */
  refreshCalls = 0;

  constructor(private readonly d: GatewayTokenDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Token có đang bị đánh dấu hỏng không (kiểm thử / chẩn đoán). */
  isInvalid(token: string): boolean {
    return this.invalid.has(token);
  }

  async acquire(): Promise<string | undefined> {
    const cur = this.d.current();
    if (!cur) return undefined;
    if (!this.invalid.has(cur)) return cur;
    return this.refresh(cur);
  }

  async onUnauthorized(stale: string): Promise<string | undefined> {
    this.mark(stale);
    return this.refresh(stale);
  }

  onRetryRejected(token: string): void {
    this.mark(token);
    this.failedAt.set(token, this.now());
    this.memo.delete(token);
    this.d.log?.('warn', 'Cổng Locaith vẫn từ chối token sau khi làm mới — khoá phiên, cần đăng nhập lại.');
    try {
      this.d.onDead?.(token);
    } catch {
      /* host lỗi không được làm hỏng luồng báo lỗi */
    }
  }

  private mark(token: string): void {
    if (this.invalid.size >= MAX_TRACKED) this.invalid.clear();
    this.invalid.add(token);
  }

  private refresh(stale: string): Promise<string | undefined> {
    const cur = this.d.current();
    if (!cur) return Promise.resolve(undefined); // đã đăng xuất / phiên bị khoá
    // Cửa sổ khác (hoặc lần đăng nhập mới) đã thay token: dùng luôn, không cần hỏi máy chủ.
    if (cur !== stale && !this.invalid.has(cur)) return Promise.resolve(cur);
    const running = this.inflight.get(stale);
    if (running) return running;
    const memo = this.memo.get(stale);
    if (memo && this.now() - memo.at < (this.d.memoMs ?? 5_000)) {
      if (memo.result === stale) this.invalid.delete(stale);
      return Promise.resolve(memo.result);
    }
    const failed = this.failedAt.get(stale);
    if (failed !== undefined && this.now() - failed < (this.d.cooldownMs ?? 30_000)) return Promise.resolve(undefined);

    this.refreshCalls++;
    const p = (async () => {
      let result: string | undefined;
      try {
        result = await this.d.refresh(stale);
      } catch {
        result = undefined;
      }
      if (result && !this.invalid.has(result)) {
        this.failedAt.delete(stale);
      } else if (result === stale) {
        // `result === stale` còn trong danh sách hỏng: máy chủ tài khoản xác nhận token còn hiệu lực → làm mới thành công, gỡ cờ.
        this.invalid.delete(stale);
        this.failedAt.delete(stale);
      } else if (!result) {
        if (this.failedAt.size >= MAX_TRACKED) this.failedAt.clear();
        this.failedAt.set(stale, this.now());
      }
      if (this.memo.size >= MAX_TRACKED) this.memo.clear();
      this.memo.set(stale, { at: this.now(), result });
      return result;
    })().finally(() => {
      this.inflight.delete(stale);
    });
    this.inflight.set(stale, p);
    return p;
  }
}
