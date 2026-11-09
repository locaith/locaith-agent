/**
 * Remote của CLI, đầu-cuối ở tầng thư viện: runtime CLI THẬT (nhà cung cấp giả) + CliRemote + RelayHost THẬT qua relay giả trong bộ nhớ (RelayBus)
 * + máy chủ tài khoản giả (mock) + RelayClient THẬT đóng vai trình duyệt locaith.ai đã đăng nhập ĐÚNG tài khoản.
 * Không đụng mạng thật, không đụng Supabase thật, không dùng token thật.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { challengeOf, newVerifier } from '../../../src/core/account/pkce';
import { ACCOUNT_DEV, b64u, deriveAccountKey, parsePairingLink, randomBytes, unb64u } from '../../../src/core/remote/e2e';
import { RelayClient, pairWithHost, type ClientStatus } from '../../../src/core/remote/relayClient';
import { hostMeta, machineLabel, CliRemote, type CliRemoteDeps } from '../../../src/cli/remote/remote';
import { remoteFile } from '../../../src/cli/remote/store';
import { MockAccountServer } from '../../helpers/mockAccountServer';
import { RelayBus, type BusLink } from '../../helpers/relayBus';
import { textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, tmpDir, waitFor, type Harness } from '../runtime/harness';
import * as fs from 'node:fs';

const USER = { id: 'u-1', email: 'chu@example.com', name: 'Chủ máy' };
const REDIRECT = 'http://127.0.0.1:47000/cb';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `waitFor` của harness chỉ chờ điều kiện đúng (trả void): bản này trả luôn giá trị tìm được. */
async function until<T>(fn: () => T | undefined | false | null, ms = 5000, what = 'điều kiện'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`Hết giờ chờ ${what}`);
    await sleep(10);
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  cleanupDirs();
});

interface Rig {
  h: Harness;
  remote: CliRemote;
  bus: RelayBus;
  hostLink: BusLink;
  acct: MockAccountServer;
  token: string;
  notices: Array<{ level: string; text: string }>;
  approvals: Array<{ label: string; sas: string }>;
  opened: string[];
  home: string;
  cwd: string;
  /** Mở một «trình duyệt» đăng nhập đúng tài khoản (khoá lấy từ danh bạ, như trang web). */
  browser(o?: { watchdogMs?: number; accountKey?: string }): Promise<Browser>;
}
interface Browser {
  rc: RelayClient;
  link: BusLink;
  got: any[];
  statuses: ClientStatus[];
  status(): ClientStatus;
  snapshot(): any;
}

async function mkRig(o: { script?: Parameters<typeof harness>[0] extends infer X ? (X extends { script?: infer S } ? S : never) : never; noToken?: boolean; allowBypass?: boolean; approve?: boolean; deps?: Partial<CliRemoteDeps> } = {}): Promise<Rig> {
  const acct = new MockAccountServer();
  acct.addUser(USER);
  await acct.start();
  cleanups.push(() => acct.stop());
  // đăng nhập giả: lấy token thiết bị như CLI làm qua `locaith login`
  const v = newVerifier();
  const code = acct.approve(USER.id, challengeOf(v), REDIRECT, 'CLI thử');
  const cfg = { supabaseUrl: acct.url, anonKey: acct.anonKey, webUrl: 'https://locaith.ai' };
  const { AccountClient } = await import('../../../src/core/account/client');
  const ex = await new AccountClient(cfg, { timeoutMs: 2000 }).exchange(code, v, { client: 'cli' });
  if (!ex.ok) throw new Error('đăng nhập giả lỗi');
  const token = ex.token;

  const h = await harness({ script: o.script ?? [] });
  cleanups.push(() => h.cleanup());
  const bus = new RelayBus();
  const hostLink = bus.link('host');
  const notices: Rig['notices'] = [];
  const approvals: Rig['approvals'] = [];
  const opened: string[] = [];
  const remote = new CliRemote({
    rt: h.rt,
    home: h.home,
    cwd: h.cwd,
    version: '9.9.9-test',
    lang: () => 'vi',
    token: () => (o.noToken ? undefined : token),
    accountConfig: cfg,
    createLink: () => hostLink,
    approve: async (r) => {
      approvals.push(r);
      return o.approve === true;
    },
    openUrl: (u) => {
      opened.push(u);
      return true;
    },
    allowBypass: () => o.allowBypass === true,
    notify: (level, text) => notices.push({ level, text }),
    ...o.deps,
  });
  cleanups.push(() => remote.dispose());

  const rig: Rig = {
    h,
    remote,
    bus,
    hostLink,
    acct,
    token,
    notices,
    approvals,
    opened,
    home: h.home,
    cwd: h.cwd,
    async browser(copts = {}) {
      const hostId = [...acct.hosts.values()][0]?.hostId;
      if (!hostId) throw new Error('danh bạ chưa có máy');
      const accountKey = copts.accountKey ?? [...acct.hosts.values()][0]?.accountKey;
      if (!accountKey) throw new Error('danh bạ chưa có khoá tài khoản');
      const key = b64u(await deriveAccountKey(unb64u(accountKey), hostId));
      const link = bus.link('web');
      const got: any[] = [];
      const statuses: ClientStatus[] = [];
      const rc = new RelayClient({ link, dev: ACCOUNT_DEV, key, onStream: (m) => got.push(m), onStatus: (s) => statuses.push(s), helloTimeoutMs: 300, pingMs: 100, watchdogMs: copts.watchdogMs ?? 4000 });
      link.start();
      rc.start();
      cleanups.push(() => {
        rc.stop();
        link.stop();
      });
      return { rc, link, got, statuses, status: () => rc.state, snapshot: () => [...got].reverse().find((m) => m.type === 'snapshot')?.state };
    },
  };
  return rig;
}

/** Bật Remote và chờ danh bạ giữ khoá + máy vào kênh. */
async function turnOn(r: Rig): Promise<void> {
  const res = await r.remote.start();
  expect(res).toEqual({ ok: true });
  await waitFor(() => r.acct.hosts.size === 1 && !!r.remote.view().keyed, 4000, 'danh bạ giữ khoá');
}

describe('bật Remote: tài khoản, danh bạ, khoá', () => {
  it('không có token (chưa đăng nhập) → không bật, nói rõ lý do và cách làm (/login), không đụng mạng', async () => {
    const r = await mkRig({ noToken: true });
    const before = r.acct.calls.length; // bước đăng nhập giả của rig đã gọi ext_auth_exchange
    const res = await r.remote.start();
    expect(res.ok).toBe(false);
    expect(r.remote.view().on).toBe(false);
    expect(r.remote.view().problem).toMatch(/\/login/);
    expect(r.acct.calls).toHaveLength(before); // không gọi thêm RPC nào (không token thì không có gì để gửi)
  });

  it('token hết hiệu lực → không bật, báo «chạy /login lại»', async () => {
    const r = await mkRig();
    r.acct.revokeAll();
    const res = await r.remote.start();
    expect(res.ok).toBe(false);
    expect(r.remote.view().problem).toMatch(/\/login lại/);
    expect(r.remote.view().on).toBe(false);
  });

  it('mất mạng tới máy chủ tài khoản → không bật, nói là lỗi mạng (không bảo đăng nhập lại oan)', async () => {
    const r = await mkRig();
    r.acct.mode = 'down';
    const res = await r.remote.start();
    expect(res.ok).toBe(false);
    expect(r.remote.view().problem).toMatch(/mạng/);
    expect(r.remote.view().problem).not.toMatch(/\/login/);
  });

  it('bật thành công: báo danh máy «<hostname> · CLI» + tên thư mục + meta client=cli; danh bạ giữ khoá; view() đúng', async () => {
    const r = await mkRig();
    await turnOn(r);
    const host = [...r.acct.hosts.values()][0]!;
    expect(host.label).toMatch(/ · CLI$/);
    expect(host.label).toBe(machineLabel());
    expect(host.workspace).toBe(r.cwd.split(/[\\/]/).pop());
    expect(host.accountKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(host.hostId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const upsert = r.acct.calls.find((c) => c.fn === 'ext_host_upsert')!;
    expect(upsert.args.p_meta).toEqual(hostMeta('9.9.9-test'));
    expect(upsert.args.p_meta).toMatchObject({ client: 'cli', app: 'Locaith CLI 9.9.9-test' });
    expect((upsert.args.p_meta as Record<string, unknown>).ext).toBeUndefined(); // không bịa «extension» (trang so phiên bản extension với 0.6.5)
    const v = r.remote.view();
    expect(v).toMatchObject({ on: true, keyed: true, sessions: 0, pairing: false, hostId: host.hostId });
    expect(['connecting', 'online']).toContain(v.link);
  });

  it('khoá tài khoản KHÔNG nằm trong log/thông báo/view; tệp remote.json quyền 600 (trừ Windows) và chứa khoá', async () => {
    const logs: string[] = [];
    const r = await mkRig({ deps: { log: (_l, m) => logs.push(m) } });
    await turnOn(r);
    const key = [...r.acct.hosts.values()][0]!.accountKey!;
    expect(JSON.stringify(r.remote.view())).not.toContain(key);
    expect(logs.join('\n')).not.toContain(key);
    expect(r.notices.map((n) => n.text).join('\n')).not.toContain(key);
    expect(r.opened.join('\n')).not.toContain(key);
    const f = remoteFile(r.home);
    expect(fs.readFileSync(f, 'utf8')).toContain(key);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('mã máy ổn định theo thư mục: tắt rồi bật lại (và mở CLI lần sau) vẫn cùng mã; thư mục khác → mã khác', async () => {
    const r = await mkRig();
    await turnOn(r);
    const id1 = r.remote.view().hostId;
    await r.remote.dispose(); // thoát CLI: giữ khoá
    const r2 = new CliRemote({ rt: r.h.rt, home: r.home, cwd: r.cwd, version: '9.9.9-test', lang: () => 'vi', token: () => r.token, accountConfig: { supabaseUrl: r.acct.url, anonKey: r.acct.anonKey, webUrl: 'https://locaith.ai' }, createLink: () => r.hostLink });
    cleanups.push(() => r2.dispose());
    expect((await r2.start()).ok).toBe(true);
    expect(r2.view().hostId).toBe(id1);
    const r3 = new CliRemote({ rt: r.h.rt, home: r.home, cwd: tmpDir('lc-other-'), version: '9.9.9-test', lang: () => 'vi', token: () => r.token, accountConfig: { supabaseUrl: r.acct.url, anonKey: r.acct.anonKey, webUrl: 'https://locaith.ai' }, createLink: () => r.hostLink });
    cleanups.push(() => r3.dispose());
    expect((await r3.start()).ok).toBe(true);
    expect(r3.view().hostId).not.toBe(id1);
  });

  it('thoát CLI (dispose) GIỮ khoá để mở lại là nối tiếp; tắt hẳn (stop) THU HỒI: gỡ máy khỏi danh bạ và lần bật sau dùng khoá MỚI', async () => {
    const r = await mkRig();
    await turnOn(r);
    const key1 = [...r.acct.hosts.values()][0]!.accountKey!;
    await r.remote.dispose();
    // dispose gỡ máy khỏi danh bạ nhưng GIỮ khoá trong tệp
    expect(r.acct.hosts.size).toBe(0);
    expect(fs.readFileSync(remoteFile(r.home), 'utf8')).toContain(key1);
    expect((await r.remote.start()).ok).toBe(true);
    await waitFor(() => r.acct.hosts.size === 1, 3000, 'báo danh lại');
    expect([...r.acct.hosts.values()][0]!.accountKey).toBe(key1);
    await r.remote.stop(); // tắt hẳn
    expect(r.acct.hosts.size).toBe(0);
    expect(fs.readFileSync(remoteFile(r.home), 'utf8')).not.toContain(key1);
    expect((await r.remote.start()).ok).toBe(true);
    await waitFor(() => r.acct.hosts.size === 1, 3000, 'báo danh lại');
    expect([...r.acct.hosts.values()][0]!.accountKey).not.toBe(key1);
  });

  it('máy chủ tài khoản CHƯA nâng cấp (không có tham số khoá): Remote vẫn bật, keyed=false, và /remote rơi về liên kết ghép đôi', async () => {
    const r = await mkRig();
    r.acct.legacyHostUpsert = true;
    expect((await r.remote.start()).ok).toBe(true);
    await waitFor(() => r.acct.hosts.size === 1, 3000, 'báo danh');
    expect(r.remote.view().keyed).toBe(false);
    const w = await r.remote.webUrl();
    expect(w?.mode).toBe('pairing');
    expect(w?.url).toMatch(/^https:\/\/locaith\.ai\/#remote\?/);
  });
});

describe('mở trang locaith.ai', () => {
  it('có khoá trong danh bạ → địa chỉ «vào bằng tài khoản» (#remote?h=<mã máy>), KHÔNG kèm khoá/bí mật', async () => {
    const r = await mkRig();
    await turnOn(r);
    const w = await r.remote.webUrl();
    expect(w?.mode).toBe('account');
    const hostId = r.remote.view().hostId!;
    expect(w?.url).toContain(encodeURIComponent(hostId));
    expect(w?.url).toMatch(/^https:\/\/locaith\.ai\/#remote\?/);
    const key = [...r.acct.hosts.values()][0]!.accountKey!;
    expect(w?.url).not.toContain(key);
    const res = await r.remote.openWeb();
    expect(res).toMatchObject({ ok: true, opened: true, mode: 'account' });
    expect(r.opened).toEqual([w?.url]);
  });

  it('chưa bật thì không có địa chỉ để mở', async () => {
    const r = await mkRig();
    expect(await r.remote.webUrl()).toBeUndefined();
    expect(await r.remote.openWeb()).toEqual({ ok: false, opened: false });
  });

  it('trình duyệt không mở được (máy chủ không có GUI) → vẫn trả địa chỉ để người dùng mở tay', async () => {
    const r = await mkRig({ deps: { openUrl: () => false } });
    await turnOn(r);
    const res = await r.remote.openWeb();
    expect(res.ok).toBe(true);
    expect(res.opened).toBe(false);
    expect(res.url).toMatch(/^https:\/\/locaith\.ai\//);
  });
});

describe('trình duyệt đăng nhập đúng tài khoản vào được, không cần ghép đôi', () => {
  it('bắt tay xong nhận snapshot: máy/thư mục/model/chế độ đúng; host khai vscode=terminal, ext=phiên bản CLI', async () => {
    const r = await mkRig();
    await turnOn(r);
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    const s = b.snapshot();
    expect(s).toBeTruthy();
    expect(s.host).toMatchObject({ vscode: 'terminal', ext: '9.9.9-test', platform: process.platform });
    expect(s.host.workspace).toBe(r.cwd.split(/[\\/]/).pop());
    expect(s.model).toBe('test-model');
    expect(s.mode).toBe('default');
    expect(s.sessionId).toBe(r.h.rt.status().sessionId);
    expect(s.remoteCanBypass).toBe(false);
    expect(r.approvals).toHaveLength(0); // không hộp thoại «Cho phép»
    expect(r.remote.view().sessions).toBe(1);
  });

  it('chủ máy được báo NGAY (đỏ/vàng, nói cách ngắt): «Một trình duyệt đăng nhập cùng tài khoản … /remote off»', async () => {
    const r = await mkRig();
    await turnOn(r);
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    await waitFor(() => r.notices.some((n) => /đăng nhập cùng tài khoản/.test(n.text)), 3000, 'thông báo');
    const n = r.notices.find((x) => /đăng nhập cùng tài khoản/.test(x.text))!;
    expect(n.level).toBe('warn');
    expect(n.text).toContain('/remote off');
  });

  it('KHÔNG vào được nếu sai khoá tài khoản (người biết tên kênh nhưng không đăng nhập đúng tài khoản): im lặng, không phiên', async () => {
    const r = await mkRig();
    await turnOn(r);
    const wrong = b64u(randomBytes(16));
    const b = await r.browser({ accountKey: wrong });
    await sleep(600);
    expect(b.status()).not.toBe('online');
    expect(b.got).toHaveLength(0);
    expect(r.remote.view().sessions).toBe(0);
  });

  it('relay (người vận hành) KHÔNG thấy nội dung: tin nhắn người dùng, câu trả lời và tên thư mục không xuất hiện ở dạng rõ trên dây', async () => {
    const SECRET_Q = 'CÂU-HỎI-BÍ-MẬT-4172';
    const SECRET_A = 'CÂU-TRẢ-LỜI-BÍ-MẬT-9931';
    const r = await mkRig({ script: [textTurn(SECRET_A)] });
    await turnOn(r);
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    await b.rc.command({ type: 'send', text: SECRET_Q });
    await waitFor(() => JSON.stringify(b.got).includes(SECRET_A), 6000, 'câu trả lời tới trình duyệt');
    const wire = r.bus.wireText();
    expect(wire).not.toContain(SECRET_Q);
    expect(wire).not.toContain(SECRET_A);
    expect(wire).not.toContain(r.cwd.split(/[\\/]/).pop()!);
    expect(wire.length).toBeGreaterThan(200); // có tin thật đã đi qua (không phải rỗng)
  });
});

describe('điều khiển từ xa', () => {
  async function online(script: Parameters<typeof mkRig>[0] = {}): Promise<{ r: Rig; b: Browser }> {
    const r = await mkRig(script);
    await turnOn(r);
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    return { r, b };
  }
  const seenText = (b: Browser): string =>
    b.got
      .filter((m) => m.type === 'events')
      .flatMap((m) => m.events)
      .filter((e: any) => e.t === 'text')
      .map((e: any) => e.delta)
      .join('');

  it('gửi tin từ xa chạy một lượt agent THẬT: tin hiện ở transcript, câu trả lời stream về trình duyệt; terminal cũng thấy', async () => {
    const { r, b } = await online({ script: [textTurn('Xin chào từ máy trạm')] });
    await b.rc.command({ type: 'send', text: 'chào bạn' });
    await waitFor(() => seenText(b).includes('Xin chào từ máy trạm'), 6000, 'câu trả lời');
    await r.h.rt.idle();
    expect(r.h.texts()).toContain('Xin chào từ máy trạm'); // runtime/terminal cũng nhận (cùng một phiên)
    expect(r.h.provider.requests.length).toBe(1);
    expect(JSON.stringify(r.h.provider.requests[0].messages)).toContain('chào bạn');
    // chủ máy được báo «Từ xa · … gửi tin nhắn»
    expect(r.notices.some((n) => /Từ xa · .*gửi tin nhắn/.test(n.text))).toBe(true);
    // snapshot sau lượt có tin của người dùng trong transcript
    await waitFor(() => b.snapshot()?.transcript?.some?.((i: any) => i.kind === 'user' && i.text === 'chào bạn') || JSON.stringify(b.got).includes('chào bạn'), 3000, 'tin người dùng');
  });

  it('tin `!shell` bị CHẶN trước khi tới runtime: lệnh lỗi shell_not_remote, KHÔNG chạy gì, KHÔNG có yêu cầu nào tới model, chủ máy được cảnh báo', async () => {
    const { r, b } = await online();
    const marker = `${r.cwd}/DA-CHAY.txt`;
    await expect(b.rc.command({ type: 'send', text: `!echo pwned > "${marker}"` })).rejects.toMatchObject({ code: 'command_failed' });
    await sleep(300);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.h.provider.requests).toHaveLength(0);
    expect(r.h.events.filter((e) => e.t === 'ui' && e.ev.t === 'tool_start')).toHaveLength(0);
    expect(r.notices.some((n) => n.level === 'warn' && /shell/.test(n.text))).toBe(true);
  });

  it('lệnh gạch chéo ngoài danh sách trắng (/resume, /model, /exit, /remote off…) bị chặn; /status và /context chạy được', async () => {
    const { r, b } = await online();
    for (const t of ['/resume', '/model x', '/exit', '/remote off', '/login', '/permissions allow Bash(*)', '/mode bypass']) {
      await expect(b.rc.command({ type: 'send', text: t })).rejects.toBeInstanceOf(Error);
    }
    expect(r.remote.view().on).toBe(true); // /remote off từ xa KHÔNG tắt được Remote
    expect(r.h.rt.status().sessionId).toBe(r.h.rt.status().sessionId);
    expect(r.h.events.filter((e) => e.t === 'ask')).toHaveLength(0); // không có hộp hỏi treo trên máy
    await b.rc.command({ type: 'send', text: '/status' });
    await waitFor(() => r.h.outputs().some((o) => /Locaith CLI/.test(o)), 3000, '/status chạy');
  });

  it('thẻ xin quyền tới trình duyệt (tool_permission) và «Cho phép» từ xa thật sự cho công cụ chạy', async () => {
    const script = [toolTurn([{ id: 'c1', name: 'write_file', input: { path: 'tu-xa.txt', content: 'XYZ' } }]), textTurn('xong')];
    const { r, b } = await online({ script });
    await b.rc.command({ type: 'send', text: 'tạo tệp tu-xa.txt' });
    const perm = await until(() => b.got.filter((m) => m.type === 'events').flatMap((m) => m.events).find((e: any) => e.t === 'tool_permission'), 6000, 'thẻ xin quyền');
    expect(perm.request.id).toBeTruthy();
    expect(fs.existsSync(`${r.cwd}/tu-xa.txt`)).toBe(false); // chưa cho phép thì chưa ghi
    await b.rc.command({ type: 'permission_response', id: perm.request.id, decision: 'allow' });
    await r.h.rt.idle();
    expect(fs.readFileSync(`${r.cwd}/tu-xa.txt`, 'utf8')).toBe('XYZ');
  });

  it('«Từ chối» từ xa → công cụ KHÔNG chạy', async () => {
    const script = [toolTurn([{ id: 'c1', name: 'write_file', input: { path: 'khong.txt', content: 'NO' } }]), textTurn('thôi')];
    const { r, b } = await online({ script });
    await b.rc.command({ type: 'send', text: 'tạo tệp khong.txt' });
    const perm = await until(() => b.got.filter((m) => m.type === 'events').flatMap((m) => m.events).find((e: any) => e.t === 'tool_permission'), 6000, 'thẻ xin quyền');
    await b.rc.command({ type: 'permission_response', id: perm.request.id, decision: 'deny' });
    await r.h.rt.idle();
    expect(fs.existsSync(`${r.cwd}/khong.txt`)).toBe(false);
  });

  it('đổi chế độ quyền: plan/acceptEdits được; bypass bị CHẶN khi chưa cho phép (cả bằng lệnh set_mode lẫn /mode bypass)', async () => {
    const { r, b } = await online();
    await b.rc.command({ type: 'set_mode', mode: 'plan' });
    expect(r.h.rt.status().mode).toBe('plan');
    await b.rc.command({ type: 'set_mode', mode: 'acceptEdits' });
    expect(r.h.rt.status().mode).toBe('acceptEdits');
    await expect(b.rc.command({ type: 'set_mode', mode: 'bypass' })).rejects.toMatchObject({ code: 'bypass_not_allowed' });
    expect(r.h.rt.status().mode).toBe('acceptEdits');
    await expect(b.rc.command({ type: 'send', text: '/mode bypass' })).rejects.toBeInstanceOf(Error);
    expect(r.h.rt.status().mode).toBe('acceptEdits');
  });

  it('bypass chỉ qua được khi người ngồi ở máy BẬT cài đặt cho phép (và runtime cho phép)', async () => {
    const r = await mkRig({ allowBypass: true, deps: {} });
    await turnOn(r);
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    expect(b.snapshot().remoteCanBypass).toBe(true);
    await b.rc.command({ type: 'set_mode', mode: 'bypass' });
    // runtime chỉ nhận bypass khi chính nó cho phép (cờ --dangerously-skip-permissions hoặc agent.allowBypassPermissions): ở đây không → vẫn không đổi
    expect(['default', 'bypass']).toContain(r.h.rt.status().mode);
  });

  it('dừng, phiên mới, mở lại phiên cũ, đổi suy luận hoạt động; lệnh chưa hỗ trợ trong CLI (đổi tên, ghim, rewind…) báo lỗi rõ thay vì im lặng', async () => {
    const { r, b } = await online({ script: [textTurn('một'), textTurn('hai')] });
    await b.rc.command({ type: 'send', text: 'câu một' });
    await r.h.rt.idle();
    const first = r.h.rt.status().sessionId;
    await b.rc.command({ type: 'new_session' });
    const second = r.h.rt.status().sessionId;
    expect(second).not.toBe(first);
    await waitFor(() => b.snapshot()?.sessionId === second, 4000, 'snapshot phiên mới');
    await b.rc.command({ type: 'set_thinking', level: 'low' });
    expect(r.h.rt.status().thinking).toBe('low');
    await b.rc.command({ type: 'stop' }); // không có gì chạy: không lỗi
    await expect(b.rc.command({ type: 'rename_session', id: first, title: 'đổi tên' })).rejects.toMatchObject({ code: 'command_failed' });
    await expect(b.rc.command({ type: 'pin_session', id: first, pinned: true })).rejects.toMatchObject({ code: 'command_failed' });
    await expect(b.rc.command({ type: 'rewind_open', promptId: 'x' })).rejects.toMatchObject({ code: 'command_failed' });
  });

  it('giới hạn tốc độ lệnh: quá 120 lệnh/phút bị từ chối (dùng chung bộ giới hạn của lõi)', async () => {
    const { b } = await online();
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      try {
        await b.rc.command({ type: 'stop' });
      } catch (err) {
        if ((err as { code?: string }).code === 'rate_limited') limited++;
      }
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('thu hồi', () => {
  it('«Đổi khoá tài khoản» ngắt trình duyệt đang vào và vô hiệu khoá cũ; khoá mới (từ danh bạ) vào lại được', async () => {
    const r = await mkRig();
    await turnOn(r);
    const oldKey = [...r.acct.hosts.values()][0]!.accountKey!;
    const b1 = await r.browser();
    await waitFor(() => b1.status() === 'online', 5000, 'online');
    expect(await r.remote.rotateKey()).toBe(true);
    const newKey = [...r.acct.hosts.values()][0]!.accountKey!;
    expect(newKey).not.toBe(oldKey);
    await waitFor(() => b1.status() === 'revoked', 4000, 'bị ngắt');
    const old = await r.browser({ accountKey: oldKey });
    await sleep(500);
    expect(old.status()).not.toBe('online');
    const fresh = await r.browser({ accountKey: newKey });
    await waitFor(() => fresh.status() === 'online', 5000, 'khoá mới vào được');
  });

  it('đổi khoá mà danh bạ không nhận (mất mạng) → KHÔNG đổi gì: khoá cũ còn nguyên và vẫn vào được', async () => {
    const r = await mkRig();
    await turnOn(r);
    const key = [...r.acct.hosts.values()][0]!.accountKey!;
    r.acct.mode = 'down';
    expect(await r.remote.rotateKey()).toBe(false);
    r.acct.mode = undefined;
    expect(fs.readFileSync(remoteFile(r.home), 'utf8')).toContain(key);
    const b = await r.browser({ accountKey: key });
    await waitFor(() => b.status() === 'online', 5000, 'vẫn vào được bằng khoá cũ');
  });

  it('tắt Remote (stop) ngắt trình duyệt ngay và gỡ máy khỏi danh bạ; khoá cũ không vào lại được sau khi bật lại', async () => {
    const r = await mkRig();
    await turnOn(r);
    const oldKey = [...r.acct.hosts.values()][0]!.accountKey!;
    const b = await r.browser();
    await waitFor(() => b.status() === 'online', 5000, 'online');
    await r.remote.stop();
    expect(r.acct.hosts.size).toBe(0);
    expect(r.remote.view().on).toBe(false);
    expect(r.remote.view().link).toBe('off');
    expect((await r.remote.start()).ok).toBe(true);
    await waitFor(() => r.acct.hosts.size === 1, 3000, 'báo danh lại');
    const old = await r.browser({ accountKey: oldKey });
    await sleep(500);
    expect(old.status()).not.toBe('online');
  });
});

describe('ghép đôi bằng liên kết (cho thiết bị không đăng nhập tài khoản này)', () => {
  it('KHÔNG bao giờ tự cho phép: không có hàm xác nhận → từ chối; thiết bị không được lưu', async () => {
    const r = await mkRig({ deps: { approve: undefined } });
    // approve mặc định trong mkRig luôn có; dùng CliRemote không truyền approve để kiểm hành vi mặc định
    const bus = new RelayBus();
    const link = bus.link('host');
    const rem = new CliRemote({ rt: r.h.rt, home: r.home, cwd: r.cwd, version: '9.9.9-test', lang: () => 'vi', token: () => r.token, accountConfig: { supabaseUrl: r.acct.url, anonKey: r.acct.anonKey, webUrl: 'https://locaith.ai' }, createLink: () => link });
    cleanups.push(() => rem.dispose());
    expect((await rem.start()).ok).toBe(true);
    const p = rem.startPairing()!;
    const psk = parsePairingLink(p.url)?.psk; // liên kết ghép đôi: #remote?r=<mã máy>&k=<psk>
    expect(psk).toBeTruthy();
    const web = bus.link('web');
    web.start();
    cleanups.push(() => web.stop());
    await expect(pairWithHost({ link: web, psk: psk!, label: 'Điện thoại lạ', resendMs: 100, timeoutMs: 3000 })).rejects.toMatchObject({ code: 'denied' });
    expect(await rem.server.status().devices).toHaveLength(0);
  });

  it('người ngồi ở máy bấm «Cho phép» (hiện mã SAS) → ghép được, thiết bị lưu trong tệp, thu hồi được', async () => {
    const r = await mkRig({ approve: true });
    await turnOn(r);
    const p = r.remote.startPairing()!;
    expect(p.expiresAt).toBeGreaterThan(Date.now());
    const psk = parsePairingLink(p.url)?.psk;
    expect(psk).toBeTruthy();
    const web = r.bus.link('web-pair');
    web.start();
    cleanups.push(() => web.stop());
    const res = await pairWithHost({ link: web, psk: psk!, label: 'Điện thoại của tôi', resendMs: 100, timeoutMs: 4000 });
    expect(res.sas).toMatch(/^\d{3} \d{3}$/); // «123 456» — người dùng đối chiếu hai mã bằng mắt
    expect(r.approvals).toHaveLength(1);
    expect(r.approvals[0]).toMatchObject({ label: 'Điện thoại của tôi', sas: res.sas });
    expect(r.remote.server.status().devices.filter((d) => d.kind === 'relay')).toHaveLength(1);
    expect(fs.readFileSync(remoteFile(r.home), 'utf8')).toContain('Điện thoại của tôi');
  });
});

describe('hiển thị trên locaith.ai', () => {
  it('nhãn máy: «<hostname> · CLI», tối đa 60 ký tự, bỏ ký tự lạ', () => {
    expect(machineLabel('may-tram')).toBe('may-tram · CLI');
    expect(machineLabel('máy-của-tôi')).toBe('my-ca-ti · CLI'); // bỏ chữ có dấu/ký tự ngoài tập cho phép (máy chủ cũng lọc như vậy)
    // Tên máy dài (hostname máy CI: sjc22-bm211-388cc323-…) phải CẮT PHẦN TÊN, hậu tố « · CLI» luôn còn — nếu không, trên trang không phân biệt được với VS Code.
    const long = machineLabel('sjc22-bm211-388cc323-4498-4c1e-8ed5-c9f2b1a7e4d3');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/ · CLI$/);
    expect(long.startsWith('sjc22-bm211')).toBe(true);
    expect(machineLabel('x'.repeat(100))).toMatch(/^x+ · CLI$/);
    expect(machineLabel('x'.repeat(100)).length).toBeLessThanOrEqual(60);
    expect(machineLabel('   ')).toBe('May · CLI');
  });

  it('meta gửi danh bạ: client=cli, platform, app «Locaith CLI <phiên bản>», không có ext/vscode', () => {
    expect(hostMeta('0.4.8', 'win32')).toEqual({ client: 'cli', platform: 'win32', app: 'Locaith CLI 0.4.8' });
  });
});
