/**
 * Lớp bọc quanh API `chrome.*` mà controller và các công cụ trang dùng. Tách ra để:
 *  - kiểm thử bằng bản giả (không cần trình duyệt),
 *  - gom MỌI chỗ gọi `chrome.*` có tác dụng phụ vào một nơi dễ rà soát.
 *
 * Chạy được ở cả Chrome lẫn Edge (cùng API Chromium).
 */

import { mapScriptError, pageError, type PageErrorCode } from './pageErrors';
import { RUNTIME_VERSION } from './page/version';

/** Tên nhóm tab chứa các tab do trợ lý mở (hiện trên thanh tab bằng chip + vạch màu). */
export const ASSISTANT_GROUP_TITLE = 'Locaith AI';

/** Trạng thái hiện diện trên một trang: bật (viền sáng + nút Dừng, tự gỡ sau `ttlMs` nếu không được gia hạn) hoặc gỡ. */
export type PresenceState = { on: false } | { on: true; label: string; stopLabel: string; ttlMs: number };

/**
 * Không chụp được vì tab đang nằm nền (người dùng đang xem tab khác). Trình duyệt chỉ chụp được tab đang hiện — đã đo trên Chrome 156 và Edge 156: kể cả
 * chụp qua giao thức gỡ lỗi, tab bị ẩn không tạo khung hình nên lệnh treo — vậy muốn chụp phải ĐƯA TAB LÊN TRƯỚC, tức là nhấp nháy sang tab đó. Mặc định
 * trợ lý không làm vậy (xem `allowFlip`).
 */
export class BackgroundTabError extends Error {
  readonly code = 'background';
  constructor() {
    super('Tab này đang nằm nền (người dùng đang xem tab khác) nên không chụp màn hình được mà không phải chuyển tab.');
  }
}

export interface TabLite {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  status: 'loading' | 'complete' | 'unloaded';
  pinned?: boolean;
  audible?: boolean;
  /** Tab đã mở tab này (window.open / liên kết target=_blank). Chỉ tab do CHÍNH tab làm việc mở mới được trợ lý nhận làm tab của mình. */
  openerTabId?: number;
}

/** Kết quả gọi vào runtime chạy trong trang. */
export type RuntimeResult<T = any> = { ok: true; value: T } | { ok: false; code: PageErrorCode; message: string };

export interface CapturedImage {
  mediaType: 'image/jpeg' | 'image/png';
  /** base64, không tiền tố data:. */
  base64: string;
  width: number;
  height: number;
}

export interface BrowserApi {
  /** Tên hiển thị của trình duyệt: "Microsoft Edge", "Google Chrome"… */
  readonly name: string;
  /** Id cửa sổ chứa trang này (khung chat). */
  windowId(): Promise<number | undefined>;
  listTabs(): Promise<TabLite[]>;
  getTab(id: number): Promise<TabLite | null>;
  /** Tab đang xem trong cửa sổ chứa khung chat (bỏ qua trang của chính extension). */
  activeTab(): Promise<TabLite | null>;
  createTab(url: string, opts: { active: boolean }): Promise<TabLite>;
  updateTab(id: number, patch: { url?: string; active?: boolean }): Promise<TabLite>;
  closeTab(id: number): Promise<void>;
  history(id: number, direction: 'back' | 'forward'): Promise<void>;
  reload(id: number): Promise<void>;
  /** Chờ tab tải xong (status complete) hoặc hết hạn. Trả trạng thái cuối cùng của tab. */
  waitForLoad(id: number, timeoutMs: number): Promise<TabLite | null>;
  /** Gọi một phương thức của runtime trong trang (tự nạp runtime nếu chưa có). */
  callRuntime<T = any>(tabId: number, method: string, arg?: unknown): Promise<RuntimeResult<T>>;
  /**
   * Chụp phần nhìn thấy của tab. Tab đang hiện: chụp thẳng. Tab nền: mặc định ném `BackgroundTabError` (không chuyển tab của người dùng); chỉ khi
   * `allowFlip` (người dùng cho phép trợ lý đưa tab lên trước) mới đưa tab lên MỘT LÚC rồi trả về đúng tab họ đang xem (trừ khi họ tự chuyển sang tab khác
   * trong lúc đó). Viền sáng/nút Dừng/con trỏ của trợ lý được ẩn khi chụp.
   */
  capture(tabId: number, opts?: { allowFlip?: boolean }): Promise<CapturedImage>;
  /**
   * Canh việc trình duyệt tự đưa tab MỚI (do chính tab nguồn hoặc tab đang xem mở ra, thường là liên kết target=_blank / window.open) lên trước trong lúc
   * trợ lý thao tác: ngay khi nó hiện lên thì trả người dùng về `backTo` — nhanh hơn nhiều so với đợi thao tác xong mới sửa. Trả hàm dừng canh (cũng tự dừng sau `ms`).
   */
  guardForeground(windowId: number, backTo: number, openers: number[], ms: number): () => void;
  /** Hiện/gỡ viền sáng + nút Dừng trên trang. Trả false nếu không đặt được (tab đã đóng, trang hệ thống, chưa có quyền). Không bao giờ ném lỗi. */
  setPresence(tabId: number, state: PresenceState): Promise<boolean>;
  /** Đánh dấu một tab do trợ lý mở: gom vào nhóm tab màu xanh lam ngọc "Locaith AI" (phân biệt với tab của người dùng). Không bao giờ ném lỗi. */
  markAssistantTab(tabId: number): Promise<void>;
  /** Chạy được mã trong tab này không (đã có quyền truy cập)? Không đọc gì từ trang. */
  canAccess(tabId: number): Promise<boolean>;
  /** Đã cấp quyền đọc/điều khiển MỌI trang web (optional host permissions). */
  hasSiteAccess(): Promise<boolean>;
  requestSiteAccess(): Promise<boolean>;
  removeSiteAccess(): Promise<boolean>;
  /**
   * Bảo đảm tiện ích được gọi tới máy chủ của `url` (API tuỳ chỉnh, điểm cấp token…): đã có quyền thì trả true ngay, chưa có thì xin quyền theo ĐÚNG máy chủ đó
   * (cần một cử chỉ người dùng). Không xin quyền mọi trang chỉ vì một địa chỉ API.
   */
  ensureOrigin(url: string): Promise<boolean>;
  /** Theo dõi thay đổi tab (chuyển tab, điều hướng, đóng tab) và thay đổi quyền truy cập. Trả hàm huỷ. */
  onTabsChanged(cb: () => void): () => void;
  openExternal(url: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bản thật dùng chrome.*
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] };
const MAX_CAPTURE_EDGE = 1568;

function toLite(t: chrome.tabs.Tab): TabLite {
  return {
    id: t.id ?? -1,
    windowId: t.windowId,
    title: t.title ?? '',
    url: t.url ?? t.pendingUrl ?? '',
    active: !!t.active,
    status: t.status === 'loading' ? 'loading' : t.status === 'unloaded' ? 'unloaded' : 'complete',
    pinned: t.pinned,
    audible: t.audible,
    openerTabId: t.openerTabId,
  };
}

function detectBrowserName(): string {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.some((b) => /edge/i.test(b)) || /\bEdg\//.test(navigator.userAgent)) return 'Microsoft Edge';
  if (brands.some((b) => /google chrome/i.test(b)) || /\bChrome\//.test(navigator.userAgent)) return 'Google Chrome';
  return 'Chromium';
}

/** Trang của CHÍNH extension này (khung chat mở như tab, trình xem artifact…): không phải "trang web người dùng đang xem". */
function isOwnPage(url: string): boolean {
  return url.startsWith(chrome.runtime.getURL(''));
}

/** Tải ảnh data URL và thu nhỏ để tiết kiệm token (cạnh dài tối đa 1568 px — mức khuyến nghị cho ảnh đưa vào model). */
async function downscale(dataUrl: string, maxEdge: number): Promise<CapturedImage> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Không tạo được canvas để thu nhỏ ảnh.');
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mediaType: 'image/jpeg', base64: btoa(bin), width: w, height: h };
  } finally {
    bmp.close();
  }
}

export class ChromeBrowserApi implements BrowserApi {
  readonly name = detectBrowserName();
  private cachedWindowId: number | undefined;

  /** `fixedAnchorTabId`: chỉ dùng khi kiểm thử — mở khung chat như một tab thường thì "tab đang xem" phải được chỉ định tay. */
  constructor(private readonly opts: { fixedAnchorTabId?: number } = {}) {}

  async windowId(): Promise<number | undefined> {
    if (this.cachedWindowId !== undefined) return this.cachedWindowId;
    try {
      this.cachedWindowId = (await chrome.windows.getCurrent()).id;
    } catch {
      /* không xác định được cửa sổ → tìm tab đang xem trong cửa sổ được focus gần nhất */
    }
    return this.cachedWindowId;
  }

  async listTabs(): Promise<TabLite[]> {
    return (await chrome.tabs.query({})).filter((t) => t.id !== undefined).map(toLite);
  }

  async getTab(id: number): Promise<TabLite | null> {
    try {
      return toLite(await chrome.tabs.get(id));
    } catch {
      return null;
    }
  }

  async activeTab(): Promise<TabLite | null> {
    if (this.opts.fixedAnchorTabId !== undefined) return this.getTab(this.opts.fixedAnchorTabId);
    const windowId = await this.windowId();
    const query: chrome.tabs.QueryInfo = windowId !== undefined ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const tabs = (await chrome.tabs.query(query)).map(toLite).filter((t) => t.id >= 0 && !isOwnPage(t.url));
    return tabs[0] ?? null;
  }

  async createTab(url: string, opts: { active: boolean }): Promise<TabLite> {
    const windowId = await this.windowId();
    return toLite(await chrome.tabs.create({ url, active: opts.active, ...(windowId !== undefined ? { windowId } : {}) }));
  }

  async updateTab(id: number, patch: { url?: string; active?: boolean }): Promise<TabLite> {
    const t = await chrome.tabs.update(id, patch);
    if (!t) throw new Error(`Tab ${id} không còn.`);
    return toLite(t);
  }

  async closeTab(id: number): Promise<void> {
    await chrome.tabs.remove(id);
  }

  async history(id: number, direction: 'back' | 'forward'): Promise<void> {
    await (direction === 'back' ? chrome.tabs.goBack(id) : chrome.tabs.goForward(id));
  }

  async reload(id: number): Promise<void> {
    await chrome.tabs.reload(id);
  }

  waitForLoad(id: number, timeoutMs: number): Promise<TabLite | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        clearTimeout(timer);
        resolve(await this.getTab(id));
      };
      const onUpdated = (tabId: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (tabId === id && info.status === 'complete') void finish();
      };
      const onRemoved = (tabId: number) => {
        if (tabId === id) void finish();
      };
      const timer = setTimeout(() => void finish(), timeoutMs);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      // Có thể đã tải xong từ trước khi đăng ký nghe.
      void this.getTab(id).then((t) => {
        if (!t) void finish();
        else if (t.status === 'complete') setTimeout(() => void finish(), 50);
      });
    });
  }

  private callSeq = 0;

  /**
   * Lời gọi còn đang chạy trong CHÍNH tài liệu cũ không? Dùng khi tab báo "bắt đầu tải": điều hướng thật làm tài liệu cũ bị huỷ (lời gọi đang chạy
   * không bao giờ trả về), còn đổi đường dẫn kiểu SPA (pushState/replaceState) cũng phát sự kiện đó nhưng lời gọi vẫn chạy và sẽ hoàn tất.
   * 'yes' = còn chạy · 'no' = tài liệu mới/không còn runtime · 'unknown' = trang bận không trả lời kịp (cứ chờ tiếp).
   */
  private async stillRunning(tabId: number, callId: string): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const reply = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: (id: string) => (globalThis as unknown as { __ndRuntime?: { __inflight?: Set<string> } }).__ndRuntime?.__inflight?.has(id) === true, args: [callId] }),
        new Promise<'slow'>((r) => setTimeout(() => r('slow'), 1_000)),
      ]);
      if (reply === 'slow') return 'unknown';
      return reply?.[0]?.result === true ? 'yes' : 'no';
    } catch {
      return 'no'; // khung đã bị huỷ / tab không còn
    }
  }

  async callRuntime<T = any>(tabId: number, method: string, arg?: unknown): Promise<RuntimeResult<T>> {
    // Thao tác có thể làm trang điều hướng: lời gọi executeScript đôi khi KHÔNG BAO GIỜ trả về (khung bị huỷ giữa chừng) → phải có hạn chờ.
    const limit = ['click', 'type', 'press', 'selectOption', 'hover', 'scroll'].includes(method) ? 8_000 : 40_000;
    const timedOut = Symbol('timeout');
    const navStarted = Symbol('navigation');
    const LOADING = Symbol('loading');
    // Khi thao tác làm trang tải trang MỚI, khung chứa script bị huỷ và lời gọi executeScript không bao giờ trả về → nghe sự kiện
    // "tab bắt đầu tải" (status: loading) để biết sớm thay vì chờ hết hạn. Sự kiện này CŨNG phát khi SPA đổi đường dẫn (pushState) mà lời gọi vẫn
    // hoàn tất bình thường → sau sự kiện, kiểm tra định kỳ xem lời gọi có còn chạy trong tài liệu cũ không (stillRunning) rồi mới kết luận.
    const withLimit = async <R>(work: Promise<R>, callId: string): Promise<R | typeof timedOut | typeof navStarted> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listener: ((id: number, info: chrome.tabs.OnUpdatedInfo) => void) | undefined;
      let wake: ((v: typeof LOADING) => void) | undefined;
      let loadingSeen = false;
      const armLoading = () => new Promise<typeof LOADING>((r) => (wake = r));
      listener = (id, info) => {
        if (id === tabId && info.status === 'loading') wake?.(LOADING);
      };
      chrome.tabs.onUpdated.addListener(listener);
      const timeout = new Promise<typeof timedOut>((r) => (timer = setTimeout(() => r(timedOut), limit)));
      let loading = armLoading();
      try {
        for (;;) {
          const poll = loadingSeen ? new Promise<'poll'>((r) => setTimeout(() => r('poll'), 250)) : new Promise<never>(() => undefined);
          const r = await Promise.race([work, timeout, loading, poll]);
          if (r === LOADING) {
            loadingSeen = true;
            loading = armLoading();
          } else if (r !== 'poll') {
            return r as R | typeof timedOut;
          }
          if ((await this.stillRunning(tabId, callId)) === 'no') return navStarted;
        }
      } finally {
        clearTimeout(timer);
        if (listener) chrome.tabs.onUpdated.removeListener(listener);
      }
    };
    const call = async (callId: string) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async (m: string, a: unknown, id: string, v: number) => {
          const rt = (globalThis as unknown as { __ndRuntime?: Record<string, any> }).__ndRuntime;
          // Thiếu runtime, hoặc tab còn giữ bản cũ (mở từ trước khi tiện ích cập nhật) → nạp lại.
          if (!rt || rt.version !== v) return { __missing: true };
          if (typeof rt[m] !== 'function') return { __error: `Phương thức không tồn tại: ${m}` };
          // Tập các lời gọi đang chạy (không phải một giá trị đơn): nhiều lời gọi song song trên cùng tab không giẫm lên nhau.
          const running: Set<string> = (rt.__inflight ??= new Set<string>());
          running.add(id);
          try {
            return { __value: await rt[m](a) };
          } catch (e) {
            return { __error: e instanceof Error ? e.message : String(e) };
          } finally {
            running.delete(id);
          }
        },
        args: [method, arg ?? null, callId, RUNTIME_VERSION],
      });
      return res?.result as { __missing?: boolean; __value?: T; __error?: string } | undefined;
    };
    const run = () => {
      const callId = `${Date.now().toString(36)}-${++this.callSeq}`;
      return withLimit(call(callId), callId);
    };
    try {
      let r = await run();
      if (r === navStarted) return pageError('navigated', 'trang đang tải trang mới');
      if (r === timedOut) return await this.timeoutResult(tabId);
      if (r?.__missing) {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['page-runtime.js'] });
        r = await run();
        if (r === navStarted) return pageError('navigated', 'trang đang tải trang mới');
        if (r === timedOut) return await this.timeoutResult(tabId);
      }
      if (!r || r.__missing) return { ok: false, code: 'no_runtime', message: 'Không nạp được bộ đọc trang vào tab này.' };
      if (r.__error !== undefined) return { ok: false, code: 'page_error', message: r.__error };
      return { ok: true, value: r.__value as T };
    } catch (err) {
      return mapScriptError(err);
    }
  }

  /** Hết hạn chờ: tab đang tải → coi là đã điều hướng giữa chừng; còn lại là hết thời gian thật sự. */
  private async timeoutResult(tabId: number): Promise<RuntimeResult<never>> {
    const t = await this.getTab(tabId);
    if (!t) return pageError('no_tab');
    return t.status === 'loading' ? pageError('navigated', 'trang đang tải trang mới') : pageError('timeout');
  }

  async capture(tabId: number, opts: { allowFlip?: boolean } = {}): Promise<CapturedImage> {
    const tab = await chrome.tabs.get(tabId);
    // captureVisibleTab chỉ chụp được tab đang hiện. Tab nền: không tự chuyển tab của người dùng (nhấp nháy) trừ khi được phép; khi được phép thì đưa lên
    // trước MỘT LÚC, chụp xong trả người dùng về đúng tab họ đang xem.
    let backTo: number | undefined;
    if (!tab.active) {
      if (!opts.allowFlip) throw new BackgroundTabError();
      const [current] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      backTo = current?.id;
      await chrome.tabs.update(tabId, { active: true });
      await this.paintSettled(tabId);
    }
    // Ảnh gửi cho mô hình là trang sạch: ẩn viền sáng + nút Dừng của trợ lý trong lúc chụp.
    await this.pageCall(tabId, 'overlay', { hidden: true }, false);
    try {
      return await downscale(await this.captureVisible(tab.windowId), MAX_CAPTURE_EDGE);
    } finally {
      await this.pageCall(tabId, 'overlay', { hidden: false }, false);
      if (backTo !== undefined) await this.restoreActive(tab.windowId, tabId, backTo);
    }
  }

  /** Trình duyệt giới hạn ~2 lần chụp mỗi giây: gặp giới hạn thì chờ một nhịp rồi thử lại một lần. */
  private async captureVisible(windowId: number): Promise<string> {
    const shoot = () => chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
    try {
      return await shoot();
    } catch (err) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err instanceof Error ? err.message : err))) throw err;
      await new Promise((r) => setTimeout(r, 700));
      return shoot();
    }
  }

  /** Trả người dùng về tab cũ — trừ khi họ đã tự chuyển sang tab khác trong lúc chụp (khi đó đừng kéo họ đi đâu cả). */
  private async restoreActive(windowId: number, shownTabId: number, backTo: number): Promise<void> {
    try {
      const [now] = await chrome.tabs.query({ active: true, windowId });
      if (now?.id !== shownTabId) return;
      await chrome.tabs.update(backTo, { active: true });
    } catch {
      /* tab cũ đã đóng */
    }
  }

  /** Đợi trang vừa được đưa lên trước vẽ xong khung hình đầu tiên (tối đa ~0,7 s) để ảnh chụp không bị trống. */
  private async paintSettled(tabId: number): Promise<void> {
    try {
      await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          func: () =>
            new Promise<boolean>((resolve) => {
              const t = setTimeout(() => resolve(false), 600);
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  clearTimeout(t);
                  resolve(true);
                }),
              );
            }),
        }),
        new Promise((r) => setTimeout(r, 900)),
      ]);
    } catch {
      /* không chạy được mã trong tab (trang hệ thống): cứ chụp */
    }
  }

  /**
   * Gọi thẳng một phương thức của runtime KHÔNG qua `callRuntime`: không đụng tới theo dõi lời gọi đang chạy (nhịp gia hạn viền sáng chạy song song
   * với một cú bấm không được làm cú bấm bị coi là "trang đã chuyển"). `inject`: được phép nạp runtime nếu tab chưa có (gỡ viền thì không cần).
   */
  private async pageCall(tabId: number, method: string, arg: unknown, inject: boolean): Promise<boolean> {
    const run = async () => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async (m: string, a: unknown, v: number) => {
          const rt = (globalThis as unknown as { __ndRuntime?: Record<string, any> }).__ndRuntime;
          if (!rt || rt.version !== v || typeof rt[m] !== 'function') return false;
          await rt[m](a); // có phương thức bất đồng bộ (ẩn lớp phủ chờ khung hình được vẽ)
          return true;
        },
        args: [method, arg ?? null, RUNTIME_VERSION],
      });
      return res?.result === true;
    };
    try {
      if (await run()) return true;
      if (!inject) return false;
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['page-runtime.js'] });
      return await run();
    } catch {
      return false; // tab đã đóng / đang điều hướng / không có quyền
    }
  }

  async setPresence(tabId: number, state: PresenceState): Promise<boolean> {
    return state.on ? this.pageCall(tabId, 'presence', { on: true, label: state.label, stopLabel: state.stopLabel, ttlMs: state.ttlMs }, true) : this.pageCall(tabId, 'presence', { on: false }, false);
  }

  async markAssistantTab(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.pinned) return; // tab ghim không vào nhóm được
      const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title: ASSISTANT_GROUP_TITLE });
      const groupId = await chrome.tabs.group(group ? { tabIds: [tabId], groupId: group.id } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: ASSISTANT_GROUP_TITLE, color: 'cyan' });
    } catch {
      /* trình duyệt không hỗ trợ nhóm tab, cửa sổ dạng popup, hay tab đã đóng: chỉ là dấu hiệu nhận biết nên bỏ qua */
    }
  }

  guardForeground(windowId: number, backTo: number, openers: number[], ms: number): () => void {
    const born = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCreated = (t: chrome.tabs.Tab) => {
      if (t.id !== undefined && t.windowId === windowId && t.openerTabId !== undefined && openers.includes(t.openerTabId)) born.add(t.id);
    };
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId && born.has(info.tabId)) void chrome.tabs.update(backTo, { active: true }).catch(() => undefined);
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onActivated.removeListener(onActivated);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onActivated.addListener(onActivated);
    timer = setTimeout(stop, ms);
    return stop;
  }

  async canAccess(tabId: number): Promise<boolean> {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
      return r?.result === true;
    } catch {
      return false;
    }
  }

  async hasSiteAccess(): Promise<boolean> {
    try {
      return await chrome.permissions.contains(ALL_SITES);
    } catch {
      return false;
    }
  }

  async requestSiteAccess(): Promise<boolean> {
    try {
      return await chrome.permissions.request(ALL_SITES);
    } catch {
      return false;
    }
  }

  async removeSiteAccess(): Promise<boolean> {
    try {
      return await chrome.permissions.remove(ALL_SITES);
    } catch {
      return false;
    }
  }

  async ensureOrigin(url: string): Promise<boolean> {
    let pattern: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      pattern = `${u.protocol}//${u.hostname}/*`; // mẫu khớp không có cổng: `http://localhost/*` khớp mọi cổng
    } catch {
      return false;
    }
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
      return await chrome.permissions.request({ origins: [pattern] });
    } catch {
      return false;
    }
  }

  onTabsChanged(cb: () => void): () => void {
    const ev = [chrome.tabs.onActivated, chrome.tabs.onUpdated, chrome.tabs.onRemoved, chrome.tabs.onCreated, chrome.windows.onFocusChanged, chrome.permissions.onAdded, chrome.permissions.onRemoved] as {
      addListener(f: () => void): void;
      removeListener(f: () => void): void;
    }[];
    const handler = () => cb();
    for (const e of ev) e.addListener(handler);
    return () => {
      for (const e of ev) e.removeListener(handler);
    };
  }

  async openExternal(url: string): Promise<void> {
    await chrome.tabs.create({ url, active: true });
  }
}
