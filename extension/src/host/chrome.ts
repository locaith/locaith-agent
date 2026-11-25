/**
 * Dịch vụ cầu nối Chrome của VS Code: giữ máy chủ cầu (core/chrome/bridge.ts), lưu token ghép đôi trong SecretStorage
 * (dùng chung mọi cửa sổ VS Code — huỷ ghép đôi ở một cửa sổ thu hồi ở tất cả) và đưa ra `ChromeCaller` cho công cụ `chrome`.
 * Máy chủ mở MẶC ĐỊNH ở 127.0.0.1 (chỉ nhận Origin chrome-extension://) để extension Chrome xin kết nối KHÔNG CẦN MÃ: VS Code hiện thẻ «Cho phép / Từ chối» ngay trong khung chat,
 * mỗi lần ghép đôi đều cần người dùng bấm Cho phép. Tắt hẳn bằng cài đặt `locaithAgent.chrome.bridge` = false (khi đó chỉ mở nếu đã ghép đôi hoặc người dùng tạo mã).
 */

import { BrowserBridge, type BridgeApp, type BridgeCreds, type BridgeStatus, type BridgeStore, type LinkTicketInfo } from '../core/chrome/bridge';
import type { ChromeCaller } from '../core/chrome/tools';
import { bridgeEvents, getBridgeApp } from './bridgeApp';

/** (0.7.20) Trạng thái cầu nối cho ứng dụng (lệnh locaithAgent.chrome.linkState). */
export interface ChromeLinkState {
  app: BridgeApp;
  running: boolean;
  /** Có một trình duyệt đã ghép đôi với ứng dụng này. */
  paired: boolean;
  /** Trình duyệt đó đang nối (hỏi lệnh trong 45 giây gần nhất). */
  connected: boolean;
  /** Có yêu cầu ghép đôi (kiểu cũ: công tắc trong tiện ích) đang chờ bấm Cho phép. */
  pairRequest: boolean;
  /** Vé ghép đôi mới nhất do ứng dụng tạo. */
  ticket?: LinkTicketInfo;
}

const KEY = 'locaithAgent.chrome.bridge';

export interface SecretsLike {
  get(k: string): Promise<string | undefined>;
  set(k: string, v: string): Promise<void>;
  delete(k: string): Promise<void>;
}

export function secretStore(s: SecretsLike): BridgeStore {
  return {
    async load(): Promise<BridgeCreds> {
      try {
        const raw = await s.get(KEY);
        const j = raw ? (JSON.parse(raw) as BridgeCreds) : {};
        return typeof j.token === 'string' && typeof j.extId === 'string' ? { token: j.token, extId: j.extId } : {};
      } catch {
        return {};
      }
    },
    async save(c: BridgeCreds): Promise<void> {
      if (c.token) await s.set(KEY, JSON.stringify({ token: c.token, extId: c.extId }));
      else await s.delete(KEY);
    },
  };
}

export class ChromeService implements ChromeCaller {
  readonly bridge: BrowserBridge;
  private readonly store: BridgeStore;

  constructor(
    secrets: SecretsLike,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void,
    opts: { bridge?: BrowserBridge; /** Có mở máy chủ ngay khi kích hoạt không (mặc định: có). */ autoStart?: () => boolean; /** (0.7.20) Ứng dụng giữ cầu nối (mặc định: setBridgeApp, rồi VS Code). */ app?: BridgeApp } = {},
  ) {
    this.store = secretStore(secrets);
    const app = opts.app ?? getBridgeApp();
    this.bridge = opts.bridge ?? new BrowserBridge(this.store, log, app ? { app } : {});
    this.autoStart = opts.autoStart ?? (() => true);
    this.bridge.onChange(() => bridgeEvents.emit('change'));
  }

  /** (0.7.20) Ghép đôi do ứng dụng khởi xướng: vé dùng một lần + địa chỉ trang /link để mở trong trình duyệt của người dùng. */
  linkTicket(): Promise<{ url: string; expiresAt: number }> {
    return this.bridge.linkTicket();
  }

  linkState(): ChromeLinkState {
    const s = this.bridge.status();
    const ticket = this.bridge.lastTicket();
    return { app: this.bridge.appInfo(), running: s.running, paired: s.paired, connected: s.connected, pairRequest: !!s.pairRequest, ...(ticket ? { ticket } : {}) };
  }

  private readonly autoStart: () => boolean;

  /** Khi kích hoạt: mở máy chủ để Chrome xin kết nối (không mã) hoặc tự kết nối lại nếu đã ghép đôi từ trước. */
  async init(): Promise<void> {
    const c = await this.store.load();
    if (!c.token && !this.autoStart()) return;
    try {
      await this.bridge.start();
    } catch (err) {
      this.log('warn', `Cầu nối Chrome: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): BridgeStatus {
    return this.bridge.status();
  }

  /** Báo giao diện khi có yêu cầu ghép đôi (không mã) mới / đã quyết định / hết hạn. Trả về hàm huỷ đăng ký. */
  onChange(cb: () => void): () => void {
    return this.bridge.onChange(cb);
  }

  /** Yêu cầu ghép đôi đang chờ người dùng bấm Cho phép. */
  pairRequest(): { id: string; extensionId: string; expiresAt: number } | undefined {
    return this.bridge.pairRequest();
  }

  approvePair(id: string): Promise<boolean> {
    return this.bridge.approvePair(id);
  }

  denyPair(id: string): boolean {
    return this.bridge.denyPair(id);
  }

  pair(): Promise<{ code: string; expiresAt: number }> {
    return this.bridge.startPairing();
  }

  unpair(): Promise<void> {
    return this.bridge.unpair();
  }

  call(op: string, args: unknown, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    return this.bridge.call(op, args, o);
  }

  dispose(): void {
    this.bridge.stop();
  }
}
