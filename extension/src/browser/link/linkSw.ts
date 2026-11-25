/**
 * Cầu nối VS Code (dịch vụ nền của bản Chrome / Edge) — phần phía Chrome của `src/core/chrome/bridge.ts`.
 *
 * Extension là bên CHỦ ĐỘNG gọi vào máy chủ cầu cục bộ của VS Code (127.0.0.1:47615–47620, long-poll): nhận lệnh, làm trên tab, trả kết quả.
 * (Bản ≤ 0.4.4 có tính năng này dưới dạng tệp vá; bản dựng lại từ src/browser 0.6.27 → 0.7.11 đã làm rơi nó. Đây là mã nguồn thật, có test.)
 *
 * (0.7.20) Không chỉ VS Code: mọi ỨNG DỤNG TRÊN MÁY có máy chủ cầu (VS Code, bản desktop Locaith Work…) — mỗi ứng dụng một token (LINK_APPS),
 * và ứng dụng tự khởi xướng được việc ghép đôi: nó mở trang /link của nó trong trình duyệt người dùng đang dùng, trang chuyển vé cho ta (onMessageExternal).
 *
 * An toàn:
 *  • TẮT mặc định. Chỉ chạy khi người dùng bật công tắc «Kết nối với ứng dụng trên máy» trong Cài đặt và bấm «Cho phép» ở thẻ ghép đôi trong ứng dụng,
 *    hoặc bấm «Kết nối trình duyệt» trong ứng dụng rồi «Kết nối» ở cửa sổ nhỏ của tiện ích;
 *  • chưa đồng ý thông báo dữ liệu của tiện ích (cổng đồng ý) thì không nối;
 *  • mọi thao tác trên MỘT trang cần người dùng duyệt NGAY TRONG Chrome theo từng trang (origin): «Cho phép lần này» / «Luôn cho phép trang này» / «Từ chối»;
 *    danh sách tab chỉ lộ tên miền của trang chưa duyệt; chỉ trang http/https;
 *  • không có dữ liệu nào đi tới máy chủ của Locaith: cầu nối chỉ nói chuyện với ứng dụng trên CHÍNH máy này (127.0.0.1);
 *  • tin từ trang /link chỉ được nhận từ http://127.0.0.1 | localhost ở đúng cổng cầu nối, và vẫn cần người dùng bấm «Kết nối» trong trình duyệt.
 */

import { consentGate } from '../consent';
import { LINK_PROTO } from '../../shared/linkProtocol';
import { inPage, type InPageArgs, type InPageKind } from './inPage';
import { originOf, permPattern } from './origin';

export { originOf, permPattern };

export const LINK_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619, 47620];
/** Khoá lưu trữ giữ nguyên như bản ≤ 0.4.4 (người nâng cấp từ bản cũ không phải ghép đôi lại). */
export const LINK_KEY = 'nd.bridge';
export const LINK_ON = 'nd.bridge.on';
export const LINK_ALLOW = 'nd.bridge.allow';
export const LINK_ALARM = 'nd-bridge-tick';
/** (0.7.17) Nhớ «ứng dụng không còn nhận token của trình duyệt này» để Cài đặt vẫn nói rõ sau khi dịch vụ nền khởi động lại (số = thời điểm; từ 0.7.20 có thể kèm tên ứng dụng). */
export const LINK_LOST = 'nd.bridge.lost';
/**
 * (0.7.20) MỖI ỨNG DỤNG MỘT token: `{ [kind]: { token, name, at } }` — `kind` do máy chủ cầu tự khai ở /v1/hello (mọi cửa sổ VS Code dùng chung `vscode`,
 * bản desktop Locaith Work là `work`). Token cũ ở LINK_KEY (chưa biết của ứng dụng nào) được thử ở mọi cổng rồi tự chuyển sang đúng ứng dụng nhận nó.
 */
export const LINK_APPS = 'nd.bridge.apps';
/** Khoá tạm cho token chưa rõ chủ (từ bản ≤ 0.7.19, hoặc máy chủ cầu cũ không có /v1/hello). */
const LEGACY = '?';
const APP_KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{24}$/;
/** (0.7.17) Chưa thấy cửa sổ VS Code nào: dò lại thưa dần, bắt đầu 15 giây, gấp đôi mỗi lần, tối đa 5 phút (theo nhịp báo thức 30 giây). */
export const SCAN_MIN_MS = 15_000;
export const SCAN_MAX_MS = 5 * 60_000;

export type PairState = 'idle' | 'asking' | 'waiting' | 'denied' | 'expired' | 'not_found' | 'busy' | 'old' | 'consent' | 'lost';

export interface LinkStatus {
  paired: boolean;
  on: boolean;
  running: boolean;
  connected: boolean;
  pairing: PairState;
  ports: number[];
  /** Trang đã «Luôn cho phép». */
  allowed: string[];
  /** Trang chỉ cho phép trong phiên này. */
  session: string[];
  /** Cổng đồng ý về dữ liệu đã được bấm Đồng ý. */
  consent: boolean;
  /** (0.7.20) Từng ứng dụng đã ghép đôi: tên tự khai và đang nối hay không. */
  apps: { kind: string; name: string; connected: boolean }[];
  /** (0.7.20) Tên các ứng dụng vừa không còn nhận trình duyệt này (để Cài đặt nói rõ). */
  lost: string[];
}

export interface LinkOptions {
  ports?: readonly number[];
  /** Bản --test (e2e) không có cổng đồng ý và coi như đã đồng ý. */
  testBuild?: boolean;
  /** Thay `fetch` (test cần gắn Origin chrome-extension://…, thứ trình duyệt tự gắn). */
  fetch?: typeof fetch;
  approveMs?: number;
  /** Đồng hồ cho lịch dò VS Code (test thay để khỏi chờ thật 15 giây – 5 phút). */
  now?: () => number;
}

export interface LinkApi {
  status(): Promise<LinkStatus>;
  toggle(on: boolean): Promise<LinkStatus>;
  /** Dừng mọi vòng hỏi (dùng trong test). */
  shutdown(): void;
  /** Chạy một lệnh như thể ứng dụng gửi tới (test). `via` = tên ứng dụng gửi lệnh (hiện trong cửa sổ hỏi duyệt trang). */
  runOp(op: string, args: Record<string, unknown>, via?: string): Promise<unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const touchWorker = (): void => {
  try {
    void chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  } catch {
    /* ngữ cảnh tiện ích đã bị huỷ (cập nhật / gỡ): không sao */
  }
};
/** Chờ sau lần lỗi thứ n của một cửa sổ VS Code đang nối: 4 s, 8 s… (tối đa 30 s). */
const backoff = (n: number): number => Math.min(30_000, 2000 * 2 ** n);
/** Một cửa sổ VS Code đang nối mà lỗi liền bấy nhiêu lần (đã đóng / treo) thì thôi giữ vòng chờ của nó; nhịp báo thức sẽ dò lại thưa dần. */
const POLL_MAX_FAILS = 3;
/** Gắn dấu giao thức vào yêu cầu có token (xem shared/linkProtocol.ts). */
const withProto = (p: string): string => `${p}${p.includes('?') ? '&' : '?'}v=${LINK_PROTO}`;

/** Câu trả lời ĐÃ ĐỌC XONG của máy chủ cầu — không bao giờ là một Response còn sống (xem `call`). */
interface Reply {
  status: number;
  ok: boolean;
  data: unknown;
}
type Job = { id: string; op: string; args?: Record<string, unknown> };

export function installLink(opts: LinkOptions = {}): LinkApi {
  let PORTS: readonly number[] = opts.ports ?? LINK_PORTS;
  // Chỉ bản --test (e2e, hằng số lúc build nên nhánh này bị loại khỏi bản phát hành): trỏ cầu nối sang máy chủ cầu GIẢ ở cổng khác để không chạm VS Code thật của người chạy test.
  const refreshPorts = async (): Promise<void> => {
    if (!opts.testBuild || opts.ports) return;
    const t = (await chrome.storage.local.get('nd.test.linkPorts'))['nd.test.linkPorts'];
    if (Array.isArray(t)) PORTS = t.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536);
  };
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  const approveMs = opts.approveMs ?? 150_000;
  const clock = opts.now ?? (() => Date.now());
  /** Cổng đang có vòng chờ lệnh → ứng dụng (kind) của cổng đó. */
  const portKind = new Map<number, string>();
  const waiting = new Map<string, { origin: string; decided: boolean; done: (d: string, reason?: string) => void }>();
  const pending = new Map<string, Promise<{ d: string; reason?: string }>>();
  /** (0.7.20) Token theo ứng dụng: kind → { token, name }. LEGACY = token cũ chưa rõ chủ. */
  const apps = new Map<string, { token: string; name: string }>();
  /** Lần gần nhất mỗi ứng dụng trả lời hợp lệ: «đã kết nối» = trong vòng 45 giây. */
  const okAt = new Map<string, number>();
  let running = false;
  let pairState: PairState = 'idle';
  let pairRun = 0; // số thứ tự lần xin: tắt công tắc giữa chừng thì lần cũ tự dừng
  let stopCtl = new AbortController(); // tắt / mất ghép đôi / dừng: huỷ NGAY mọi yêu cầu đang bay (kể cả long-poll 20 giây)
  let scanning: Promise<void> | null = null;
  let nextScanAt = 0;
  let scanDelay = SCAN_MIN_MS;

  const consentOk = async (): Promise<boolean> => {
    if (opts.testBuild) return true;
    const g = consentGate();
    return g ? g.ok().catch(() => false) : false;
  };
  // sendMessage có thể ném lỗi ĐỒNG BỘ (ngữ cảnh tiện ích đã bị huỷ): không để nó thoát ra khỏi vòng chờ / khối finally.
  const changed = (): void => {
    try {
      void Promise.resolve(chrome.runtime.sendMessage({ type: 'nd-link-changed' })).catch(() => undefined);
    } catch {
      /* không có khung nào đang nghe */
    }
  };
  const setPair = (s: PairState): void => {
    pairState = s;
    changed();
  };
  const appConnected = (kind: string): boolean => running && Date.now() - (okAt.get(kind) ?? 0) < 45_000;
  const connected = (): boolean => [...apps.keys()].some(appConnected);
  const bearer = (token: string): Record<string, string> => ({ authorization: 'Bearer ' + token });
  const hasTokens = (): boolean => apps.size > 0;
  const validApp = (a: unknown): { kind: string; name: string } | null => {
    const x = a as { kind?: unknown; name?: unknown } | null | undefined;
    return x && typeof x.kind === 'string' && APP_KIND_RE.test(x.kind) ? { kind: x.kind, name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 40) : x.kind } : null;
  };

  /** Đọc token theo ứng dụng (LINK_APPS) + token cũ chưa rõ chủ (LINK_KEY). Trả về có token nào không. */
  async function loadTokens(): Promise<boolean> {
    const o = await chrome.storage.local.get([LINK_APPS, LINK_KEY]);
    apps.clear();
    const m = (o[LINK_APPS] ?? {}) as Record<string, { token?: unknown; name?: unknown }>;
    for (const [k, v] of Object.entries(m)) {
      if (APP_KIND_RE.test(k) && typeof v?.token === 'string' && v.token) apps.set(k, { token: v.token, name: typeof v.name === 'string' ? v.name.slice(0, 40) : k });
    }
    const legacy = (o[LINK_KEY] as { token?: unknown } | undefined)?.token;
    if (typeof legacy === 'string' && legacy && ![...apps.values()].some((a) => a.token === legacy)) apps.set(LEGACY, { token: legacy, name: '' });
    return apps.size > 0;
  }

  async function saveTokens(): Promise<void> {
    const out: Record<string, { token: string; name: string; at: number }> = {};
    for (const [k, v] of apps) if (k !== LEGACY) out[k] = { token: v.token, name: v.name, at: Date.now() };
    await chrome.storage.local.set({ [LINK_APPS]: out });
    const legacy = apps.get(LEGACY);
    if (legacy) await chrome.storage.local.set({ [LINK_KEY]: { token: legacy.token } });
    else await chrome.storage.local.remove(LINK_KEY);
  }

  /** Ghi token mới của một ứng dụng (ghép đôi xong) và bỏ thông báo «mất ghép đôi». */
  async function addApp(kind: string, token: string, name: string): Promise<void> {
    await loadTokens(); // dịch vụ nền có thể vừa khởi động lại: lấy đúng những gì đang lưu
    apps.set(kind, { token, name: name || apps.get(kind)?.name || '' });
    await saveTokens();
    await chrome.storage.local.remove(LINK_LOST);
  }
  const isOn = async (): Promise<boolean> => (await chrome.storage.local.get(LINK_ON))[LINK_ON] !== false;

  /**
   * Gọi máy chủ cầu của VS Code và LUÔN giải phóng thân câu trả lời — đọc hết, hoặc huỷ nếu lỗi / quá giờ / bị dừng.
   * Bài học 0.7.12: thân câu trả lời 401 bị bỏ quên, mỗi lần Chrome giữ lại một vùng nhớ dùng chung 2 MB không bao giờ trả
   * (máy thật 25/11/2026: 1.371 vùng = 2,7 GB trong một tiến trình tiện ích, bộ nhớ cam kết của Windows tăng ~4 GB/giờ, máy treo sau một ngày).
   * Hàm này không trả Response ra ngoài, chỉ trả mã trạng thái và JSON đã đọc — nơi gọi không thể quên giải phóng.
   */
  async function call(port: number, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Reply> {
    const ctl = new AbortController();
    const stopSig = stopCtl.signal;
    const abort = (): void => ctl.abort();
    if (stopSig.aborted) abort();
    else stopSig.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let res: Response | undefined;
    try {
      res = await doFetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: ctl.signal });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, ok: res.ok, data };
    } finally {
      clearTimeout(timer);
      stopSig.removeEventListener('abort', abort);
      if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
    }
  }

  async function start(): Promise<boolean> {
    await refreshPorts();
    if (!(await loadTokens())) return false;
    if (!(await isOn())) return false;
    if (!(await consentOk())) return false;
    if (!running) {
      running = true;
      nextScanAt = 0;
      scanDelay = SCAN_MIN_MS;
    }
    chrome.alarms.create(LINK_ALARM, { periodInMinutes: 0.5 });
    changed();
    await scan();
    return true;
  }

  /** Dừng mọi thứ đang chạy: hạ cờ, huỷ ngay các yêu cầu đang bay, bỏ nhịp báo thức. */
  function halt(): void {
    running = false;
    stopCtl.abort();
    stopCtl = new AbortController();
    void chrome.alarms.clear(LINK_ALARM);
  }

  function stop(): void {
    halt();
    changed();
  }

  /**
   * Các ứng dụng `kinds` có mặt nhưng KHÔNG cổng nào của chúng nhận token của trình duyệt này (đã ghép đôi với hồ sơ / trình duyệt khác, hoặc đã huỷ ghép đôi):
   * bỏ token của RIÊNG các ứng dụng đó (ứng dụng khác vẫn nối), nhớ tên để Cài đặt nói rõ. Không còn token nào → dừng hẳn và tắt công tắc.
   * KHÔNG tự thử lại — bản 0.7.12 thử lại mỗi 7 giây mãi mãi và rò bộ nhớ.
   */
  async function lose(kinds: string[]): Promise<void> {
    const names = kinds.map((k) => apps.get(k)?.name || '').filter(Boolean);
    for (const k of kinds) {
      apps.delete(k);
      okAt.delete(k);
    }
    await saveTokens();
    await chrome.storage.local.set({ [LINK_LOST]: { at: Date.now(), apps: names } });
    if (!hasTokens()) {
      halt();
      await chrome.storage.local.set({ [LINK_ON]: false });
    }
    setPair('lost');
  }

  /**
   * Hỏi máy chủ cầu ở `port` là ứng dụng nào (không token). null = máy chủ cũ (≤ 0.7.19) không có /v1/hello; ném lỗi = không có ứng dụng ở cổng đó.
   * PHẢI có dấu ?v=2: máy chủ 0.7.18–0.7.19 coi GET không dấu, không token từ trình duyệt là tiện ích bản cũ đang rò và GIỮ nó 45 giây không trả lời.
   */
  async function helloApp(port: number): Promise<{ kind: string; name: string } | null> {
    const h = await call(port, withProto('/v1/hello'), {}, 3000);
    return h.status === 200 ? validApp((h.data as { app?: unknown } | undefined)?.app) : null;
  }

  /**
   * Dò MỘT cổng: biết ứng dụng qua /v1/hello rồi thử đúng token của ứng dụng đó (cộng token cũ chưa rõ chủ); máy chủ cũ thì thử mọi token.
   * Cổng nhận token → mở vòng chờ cho cổng đó. `refused`: token (theo khoá) mà lời từ chối của cổng này CHỨNG MINH là hết hiệu lực:
   *  • máy chủ mới từ chối token của CHÍNH ứng dụng nó (mọi cửa sổ cùng ứng dụng dùng chung một token);
   *  • token cũ chưa rõ chủ (từ bản ≤ 0.7.19 — khi ấy chỉ ghép với VS Code) bị VS Code bản mới hoặc một máy chủ cũ từ chối.
   * Lời từ chối khác không chứng minh gì (vd. Locaith Work từ chối token của VS Code đang đóng) → không được làm mất token đó.
   */
  async function probe(port: number): Promise<{ accepted?: string; refused: string[] }> {
    const refused: string[] = [];
    let app: { kind: string; name: string } | null;
    try {
      app = await helloApp(port);
    } catch {
      return { refused }; // không có ứng dụng ở cổng này (hoặc không trả lời kịp)
    }
    const cands = app ? [app.kind, LEGACY].filter((k) => apps.has(k)) : [...apps.keys()];
    for (const k of cands) {
      const tok = apps.get(k)?.token;
      if (!tok || !running) continue;
      let r: Reply;
      try {
        r = await call(port, withProto('/v1/ping'), { headers: bearer(tok) }, 5000);
      } catch {
        return { refused };
      }
      if (r.status === 200) {
        // máy chủ cũ (không /v1/hello) thì giữ nguyên khoá: không biết được đó là VS Code hay ứng dụng khác
        const kind = app?.kind ?? k;
        const name = app?.name || apps.get(k)?.name || '';
        if (k !== kind || apps.get(kind)?.name !== name) {
          // token cũ chưa rõ chủ → chuyển sang đúng ứng dụng đã nhận nó; hoặc ứng dụng vừa đổi tên hiển thị
          if (k !== kind) apps.delete(k);
          apps.set(kind, { token: tok, name });
          await saveTokens();
        }
        okAt.set(kind, Date.now());
        void pollLoop(port, kind);
        return { accepted: kind, refused };
      }
      if (r.status === 401 || r.status === 403) {
        const proves = app ? k === app.kind || (k === LEGACY && app.kind === 'vscode') : k === LEGACY;
        if (proves) refused.push(k);
        const e = apps.get(k);
        if (proves && app && e && !e.name) e.name = app.name; // để Cài đặt nói đúng tên ứng dụng đã ngắt
      }
    }
    return { refused };
  }

  /**
   * Dò các cổng CHƯA có vòng chờ:
   *  • cổng nhận token của ứng dụng của nó → mở vòng chờ lệnh cho ĐÚNG cổng đó;
   *  • không có ứng dụng (cổng đóng) → không giữ gì, không giữ dịch vụ nền thức; lần dò sau thưa dần 15 giây → 5 phút;
   *  • ứng dụng có mặt mà không cổng nào của nó nhận token → `lose()` bỏ token của RIÊNG ứng dụng đó.
   */
  function scan(): Promise<void> {
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        if (!running || !hasTokens()) return;
        const free = PORTS.filter((p) => !portKind.has(p));
        const res = await Promise.all(free.map((p) => probe(p)));
        if (!running || !hasTokens()) return;
        const accepted = new Set<string>(portKind.values());
        for (const r of res) if (r.accepted) accepted.add(r.accepted);
        if (res.some((r) => r.accepted)) {
          scanDelay = SCAN_MIN_MS;
          nextScanAt = 0;
          changed();
        }
        const lost = [...new Set(res.flatMap((r) => r.refused))].filter((k) => apps.has(k) && !accepted.has(k));
        if (lost.length) {
          await lose(lost);
          if (!hasTokens()) return;
        }
        if (!portKind.size) {
          nextScanAt = clock() + scanDelay;
          scanDelay = Math.min(SCAN_MAX_MS, scanDelay * 2);
        }
      } finally {
        scanning = null;
      }
    })();
    return scanning;
  }

  /**
   * Vòng chờ lệnh (long-poll) tới MỘT cửa sổ VS Code đã nhận token của ta (do `scan` mở).
   *  • 200 → nhận việc (nếu có) và hỏi tiếp; máy chủ trả ngay mà không có việc thì nghỉ 1 giây (không quay vòng nóng);
   *  • 401 / 403 → cửa sổ này không còn nhận ta: thôi hẳn, KHÔNG hỏi lại (0.7.12 hỏi lại mỗi 7 giây mãi mãi);
   *  • lỗi mạng / lỗi máy chủ → chờ 4 s, 8 s; lỗi liền 3 lần (VS Code đã đóng) thì thôi giữ vòng, nhịp báo thức dò lại thưa dần.
   */
  async function pollLoop(port: number, kind: string): Promise<void> {
    if (portKind.has(port)) return;
    portKind.set(port, kind);
    let fails = 0;
    let refused = false;
    try {
      while (running && apps.has(kind)) {
        touchWorker(); // đang nối: giữ dịch vụ nền sống để nhận lệnh kịp thời
        const t0 = Date.now();
        const tok = apps.get(kind)?.token ?? '';
        let r: Reply;
        try {
          r = await call(port, withProto('/v1/poll?wait=20'), { headers: bearer(tok) }, 35_000);
        } catch {
          if (!running || ++fails >= POLL_MAX_FAILS) break;
          await sleep(backoff(fails));
          continue;
        }
        if (r.ok) {
          fails = 0;
          okAt.set(kind, Date.now());
          const job = (r.data as { job?: Job } | undefined)?.job;
          if (job) void run(port, kind, job);
          else if (Date.now() - t0 < 1000) await sleep(1000);
          continue;
        }
        if (r.status === 401 || r.status === 403) {
          refused = true;
          break;
        }
        if (++fails >= POLL_MAX_FAILS) break;
        await sleep(backoff(fails));
      }
    } finally {
      portKind.delete(port);
      changed();
      if (running && hasTokens()) {
        if (refused && ![...portKind.values()].includes(kind)) void scan(); // token của ứng dụng này bị từ chối: dò lại — không cổng nào của nó nhận nữa thì bỏ token của RIÊNG nó
        else if (!portKind.size) {
          nextScanAt = clock() + scanDelay; // ứng dụng đã đóng: để nhịp báo thức dò lại thưa dần
          scanDelay = Math.min(SCAN_MAX_MS, scanDelay * 2);
        }
      }
    }
  }

  async function run(port: number, kind: string, job: Job): Promise<void> {
    let out: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      out = { ok: true, data: await runOp(job.op, job.args ?? {}, apps.get(kind)?.name) };
    } catch (e) {
      out = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    const tok = apps.get(kind)?.token;
    if (!tok) return;
    try {
      await call(port, withProto('/v1/result'), { method: 'POST', headers: { ...bearer(tok), 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ...out }) }, 30_000);
    } catch (e) {
      console.error('[Locaith AI] cầu nối ứng dụng trên máy: không trả được kết quả', e);
    }
  }

  // ── ghép đôi KHÔNG MÃ ─────────────────────────────────────────────────────────
  // Bật công tắc → xin kết nối tới MỌI cổng VS Code; VS Code hiện thẻ «Cho phép / Từ chối» trong khung chat của nó; người dùng bấm Cho phép → ta nhận token MỘT lần, lưu rồi nối.
  const post = (port: number, path: string, body?: unknown): Promise<Reply> =>
    call(port, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }, 8000);
  const cancelAsked = (list: ({ port: number; id?: string } | null)[]): void => {
    for (const x of list) if (x && x.id) post(x.port, '/v1/pair/cancel', { id: x.id }).catch(() => undefined);
  };

  async function requestPairing(): Promise<void> {
    await refreshPorts();
    const me = ++pairRun;
    await chrome.storage.local.remove(LINK_LOST);
    setPair('asking');
    const asked = await Promise.all(
      PORTS.map(async (port) => {
        try {
          const r = await post(port, '/v1/pair/request');
          const j = (r.data ?? {}) as { id?: string; error?: string };
          return r.ok && j.id ? { port, id: j.id } : { port, status: r.status, error: j.error };
        } catch {
          return null; // không có VS Code ở cổng này
        }
      }),
    );
    if (me !== pairRun) return cancelAsked(asked as { port: number; id?: string }[]); // công tắc đã tắt trong lúc hỏi
    const live = asked.filter((x): x is { port: number; id: string } => !!x && 'id' in x && !!x.id);
    if (!live.length) {
      const any = asked.filter(Boolean) as { error?: string }[];
      setPair(any.some((x) => x.error === 'busy' || x.error === 'rate_limited') ? 'busy' : any.length ? 'old' : 'not_found');
      await chrome.storage.local.set({ [LINK_ON]: false });
      stop(); // công tắc đã tắt: không để vòng nào chạy ngầm
      return;
    }
    setPair('waiting');
    const end = Date.now() + 125_000;
    while (me === pairRun && Date.now() < end) {
      touchWorker(); // giữ dịch vụ nền sống trong lúc chờ người dùng
      let denied = 0;
      let gone = 0;
      let old = 0;
      for (const x of live) {
        try {
          // POST, không phải GET: Chrome KHÔNG gắn tiêu đề Origin vào yêu cầu GET gửi từ extension (đã đo, cả Chrome lẫn Edge) mà máy chủ cầu cần Origin để biết extension nào đang hỏi;
          // POST thì luôn có Origin. VS Code bản cũ (chưa có POST /v1/pair/status) trả 404 → thử GET kiểu cũ (nó cũng sẽ bị từ chối → báo «VS Code quá cũ» bên dưới).
          let r = await post(x.port, '/v1/pair/status', { id: x.id });
          if (r.status === 404) r = await call(x.port, `/v1/pair/status?id=${encodeURIComponent(x.id)}`, {}, 8000);
          const j = (r.data ?? {}) as { state?: string; token?: string; error?: string; app?: unknown };
          if (r.status === 404 || j.error === 'origin') {
            old++;
            continue;
          }
          if (j.state === 'approved' && j.token) {
            if (me !== pairRun) return;
            // (0.7.20) token này thuộc ứng dụng nào: máy chủ mới trả kèm `app`; máy chủ cũ thì hỏi /v1/hello; vẫn không rõ → để «chưa rõ chủ», lần dò tự nhận
            const app = validApp(j.app) ?? (await helloApp(x.port).catch(() => null));
            await addApp(app?.kind ?? LEGACY, j.token, app?.name ?? '');
            await chrome.storage.local.set({ [LINK_ON]: true });
            cancelAsked(live.filter((y) => y !== x));
            setPair('idle');
            await start();
            return;
          }
          if (j.state === 'denied') denied++;
          else if (j.state === 'expired') gone++;
        } catch {
          gone++;
        }
      }
      if (old === live.length) {
        setPair('old'); // mọi VS Code tìm thấy đều là bản cũ chưa hỗ trợ ghép đôi không mã từ bản Chrome này
        await chrome.storage.local.set({ [LINK_ON]: false });
        stop();
        cancelAsked(live);
        return;
      }
      if (denied + gone === live.length) {
        setPair(denied > 0 ? 'denied' : 'expired');
        await chrome.storage.local.set({ [LINK_ON]: false });
        stop();
        return;
      }
      await sleep(1000);
    }
    if (me === pairRun) {
      setPair('expired');
      await chrome.storage.local.set({ [LINK_ON]: false });
      stop();
      cancelAsked(live);
    }
  }

  async function status(): Promise<LinkStatus> {
    const [l, s, ok] = await Promise.all([chrome.storage.local.get([LINK_ALLOW, LINK_ON, LINK_LOST]), chrome.storage.session.get(LINK_ALLOW), consentOk()]);
    if (!running) await loadTokens(); // đang chạy thì bản trong bộ nhớ là đúng nhất; chưa chạy thì đọc từ kho để hiện
    const paired = hasTokens();
    const on = l[LINK_ON] === undefined ? paired : l[LINK_ON] === true; // bản cũ: có token = bật; cài mới chưa ghép = tắt
    const lostRaw = l[LINK_LOST] as number | { apps?: unknown } | undefined;
    const lost = lostRaw && typeof lostRaw === 'object' && Array.isArray(lostRaw.apps) ? lostRaw.apps.filter((x): x is string => typeof x === 'string') : [];
    const pairing: PairState = pairState === 'idle' && lostRaw ? 'lost' : pairState; // còn nhớ sau khi dịch vụ nền khởi động lại
    const list = [...apps.entries()].map(([kind, v]) => ({ kind, name: v.name, connected: appConnected(kind) }));
    return { paired, on, running, connected: connected(), pairing, ports: [...portKind.keys()], allowed: (l[LINK_ALLOW] as string[]) || [], session: (s[LINK_ALLOW] as string[]) || [], consent: ok, apps: list, lost };
  }

  async function toggle(on: boolean): Promise<LinkStatus> {
    if (!on) {
      pairRun++; // dừng lần xin đang chờ (nếu có)
      pairState = 'idle';
      await chrome.storage.local.set({ [LINK_ON]: false });
      stop();
      return status();
    }
    if (!(await consentOk())) {
      // Chưa đồng ý thông báo dữ liệu: không nối, không xin ghép đôi. (Khung chat vốn chặn bằng lớp phủ đồng ý; đây là chốt chặn thứ hai.)
      setPair('consent');
      return status();
    }
    await chrome.storage.local.set({ [LINK_ON]: true });
    await chrome.storage.local.remove(LINK_LOST);
    pairState = 'idle';
    if (await loadTokens()) {
      await start();
      // Đã ghép từ trước: nối ngay. Không nối được trong vài giây (ứng dụng đóng, hoặc token đã bị thu hồi / ghép nơi khác) thì xin lại như lần đầu.
      for (let i = 0; i < 16 && !connected(); i++) await sleep(250);
      if (!connected()) {
        await chrome.storage.local.set({ [LINK_ON]: true }); // `lose()` có thể vừa tắt nó khi thấy token bị từ chối
        void requestPairing();
      }
      return status();
    }
    void requestPairing();
    return status();
  }

  // ── duyệt theo trang (origin) ─────────────────────────────────────────────────
  async function isAllowed(origin: string): Promise<boolean> {
    const [s, l] = await Promise.all([chrome.storage.session.get(LINK_ALLOW), chrome.storage.local.get(LINK_ALLOW)]);
    if (!(((s[LINK_ALLOW] as string[]) || []).includes(origin) || ((l[LINK_ALLOW] as string[]) || []).includes(origin))) return false;
    return chrome.permissions.contains({ origins: [permPattern(origin)] }); // người dùng có thể đã thu hồi quyền trang ở chrome://extensions
  }

  async function remember(origin: string, decision: 'once' | 'always'): Promise<void> {
    const area = decision === 'always' ? chrome.storage.local : chrome.storage.session;
    const cur = (((await area.get(LINK_ALLOW))[LINK_ALLOW] as string[]) || []).filter((o) => o !== origin);
    await area.set({ [LINK_ALLOW]: [...cur, origin] });
  }

  function askApproval(origin: string, via?: string): Promise<{ d: string; reason?: string }> {
    const existing = pending.get(origin);
    if (existing) return existing;
    const req = Math.random().toString(36).slice(2);
    let winId: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = new Promise<{ d: string; reason?: string }>((resolve) => {
      // `decided`: cửa sổ tự đóng ngay sau khi gửi quyết định — việc đóng đó KHÔNG được tính là từ chối.
      const entry = { origin, decided: false, done: (d: string, reason?: string) => finish(d, reason) };
      const onClose = (id: number): void => {
        if (id === winId && !entry.decided) finish('deny', 'closed');
      };
      const finish = (d: string, reason?: string): void => {
        if (!waiting.has(req)) return;
        waiting.delete(req);
        if (timer) clearTimeout(timer);
        chrome.windows.onRemoved.removeListener(onClose);
        if (winId !== undefined) void Promise.resolve(chrome.windows.remove(winId)).catch(() => undefined);
        resolve({ d, reason });
      };
      waiting.set(req, entry);
      timer = setTimeout(() => finish('deny', 'timeout'), approveMs);
      chrome.windows.onRemoved.addListener(onClose);
      Promise.resolve(chrome.windows.create({ url: chrome.runtime.getURL(`bridge-approve.html?req=${req}&origin=${encodeURIComponent(origin)}&app=${encodeURIComponent(via ?? '')}`), type: 'popup', width: 460, height: 380, focused: true }))
        .then((w) => (winId = w?.id))
        .catch((e) => finish('deny', 'popup: ' + String((e as Error)?.message ?? e)));
    }).finally(() => pending.delete(origin));
    pending.set(origin, p);
    return p;
  }

  async function ensureAccess(url: string | undefined, via?: string): Promise<string> {
    if (!url) throw new Error('Không đọc được địa chỉ của tab. Cho phép «tabs» khi trình duyệt hỏi lúc kết nối với ứng dụng trên máy, hoặc mở trang bằng lệnh tab.open.');
    const origin = originOf(url);
    if (await isAllowed(origin)) return origin;
    const r = await askApproval(origin, via);
    if (r.d === 'deny') {
      const why =
        r.reason === 'closed'
          ? `Cửa sổ xác nhận trong Chrome đã bị đóng mà chưa có quyết định cho ${origin}.`
          : r.reason === 'timeout'
            ? `Hết thời gian chờ bạn xác nhận cho ${origin} trong Chrome.`
            : r.reason
              ? `Chrome không cấp được quyền cho ${origin}: ${r.reason}`
              : `Người dùng đã từ chối cho trợ lý điều khiển ${origin} trong Chrome.`;
      throw new Error(why);
    }
    return origin;
  }

  // ── thao tác trên tab ─────────────────────────────────────────────────────────
  async function getTab(id: unknown): Promise<chrome.tabs.Tab> {
    if (id !== undefined && id !== null) return chrome.tabs.get(Number(id));
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!t) throw new Error('Không có tab nào đang mở.');
    return t;
  }

  async function waitComplete(tabId: number, ms: number): Promise<chrome.tabs.Tab> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return t;
      await sleep(250);
    }
    return chrome.tabs.get(tabId);
  }

  async function onPage(a: Record<string, unknown>, kind: InPageKind): Promise<Record<string, unknown>> {
    const tab = await getTab(a.tabId);
    await ensureAccess(tab.url, a.__via as string | undefined);
    const { __via: _via, ...pageArgs } = a; // tên ứng dụng chỉ dùng cho cửa sổ hỏi duyệt, không đưa vào trang
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, func: inPage, args: [kind, pageArgs as InPageArgs] });
    if (!r) throw new Error('Không chạy được trên trang này.');
    const res = (r.result || {}) as Record<string, unknown>;
    if (res.ok === false) throw new Error(String(res.error || 'Thao tác thất bại.'));
    return { tabId: tab.id, ...res };
  }

  const OPS: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
    ping: async () => ({ v: 1, extension: chrome.runtime.id }),
    'tabs.list': async () => {
      const out: Record<string, unknown>[] = [];
      for (const t of await chrome.tabs.query({})) {
        if (!t.url) {
          out.push({ id: t.id, windowId: t.windowId, active: t.active, restricted: true });
          continue;
        }
        let origin = '';
        try {
          origin = originOf(t.url);
        } catch {
          continue; // chrome://, tab trống…: bỏ qua
        }
        const allowed = await isAllowed(origin);
        out.push(
          allowed
            ? { id: t.id, windowId: t.windowId, active: t.active, allowed: true, title: t.title || '', url: t.url }
            : { id: t.id, windowId: t.windowId, active: t.active, allowed: false, host: new URL(origin).host },
        );
      }
      return out;
    },
    'tab.open': async (a) => {
      const url = String(a.url);
      await ensureAccess(url, a.__via as string | undefined);
      const tab = await chrome.tabs.create({ url, active: a.active !== false });
      const t = await waitComplete(tab.id as number, 30_000);
      return { tabId: t.id, url: t.url, title: t.title };
    },
    'tab.activate': async (a) => {
      const tab = await getTab(a.tabId);
      await ensureAccess(tab.url, a.__via as string | undefined);
      await chrome.tabs.update(tab.id as number, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id };
    },
    'tab.close': async (a) => {
      const tab = await getTab(a.tabId);
      await ensureAccess(tab.url, a.__via as string | undefined);
      await chrome.tabs.remove(tab.id as number);
      return { closed: tab.id };
    },
    'page.read': (a) => onPage(a, 'read'),
    'page.snapshot': (a) => onPage(a, 'snapshot'),
    'page.click': (a) => onPage(a, 'click'),
    'page.type': (a) => onPage(a, 'type'),
    'page.key': (a) => onPage(a, 'key'),
    'page.scroll': (a) => onPage(a, 'scroll'),
    'page.wait': (a) => onPage(a, 'wait'),
    'page.screenshot': async (a) => {
      const tab = await getTab(a.tabId);
      await ensureAccess(tab.url, a.__via as string | undefined);
      // Chrome chỉ cho chụp tab khi extension có quyền "mọi trang" (<all_urls>) hoặc activeTab: quyền theo từng trang không đủ. Quyền này TUỲ CHỌN, người dùng bật trong Cài đặt → Truy cập trang web.
      if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) {
        throw new Error(
          'Chụp màn hình cần quyền "xem mọi trang" (tuỳ chọn) của Chrome. Mở khung Locaith AI trong trình duyệt → Cài đặt → bật quyền «Truy cập trang web» (mục phía trên «Kết nối với ứng dụng trên máy»). Trợ lý vẫn chỉ thao tác được trên các trang bạn đã duyệt. Trong lúc chưa bật, hãy dùng page.snapshot hoặc page.read.',
        );
      }
      await chrome.tabs.update(tab.id as number, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(300);
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
      return { tabId: tab.id, mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
    },
  };

  async function runOp(op: string, args: Record<string, unknown>, via?: string): Promise<unknown> {
    const fn = OPS[op];
    if (!fn) throw new Error('Lệnh không được hỗ trợ: ' + op);
    const a = { ...(args || {}) };
    delete a.__via; // chỉ dịch vụ nền được đặt tên ứng dụng gửi lệnh
    return fn(via ? { ...a, __via: via } : a);
  }

  // ── (0.7.20) ghép đôi do ỨNG DỤNG khởi xướng ─────────────────────────────────
  // Ứng dụng (VS Code, Locaith Work…) tạo vé rồi mở trang http://127.0.0.1:<cổng>/link?t=<vé> trong trình duyệt của người dùng; trang gửi vé cho ta
  // (externally_connectable). Ta hỏi người dùng MỘT lần trong cửa sổ nhỏ; bấm «Kết nối» thì đổi vé lấy token của RIÊNG ứng dụng đó.
  const linkAsks = new Map<string, { port: number; t: string; name: string; kind?: string; winId?: number; decided: boolean; cleanup: () => void }>();
  /** Yêu cầu đang chờ cũng được ghi ở storage.session: Chrome có thể tắt dịch vụ nền khi người dùng còn đang đọc cửa sổ — cú bấm sau đó vẫn phải có tác dụng. */
  const ASK_KEY = (req: string): string => `nd.link.ask.${req}`;

  async function askAppLink(port: number, t: string): Promise<void> {
    const dup = (): boolean => [...linkAsks.values()].some((x) => x.t === t); // trang tải lại: không mở cửa sổ thứ hai
    if (dup()) return;
    const app = await helloApp(port).catch(() => null);
    if (dup()) return; // hai tin cùng vé tới gần như cùng lúc
    const req = Math.random().toString(36).slice(2);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keep = setInterval(touchWorker, 10_000); // giữ dịch vụ nền sống trong lúc chờ người dùng (như requestPairing)
    const onClose = (id: number): void => {
      if (id === entry.winId && !entry.decided) void finishAppLink(req, 'deny');
    };
    const entry = {
      port,
      t,
      name: app?.name ?? '',
      kind: app?.kind,
      winId: undefined as number | undefined,
      decided: false,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        clearInterval(keep);
        chrome.windows.onRemoved.removeListener(onClose);
      },
    };
    linkAsks.set(req, entry);
    chrome.windows.onRemoved.addListener(onClose);
    timer = setTimeout(() => void finishAppLink(req, 'deny'), 125_000); // vé sống 2 phút
    await chrome.storage.session.set({ [ASK_KEY(req)]: { port, t, name: entry.name, kind: entry.kind ?? null, exp: Date.now() + 125_000 } }).catch(() => undefined);
    try {
      const w = await chrome.windows.create({ url: chrome.runtime.getURL(`bridge-approve.html?mode=app&req=${req}&app=${encodeURIComponent(entry.name)}&port=${port}`), type: 'popup', width: 460, height: 420, focused: true });
      entry.winId = w?.id;
    } catch {
      void finishAppLink(req, 'deny');
    }
  }

  /** Dịch vụ nền vừa khởi động lại giữa lúc người dùng đọc cửa sổ: dựng lại yêu cầu từ storage.session (nếu còn hạn). */
  async function restoreAppLink(req: string): Promise<boolean> {
    if (linkAsks.has(req)) return true;
    if (!/^[a-z0-9]{1,16}$/.test(req)) return false;
    const v = (await chrome.storage.session.get(ASK_KEY(req)).catch(() => ({}) as Record<string, unknown>))[ASK_KEY(req)] as
      | { port?: unknown; t?: unknown; name?: unknown; kind?: unknown; exp?: unknown }
      | undefined;
    if (!v || typeof v.port !== 'number' || typeof v.t !== 'string' || !TICKET_RE.test(v.t) || typeof v.exp !== 'number' || v.exp < Date.now()) {
      if (v) await chrome.storage.session.remove(ASK_KEY(req)).catch(() => undefined);
      return false;
    }
    if (linkAsks.has(req)) return true;
    await refreshPorts();
    if (!PORTS.includes(v.port)) return false;
    linkAsks.set(req, { port: v.port, t: v.t, name: typeof v.name === 'string' ? v.name : '', kind: typeof v.kind === 'string' ? v.kind : undefined, decided: true, cleanup: () => undefined });
    return true;
  }

  async function finishAppLink(req: string, decision: string): Promise<void> {
    const a = linkAsks.get(req);
    if (!a) return;
    linkAsks.delete(req);
    a.cleanup();
    void chrome.storage.session.remove(ASK_KEY(req)).catch(() => undefined);
    if (a.winId !== undefined && !a.decided) void Promise.resolve(chrome.windows.remove(a.winId)).catch(() => undefined);
    if (decision !== 'connect') {
      await post(a.port, '/v1/pair/ticket/deny', { t: a.t }).catch(() => undefined);
      return;
    }
    const r = await post(a.port, '/v1/pair/ticket', { t: a.t }).catch(() => null);
    const j = (r?.data ?? {}) as { token?: unknown; app?: unknown };
    if (!r || r.status !== 200 || typeof j.token !== 'string' || !j.token) return;
    const app = validApp(j.app) ?? (a.kind ? { kind: a.kind, name: a.name } : null);
    await addApp(app?.kind ?? LEGACY, j.token, app?.name ?? a.name);
    await chrome.storage.local.set({ [LINK_ON]: true });
    pairState = 'idle';
    changed();
    void (async () => {
      if (!running) return void (await start());
      if (scanning) await scanning; // một lần dò đang chạy có thể đã lập danh sách token trước khi có token mới
      await scan();
    })();
  }

  // Trang /link của một ứng dụng trên máy gửi vé tới (chỉ nhận từ http://127.0.0.1|localhost ở đúng cổng cầu nối).
  chrome.runtime.onMessageExternal?.addListener((m: unknown, sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => {
    const msg = m as { type?: unknown; t?: unknown } | null;
    if (!msg || msg.type !== 'nd-link-ticket' || typeof msg.t !== 'string' || !TICKET_RE.test(msg.t)) return;
    const o = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})$/.exec(String(sender.origin ?? ''));
    const port = o ? Number(o[1]) : 0;
    const t = msg.t;
    void (async () => {
      await refreshPorts();
      if (!port || !PORTS.includes(port)) return reply({ ok: false, reason: 'origin' });
      if (!(await consentOk())) return reply({ ok: false, reason: 'consent' });
      reply({ ok: true });
      await askAppLink(port, t);
    })();
    return true;
  });

  // ── thông điệp từ khung chat / cửa sổ duyệt ───────────────────────────────────
  chrome.runtime.onMessage.addListener((m: unknown, sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => {
    const msg = m as { type?: string; on?: unknown; origin?: unknown; req?: unknown; decision?: unknown; reason?: unknown } | null;
    if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id || typeof msg.type !== 'string' || !msg.type.startsWith('nd-link-')) return;
    if (msg.type === 'nd-link-status') {
      void status().then(reply);
      return true;
    }
    if (msg.type === 'nd-link-toggle') {
      void toggle(msg.on === true).then(reply);
      return true;
    }
    if (msg.type === 'nd-link-forget') {
      void (async () => {
        const origin = String(msg.origin ?? '');
        const [l, s] = await Promise.all([chrome.storage.local.get(LINK_ALLOW), chrome.storage.session.get(LINK_ALLOW)]);
        await chrome.storage.local.set({ [LINK_ALLOW]: ((l[LINK_ALLOW] as string[]) || []).filter((o) => o !== origin) });
        await chrome.storage.session.set({ [LINK_ALLOW]: ((s[LINK_ALLOW] as string[]) || []).filter((o) => o !== origin) });
        changed();
        reply({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'nd-link-decision') {
      const req = String(msg.req);
      const w = waiting.get(req);
      if (!w) {
        // (0.7.20) cửa sổ «Kết nối» của một ứng dụng — kể cả khi dịch vụ nền vừa khởi động lại giữa chừng
        void (async () => {
          if (!(await restoreAppLink(req))) return reply({ ok: false });
          const a = linkAsks.get(req);
          if (a) a.decided = true; // cửa sổ tự đóng sau khi gửi quyết định — không tính là từ chối
          await finishAppLink(req, msg.decision === 'connect' ? 'connect' : 'deny').catch((e) => console.error('[Locaith AI] kết nối ứng dụng trên máy: lỗi khi đổi vé', e));
          reply({ ok: true }); // trang duyệt chờ phản hồi này rồi mới tự đóng
        })();
        return true;
      }
      w.decided = true; // từ đây việc cửa sổ đóng lại không còn bị tính là từ chối
      const d = msg.decision === 'always' || msg.decision === 'once' ? msg.decision : 'deny';
      const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 300) : undefined;
      void (d === 'deny' ? Promise.resolve() : remember(w.origin, d)).then(() => {
        w.done(d, reason);
        reply({ ok: true }); // trang duyệt chờ phản hồi này rồi mới tự đóng
      });
      return true;
    }
  });

  // Nhịp báo thức 30 giây (chỉ có khi đang bật): dịch vụ nền bị tắt thì dựng lại; đang nối thì xem có cửa sổ / ứng dụng mới không;
  // chưa thấy ứng dụng nào thì chỉ dò khi đã tới lượt (thưa dần) — không vòng nào chạy liên tục khi ứng dụng đóng.
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== LINK_ALARM) return;
    if (!running) void start();
    else if (portKind.size > 0 || clock() >= nextScanAt) void scan();
  });
  void start();

  return {
    status,
    toggle,
    runOp,
    shutdown: () => {
      pairRun++;
      halt();
      for (const a of linkAsks.values()) a.cleanup(); // như dịch vụ nền bị tắt: hẹn giờ mất, yêu cầu ở storage.session còn
      linkAsks.clear();
    },
  };
}
