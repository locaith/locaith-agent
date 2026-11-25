/**
 * Cầu nối VS Code của bản Chrome / Edge (src/browser/link) chạy THẬT với máy chủ cầu cục bộ của VS Code (src/core/chrome/bridge.ts):
 * dịch vụ nền được dựng với `chrome.*` giả, máy chủ là BrowserBridge thật trên cổng ngẫu nhiên. Kiểm: TẮT mặc định + cổng đồng ý, ghép đôi không mã (cho phép / từ chối),
 * nối và nhận lệnh, duyệt theo từng trang (một lần / từ chối / thu hồi), tab chưa duyệt chỉ lộ tên miền, bỏ qua tin nhắn lạ.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBridge, type BridgeCreds, type BridgeStore } from '../../src/core/chrome/bridge';
import { SCAN_MIN_MS, installLink, type LinkApi } from '../../src/browser/link/linkSw';
import { originOf, permPattern } from '../../src/browser/link/origin';

const EXT = 'a'.repeat(32);
type Listener = (m: unknown, sender: { id?: string }, reply: (r: unknown) => void) => boolean | void;

function area() {
  const m = new Map<string, unknown>();
  const keys = (k: string | string[] | null | undefined) => (k == null ? [...m.keys()] : Array.isArray(k) ? k : [k]);
  return {
    m,
    get: async (k?: string | string[]) => Object.fromEntries(keys(k).filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))])),
    set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v))),
    remove: async (k: string | string[]) => void keys(k).forEach((x) => m.delete(x)),
  };
}

interface Tab {
  id: number;
  windowId: number;
  active: boolean;
  url?: string;
  title?: string;
  status: string;
}

function fakeChrome() {
  const local = area();
  const session = area();
  const listeners: Listener[] = [];
  const granted = new Set<string>();
  const log = { windowsCreated: [] as string[], executed: [] as { kind: string; tabId: number }[], permRequests: [] as unknown[], alarms: [] as string[], changed: 0 };
  const alarmListeners: ((a: { name: string }) => void)[] = [];
  let tabs: Tab[] = [];
  let nextWin = 100;
  const onClosed = new Set<(id: number) => void>();
  const chrome = {
    runtime: {
      id: EXT,
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://${EXT}/${p}`,
      getPlatformInfo: (cb?: () => void) => cb?.(),
      sendMessage: async (m: { type?: string }) => {
        if (m?.type === 'nd-link-changed') log.changed++;
      },
      onMessage: { addListener: (l: Listener) => void listeners.push(l), removeListener: (l: Listener) => void listeners.splice(listeners.indexOf(l), 1) },
    },
    storage: { local, session },
    alarms: { create: (n: string) => void log.alarms.push(n), clear: async () => true, onAlarm: { addListener: (l: (a: { name: string }) => void) => void alarmListeners.push(l) } },
    permissions: {
      contains: async (q: { origins?: string[] }) => (q.origins ?? []).every((o) => granted.has(o)),
      request: async (q: unknown) => (log.permRequests.push(q), true),
      remove: async () => true,
    },
    windows: {
      create: async (o: { url: string }) => {
        log.windowsCreated.push(o.url);
        return { id: nextWin++ };
      },
      remove: async () => undefined,
      update: async () => undefined,
      onRemoved: { addListener: (f: (id: number) => void) => void onClosed.add(f), removeListener: (f: (id: number) => void) => void onClosed.delete(f) },
    },
    tabs: {
      query: async () => tabs.filter((t) => true),
      get: async (id: number) => tabs.find((t) => t.id === id)!,
      create: async (o: { url: string }) => {
        const t: Tab = { id: 900 + tabs.length, windowId: 1, active: true, url: o.url, title: 't', status: 'complete' };
        tabs.push(t);
        return t;
      },
      update: async () => undefined,
      remove: async () => undefined,
      captureVisibleTab: async () => 'data:image/jpeg;base64,QUJD',
    },
    scripting: {
      executeScript: async (o: { target: { tabId: number }; args: [string, unknown] }) => {
        log.executed.push({ kind: o.args[0], tabId: o.target.tabId });
        return [{ result: { url: 'x', text: 'nội dung trang' } }];
      },
    },
  };
  /** Gửi tin nhắn như một trang của extension và chờ phản hồi. */
  const send = (m: unknown, senderId: string | undefined = EXT) =>
    new Promise<unknown>((resolve) => {
      let used = false;
      for (const l of listeners) {
        const r = l(m, { id: senderId }, (x) => ((used = true), resolve(x)));
        if (r === true) return;
      }
      if (!used) resolve(undefined);
    });
  /** Bắn nhịp báo thức như Chrome làm mỗi 30 giây. */
  const fireAlarm = (name = 'nd-bridge-tick') => alarmListeners.forEach((l) => l({ name }));
  return { chrome, local, session, log, granted, send, setTabs: (t: Tab[]) => (tabs = t), listeners, fireAlarm };
}

const memStore = (): BridgeStore => {
  let v: BridgeCreds = {};
  return { load: async () => ({ ...v }), save: async (c) => void (v = { ...c }) };
};
const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('quá hạn chờ điều kiện');
};

let bridge: BrowserBridge;
let port: number;
let fc: ReturnType<typeof fakeChrome>;
let link: LinkApi;
const g = globalThis as { chrome?: unknown };

beforeEach(async () => {
  fc = fakeChrome();
  g.chrome = fc.chrome;
  bridge = new BrowserBridge(memStore(), () => undefined, { ports: [0], credTtlMs: 0, connectWaitMs: 4000 });
  port = await bridge.start();
});
afterEach(() => {
  link?.shutdown();
  bridge.stop();
  delete g.chrome;
});

/** fetch thật + gắn Origin chrome-extension:// như trình duyệt tự gắn cho tiện ích. */
const extFetch: typeof fetch = (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), origin: `chrome-extension://${EXT}` } });

const mkLink = (o: { testBuild?: boolean; fetch?: typeof fetch; ports?: number[] } = {}) =>
  (link = installLink({
    ports: o.ports ?? [port],
    testBuild: o.testBuild ?? true,
    approveMs: 3000,
    fetch: o.fetch ?? extFetch,
  }));

/**
 * (0.7.17) fetch có ghi sổ: mọi lời gọi (kể cả thất bại) và mọi Response thật đã trả về.
 * `unreleased()` liệt kê Response có thân CHƯA được đọc hết cũng chưa bị huỷ — đúng thứ làm 0.7.12 rò 2 MB mỗi lần trong Chrome.
 */
function tracked() {
  const calls: string[] = [];
  const responses: Response[] = [];
  const f: typeof fetch = async (u, init) => {
    calls.push(String(u));
    const r = await extFetch(u, init);
    responses.push(r);
    return r;
  };
  return { fetch: f, calls, unreleased: () => responses.filter((r) => r.body !== null && !r.bodyUsed).map((r) => `${r.status} ${r.url}`) };
}

/** Ghép đôi xong và nối: bật công tắc, bấm Cho phép trong «VS Code» (bridge.approvePair). */
async function pairAndConnect(f?: typeof fetch): Promise<void> {
  mkLink(f ? { fetch: f } : {});
  await link.toggle(true);
  await until(() => !!bridge.pairRequest());
  expect(await bridge.approvePair(bridge.pairRequest()!.id)).toBe(true);
  await until(async () => (await link.status()).connected);
}

describe('cầu nối VS Code (Chrome) — tắt mặc định và cổng đồng ý', () => {
  it('cài mới: tắt, chưa ghép đôi, không gửi gì tới cổng nào', async () => {
    mkLink();
    const s = await link.status();
    expect(s).toMatchObject({ on: false, paired: false, running: false, connected: false, pairing: 'idle', allowed: [], session: [] });
    expect(bridge.pairRequest()).toBeUndefined();
  });

  it('chưa đồng ý thông báo dữ liệu (bản phát hành, không có cổng): bật công tắc KHÔNG xin ghép đôi', async () => {
    mkLink({ testBuild: false });
    const s = await link.toggle(true);
    expect(s.pairing).toBe('consent');
    expect(s.consent).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.pairRequest()).toBeUndefined();
  });
});

describe('cầu nối VS Code (Chrome) — ghép đôi không mã', () => {
  it('bật công tắc → VS Code thấy yêu cầu → Cho phép → nối, token lưu, bật vĩnh viễn', async () => {
    await pairAndConnect();
    const s = await link.status();
    expect(s).toMatchObject({ on: true, paired: true, running: true, connected: true, pairing: 'idle' });
    expect(bridge.status().extensionId).toBe(EXT);
    expect(fc.log.alarms).toContain('nd-bridge-tick');
    expect((fc.local.m.get('nd.bridge') as { token: string }).token.length).toBeGreaterThan(20);
  });

  it('VS Code bấm Từ chối → trạng thái «denied», công tắc tự tắt, không có token', async () => {
    mkLink();
    await link.toggle(true);
    await until(() => !!bridge.pairRequest());
    bridge.denyPair(bridge.pairRequest()!.id);
    await until(async () => (await link.status()).pairing === 'denied');
    const s = await link.status();
    expect(s.on).toBe(false);
    expect(s.paired).toBe(false);
  });

  it('không có VS Code ở cổng nào → «not_found», công tắc tự tắt', async () => {
    bridge.stop();
    mkLink();
    const s = await link.toggle(true);
    await until(async () => (await link.status()).pairing === 'not_found');
    expect((await link.status()).on).toBe(false);
    expect(s.paired).toBe(false);
  });

  it('tắt công tắc giữa chừng: dừng hỏi, yêu cầu ở VS Code được huỷ', async () => {
    mkLink();
    await link.toggle(true);
    await until(() => !!bridge.pairRequest());
    await link.toggle(false);
    const s = await link.status();
    expect(s.on).toBe(false);
    expect(s.running).toBe(false);
  });
});

describe('cầu nối VS Code (Chrome) — lệnh từ VS Code và duyệt theo từng trang', () => {
  const tabs: Tab[] = [
    { id: 1, windowId: 1, active: true, url: 'https://shop.example.com/cart?x=1', title: 'Giỏ hàng', status: 'complete' },
    { id: 2, windowId: 1, active: false, url: 'https://bank.example.org/secret', title: 'Ngân hàng', status: 'complete' },
    { id: 3, windowId: 1, active: false, url: 'chrome://settings', title: 'Settings', status: 'complete' },
    { id: 4, windowId: 1, active: false, status: 'complete' },
  ];

  it('tabs.list: trang chưa duyệt chỉ lộ tên miền (không URL/tiêu đề); chrome:// bị bỏ; tab không có URL đánh dấu restricted', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    const out = (await bridge.call('tabs.list', {})) as Record<string, unknown>[];
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 1, windowId: 1, active: true, allowed: false, host: 'shop.example.com' });
    expect(JSON.stringify(out)).not.toMatch(/Giỏ hàng|cart|secret|Ngân hàng/);
    expect(out[2]).toMatchObject({ id: 4, restricted: true });
  });

  it('page.read trên trang chưa duyệt → mở cửa sổ hỏi trong Chrome; «Cho phép lần này» → đọc được và nhớ trong phiên (không hỏi lại)', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    const p = bridge.call('page.read', { tabId: 1 });
    await until(() => fc.log.windowsCreated.length === 1);
    const url = new URL(fc.log.windowsCreated[0]);
    expect(url.pathname).toBe('/bridge-approve.html');
    expect(url.searchParams.get('origin')).toBe('https://shop.example.com');
    fc.granted.add(permPattern('https://shop.example.com')); // trang duyệt đã xin quyền trang của Chrome trong cú bấm
    expect(await fc.send({ type: 'nd-link-decision', req: url.searchParams.get('req'), decision: 'once' })).toEqual({ ok: true });
    expect(await p).toMatchObject({ tabId: 1, text: 'nội dung trang' });
    expect(fc.log.executed).toEqual([{ kind: 'read', tabId: 1 }]);
    expect(((await link.status()).session)).toEqual(['https://shop.example.com']);
    expect(((await link.status()).allowed)).toEqual([]);
    await bridge.call('page.snapshot', { tabId: 1 });
    expect(fc.log.windowsCreated).toHaveLength(1); // không hỏi lại
    // tabs.list giờ lộ tên và URL của trang đã duyệt, trang khác vẫn chỉ tên miền
    const out = (await bridge.call('tabs.list', {})) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ allowed: true, title: 'Giỏ hàng' });
    expect(out[1]).toEqual({ id: 2, windowId: 1, active: false, allowed: false, host: 'bank.example.org' });
  });

  it('Từ chối → lệnh lỗi rõ ràng, không chạy gì trên trang', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    const p = bridge.call('page.click', { tabId: 2, text: 'Chuyển tiền' });
    const rejected = expect(p).rejects.toThrow(/từ chối cho trợ lý điều khiển https:\/\/bank\.example\.org/);
    await until(() => fc.log.windowsCreated.length === 1);
    const req = new URL(fc.log.windowsCreated[0]).searchParams.get('req');
    await fc.send({ type: 'nd-link-decision', req, decision: 'deny' });
    await rejected;
    expect(fc.log.executed).toEqual([]);
  });

  it('Chrome không cấp quyền trang (người dùng từ chối hộp thoại của Chrome) → lỗi nêu lý do', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    const p = bridge.call('page.read', { tabId: 1 });
    const rejected = expect(p).rejects.toThrow(/Chrome không cấp được quyền cho https:\/\/shop\.example\.com: hộp thoại bị từ chối/);
    await until(() => fc.log.windowsCreated.length === 1);
    const req = new URL(fc.log.windowsCreated[0]).searchParams.get('req');
    await fc.send({ type: 'nd-link-decision', req, decision: 'deny', reason: 'hộp thoại bị từ chối' });
    await rejected;
  });

  it('«Luôn cho phép» lưu bền; thu hồi (nd-link-forget) → lại phải hỏi', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    const p = bridge.call('page.read', { tabId: 1 });
    await until(() => fc.log.windowsCreated.length === 1);
    fc.granted.add(permPattern('https://shop.example.com'));
    await fc.send({ type: 'nd-link-decision', req: new URL(fc.log.windowsCreated[0]).searchParams.get('req'), decision: 'always' });
    await p;
    expect((await link.status()).allowed).toEqual(['https://shop.example.com']);
    await bridge.call('page.read', { tabId: 1 });
    expect(fc.log.windowsCreated).toHaveLength(1);
    await fc.send({ type: 'nd-link-forget', origin: 'https://shop.example.com' });
    expect((await link.status()).allowed).toEqual([]);
    const again = bridge.call('page.read', { tabId: 1 });
    const rejected = expect(again).rejects.toThrow(/Hết thời gian chờ/);
    await until(() => fc.log.windowsCreated.length === 2);
    await rejected; // không ai bấm → hết hạn (approveMs 3 giây) = từ chối
  }, 15000);

  it('trang đã duyệt nhưng người dùng đã thu hồi quyền trang ở chrome://extensions → hỏi lại', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    await fc.local.set({ 'nd.bridge.allow': ['https://shop.example.com'] });
    // chưa có quyền trang của Chrome (fc.granted rỗng) → isAllowed false
    const out = (await bridge.call('tabs.list', {})) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ allowed: false, host: 'shop.example.com' });
  });

  it('tab.open: duyệt theo URL TRƯỚC khi mở; chỉ http/https', async () => {
    fc.setTabs([]);
    await pairAndConnect();
    await expect(bridge.call('tab.open', { url: 'file:///C:/secret.txt' })).rejects.toThrow(/Chỉ điều khiển được trang http\/https/);
    await expect(bridge.call('tab.open', { url: 'javascript:alert(1)' })).rejects.toThrow(/http\/https/);
    await fc.local.set({ 'nd.bridge.allow': ['https://example.com'] });
    fc.granted.add(permPattern('https://example.com'));
    expect(await bridge.call('tab.open', { url: 'https://example.com/a' })).toMatchObject({ url: 'https://example.com/a' });
  });

  it('page.screenshot cần quyền «mọi trang» tuỳ chọn; thiếu → lời nhắn chỉ tới Cài đặt', async () => {
    fc.setTabs(tabs);
    await pairAndConnect();
    await fc.local.set({ 'nd.bridge.allow': ['https://shop.example.com'] });
    fc.granted.add(permPattern('https://shop.example.com'));
    await expect(bridge.call('page.screenshot', { tabId: 1 })).rejects.toThrow(/Kết nối với VS Code/);
    fc.granted.add('<all_urls>');
    expect(await bridge.call('page.screenshot', { tabId: 1 })).toMatchObject({ mediaType: 'image/jpeg', data: 'QUJD' });
  });

  it('lệnh lạ bị từ chối', async () => {
    await pairAndConnect();
    await expect(bridge.call('system.exec', { cmd: 'calc' })).rejects.toThrow(/Lệnh không được hỗ trợ: system\.exec/);
  });
});

describe('cầu nối VS Code (Chrome) — tin nhắn trong extension', () => {
  it('chỉ nhận tin nhắn nd-link-* từ chính extension; người gửi khác hoặc loại tin khác bị bỏ qua', async () => {
    mkLink();
    expect(await fc.send({ type: 'nd-link-status' }, 'b'.repeat(32))).toBeUndefined();
    expect(await fc.send({ type: 'nd-link-toggle', on: true }, '')).toBeUndefined();
    expect(await fc.send({ type: 'nd-presence-stop' })).toBeUndefined();
    expect(await fc.send(null)).toBeUndefined();
    expect(bridge.pairRequest()).toBeUndefined();
    expect(await fc.send({ type: 'nd-link-status' })).toMatchObject({ on: false });
  });

  it('nd-link-decision với mã lạ không làm gì', async () => {
    mkLink();
    expect(await fc.send({ type: 'nd-link-decision', req: 'khong-co', decision: 'always' })).toEqual({ ok: false });
    expect((await link.status()).allowed).toEqual([]);
  });
});

describe('origin', () => {
  it('chỉ http/https; mẫu quyền bỏ cổng', () => {
    expect(originOf('https://a.example.com:8443/x?y#z')).toBe('https://a.example.com:8443');
    expect(() => originOf('chrome://settings')).toThrow(/http\/https/);
    expect(() => originOf('data:text/html,hi')).toThrow(/http\/https/);
    expect(permPattern('http://localhost:3000')).toBe('http://localhost/*');
  });
});

/**
 * (0.7.17) Sự cố 0.7.12 trên máy thật (25/11/2026): VS Code trả 401 (trình duyệt này đã bị thay bằng hồ sơ khác khi ghép đôi), tiện ích hỏi lại
 * mỗi 7 giây mãi mãi và KHÔNG đọc / huỷ thân câu trả lời → Chrome giữ một vùng nhớ 2 MB mỗi lần: 2,7 GB trong một tiến trình, ~4 GB/giờ.
 * Các ca dưới đây chạy với máy chủ cầu THẬT và Response THẬT; `unreleased()` phải luôn rỗng.
 */
describe('cầu nối VS Code (Chrome) — không rò bộ nhớ, không gọi mãi (0.7.17)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Chờ theo SỐ LẦN thử (không theo đồng hồ — có ca giả đồng hồ). */
  const waitFor = async (f: () => boolean | Promise<boolean>, tries = 250) => {
    for (let i = 0; i < tries; i++) {
      if (await f()) return;
      await sleep(20);
    }
    throw new Error('quá hạn chờ điều kiện');
  };
  const closedPort = async (): Promise<number> => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const p = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  };
  const authed = (calls: string[]) => calls.filter((c) => /\/v1\/(ping|poll|result)/.test(c));

  it('token bị VS Code từ chối (đã ghép đôi nơi khác): dò MỘT lần rồi dừng hẳn — không gọi lại, xoá token, tắt công tắc, báo mất ghép đôi; mọi thân câu trả lời đã giải phóng', async () => {
    await fc.local.set({ 'nd.bridge': { token: 'token-cu-da-het-hieu-luc' }, 'nd.bridge.on': true });
    const t = tracked();
    mkLink({ fetch: t.fetch, ports: [port, await closedPort()] });
    await waitFor(async () => (await link.status()).pairing === 'lost');
    const n = t.calls.length;
    await sleep(1500); // 0.7.12 đã gọi lại sau 7 giây; ở đây không được gọi thêm lần nào nữa
    expect(t.calls.length).toBe(n);
    expect(authed(t.calls)).toHaveLength(2); // đúng một lần ping mỗi cổng
    expect(t.calls.every((c) => /[?&]v=2(&|$)/.test(c))).toBe(true); // luôn gắn dấu giao thức để VS Code mới trả 401 thay vì đóng kết nối
    expect(await link.status()).toMatchObject({ on: false, paired: false, running: false, connected: false, pairing: 'lost', ports: [] });
    expect(fc.local.m.has('nd.bridge')).toBe(false);
    expect(fc.local.m.get('nd.bridge.lost')).toEqual(expect.any(Number));
    expect(t.unreleased()).toEqual([]);
    fc.fireAlarm(); // báo thức cũ (nếu Chrome còn giữ) cũng không dựng lại gì
    await sleep(200);
    expect(t.calls.length).toBe(n);
  });

  it('đang nối thì VS Code huỷ / ghép nơi khác → vòng chờ nhận 401 → dừng hẳn và báo mất ghép đôi, không hỏi lại; thân câu trả lời đã giải phóng', async () => {
    const t = tracked();
    await pairAndConnect(t.fetch);
    await bridge.unpair(); // đánh thức long-poll đang chờ; lần hỏi kế tiếp sẽ bị 401
    await waitFor(async () => (await link.status()).pairing === 'lost');
    const n = t.calls.length;
    await sleep(1500);
    expect(t.calls.length).toBe(n);
    expect((await link.status()).running).toBe(false);
    expect(t.unreleased()).toEqual([]);
  });

  it('mọi đường gọi đều giải phóng thân câu trả lời: xin ghép đôi, nhận token, ping, chờ lệnh, trả kết quả, và long-poll đang bay khi tắt', async () => {
    const t = tracked();
    await pairAndConnect(t.fetch);
    expect(await bridge.call('ping', {})).toMatchObject({ v: 1 }); // VS Code → lệnh → tiện ích làm → POST /v1/result
    expect(t.calls.some((c) => c.includes('/v1/result?v=2'))).toBe(true);
    await link.toggle(false); // huỷ ngay long-poll đang chờ, không để nó treo thêm 20 giây
    await sleep(300);
    expect(t.unreleased()).toEqual([]);
    expect((await link.status()).running).toBe(false);
  });

  it('không có VS Code: không vòng chờ nào chạy; báo thức chỉ dò khi tới lượt và giãn dần (15 s → 30 s …)', async () => {
    await fc.local.set({ 'nd.bridge': { token: 'tok' }, 'nd.bridge.on': true });
    let t = 1_000_000;
    const calls: string[] = [];
    const closed = await closedPort();
    link = installLink({ ports: [closed], testBuild: true, now: () => t, fetch: (u, init) => (calls.push(String(u)), extFetch(u, init)) });
    await waitFor(async () => calls.length === 1 && (await link.status()).running);
    await sleep(100);
    expect((await link.status()).ports).toEqual([]); // không có vòng chờ nào
    fc.fireAlarm(); // chưa tới lượt
    await sleep(100);
    expect(calls).toHaveLength(1);
    t += SCAN_MIN_MS + 1; // tới lượt (15 s)
    fc.fireAlarm();
    await waitFor(() => calls.length === 2);
    await sleep(50);
    t += SCAN_MIN_MS + 1; // lượt sau phải chờ 30 s: 15 s là chưa đủ
    fc.fireAlarm();
    await sleep(100);
    expect(calls).toHaveLength(2);
    t += SCAN_MIN_MS + 1;
    fc.fireAlarm();
    await waitFor(() => calls.length === 3);
    expect((await link.status()).ports).toEqual([]);
  });

  it('máy chủ trả ngay mà không có việc: không quay vòng nóng (tối đa ~1 lần/giây)', async () => {
    await fc.local.set({ 'nd.bridge': { token: 'tok' }, 'nd.bridge.on': true });
    const calls: string[] = [];
    mkLink({ ports: [47999], fetch: async (u) => (calls.push(String(u)), new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) });
    await sleep(2300);
    const polls = calls.filter((c) => c.includes('/v1/poll')).length;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });

  it('sau khi mất ghép đôi, bật lại công tắc → xin ghép đôi mới; thông báo «mất ghép đôi» biến mất', async () => {
    await fc.local.set({ 'nd.bridge': { token: 'token-cu' }, 'nd.bridge.on': true });
    mkLink();
    await waitFor(async () => (await link.status()).pairing === 'lost');
    await link.toggle(true);
    await waitFor(() => !!bridge.pairRequest());
    const s = await link.status();
    expect(s.on).toBe(true);
    expect(['asking', 'waiting']).toContain(s.pairing);
    expect(fc.local.m.has('nd.bridge.lost')).toBe(false);
    expect(await bridge.approvePair(bridge.pairRequest()!.id)).toBe(true);
    await waitFor(async () => (await link.status()).connected);
  });
});
