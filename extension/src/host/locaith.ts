/**
 * Họ mô hình Locaith (AI Local: Locaith-v5-flash, Locaith-v5-SI) ở phía host VS Code:
 *  • `LocaithConsent` — bản ghi ĐỒNG Ý THÔNG BÁO DỮ LIỆU theo TÀI KHOẢN. Máy chủ (cổng Locaith) giữ bản chính; ở đây chỉ có bản đệm trong globalState theo (tài khoản, phiên bản)
 *    để khỏi hỏi lại mỗi lần mở VS Code. Chưa đồng ý thì KHÔNG có byte nào của người dùng rời máy tới cổng (xem `guard` trong LocaithBridge).
 *  • `LocaithBridge` — gắn trễ (tài khoản + đồng ý được dựng sau ProviderService) và trao cho ProviderRegistry token đăng nhập, tiêu đề mỗi lời gọi và chốt chặn.
 * Không import `vscode` để kiểm thử đơn vị bằng Node thuần. Hợp đồng với cổng: docs/LOCAITH-MODELS.md.
 */

import { ProviderError } from '../core/types';
import {
  CONSENT_MESSAGE,
  LOCAITH_NOTICE_VERSION,
  LOCAITH_PROVIDER_ID,
  type ConsentError,
  type LocaithGatewayClient,
} from '../core/providers/locaithGateway';
import type { AccountProviderHooks } from '../core/providers/registry';
import { GatewayTokenManager } from '../core/account/gatewayToken';
import { gatewayDiagnosticHeaders, type GatewayClientFamily } from '../core/providers/gatewayDiagnostics';

const CACHE_KEY = 'locaithAgent.locaith.consent';

interface CacheRecord {
  /** Id tài khoản Locaith đã đồng ý trên máy này. */
  account: string;
  /** Phiên bản thông báo đã đồng ý. */
  version: number;
  at: number;
  /** Người dùng đã rút lại trên máy này: không dùng mô hình Locaith cho tới khi đồng ý lại (bản ghi ở máy chủ vẫn còn làm bằng chứng). */
  withdrawn?: boolean;
}

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** Phần tài khoản mà bản ghi đồng ý cần biết (để thay bằng đồ giả khi kiểm thử đơn vị). */
export interface LocaithAccountLike {
  /** Đã đăng nhập (kể cả đang trong thời gian ân hạn mất mạng). */
  readonly usable: boolean;
  token(): string | undefined;
  /** Id ổn định của tài khoản (khoá của bản đệm đồng ý). */
  userId(): string | undefined;
  /** (lane:gateway-client) Mã thiết bị của phiên (chưa băm) — chỉ để băm làm nhãn chẩn đoán `X-Locaith-Device`. */
  deviceId?(): string | undefined;
  /** (lane:gateway-client) Làm mới khi cổng trả 401 cho `stale`; trả token dùng được hoặc undefined. */
  refreshToken?(stale: string): Promise<string | undefined>;
  /** (lane:gateway-client) Cổng từ chối token ngay cả sau khi làm mới → khoá phiên để người dùng đăng nhập lại. */
  expireToken?(token: string): Promise<void> | void;
}

export type AcceptResult = { ok: true } | { ok: false; error: ConsentError | 'rejected' | 'signed_out'; message?: string };

/** Phần ChatController cần: tách khỏi lớp cụ thể để kiểm thử bằng đồ giả. */
export interface LocaithGate {
  accepted(): boolean;
  /** Phiên bản thông báo máy chủ đòi MỚI hơn bản tiện ích này biết → phải cập nhật tiện ích mới đồng ý được. */
  outdated(): boolean;
  /** Hỏi máy chủ tài khoản này đã đồng ý chưa (có thể đã đồng ý ở máy khác). Lỗi mạng: giữ nguyên bản đệm. */
  refresh(): Promise<void>;
  accept(): Promise<AcceptResult>;
  /** Rút lại ở máy này (bản ghi ở máy chủ vẫn còn). */
  withdraw(): Promise<void>;
  /** Máy chủ vừa từ chối vì chưa có bản ghi hợp lệ → xoá bản đệm để hỏi lại. */
  invalidate(): void;
  onChange(cb: () => void): { dispose(): void };
}

export class LocaithConsent implements LocaithGate {
  private cache: CacheRecord | null;
  private readonly subs = new Set<() => void>();
  private serverCurrent = LOCAITH_NOTICE_VERSION;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly d: {
      memento: MementoLike;
      account: LocaithAccountLike;
      client: Pick<LocaithGatewayClient, 'getConsent' | 'postConsent'>;
      /** Phiên bản tiện ích, gửi kèm bản ghi: `vscode/0.6.0`. */
      clientLabel: string;
      log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
      now?: () => number;
    },
  ) {
    const raw = d.memento.get<unknown>(CACHE_KEY, null);
    this.cache = isCache(raw) ? raw : null;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private mine(): CacheRecord | null {
    const uid = this.d.account.userId();
    return uid && this.cache && this.cache.account === uid ? this.cache : null;
  }

  accepted(): boolean {
    if (!this.d.account.usable) return false;
    const c = this.mine();
    return !!c && !c.withdrawn && c.version >= LOCAITH_NOTICE_VERSION;
  }

  outdated(): boolean {
    return this.serverCurrent > LOCAITH_NOTICE_VERSION;
  }

  onChange(cb: () => void): { dispose(): void } {
    this.subs.add(cb);
    return { dispose: () => void this.subs.delete(cb) };
  }

  private async save(rec: CacheRecord | null): Promise<void> {
    this.cache = rec;
    await this.d.memento.update(CACHE_KEY, rec);
    for (const cb of [...this.subs]) {
      try {
        cb();
      } catch {
        /* một bên nghe lỗi không được làm hỏng bên khác */
      }
    }
  }

  async refresh(): Promise<void> {
    // Nhiều nơi hỏi cùng lúc (mở khung chat, chọn model, gửi tin) dùng chung MỘT lượt gọi.
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const token = this.d.account.usable ? this.d.account.token() : undefined;
    const uid = this.d.account.userId();
    if (!token || !uid) return;
    const mine = this.mine();
    if (mine?.withdrawn) return; // đã rút lại ở máy này: không tự bật lại chỉ vì máy chủ còn bản ghi
    const r = await this.d.client.getConsent(token);
    if (!r.ok) {
      this.d.log?.('debug', `Locaith: chưa hỏi được bản ghi đồng ý (${r.error}) — giữ bản đệm.`);
      return;
    }
    this.serverCurrent = r.state.current;
    const okOnServer = r.state.accepted && r.state.version >= LOCAITH_NOTICE_VERSION;
    if (okOnServer) {
      if (!mine || mine.version < r.state.version) await this.save({ account: uid, version: r.state.version, at: this.now() });
    } else if (mine) {
      await this.save(null); // máy chủ không còn coi là đã đồng ý (đổi phiên bản, bản ghi bị xoá…): hỏi lại
    }
  }

  async accept(): Promise<AcceptResult> {
    const token = this.d.account.usable ? this.d.account.token() : undefined;
    const uid = this.d.account.userId();
    if (!token || !uid) return { ok: false, error: 'signed_out' };
    const r = await this.d.client.postConsent(token, LOCAITH_NOTICE_VERSION, this.d.clientLabel);
    if (!r.ok) {
      this.d.log?.('warn', `Locaith: ghi nhận đồng ý thất bại (${r.error}${r.message ? `: ${r.message}` : ''}).`);
      return r;
    }
    await this.save({ account: uid, version: LOCAITH_NOTICE_VERSION, at: this.now() });
    return { ok: true };
  }

  async withdraw(): Promise<void> {
    const uid = this.d.account.userId();
    if (!uid) return;
    await this.save({ account: uid, version: this.mine()?.version ?? 0, at: this.now(), withdrawn: true });
  }

  invalidate(): void {
    if (!this.mine()) return;
    void this.save(null);
  }
}

function isCache(v: unknown): v is CacheRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.account === 'string' && o.account.length > 0 && o.account.length <= 80 && Number.isFinite(o.version) && Number.isFinite(o.at);
}

/** `[A-Za-z0-9 ._/-]`, tối đa `max` ký tự — đúng bộ ký tự cổng chấp nhận cho tiêu đề tự do. */
export function headerSafe(v: string, max: number): string {
  return v.replace(/[^A-Za-z0-9 ._/-]/g, '_').slice(0, max);
}

/**
 * Cầu nối trễ giữa ProviderService (dựng sớm) và tài khoản + đồng ý (dựng muộn hơn): trao cho ProviderRegistry token, tiêu đề mỗi lời gọi và chốt chặn.
 * Chưa gắn (hoặc chưa đăng nhập / chưa đồng ý) thì không có token và chốt chặn từ chối — an toàn mặc định.
 */
export class LocaithBridge {
  private account?: LocaithAccountLike;
  private consent?: Pick<LocaithGate, 'accepted'>;

  attach(account: LocaithAccountLike, consent: Pick<LocaithGate, 'accepted'>): void {
    this.account = account;
    this.consent = consent;
  }

  hooks(extensionVersion: string, family: GatewayClientFamily = 'vscode'): AccountProviderHooks {
    // (lane:gateway-client, H01) người giữ token: cờ «hỏng cho tới khi làm mới», làm mới đúng một lần, khử trùng lặp.
    const tokens = new GatewayTokenManager({
      current: () => (this.account?.usable ? this.account.token() : undefined),
      refresh: (stale) => this.account?.refreshToken?.(stale) ?? Promise.resolve(undefined),
      onDead: (t) => void this.account?.expireToken?.(t),
    });
    return {
      token: () => (this.account?.usable ? this.account.token() : undefined),
      auth: tokens,
      headers: ({ sessionKey, ticket }) => ({
        // (lane:gateway-client, H02) nhãn chẩn đoán: họ+phiên bản máy khách, băm thiết bị, băm phiên chat — không có mã thô, email hay đường dẫn.
        ...gatewayDiagnosticHeaders({ family, version: extensionVersion, deviceId: this.account?.deviceId?.(), sessionKey }),
        // Bắt buộc: báo cho cổng rằng ta muốn nhận 429 + mã vé khi đầy (và tự đếm ngược), thay vì để cổng giữ yêu cầu mở.
        'x-locaith-queue': 'ticket',
        ...(ticket ? { 'x-locaith-ticket': headerSafe(ticket, 120) } : {}),
      }),
      guard: () =>
        this.consent?.accepted() ? undefined : new ProviderError(CONSENT_MESSAGE, { kind: 'consent_required', providerId: LOCAITH_PROVIDER_ID, retryable: false }),
    };
  }
}
