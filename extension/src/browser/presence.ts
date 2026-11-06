/**
 * "Hiện diện" của trợ lý trên các trang nó đọc/điều khiển: viền sáng xanh lam ngọc quanh trang + nút Dừng nhỏ ở dưới, để người dùng biết
 * trang nào đang được trợ lý làm việc và dừng được ngay tại trang. Phần vẽ nằm trong runtime của trang (page/runtime.ts); lớp này quyết định
 * KHI NÀO bật/gỡ và gia hạn.
 *
 *  - Bật khi một công cụ chạm vào tab (`touch`), gỡ khi lượt chạy kết thúc hoặc bị dừng (`end`).
 *  - Trang tự gỡ lớp phủ sau `ttlMs` nếu không được gia hạn → khung chat đóng đột ngột cũng không để lại viền mồ côi. Nhịp gia hạn chạy trong lúc lượt còn chạy.
 *  - Mọi thao tác trên cùng một tab được xếp hàng, nên lệnh "gỡ" không bao giờ bị lệnh "bật" gửi trước đó chạy đè.
 *  - Không bao giờ ném lỗi và không chặn công cụ: đây chỉ là dấu hiệu cho người dùng.
 */

import type { BrowserApi } from './api';
import type { ActionFx, ActionKind } from './page/overlay';

export type { ActionFx, ActionKind };
export type PresenceKind = 'read' | 'act';

/** Phần công cụ trang cần dùng: báo "tôi đang đọc/điều khiển tab này" và xin hiệu ứng (con trỏ, dấu số) + số bước cho một thao tác lên phần tử. */
export interface PresenceSink {
  touch(tabId: number, kind: PresenceKind): void;
  /**
   * Mỗi thao tác bấm/gõ/chọn/rê chuột lên một phần tử gọi MỘT lần: cấp SỐ BƯỚC (tăng dần suốt cuộc trò chuyện, hiện cả trên dấu ở trang lẫn trong khung chat)
   * và dữ liệu hiệu ứng để runtime vẽ con trỏ. Hiệu ứng (`show`) chỉ có khi người dùng chưa tắt "viền sáng + nút Dừng" và lượt chạy còn đang chạy.
   */
  action(tabId: number, kind: ActionKind, what?: string): ActionFx;
}

export interface PresenceDeps {
  api: BrowserApi;
  /** Cài đặt "viền sáng + nút Dừng" đang bật không (đọc mỗi lần để đổi cài đặt có hiệu lực ngay). */
  enabled(): boolean;
  lang(): 'vi' | 'en';
  /** Chu kỳ gia hạn (ms). */
  intervalMs?: number;
  /** Sau chừng này (ms) không được gia hạn thì trang tự gỡ lớp phủ. */
  ttlMs?: number;
}

const TEXT = {
  vi: { read: 'Locaith AI đang đọc trang này', act: 'Locaith AI đang điều khiển trang này', stop: 'Dừng', verb: { click: 'Bấm', type: 'Gõ vào', select: 'Chọn trong', hover: 'Rê chuột tới' } },
  en: { read: 'Locaith AI is reading this page', act: 'Locaith AI is controlling this page', stop: 'Stop', verb: { click: 'Click', type: 'Type in', select: 'Select in', hover: 'Hover' } },
} as const;

export class Presence implements PresenceSink {
  private running = false;
  private readonly tabs = new Map<number, PresenceKind>();
  private readonly queue = new Map<number, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;

  constructor(private readonly d: PresenceDeps) {}

  /** Cuộc trò chuyện mới / mở cuộc khác: số bước bắt đầu lại; `next` = số bước kế tiếp (khi mở lại cuộc cũ thì nối tiếp số lớn nhất đã có). */
  resetSteps(next = 1): void {
    this.step = Math.max(0, next - 1);
  }

  /** Một lượt chạy bắt đầu: từ giờ `touch` mới có tác dụng. */
  begin(): void {
    this.running = true;
  }

  /** Tab này đang có lớp phủ của lượt chạy hiện tại không (dùng để nhận đúng cú bấm Dừng từ trang). */
  has(tabId: number): boolean {
    return this.running && this.tabs.has(tabId);
  }

  touch(tabId: number, kind: PresenceKind): void {
    if (!this.running || !this.d.enabled()) return;
    // Đã thao tác (act) trong lượt này thì nhãn giữ là "điều khiển", không quay lại "đọc" mỗi lần đọc thêm.
    this.tabs.set(tabId, kind === 'act' || this.tabs.get(tabId) === 'act' ? 'act' : 'read');
    this.push(tabId);
    if (!this.timer) this.timer = setInterval(() => this.beat(), this.d.intervalMs ?? 4_000);
  }

  action(tabId: number, kind: ActionKind, what?: string): ActionFx {
    const n = ++this.step;
    const text = TEXT[this.d.lang()];
    const fx: ActionFx = { n, kind, verb: text.verb[kind], ...(what ? { what } : {}) };
    if (this.running && this.d.enabled()) {
      // Cho runtime đủ dữ liệu để TỰ dựng lớp phủ nếu nó chưa có (thao tác đầu tiên ngay sau khi chuyển trang), khỏi phụ thuộc thứ tự với lệnh "bật" đang chạy ngầm.
      fx.show = { on: true, label: text.act, stopLabel: text.stop, ttlMs: this.d.ttlMs ?? 15_000 };
      this.touch(tabId, 'act');
    }
    return fx;
  }

  /** Lượt chạy kết thúc hoặc bị dừng: gỡ lớp phủ khỏi mọi tab đã chạm vào. */
  end(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ids = [...this.tabs.keys()];
    this.tabs.clear();
    for (const id of ids) this.enqueue(id, () => this.d.api.setPresence(id, { on: false }));
  }

  dispose(): void {
    this.end();
  }

  private beat(): void {
    if (!this.running) return;
    if (!this.d.enabled()) {
      // Người dùng vừa tắt cài đặt giữa chừng: gỡ ngay.
      const ids = [...this.tabs.keys()];
      this.tabs.clear();
      for (const id of ids) this.enqueue(id, () => this.d.api.setPresence(id, { on: false }));
      return;
    }
    for (const id of this.tabs.keys()) this.push(id);
  }

  private push(tabId: number): void {
    const kind = this.tabs.get(tabId);
    if (!kind) return;
    const text = TEXT[this.d.lang()];
    this.enqueue(tabId, async () => {
      if (!this.tabs.has(tabId)) return false; // lượt đã kết thúc trong lúc chờ tới lượt
      const ok = await this.d.api.setPresence(tabId, { on: true, label: text[kind], stopLabel: text.stop, ttlMs: (this.d.ttlMs ?? 15_000) });
      // Tab đã đóng thì thôi gia hạn. (Trang không cho chạy mã — trang hệ thống — thì cứ thử lại ở nhịp sau, không tốn gì.)
      if (!ok && !(await this.d.api.getTab(tabId))) this.tabs.delete(tabId);
      return ok;
    });
  }

  private enqueue(tabId: number, job: () => Promise<unknown>): void {
    const prev = this.queue.get(tabId) ?? Promise.resolve();
    const next: Promise<unknown> = prev.then(job, job).catch(() => undefined);
    this.queue.set(tabId, next);
    void next.then(() => {
      if (this.queue.get(tabId) === next) this.queue.delete(tabId);
    });
  }
}
