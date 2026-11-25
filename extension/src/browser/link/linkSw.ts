/**
 * Cầu nối VS Code (dịch vụ nền của bản Chrome / Edge) — phần phía Chrome của `src/core/chrome/bridge.ts`.
 *
 * Extension là bên CHỦ ĐỘNG gọi vào máy chủ cầu cục bộ của VS Code (127.0.0.1:47615–47620, long-poll): nhận lệnh, làm trên tab, trả kết quả.
 * (Bản ≤ 0.4.4 có tính năng này dưới dạng tệp vá; bản dựng lại từ src/browser 0.6.27 → 0.7.11 đã làm rơi nó. Đây là mã nguồn thật, có test.)
 *
 * An toàn:
 *  • TẮT mặc định. Chỉ chạy khi người dùng bật công tắc «VS Code» trong Cài đặt và bấm «Cho phép» ở thẻ ghép đôi trong VS Code;
 *  • chưa đồng ý thông báo dữ liệu của tiện ích (cổng đồng ý) thì không nối;
 *  • mọi thao tác trên MỘT trang cần người dùng duyệt NGAY TRONG Chrome theo từng trang (origin): «Cho phép lần này» / «Luôn cho phép trang này» / «Từ chối»;
 *    danh sách tab chỉ lộ tên miền của trang chưa duyệt; chỉ trang http/https;
 *  • không có dữ liệu nào đi tới máy chủ của Locaith: cầu nối chỉ nói chuyện với VS Code trên CHÍNH máy này (127.0.0.1).
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
/** (0.7.17) Nhớ «VS Code không còn nhận token của trình duyệt này» để Cài đặt vẫn nói rõ sau khi dịch vụ nền khởi động lại. */
export const LINK_LOST = 'nd.bridge.lost';
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
  /** Chạy một lệnh như thể VS Code gửi tới (test). */
  runOp(op: string, args: Record<string, unknown>): Promise<unknown>;
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
  const loops = new Set<number>();
  const waiting = new Map<string, { origin: string; decided: boolean; done: (d: string, reason?: string) => void }>();
  const pending = new Map<string, Promise<{ d: string; reason?: string }>>();
  let token = '';
  let running = false;
  let lastOkAt = 0; // lần gần nhất một cổng VS Code trả lời hợp lệ: «đã kết nối» = trong vòng 45 giây
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
  const connected = (): boolean => running && Date.now() - lastOkAt < 45_000;
  const authHeaders = (): Record<string, string> => ({ authorization: 'Bearer ' + token });

  async function loadToken(): Promise<string> {
    const o = await chrome.storage.local.get(LINK_KEY);
    token = ((o[LINK_KEY] as { token?: string } | undefined)?.token as string | undefined) || '';
    return token;
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
    if (!(await loadToken())) return false;
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
   * Có VS Code nhưng KHÔNG cửa sổ nào nhận token của trình duyệt này (đã ghép đôi với hồ sơ / trình duyệt khác, hoặc đã bấm Huỷ ghép đôi):
   * dừng hẳn, xoá token, tắt công tắc, nhớ lý do để Cài đặt nói rõ. KHÔNG tự thử lại — bản 0.7.12 thử lại mỗi 7 giây mãi mãi và rò bộ nhớ.
   */
  async function lose(): Promise<void> {
    halt();
    token = '';
    await chrome.storage.local.remove(LINK_KEY);
    await chrome.storage.local.set({ [LINK_ON]: false, [LINK_LOST]: Date.now() });
    setPair('lost');
  }

  /**
   * Dò các cổng CHƯA có vòng chờ bằng /v1/ping có token:
   *  • cổng trả 200 (cửa sổ VS Code nhận ta) → mở vòng chờ lệnh cho ĐÚNG cổng đó;
   *  • không có VS Code (cổng đóng) → không giữ gì, không giữ dịch vụ nền thức; lần dò sau thưa dần 15 giây → 5 phút;
   *  • có VS Code mà không cửa sổ nào nhận token → `lose()`.
   */
  function scan(): Promise<void> {
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        if (!running || !token) return;
        const free = PORTS.filter((p) => !loops.has(p));
        const res = await Promise.all(
          free.map(async (p) => {
            try {
              return { p, status: (await call(p, withProto('/v1/ping'), { headers: authHeaders() }, 5000)).status };
            } catch {
              return { p, status: 0 }; // không có VS Code ở cổng này (hoặc không trả lời kịp)
            }
          }),
        );
        if (!running || !token) return;
        const ok = res.filter((x) => x.status === 200);
        for (const x of ok) void pollLoop(x.p);
        if (ok.length) {
          lastOkAt = Date.now();
          scanDelay = SCAN_MIN_MS;
          nextScanAt = 0;
          changed();
          return;
        }
        if (loops.size) return; // vẫn còn cửa sổ đang nối: cổng khác từ chối thì thôi, lần dò sau xét lại
        if (res.some((x) => x.status === 401 || x.status === 403)) {
          await lose();
          return;
        }
        nextScanAt = clock() + scanDelay;
        scanDelay = Math.min(SCAN_MAX_MS, scanDelay * 2);
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
  async function pollLoop(port: number): Promise<void> {
    if (loops.has(port)) return;
    loops.add(port);
    let fails = 0;
    let refused = false;
    try {
      while (running && token) {
        touchWorker(); // đang nối: giữ dịch vụ nền sống để nhận lệnh kịp thời
        const t0 = Date.now();
        let r: Reply;
        try {
          r = await call(port, withProto('/v1/poll?wait=20'), { headers: authHeaders() }, 35_000);
        } catch {
          if (!running || ++fails >= POLL_MAX_FAILS) break;
          await sleep(backoff(fails));
          continue;
        }
        if (r.ok) {
          fails = 0;
          lastOkAt = Date.now();
          const job = (r.data as { job?: Job } | undefined)?.job;
          if (job) void run(port, job);
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
      loops.delete(port);
      changed();
      if (running && token && loops.size === 0) {
        if (refused) void scan(); // token bị từ chối: dò lại ngay — không cửa sổ nào nhận nữa thì báo mất ghép đôi
        else {
          nextScanAt = clock() + scanDelay; // VS Code đã đóng: để nhịp báo thức dò lại thưa dần
          scanDelay = Math.min(SCAN_MAX_MS, scanDelay * 2);
        }
      }
    }
  }

  async function run(port: number, job: Job): Promise<void> {
    let out: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      out = { ok: true, data: await runOp(job.op, job.args ?? {}) };
    } catch (e) {
      out = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    try {
      await call(port, withProto('/v1/result'), { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ...out }) }, 30_000);
    } catch (e) {
      console.error('[Locaith AI] cầu nối VS Code: không trả được kết quả', e);
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
          const j = (r.data ?? {}) as { state?: string; token?: string; error?: string };
          if (r.status === 404 || j.error === 'origin') {
            old++;
            continue;
          }
          if (j.state === 'approved' && j.token) {
            if (me !== pairRun) return;
            await chrome.storage.local.set({ [LINK_KEY]: { token: j.token }, [LINK_ON]: true });
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
    const [l, s, ok] = await Promise.all([chrome.storage.local.get([LINK_KEY, LINK_ALLOW, LINK_ON, LINK_LOST]), chrome.storage.session.get(LINK_ALLOW), consentOk()]);
    const paired = !!(l[LINK_KEY] && (l[LINK_KEY] as { token?: string }).token);
    const on = l[LINK_ON] === undefined ? paired : l[LINK_ON] === true; // bản cũ: có token = bật; cài mới chưa ghép = tắt
    const pairing: PairState = pairState === 'idle' && l[LINK_LOST] ? 'lost' : pairState; // còn nhớ sau khi dịch vụ nền khởi động lại
    return { paired, on, running, connected: connected(), pairing, ports: [...loops], allowed: (l[LINK_ALLOW] as string[]) || [], session: (s[LINK_ALLOW] as string[]) || [], consent: ok };
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
    if (await loadToken()) {
      await start();
      // Đã ghép từ trước: nối ngay. Không nối được trong vài giây (VS Code đóng, hoặc token đã bị thu hồi / ghép nơi khác) thì xin lại như lần đầu.
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

  function askApproval(origin: string): Promise<{ d: string; reason?: string }> {
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
      Promise.resolve(chrome.windows.create({ url: chrome.runtime.getURL(`bridge-approve.html?req=${req}&origin=${encodeURIComponent(origin)}`), type: 'popup', width: 460, height: 380, focused: true }))
        .then((w) => (winId = w?.id))
        .catch((e) => finish('deny', 'popup: ' + String((e as Error)?.message ?? e)));
    }).finally(() => pending.delete(origin));
    pending.set(origin, p);
    return p;
  }

  async function ensureAccess(url: string | undefined): Promise<string> {
    if (!url) throw new Error('Không đọc được địa chỉ của tab. Bật «tabs» khi Chrome hỏi lúc bật công tắc VS Code, hoặc mở trang bằng lệnh tab.open.');
    const origin = originOf(url);
    if (await isAllowed(origin)) return origin;
    const r = await askApproval(origin);
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
    await ensureAccess(tab.url);
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, func: inPage, args: [kind, a as InPageArgs] });
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
      await ensureAccess(url);
      const tab = await chrome.tabs.create({ url, active: a.active !== false });
      const t = await waitComplete(tab.id as number, 30_000);
      return { tabId: t.id, url: t.url, title: t.title };
    },
    'tab.activate': async (a) => {
      const tab = await getTab(a.tabId);
      await ensureAccess(tab.url);
      await chrome.tabs.update(tab.id as number, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id };
    },
    'tab.close': async (a) => {
      const tab = await getTab(a.tabId);
      await ensureAccess(tab.url);
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
      await ensureAccess(tab.url);
      // Chrome chỉ cho chụp tab khi extension có quyền "mọi trang" (<all_urls>) hoặc activeTab: quyền theo từng trang không đủ. Quyền này TUỲ CHỌN, người dùng bật trong Cài đặt → VS Code.
      if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) {
        throw new Error(
          'Chụp màn hình cần quyền "xem mọi trang" (tuỳ chọn) của Chrome. Mở khung Locaith AI trong Chrome → Cài đặt → «Kết nối với VS Code» và bấm «Cho phép chụp màn hình». Trợ lý vẫn chỉ thao tác được trên các trang bạn đã duyệt. Trong lúc chưa bật, hãy dùng page.snapshot hoặc page.read.',
        );
      }
      await chrome.tabs.update(tab.id as number, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(300);
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 });
      return { tabId: tab.id, mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
    },
  };

  async function runOp(op: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = OPS[op];
    if (!fn) throw new Error('Lệnh không được hỗ trợ: ' + op);
    return fn(args || {});
  }

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
      const w = waiting.get(String(msg.req));
      if (!w) {
        reply({ ok: false });
        return;
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

  // Nhịp báo thức 30 giây (chỉ có khi đang bật): dịch vụ nền bị tắt thì dựng lại; đang nối thì xem có cửa sổ VS Code mới không;
  // chưa thấy VS Code thì chỉ dò khi đã tới lượt (thưa dần) — không vòng nào chạy liên tục khi VS Code đóng.
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== LINK_ALARM) return;
    if (!running) void start();
    else if (loops.size > 0 || clock() >= nextScanAt) void scan();
  });
  void start();

  return {
    status,
    toggle,
    runOp,
    shutdown: () => {
      pairRun++;
      halt();
    },
  };
}
