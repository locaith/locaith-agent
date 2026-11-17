/**
 * Mô hình Locaith (Locaith-v5-flash / SI) trong bản Chrome / Edge, từ 0.7.10: tài khoản TUỲ CHỌN (dán «mã kết nối» lấy ở locaith.ai/#ext-browser), đồng ý thông báo dữ liệu theo
 * tài khoản, hàng chờ, hạn mức kiểu Anthropic. Chạy BrowserController THẬT với máy chủ tài khoản giả (PostgREST) và cổng mô hình giả (SSE) qua HTTP thật — đúng cách bản VS Code
 * được kiểm ở test/locaithConsent.test.ts, nhưng ở đây không có `vscode` và kho là chrome.storage giả (MemoryKv).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountClient } from '../../src/core/account/client';
import { challengeOf, newVerifier } from '../../src/core/account/pkce';
import type { AccountConfig } from '../../src/core/account/config';
import { gatewayDiagnosticHeaders } from '../../src/core/providers/gatewayDiagnostics';
import { LOCAITH_GATEWAY_URL, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from '../../src/core/providers/locaithGateway';
import { ProviderService } from '../../src/core/providers/service';
import { SkillRegistry } from '../../src/core/skills/registry';
import { LOCAITH_CONSENT_CACHE_KEY, LocaithBridge, LocaithConsent } from '../../src/host/locaith';
import type { HostMessage, UiEvent, ViewState } from '../../src/shared/protocol';
import { BaseSessionStore, type StoreIO } from '../../src/shared/sessionStore';
import { BrowserAccount, kvMemento } from '../../src/browser/account';
import { BrowserConfig } from '../../src/browser/config';
import { BrowserController } from '../../src/browser/controller';
import { MemoryKv } from '../../src/browser/kv';
import { BrowserLogger } from '../../src/browser/logger';
import { OAuthManager } from '../../src/browser/oauth';
import { BrowserSecrets } from '../../src/browser/secrets';
import { browserSkills } from '../../src/browser/skills';
import { MockAccountServer } from '../helpers/mockAccountServer';
import { MockGateway } from '../helpers/mockGateway';
import { FakeBrowserApi } from './helpers/fakeApi';

const USER = { id: 'u-1', email: 'a@example.com', name: 'Người A' };
const VERSION = '9.9.9';
const TOKEN_RE = /lat_[A-Za-z0-9_-]{43}/;

function memoryIO(): StoreIO {
  const files = new Map<string, Uint8Array>();
  return {
    async read(n) {
      const v = files.get(n);
      if (!v) throw new Error('ENOENT');
      return v;
    },
    async write(n, d) {
      files.set(n, d);
    },
    async remove(n) {
      files.delete(n);
    },
    async names() {
      return [...files.keys()];
    },
  };
}

interface Rig {
  ctl: BrowserController;
  api: FakeBrowserApi;
  kv: MemoryKv;
  config: BrowserConfig;
  secrets: BrowserSecrets;
  providers: ProviderService;
  account: BrowserAccount;
  consent: LocaithConsent;
  gw: MockGateway;
  acct: MockAccountServer;
  messages: HostMessage[];
  /** Mã kết nối mới (như trang locaith.ai/#ext-browser cấp). */
  mint(): Promise<string>;
  /** Dán mã vào thẻ kết nối (đúng đường giao diện → controller). */
  connect(code?: string): Promise<string>;
  view(): ViewState;
  events(): UiEvent[];
  patches(): Partial<ViewState>[];
  toasts(): string[];
  transcriptText(): string;
  stop(): Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function make(opts: { kv?: MemoryKv; keys?: Record<string, string> } = {}): Promise<Rig> {
  const acct = new MockAccountServer();
  acct.addUser(USER);
  await acct.start();
  const gw = new MockGateway((t) => acct.userIdForToken(t));
  const gws = await listen((req, res) => {
    if (!gw.handle(req, res)) res.writeHead(404).end();
  });
  const cfg: AccountConfig = { supabaseUrl: acct.url, anonKey: acct.anonKey, webUrl: 'https://locaith.ai' };
  const client = new AccountClient(cfg, { timeoutMs: 2000 });

  const kv = opts.kv ?? new MemoryKv();
  const config = new BrowserConfig(kv);
  await config.load();
  await config.setBaseUrl(LOCAITH_PROVIDER_ID, `${gws.url}/api/llm/v1`);
  const secrets = new BrowserSecrets(kv);
  for (const [id, key] of Object.entries(opts.keys ?? {})) await secrets.set(id, key);
  const logger = new BrowserLogger();
  const bridge = new LocaithBridge();
  const providers = new ProviderService({
    baseUrls: () => config.baseUrls(),
    customProviders: () => config.customProviders(),
    eagerInput: () => true,
    summarizerModel: () => 'auto',
    resolveKey: (id) => secrets.get(id),
    log: () => undefined,
    env: {},
    // Chỉ cổng Locaith giả được gọi thật; mọi nhà cung cấp khác coi như ngoại tuyến (test không bao giờ chạm mạng).
    fetchImpl: (input, init) => (String(input instanceof Request ? input.url : input).startsWith(gws.url) ? fetch(input, init) : Promise.reject(new Error('ngoại tuyến trong test'))),
    account: bridge.hooks(VERSION, 'browser'),
  });
  const api = new FakeBrowserApi();
  api.addTab({ url: 'https://shop.vn/trang', title: 'Cửa hàng Hoa Sen' });
  api.on('selection', { ok: true, text: '' });
  const account = new BrowserAccount({
    kv,
    client,
    cfg,
    openUrl: (u) => api.openExternal(u),
    registerSecret: (v) => logger.registerSecret(v),
    log: () => undefined,
  });
  const consent = new LocaithConsent({
    memento: await kvMemento(kv, [LOCAITH_CONSENT_CACHE_KEY]),
    account,
    client: new LocaithGatewayClient({
      baseUrl: () => config.baseUrls()[LOCAITH_PROVIDER_ID] ?? LOCAITH_GATEWAY_URL,
      timeoutMs: 3000,
      headers: () => gatewayDiagnosticHeaders({ family: 'browser', version: VERSION, deviceId: account.deviceId() }),
    }),
    clientLabel: `browser/${VERSION}`,
  });
  bridge.attach(account, consent);
  await account.reload();

  const messages: HostMessage[] = [];
  const oauth = new OAuthManager({
    kv,
    ensureIdentity: async () => true,
    launch: async () => {
      throw new Error('không dùng');
    },
    redirectUri: () => 'https://abcdefgh.chromiumapp.org/',
    setKey: (id, key) => secrets.set(id, key),
    deleteKey: (id) => secrets.delete(id),
  });
  const ctl = new BrowserController({
    config,
    secrets,
    oauth,
    providers,
    skills: new SkillRegistry(browserSkills()),
    store: new BaseSessionStore(memoryIO(), 'browser'),
    logger,
    api,
    artifacts: { open: () => undefined, save: () => undefined, download: () => undefined },
    post: (m) => messages.push(structuredClone(m)),
    version: VERSION,
    account,
    locaith: consent,
  });
  await ctl.start();

  const mint = async (): Promise<string> => {
    const v = newVerifier();
    const code = acct.approve(USER.id, challengeOf(v), 'http://127.0.0.1/ext-browser', 'Chrome / Edge');
    const r = await client.exchange(code, v, { client: 'chrome' });
    if (!r.ok) throw new Error('không cấp được mã kết nối thử');
    return r.token;
  };
  const view = () => ctl.snapshot().view;
  const rig: Rig = {
    ctl,
    api,
    kv,
    config,
    secrets,
    providers,
    account,
    consent,
    gw,
    acct,
    messages,
    mint,
    async connect(code?: string) {
      const token = code ?? (await mint());
      await ctl.onMessage({ type: 'account_enter_code', code: token });
      await settleAsync();
      return token;
    },
    view,
    events: () => messages.flatMap((m) => (m.type === 'events' ? m.events : [])),
    patches: () => messages.flatMap((m) => (m.type === 'patch' ? [m.patch] : [])),
    toasts: () => messages.flatMap((m) => (m.type === 'toast' ? [m.text] : [])),
    transcriptText: () => JSON.stringify(view().transcript),
    async stop() {
      ctl.dispose();
      account.dispose();
      gws.server.closeAllConnections?.();
      await new Promise<void>((r) => gws.server.close(() => r()));
      await acct.stop();
    },
  };
  return rig;
}

const settleAsync = async (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  if (!cond()) throw new Error('hết giờ chờ điều kiện');
}
async function sendAndSettle(r: Rig, text: string): Promise<void> {
  await r.ctl.send(text, []);
  await waitFor(() => !r.ctl.isRunning, 8000);
  await settleAsync(80);
}
const lastInit = (r: Rig) => [...r.messages].reverse().find((m): m is Extract<HostMessage, { type: 'init' }> => m.type === 'init');

let rig: Rig;
afterEach(async () => {
  await rig?.stop();
});

describe('bản trình duyệt + mô hình Locaith: tài khoản tuỳ chọn', () => {
  it('chưa kết nối: giao diện KHÔNG bị chặn bởi màn đăng nhập (tuỳ chọn); nhóm Locaith có cờ tài khoản và chưa có khoá', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    const v = lastInit(rig)!.state;
    expect(v.account).toMatchObject({ status: 'signedOut', optional: true, connectUrl: 'https://locaith.ai/#ext-browser' });
    expect(v.locaith).toMatchObject({ accepted: false, card: false });
    const loc = v.providers.find((p) => p.id === LOCAITH_PROVIDER_ID)!;
    expect(loc).toMatchObject({ account: true, hasKey: false });
    expect(loc.models.map((m) => m.id)).toEqual(expect.arrayContaining(['locaith-v5-flash', 'locaith-v5-si']));
    // chưa có khoá nào: phiên rơi về chế độ demo (như trước 0.7.10), không phải Locaith
    expect(v.provider).not.toBe(LOCAITH_PROVIDER_ID);
    expect(rig.gw.others.length + rig.gw.chat.length).toBe(0); // chưa đăng nhập thì không gọi cổng
  });

  it('cờ «Cần đồng ý thông báo dữ liệu» của nhóm Locaith chỉ có khi ĐÃ đăng nhập (chưa đăng nhập thì chưa có gì để đồng ý)', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    const flag = () => rig.view().providers.find((p) => p.id === LOCAITH_PROVIDER_ID)?.needsConsent;
    expect(flag()).toBe(false); // chưa đăng nhập
    await rig.connect();
    await waitFor(() => flag() === true); // đã đăng nhập, chưa đồng ý
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'accept' });
    expect(flag()).toBe(false); // đã đồng ý
  });

  it('chọn Locaith rồi gửi khi chưa kết nối: không byte nào tới cổng, nhắc kết nối, trả lại nội dung vừa gõ và mở Cài đặt', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.ctl.onMessage({ type: 'set_model', provider: LOCAITH_PROVIDER_ID, model: 'locaith-v5-flash' });
    await rig.ctl.send('Tóm tắt trang này giúp mình', []);
    await settleAsync(); // bộ gom sự kiện (33 ms) xả
    expect(rig.gw.chat).toHaveLength(0);
    expect(rig.gw.others).toHaveLength(0);
    const notice = rig.events().find((e): e is Extract<UiEvent, { t: 'notice' }> => e.t === 'notice' && e.level === 'warn');
    expect(notice?.text).toMatch(/Tài khoản Locaith/);
    expect(rig.messages.find((m) => m.type === 'draft')).toMatchObject({ type: 'draft', text: 'Tóm tắt trang này giúp mình' });
    expect(rig.patches().some((p) => p.screen === 'settings') || lastInit(rig)?.state.screen === 'settings').toBe(true);
  });

  it('dán mã đúng: kết nối, Locaith có khoá, phiên TRỐNG của người chưa có khoá nào tự chuyển sang Locaith; mã không lọt vào nhật ký giao diện', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    const token = await rig.connect();
    const v = rig.view();
    expect(v.account).toMatchObject({ status: 'signedIn', optional: true, user: { email: 'a@example.com' } });
    expect(v.providers.find((p) => p.id === LOCAITH_PROVIDER_ID)).toMatchObject({ hasKey: true, account: true });
    expect(v.provider).toBe(LOCAITH_PROVIDER_ID);
    expect(v.model).toBe('locaith-v5-flash');
    expect(rig.toasts().join('\n')).toMatch(/Đã kết nối tài khoản Locaith/);
    // mã nằm trong chrome.storage (không mã hoá, như khoá API) nhưng KHÔNG nằm trong bất kỳ thông điệp nào gửi tới giao diện
    expect(JSON.stringify(rig.messages)).not.toContain(token);
    expect(((await rig.kv.get('nd.account')) as { token: string }).token).toBe(token);
  });

  it('người ĐÃ có khoá API riêng: kết nối Locaith không đổi mô hình đang dùng', async () => {
    rig = await make({ keys: { anthropic: 'sk-ant-test-key-123456' } });
    await rig.ctl.onMessage({ type: 'set_model', provider: 'anthropic', model: 'claude-sonnet-5-5' });
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    expect(rig.view().provider).toBe('anthropic');
    expect(rig.view().providers.find((p) => p.id === LOCAITH_PROVIDER_ID)?.hasKey).toBe(true);
  });

  it('dán mã sai: lý do hiện trong thẻ (bad_code / invalid_token), không kết nối; mã đúng sau đó vào được', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.ctl.onMessage({ type: 'account_sign_in' });
    expect(rig.view().account?.status).toBe('signingIn');
    expect(rig.api.calls.some((c) => c.method === 'openExternal' && c.arg === 'https://locaith.ai/#ext-browser')).toBe(true);
    await rig.ctl.onMessage({ type: 'account_enter_code', code: 'đây không phải mã' });
    await settleAsync();
    expect(rig.view().account).toMatchObject({ status: 'signingIn', error: 'bad_code' });
    await rig.ctl.onMessage({ type: 'account_enter_code', code: 'lat_' + 'k'.repeat(43) });
    await settleAsync();
    expect(rig.view().account?.error).toBe('invalid_token');
    await rig.connect();
    expect(rig.view().account).toMatchObject({ status: 'signedIn' });
    expect(rig.view().account?.error).toBeUndefined();
  });

  it('LẦN ĐẦU dùng Locaith: chưa đồng ý → thẻ thông báo mở, KHÔNG gửi gì; «Đồng ý» ghi lên cổng (client browser/…); gửi lại thì được trả lời, tiêu đề đúng', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    const token = await rig.connect();
    await rig.ctl.send('Xin chào Locaith', []);
    expect(rig.gw.chat).toHaveLength(0);
    expect(rig.view().locaith).toMatchObject({ card: true, accepted: false });
    expect(rig.messages.find((m) => m.type === 'draft')).toMatchObject({ text: 'Xin chào Locaith' });
    expect(rig.gw.consents).toHaveLength(0);

    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'accept' });
    expect(rig.gw.consents).toEqual([{ userId: 'u-1', version: 1, client: `browser/${VERSION}` }]);
    expect(rig.view().locaith).toMatchObject({ card: false, accepted: true });

    rig.gw.mode.reply = 'Chào bạn, mình là Locaith-v5!';
    await sendAndSettle(rig, 'Xin chào Locaith');
    expect(rig.gw.chat).toHaveLength(1);
    const h = rig.gw.chat[0]!.headers;
    expect(h.authorization).toBe(`Bearer ${token}`);
    expect(h['x-locaith-client']).toBe(`browser/${VERSION}`);
    expect(h['x-locaith-queue']).toBe('ticket');
    expect(h['x-locaith-device']).toMatch(/^[0-9a-f]{16}$/); // băm một chiều, không phải mã thiết bị thô
    expect(h['x-locaith-session']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rig.gw.chat[0]!.headers)).not.toContain('a@example.com');
    expect(rig.view().transcript.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.type === 'text' && b.text === 'Chào bạn, mình là Locaith-v5!'))).toBe(true);
    // nội dung tab đang xem đi cùng yêu cầu (đúng như mọi nhà cung cấp khác) — và đã được người dùng đồng ý ở thẻ
    expect(JSON.stringify(rig.gw.chat[0]!.body.messages)).toContain('Cửa hàng Hoa Sen');
  });

  it('đã đồng ý ở nơi khác (trang locaith.ai / máy khác): gửi thẳng, không hiện thẻ', async () => {
    rig = await make();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' }); // trang #ext-browser đã ghi nhận đồng ý
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    expect(rig.view().locaith?.accepted).toBe(true); // afterAccountChange đã hỏi máy chủ
    await sendAndSettle(rig, 'Chào');
    expect(rig.gw.chat).toHaveLength(1);
    expect(rig.view().locaith?.card).toBe(false);
  });

  it('«Dùng API riêng» trên thẻ: rời Locaith; «Rút lại đồng ý»: lần sau hỏi lại', async () => {
    rig = await make({ keys: { anthropic: 'sk-ant-test-key-123456' } });
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    await rig.ctl.onMessage({ type: 'set_model', provider: LOCAITH_PROVIDER_ID, model: 'locaith-v5-flash' });
    await rig.ctl.send('Chào', []);
    expect(rig.view().locaith?.card).toBe(true);
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'decline' });
    expect(rig.view().locaith?.card).toBe(false);
    expect(rig.view().provider).toBe('anthropic'); // sang khoá riêng của người dùng
    // đồng ý, rồi rút lại
    await rig.ctl.onMessage({ type: 'set_model', provider: LOCAITH_PROVIDER_ID, model: 'locaith-v5-flash' });
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'accept' });
    expect(rig.view().locaith?.accepted).toBe(true);
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'withdraw' });
    expect(rig.view().locaith?.accepted).toBe(false);
    expect(rig.view().provider).not.toBe(LOCAITH_PROVIDER_ID);
  });

  it('ghi nhận đồng ý lỗi (máy chủ 500): thẻ giữ nguyên và hiện lỗi, không gửi gì', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.mode.consentFail = true;
    await rig.ctl.send('Chào', []);
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'accept' });
    expect(rig.view().locaith).toMatchObject({ card: true, accepted: false });
    expect(rig.view().locaith?.error).toMatch(/máy chủ Locaith|Locaith/i);
    expect(rig.gw.chat).toHaveLength(0);
  });

  it('đông người: dải xếp hàng hiện (vị trí thật) rồi biến mất khi được nhận; câu trả lời vẫn tới', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' });
    await rig.consent.refresh();
    rig.gw.mode.queue = [4];
    await sendAndSettle(rig, 'Chào');
    const q = rig.patches().filter((p) => 'modelQueue' in p);
    expect(q.some((p) => p.modelQueue?.position === 4 && p.modelQueue.limit === 100)).toBe(true);
    expect(rig.view().modelQueue).toBeUndefined();
    expect(rig.gw.chat).toHaveLength(2); // lần đầu bị xếp hàng, lần sau (kèm vé) được nhận
    expect(rig.gw.chat[1]!.headers['x-locaith-ticket']).toBe('q_test1');
    expect(rig.view().transcript.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.type === 'text' && /Xin chào từ Locaith/.test(b.text)))).toBe(true);
  });

  it('hết hạn mức 5 giờ của gói trả phí: thông báo của cổng + nút «Nâng cấp» mở locaith.ai/#upgrade; đọc lại mức dùng ngay, không thử lại', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' });
    await rig.consent.refresh();
    rig.gw.mode.limit = { state: 'limit_session', plan: 'plus', resetsInS: 7800, message: 'Bạn đã dùng hết hạn mức 5 giờ của gói Plus. Hạn mức làm mới sau 2 giờ 10 phút.' };
    rig.gw.mode.account = { plan: 'plus', entitlement: { state: 'limit_session', plan: 'plus', usage: { session: { percent: 100, resets_in_s: 7800 }, week: { percent: 35, resets_in_s: 400000 } }, can_upgrade: true, upgrade_url: 'https://locaith.ai/#upgrade' } };
    await sendAndSettle(rig, 'Chào');
    expect(rig.gw.chat).toHaveLength(1); // không thử lại
    const n = rig.events().find((e): e is Extract<UiEvent, { t: 'notice' }> => e.t === 'notice' && e.level === 'error' && !!e.link);
    expect(n?.text).toMatch(/hết hạn mức 5 giờ của gói Plus/);
    expect(n?.link).toEqual({ url: 'https://locaith.ai/#upgrade', label: 'Nâng cấp' });
    await waitFor(() => rig.view().locaith?.usage?.state === 'limit_session');
    expect(rig.view().locaith?.usage).toMatchObject({ plan: 'plus', session: { percent: 100 }, week: { percent: 35 } });
    expect(JSON.stringify(rig.view().locaith)).not.toMatch(/\$|usd|đồng/i); // chỉ phần trăm và giờ làm mới, không có tiền
  });

  it('tài khoản miễn phí hết token một lần (402): nút «Mua gói», không thử lại', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' });
    await rig.consent.refresh();
    rig.gw.mode.limit = { state: 'free_exhausted', message: 'Bạn đã dùng hết token miễn phí của tài khoản này. Hãy mua gói tại https://locaith.ai/#upgrade để dùng tiếp.' };
    await sendAndSettle(rig, 'Chào');
    expect(rig.gw.chat).toHaveLength(1);
    const n = rig.events().find((e): e is Extract<UiEvent, { t: 'notice' }> => e.t === 'notice' && !!e.link);
    expect(n?.link).toEqual({ url: 'https://locaith.ai/#upgrade', label: 'Mua gói' });
  });

  it('mức đã dùng của hạn mức: đọc lúc vừa kết nối và khi mở Cài đặt (locaith_refresh, giãn cách 15 giây); chỉ phần trăm + giờ làm mới', async () => {
    rig = await make();
    rig.gw.mode.account = { plan: 'pro', entitlement: { state: 'ok', plan: 'pro', usage: { session: { percent: 12, resets_in_s: 9000 }, week: { percent: 3, resets_in_s: 500000 } }, can_upgrade: true, session_hours: 5, week_hours: 168 } };
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect(); // vừa kết nối → host đọc một lần
    await waitFor(() => !!rig.view().locaith?.usage);
    expect(rig.view().locaith?.usage).toMatchObject({ plan: 'pro', state: 'ok', session: { percent: 12 }, week: { percent: 3 }, sessionHours: 5, canUpgrade: true });
    const calls = () => rig.gw.others.filter((r) => r.path === '/account').length;
    expect(calls()).toBe(1);
    await rig.ctl.onMessage({ type: 'locaith_refresh' }); // mở Cài đặt ngay sau đó: bị giãn cách, không hỏi lại
    await settleAsync();
    expect(calls()).toBe(1);
    rig.gw.mode.account = { plan: 'pro', entitlement: { state: 'ok', plan: 'pro', usage: { session: { percent: 40, resets_in_s: 1000 }, week: { percent: 9, resets_in_s: 400000 } }, can_upgrade: true } };
    await rig.consent.refreshUsage(true); // ép (như khi vừa chạm hạn mức)
    expect(rig.consent.usage()?.session?.percent).toBe(40);
    expect(JSON.stringify(rig.view().locaith)).not.toMatch(/\$|usd|đồng/i);
  });

  it('cổng cũ chưa có /account: không có số liệu, không lỗi, không làm hỏng việc gửi', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' });
    await rig.consent.refresh();
    await rig.ctl.onMessage({ type: 'locaith_refresh' });
    await settleAsync();
    expect(rig.view().locaith?.usage).toBeUndefined();
    await sendAndSettle(rig, 'Chào');
    expect(rig.view().transcript.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.type === 'text'))).toBe(true);
  });

  it('token bị thu hồi giữa chừng (cổng trả 401): hết hiệu lực, giao diện nhắc kết nối lại; lần gửi kế tiếp không rời máy', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    rig.gw.consents.push({ userId: 'u-1', version: 1, client: 'chrome' });
    await rig.consent.refresh();
    rig.acct.revokeAll(); // người dùng thu hồi mã ở locaith.ai
    await sendAndSettle(rig, 'Chào');
    await waitFor(() => rig.view().account?.status === 'expired');
    expect(rig.view().account).toMatchObject({ status: 'expired', reason: 'revoked' });
    expect(rig.view().providers.find((p) => p.id === LOCAITH_PROVIDER_ID)?.hasKey).toBe(false);
    const before = rig.gw.chat.length;
    await rig.ctl.send('Thử lại', []);
    await settleAsync();
    expect(rig.gw.chat.length).toBe(before); // không gửi thêm gì
    expect(rig.events().some((e) => e.t === 'notice' && e.level === 'warn' && /Tài khoản Locaith/.test(e.text))).toBe(true);
    // mã mới vào lại được
    await rig.connect();
    expect(rig.view().account?.status).toBe('signedIn');
  });

  it('đăng xuất: máy chủ thu hồi mã; phiên TRỐNG đang ở Locaith chuyển sang chỗ khác; Locaith hết khoá', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    expect(rig.view().provider).toBe(LOCAITH_PROVIDER_ID);
    await rig.ctl.onMessage({ type: 'account_sign_out' });
    await settleAsync();
    expect(rig.view().account?.status).toBe('signedOut');
    expect(rig.view().provider).not.toBe(LOCAITH_PROVIDER_ID);
    expect(rig.view().providers.find((p) => p.id === LOCAITH_PROVIDER_ID)?.hasKey).toBe(false);
    expect([...rig.acct.devices.values()].every((d) => d.revoked)).toBe(true);
    expect(await rig.kv.get('nd.account')).toBeUndefined();
  });

  it('mã kết nối dán nhầm vào ô chat bị chặn TRƯỚC khi rời máy (không gửi cho nhà cung cấp AI); phần chữ còn lại được trả về ô nhập', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    const token = await rig.mint();
    await rig.ctl.send(`Đây là mã của mình: ${token} giúp mình nhé`, []);
    expect(rig.gw.chat).toHaveLength(0);
    expect(rig.view().transcript.filter((i) => i.kind === 'user')).toHaveLength(0);
    expect(rig.toasts().join('\n')).toMatch(/mã kết nối Locaith/i);
    const draft = rig.messages.find((m) => m.type === 'draft');
    expect(draft && draft.type === 'draft' ? draft.text : '').not.toMatch(TOKEN_RE);
    expect(draft && draft.type === 'draft' ? draft.text : '').toContain('giúp mình nhé');
    expect(JSON.stringify(rig.messages)).not.toContain(token);
  });

  it('hồi quy: dùng khoá API riêng KHÔNG cần tài khoản — không gọi máy chủ tài khoản hay cổng Locaith', async () => {
    rig = await make({ keys: { anthropic: 'sk-ant-test-key-123456' } });
    await rig.ctl.onMessage({ type: 'ready' });
    expect(rig.view().provider).toBe('anthropic');
    expect(rig.acct.calls).toHaveLength(0);
    expect(rig.gw.chat.length + rig.gw.others.length).toBe(0);
  });

  it('khung chat mở lại (khởi động lại trình duyệt): tài khoản và bản đệm «đã đồng ý» sống trong chrome.storage — vào thẳng, không hỏi đồng ý lại', async () => {
    rig = await make();
    await rig.ctl.onMessage({ type: 'ready' });
    await rig.connect();
    await rig.ctl.onMessage({ type: 'locaith_consent', action: 'accept' });
    // «Khởi động lại»: dựng lại tài khoản + bản ghi đồng ý trên CÙNG kho chrome.storage (máy chủ tài khoản vẫn là máy chủ cũ, token còn hiệu lực).
    const cfg: AccountConfig = { supabaseUrl: rig.acct.url, anonKey: rig.acct.anonKey, webUrl: 'https://locaith.ai' };
    const account2 = new BrowserAccount({ kv: rig.kv, client: new AccountClient(cfg, { timeoutMs: 2000 }), cfg, openUrl: async () => undefined });
    await account2.reload();
    expect(account2.usable).toBe(true); // ngay từ lần nạp đầu, chưa cần mạng
    const calls = rig.gw.others.length;
    const consent2 = new LocaithConsent({
      memento: await kvMemento(rig.kv, [LOCAITH_CONSENT_CACHE_KEY]),
      account: account2,
      client: new LocaithGatewayClient({ baseUrl: () => rig.config.baseUrls()[LOCAITH_PROVIDER_ID]!, timeoutMs: 2000 }),
      clientLabel: `browser/${VERSION}`,
    });
    expect(consent2.accepted()).toBe(true); // đọc từ bản đệm, không hỏi cổng
    expect(rig.gw.others.length).toBe(calls);
    account2.dispose();
  });
});
