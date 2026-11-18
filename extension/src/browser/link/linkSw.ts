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
import { inPage, type InPageArgs, type InPageKind } from './inPage';
import { originOf, permPattern } from './origin';

export { originOf, permPattern };

export const LINK_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619, 47620];
/** Khoá lưu trữ giữ nguyên như bản ≤ 0.4.4 (người nâng cấp từ bản cũ không phải ghép đôi lại). */
export const LINK_KEY = 'nd.bridge';
export const LINK_ON = 'nd.bridge.on';
export const LINK_ALLOW = 'nd.bridge.allow';
export const LINK_ALARM = 'nd-bridge-tick';

export type PairState = 'idle' | 'asking' | 'waiting' | 'denied' | 'expired' | 'not_found' | 'busy' | 'old' | 'consent';

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
const touchWorker = (): void => void chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);

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
  const loops = new Set<number>();
  const waiting = new Map<string, { origin: string; decided: boolean; done: (d: string, reason?: string) => void }>();
  const pending = new Map<string, Promise<{ d: string; reason?: string }>>();
  let token = '';
  let running = false;
  let lastOkAt = 0; // lần gần nhất một cổng VS Code trả lời hợp lệ: «đã kết nối» = trong vòng 45 giây
  let pairState: PairState = 'idle';
  let pairRun = 0; // số thứ tự lần xin: tắt công tắc giữa chừng thì lần cũ tự dừng

  const consentOk = async (): Promise<boolean> => {
    if (opts.testBuild) return true;
    const g = consentGate();
    return g ? g.ok().catch(() => false) : false;
  };
  const changed = (): void => void Promise.resolve(chrome.runtime.sendMessage({ type: 'nd-link-changed' })).catch(() => undefined);
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

  async function start(): Promise<boolean> {
    await refreshPorts();
    if (!(await loadToken())) return false;
    if (!(await isOn())) return false;
    if (!(await consentOk())) return false;
    running = true;
    for (const p of PORTS) if (!loops.has(p)) void pollLoop(p);
    chrome.alarms.create(LINK_ALARM, { periodInMinutes: 0.5 });
    changed();
    return true;
  }

  function stop(): void {
    running = false;
    void chrome.alarms.clear(LINK_ALARM);
    changed();
  }

  async function pollLoop(port: number): Promise<void> {
    loops.add(port);
    let miss = 0;
    try {
      // Kiểm nhanh xem cổng này có VS Code đã ghép với ta không (long-poll chỉ trả lời sau tối đa 20 giây: không có bước này công tắc báo «đang tìm VS Code» cả 20 giây đầu).
      try {
        const r = await doFetch(`http://127.0.0.1:${port}/v1/ping`, { headers: authHeaders() });
        if (r.ok) {
          lastOkAt = Date.now();
          changed();
        }
      } catch {
        /* cổng này chưa có VS Code */
      }
      while (running && token) {
        try {
          touchWorker(); // đặt lại bộ đếm nhàn rỗi để dịch vụ nền không bị tắt khi đang chờ lệnh
          const r = await doFetch(`http://127.0.0.1:${port}/v1/poll?wait=20`, { headers: authHeaders() });
          if (r.ok) {
            miss = 0;
            lastOkAt = Date.now();
            const j = (await r.json()) as { job?: { id: string; op: string; args?: Record<string, unknown> } };
            if (j && j.job) void run(port, j.job);
            continue;
          }
          miss = r.status === 401 ? 6 : miss + 1; // 401: cửa sổ VS Code này không biết token của ta (ghép đôi khác) — thử lại thưa
        } catch {
          miss++;
        }
        await sleep(Math.min(8000, 1000 + miss * 1000));
      }
    } finally {
      loops.delete(port);
    }
  }

  async function run(port: number, job: { id: string; op: string; args?: Record<string, unknown> }): Promise<void> {
    let out: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      out = { ok: true, data: await runOp(job.op, job.args ?? {}) };
    } catch (e) {
      out = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    try {
      await doFetch(`http://127.0.0.1:${port}/v1/result`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ...out }) });
    } catch (e) {
      console.error('[Locaith AI] cầu nối VS Code: không trả được kết quả', e);
    }
  }

  // ── ghép đôi KHÔNG MÃ ─────────────────────────────────────────────────────────
  // Bật công tắc → xin kết nối tới MỌI cổng VS Code; VS Code hiện thẻ «Cho phép / Từ chối» trong khung chat của nó; người dùng bấm Cho phép → ta nhận token MỘT lần, lưu rồi nối.
  const post = (port: number, path: string, body?: unknown) =>
    doFetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const cancelAsked = (list: ({ port: number; id?: string } | null)[]): void => {
    for (const x of list) if (x && x.id) post(x.port, '/v1/pair/cancel', { id: x.id }).catch(() => undefined);
  };

  async function requestPairing(): Promise<void> {
    await refreshPorts();
    const me = ++pairRun;
    setPair('asking');
    const asked = await Promise.all(
      PORTS.map(async (port) => {
        try {
          const r = await post(port, '/v1/pair/request');
          const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
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
          if (r.status === 404) r = await doFetch(`http://127.0.0.1:${x.port}/v1/pair/status?id=${encodeURIComponent(x.id)}`);
          const j = (await r.json()) as { state?: string; token?: string; error?: string };
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
        cancelAsked(live);
        return;
      }
      if (denied + gone === live.length) {
        setPair(denied > 0 ? 'denied' : 'expired');
        await chrome.storage.local.set({ [LINK_ON]: false });
        return;
      }
      await sleep(1000);
    }
    if (me === pairRun) {
      setPair('expired');
      await chrome.storage.local.set({ [LINK_ON]: false });
      cancelAsked(live);
    }
  }

  async function status(): Promise<LinkStatus> {
    const [l, s, ok] = await Promise.all([chrome.storage.local.get([LINK_KEY, LINK_ALLOW, LINK_ON]), chrome.storage.session.get(LINK_ALLOW), consentOk()]);
    const paired = !!(l[LINK_KEY] && (l[LINK_KEY] as { token?: string }).token);
    const on = l[LINK_ON] === undefined ? paired : l[LINK_ON] === true; // bản cũ: có token = bật; cài mới chưa ghép = tắt
    return { paired, on, running, connected: connected(), pairing: pairState, ports: [...loops], allowed: (l[LINK_ALLOW] as string[]) || [], session: (s[LINK_ALLOW] as string[]) || [], consent: ok };
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
    pairState = 'idle';
    if (await loadToken()) {
      await start();
      // Đã ghép từ trước: nối ngay. Không nối được trong vài giây (VS Code đóng, hoặc token bị thu hồi ở VS Code) thì xin lại như lần đầu.
      for (let i = 0; i < 16 && !connected(); i++) await sleep(250);
      if (!connected()) void requestPairing();
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

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === LINK_ALARM) void start();
  });
  void start();

  return {
    status,
    toggle,
    runOp,
    shutdown: () => {
      pairRun++;
      running = false;
    },
  };
}
