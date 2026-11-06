import { BackgroundTabError, type BrowserApi, type CapturedImage, type PresenceState, type RuntimeResult, type TabLite } from '../../../src/browser/api';
import { pageError } from '../../../src/browser/pageErrors';

export type RuntimeHandler = (tabId: number, arg: any) => RuntimeResult | Promise<RuntimeResult>;

/** Trình duyệt giả: danh sách tab trong bộ nhớ, runtime trong trang do test lập trình. */
export class FakeBrowserApi implements BrowserApi {
  name = 'Trình duyệt thử';
  tabs: TabLite[] = [];
  handlers: Record<string, RuntimeHandler> = {};
  calls: { tabId: number; method: string; arg: unknown }[] = [];
  created: string[] = [];
  closed: number[] = [];
  siteAccess = false;
  accessible = new Set<number>();
  activeId: number | null = null;
  private nextId = 100;
  private listeners = new Set<() => void>();

  addTab(partial: Partial<TabLite> & { url: string }): TabLite {
    const t: TabLite = { id: partial.id ?? this.nextId++, windowId: 1, title: partial.title ?? `Tab ${partial.url}`, active: false, status: 'complete', ...partial };
    this.tabs.push(t);
    if (this.activeId === null) this.activeId = t.id;
    this.accessible.add(t.id);
    return t;
  }

  /**
   * Đặt kết quả của một phương thức runtime. Giá trị thường được bọc thành `{ ok: true, value }` (đúng như `callRuntime` thật: `value`
   * là thứ hàm trong trang trả về, có thể tự nó là `{ ok: false, … }`). Truyền HÀM để trả thẳng một phong bì RuntimeResult (lỗi cấp extension).
   */
  on(method: string, h: RuntimeHandler | unknown): void {
    this.handlers[method] = typeof h === 'function' ? (h as RuntimeHandler) : () => ({ ok: true, value: h });
  }

  async windowId(): Promise<number | undefined> {
    return 1;
  }
  async listTabs(): Promise<TabLite[]> {
    return this.tabs.map((t) => ({ ...t, active: this.activeId === t.id }));
  }
  async getTab(id: number): Promise<TabLite | null> {
    const t = this.tabs.find((x) => x.id === id);
    return t ? { ...t, active: this.activeId === id } : null;
  }
  async activeTab(): Promise<TabLite | null> {
    return this.activeId === null ? null : this.getTab(this.activeId);
  }
  async createTab(url: string, opts: { active: boolean }): Promise<TabLite> {
    this.created.push(url);
    const t = this.addTab({ url, title: `Trang ${url}` });
    if (opts.active) this.activeId = t.id;
    return { ...t };
  }
  async updateTab(id: number, patch: { url?: string; active?: boolean }): Promise<TabLite> {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) throw new Error('no tab');
    if (patch.url) {
      t.url = patch.url;
      t.title = `Trang ${patch.url}`;
    }
    if (patch.active) this.activeId = id;
    return { ...t, active: this.activeId === id };
  }
  async closeTab(id: number): Promise<void> {
    this.closed.push(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
  }
  async history(): Promise<void> {}
  async reload(): Promise<void> {}
  async waitForLoad(id: number): Promise<TabLite | null> {
    return this.getTab(id);
  }
  async callRuntime<T = any>(tabId: number, method: string, arg?: unknown): Promise<RuntimeResult<T>> {
    this.calls.push({ tabId, method, arg });
    if (!this.tabs.some((t) => t.id === tabId)) return pageError('no_tab');
    if (!this.accessible.has(tabId)) return pageError('no_access');
    const h = this.handlers[method];
    if (!h) return { ok: true, value: { ok: true } as T };
    return (await h(tabId, arg)) as RuntimeResult<T>;
  }
  captures: number[] = [];
  /** Số lần trợ lý phải đưa một tab nền lên trước MỘT LÚC để chụp (nhấp nháy). */
  flips: number[] = [];
  async capture(tabId: number, opts: { allowFlip?: boolean } = {}): Promise<CapturedImage> {
    if (!this.accessible.has(tabId)) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    // Như bản thật: tab đang hiện chụp thẳng; tab nền chỉ được chụp khi cho phép đưa lên trước một lúc (rồi người dùng được trả về tab cũ), nếu không thì từ chối.
    if (this.activeId !== tabId) {
      if (!opts.allowFlip) throw new BackgroundTabError();
      this.flips.push(tabId);
    }
    this.captures.push(tabId);
    return { mediaType: 'image/jpeg', base64: 'AAAA', width: 800, height: 600 };
  }
  /** Các lần canh tab mới tự nhảy lên trước (guardForeground) và các lần đã dừng canh. */
  guards: { windowId: number; backTo: number; openers: number[]; ms: number; stopped: boolean }[] = [];
  guardForeground(windowId: number, backTo: number, openers: number[], ms: number): () => void {
    const g = { windowId, backTo, openers, ms, stopped: false };
    this.guards.push(g);
    return () => {
      g.stopped = true;
    };
  }
  /** Lịch sử bật/gỡ viền sáng: mỗi phần tử là một lời gọi setPresence. */
  presenceLog: { tabId: number; state: PresenceState }[] = [];
  /** Tab đang có viền sáng (theo lời gọi cuối cùng). */
  presenceOn = new Set<number>();
  async setPresence(tabId: number, state: PresenceState): Promise<boolean> {
    this.presenceLog.push({ tabId, state });
    if (!this.tabs.some((t) => t.id === tabId)) return false;
    if (state.on) this.presenceOn.add(tabId);
    else this.presenceOn.delete(tabId);
    return true;
  }
  /** Các tab đã được đánh dấu là do trợ lý mở. */
  marked: number[] = [];
  async markAssistantTab(tabId: number): Promise<void> {
    if (!this.marked.includes(tabId)) this.marked.push(tabId);
  }
  async canAccess(tabId: number): Promise<boolean> {
    return this.accessible.has(tabId);
  }
  async hasSiteAccess(): Promise<boolean> {
    return this.siteAccess;
  }
  async requestSiteAccess(): Promise<boolean> {
    this.siteAccess = true;
    this.listeners.forEach((l) => l());
    return true;
  }
  async removeSiteAccess(): Promise<boolean> {
    this.siteAccess = false;
    this.listeners.forEach((l) => l());
    return true;
  }
  /** Máy chủ đã được cấp quyền (kiểm thử đặt tay); mặc định cấp luôn. */
  grantedOrigins: string[] = [];
  originAnswer = true;
  async ensureOrigin(url: string): Promise<boolean> {
    this.grantedOrigins.push(url);
    return this.originAnswer;
  }
  /** Giả lập trình duyệt phát sự kiện tab đổi (người dùng chuyển tab, đóng tab…). */
  notifyTabsChanged(): void {
    this.listeners.forEach((l) => l());
  }
  onTabsChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async openExternal(): Promise<void> {}
}
