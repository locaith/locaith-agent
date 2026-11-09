/**
 * Lệnh `/remote` ở tầng runtime (mô-đun tính năng thật, runtime thật, máy chủ tài khoản giả, relay giả trong bộ nhớ). Kiểm: hộp xác nhận lần đầu nói rõ rủi ro; bật/tắt/status/url/pair/key;
 * tắt = thu hồi; tự bật lại ở thư mục đã bật; dải trạng thái; hộp xin quyền ở terminal tự đóng khi trả lời từ xa; /remote không chạy được TỪ XA.
 */
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountClient } from '../../../src/core/account/client';
import { challengeOf, newVerifier } from '../../../src/core/account/pkce';
import { ACCOUNT_DEV, b64u, deriveAccountKey, unb64u } from '../../../src/core/remote/e2e';
import { RelayClient } from '../../../src/core/remote/relayClient';
import type { RelayLink } from '../../../src/core/remote/relayHost';
import { CliRemote } from '../../../src/cli/remote/remote';
import { remoteFile } from '../../../src/cli/remote/store';
import { makeRemoteFeature } from '../../../src/cli/runtime/features/remote';
import type { AskInput } from '../../../src/cli/runtime/contract';
import { MockAccountServer } from '../../helpers/mockAccountServer';
import { RelayBus } from '../../helpers/relayBus';
import { textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, tmpDir, waitFor, type Harness } from '../runtime/harness';

const USER = { id: 'u-7', email: 'chu@example.com', name: 'Chủ máy' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  cleanupDirs();
});

interface Rig {
  h: Harness;
  acct: MockAccountServer;
  bus: RelayBus;
  opened: string[];
  asks: AskInput[];
  /** Trả lời tự động các hộp hỏi: hàm trả giá trị (mặc định `true` cho confirm). */
  answerWith: (fn: (a: any) => unknown) => void;
  cwd: string;
  home: string;
}

async function mkRig(o: { login?: boolean; home?: string; cwd?: string; settings?: Record<string, unknown>; script?: any[]; keepAcct?: MockAccountServer } = {}): Promise<Rig> {
  const acct = o.keepAcct ?? new MockAccountServer();
  if (!o.keepAcct) {
    acct.addUser(USER);
    await acct.start();
    cleanups.push(() => acct.stop());
  }
  const cfg = { supabaseUrl: acct.url, anonKey: acct.anonKey, webUrl: 'https://locaith.ai' };
  const home = o.home ?? tmpDir('lc-home-');
  const cwd = o.cwd ?? tmpDir('lc-cwd-');
  // đăng nhập giả: ghi khoá `lat_…` vào ~/.locaith/cli.json như `locaith login`
  if (o.login !== false) {
    const v = newVerifier();
    const code = acct.approve(USER.id, challengeOf(v), 'http://127.0.0.1:47000/cb', 'CLI thử');
    const ex = await new AccountClient(cfg, { timeoutMs: 2000 }).exchange(code, v, { client: 'cli' });
    if (!ex.ok) throw new Error('đăng nhập giả lỗi');
    fs.mkdirSync(`${home}/.locaith`, { recursive: true });
    fs.writeFileSync(`${home}/.locaith/cli.json`, JSON.stringify({ apiKey: ex.token }), { mode: 0o600 }); // đúng tên trường của CLI (xem runtime/auth.ts)
  }
  const bus = new RelayBus();
  const opened: string[] = [];
  const asks: AskInput[] = [];
  let answer: (a: any) => unknown = (a) => (a.kind === 'confirm' ? true : null);
  const feature = makeRemoteFeature({
    createRemote: (ctx, rt, hooks) =>
      new CliRemote({
        rt,
        home: ctx.home,
        cwd: ctx.cwd,
        version: ctx.version,
        lang: () => ctx.lang,
        token: () => ctx.accountToken?.(),
        accountConfig: cfg,
        createLink: () => bus.link('host') as unknown as RelayLink,
        approve: hooks.approve,
        openUrl: async (u) => {
          opened.push(u);
          return true;
        },
        allowBypass: () => ctx.settings.get<boolean>('remote.allowBypass', false) === true,
        notify: hooks.notify,
        onChange: hooks.onChange,
      }),
  });
  const h = await harness({ home, cwd, features: [feature], script: o.script ?? [], ...(o.settings ? { userSettings: o.settings } : {}) });
  cleanups.push(() => h.cleanup());
  // hộp hỏi: ghi lại rồi trả lời theo `answer`
  h.rt.on((e) => {
    if (e.t === 'ask') {
      asks.push(e.ask as AskInput);
      const v = answer(e.ask);
      queueMicrotask(() => h.rt.answer((e.ask as { id: string }).id, v as never));
    }
  });
  return { h, acct, bus, opened, asks, answerWith: (fn) => (answer = fn), cwd, home };
}

const out = (r: Rig): string => r.h.outputs().join('\n---\n');
const lastOut = (r: Rig): string => r.h.outputs().pop() ?? '';
/** Các thư mục đã được ghi nhớ «đã bật Remote» trong ~/.locaith/remote.json ({} nếu chưa có tệp/chưa ghi nhớ gì). */
const enabledMap = (home: string): Record<string, boolean> => {
  const f = remoteFile(home);
  return fs.existsSync(f) ? ((JSON.parse(fs.readFileSync(f, 'utf8')) as { enabled?: Record<string, boolean> }).enabled ?? {}) : {};
};

describe('/remote — bật lần đầu', () => {
  it('hỏi XÁC NHẬN nói rõ rủi ro (tài khoản điều khiển được máy, lệnh/tệp, mã hoá đầu-cuối, /remote off); từ chối thì KHÔNG bật gì và không gọi mạng', async () => {
    const r = await mkRig();
    r.answerWith((a) => (a.kind === 'confirm' ? false : null));
    const before = r.acct.calls.length;
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    const ask = r.asks.find((a: any) => a.kind === 'confirm') as any;
    expect(ask.title).toMatch(/tài khoản Locaith của bạn/);
    expect(ask.title).toMatch(/đọc\/sửa tệp, chạy lệnh/);
    expect(ask.title).toMatch(/mã hoá đầu-cuối/);
    expect(ask.title).toMatch(/\/remote off/);
    expect(ask.defaultYes).toBe(false);
    expect(ask.danger).toBe(true);
    expect(lastOut(r)).toMatch(/Chưa bật Remote/);
    expect(r.acct.hosts.size).toBe(0);
    expect(r.acct.calls.length).toBe(before);
    expect(r.opened).toHaveLength(0);
    expect(Object.keys(enabledMap(r.home))).toHaveLength(0); // chưa đồng ý thì không ghi nhớ gì
  });

  it('đồng ý → bật, báo danh máy, MỞ locaith.ai (vào bằng tài khoản) và in trạng thái; ghi nhớ đã bật ở thư mục này', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatch(/^https:\/\/locaith\.ai\/#remote\?h=[A-Za-z0-9_-]{22}$/);
    expect(r.h.events.some((e) => e.t === 'action' && e.action === 'open_url' && (e as any).payload === r.opened[0])).toBe(false); // mở qua openUrl của CliRemote (hook kiểm thử)
    const o = out(r);
    expect(o).toMatch(/Đã mở \*\*locaith\.ai\*\*/);
    expect(o).toMatch(/Remote: \*\*đang bật\*\*/);
    expect(o).toMatch(/Vào bằng tài khoản: \*\*sẵn sàng\*\*/);
    expect(o).toMatch(/\/remote off/);
    expect(JSON.parse(fs.readFileSync(remoteFile(r.home), 'utf8')).enabled).toBeTruthy();
    // dải trạng thái có `remote`
    await waitFor(() => !!r.h.rt.status().remote, 3000, 'status.remote');
    expect(r.h.rt.status().remote).toMatchObject({ sessions: 0 });
    expect(['connecting', 'online']).toContain(r.h.rt.status().remote!.link);
  });

  it('gõ lại /remote khi đã bật: KHÔNG hỏi lại, mở lại trang', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    const confirms = r.asks.filter((a: any) => a.kind === 'confirm').length;
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    expect(r.asks.filter((a: any) => a.kind === 'confirm').length).toBe(confirms);
    expect(r.opened).toHaveLength(2);
  });

  it('CHƯA đăng nhập → nói rõ cần tài khoản và chạy /login, không bật, không hỏi gì', async () => {
    const r = await mkRig({ login: false });
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    expect(lastOut(r)).toMatch(/Remote cần tài khoản Locaith/);
    expect(lastOut(r)).toMatch(/\/login/);
    expect(r.acct.hosts.size).toBe(0);
    expect(r.opened).toHaveLength(0);
  });

  it('máy chủ tài khoản không tới được → «Không bật được»/«mạng», không bật, và KHÔNG ghi nhớ «đã bật»', async () => {
    const r = await mkRig();
    r.acct.mode = 'down';
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    expect(lastOut(r)).toMatch(/mạng/);
    expect(r.opened).toHaveLength(0);
    expect(Object.keys(enabledMap(r.home))).toHaveLength(0); // bật không được thì không ghi nhớ «đã bật» (lần sau không tự thử bật)
  });

  it('chế độ không tương tác (-p): /remote nói cần giao diện, không bật', async () => {
    const r = await mkRig();
    // runtime không tương tác: dựng riêng
    const h2 = await harness({ home: r.home, cwd: r.cwd, features: [makeRemoteFeature()], interactive: false });
    cleanups.push(() => h2.cleanup());
    await h2.rt.submit('/remote');
    await h2.rt.idle();
    expect(h2.outputs().join('\n')).toMatch(/giao diện tương tác/);
    expect(r.acct.hosts.size).toBe(0);
  });
});

describe('/remote status | url | pair | key | off', () => {
  async function on(): Promise<Rig> {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    return r;
  }

  it('status: tắt → hướng dẫn bật; bật → đường truyền, số trình duyệt, vào-bằng-tài-khoản', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote status');
    expect(lastOut(r)).toMatch(/Remote: \*\*tắt\*\*/);
    const r2 = await on();
    await r2.h.rt.submit('/remote status');
    expect(lastOut(r2)).toMatch(/Remote: \*\*đang bật\*\*/);
    expect(lastOut(r2)).toMatch(/0 trình duyệt đang mở/);
  });

  it('url: in địa chỉ vào-bằng-tài-khoản (KHÔNG chứa khoá/bí mật); chưa bật thì báo gõ /remote', async () => {
    const r0 = await mkRig();
    await r0.h.rt.submit('/remote url');
    expect(lastOut(r0)).toMatch(/Remote chưa bật/);
    const r = await on();
    await r.h.rt.submit('/remote url');
    expect(lastOut(r)).toMatch(/https:\/\/locaith\.ai\/#remote\?h=[A-Za-z0-9_-]{22}/);
    const key = [...r.acct.hosts.values()][0]!.accountKey!;
    expect(lastOut(r)).not.toContain(key);
  });

  it('pair: in liên kết ghép đôi dùng một lần (bí mật sau #) và hướng dẫn; thiết bị ghép được sau khi người ngồi ở máy bấm «Cho phép» (hộp có mã SAS)', async () => {
    const r = await on();
    await r.h.rt.submit('/remote pair');
    const o = lastOut(r);
    expect(o).toMatch(/dùng một lần, hết hạn sau 5 phút/);
    expect(o).toMatch(/#remote\?r=[A-Za-z0-9_-]{22}&k=[A-Za-z0-9_-]{22}/);
    const { parsePairingLink } = await import('../../../src/core/remote/e2e');
    const link = /https:\/\/\S+/.exec(o)![0];
    const psk = parsePairingLink(link)!.psk;
    const { pairWithHost } = await import('../../../src/core/remote/relayClient');
    const web = r.bus.link('web');
    web.start();
    cleanups.push(() => web.stop());
    r.answerWith((a) => (a.kind === 'confirm' ? true : null));
    const res = await pairWithHost({ link: web, psk, label: 'Điện thoại', resendMs: 100, timeoutMs: 5000 });
    const ask = r.asks.filter((a: any) => a.kind === 'confirm').pop() as any;
    expect(ask.title).toMatch(/Điện thoại/);
    expect(ask.detail).toContain(res.sas); // người dùng đối chiếu mã SAS
    expect(ask.defaultYes).toBe(false);
    expect(ask.danger).toBe(true);
  });

  it('pair: bấm «Từ chối» ở terminal → thiết bị KHÔNG được ghép', async () => {
    const r = await on();
    await r.h.rt.submit('/remote pair');
    const { parsePairingLink } = await import('../../../src/core/remote/e2e');
    const { pairWithHost } = await import('../../../src/core/remote/relayClient');
    const psk = parsePairingLink(/https:\/\/\S+/.exec(lastOut(r))![0])!.psk;
    const web = r.bus.link('web');
    web.start();
    cleanups.push(() => web.stop());
    r.answerWith((a) => (a.kind === 'confirm' ? false : null));
    await expect(pairWithHost({ link: web, psk, label: 'Lạ', resendMs: 100, timeoutMs: 4000 })).rejects.toMatchObject({ code: 'denied' });
  });

  it('key: hỏi xác nhận rồi đổi khoá — khoá trong danh bạ đổi; từ chối thì không đổi', async () => {
    const r = await on();
    const k1 = [...r.acct.hosts.values()][0]!.accountKey!;
    r.answerWith((a) => (a.kind === 'confirm' ? false : null));
    await r.h.rt.submit('/remote key');
    await r.h.rt.idle(); // `submit` trả về ngay khi hộp xác nhận hiện ra — chờ lệnh chạy hết
    expect([...r.acct.hosts.values()][0]!.accountKey).toBe(k1);
    const outputsBefore = r.h.outputs().length;
    r.answerWith((a) => (a.kind === 'confirm' ? true : null));
    await r.h.rt.submit('/remote key');
    await r.h.rt.idle();
    await waitFor(() => r.h.outputs().length > outputsBefore, 3000, 'kết quả đổi khoá');
    expect(lastOut(r)).toMatch(/Đã đổi khoá tài khoản/);
    expect([...r.acct.hosts.values()][0]!.accountKey).not.toBe(k1);
  });

  it('off: gõ được ngay tại terminal — gỡ máy khỏi danh bạ, xoá khoá và ghi nhớ; trạng thái status.remote biến mất; gõ lần nữa → «đang tắt»', async () => {
    const r = await on();
    const k = [...r.acct.hosts.values()][0]!.accountKey!;
    await r.h.rt.submit('/remote off');
    expect(lastOut(r)).toMatch(/Đã tắt Remote/);
    expect(r.acct.hosts.size).toBe(0);
    expect(fs.readFileSync(remoteFile(r.home), 'utf8')).not.toContain(k);
    expect(JSON.parse(fs.readFileSync(remoteFile(r.home), 'utf8')).enabled ?? {}).toEqual({});
    await waitFor(() => !r.h.rt.status().remote, 3000, 'status.remote biến mất');
    await r.h.rt.submit('/remote off');
    expect(lastOut(r)).toMatch(/Remote đang tắt/);
  });

  it('lệnh lạ → báo cách dùng', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote lung-tung');
    expect(lastOut(r)).toMatch(/Không có «\/remote lung-tung»/);
    expect(lastOut(r)).toMatch(/status · off · url · pair · key/);
  });
});

describe('/remote — tự bật lại ở thư mục đã bật', () => {
  it('lần mở sau (cùng thư mục, đã đăng nhập) tự bật không hỏi; thư mục KHÁC thì không', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    const id1 = [...r.acct.hosts.values()][0]!.hostId;
    await r.h.cleanup(); // thoát CLI: dispose → ngắt đường truyền nhưng GIỮ khoá
    cleanups.pop();
    await waitFor(() => r.acct.hosts.size === 0, 3000, 'gỡ khỏi danh bạ khi thoát');

    const r2 = await mkRig({ keepAcct: r.acct, home: r.home, cwd: r.cwd, login: false });
    await waitFor(() => r2.acct.hosts.size === 1, 5000, 'tự bật lại');
    expect([...r2.acct.hosts.values()][0]!.hostId).toBe(id1); // cùng mã máy
    expect(r2.asks.filter((a: any) => a.kind === 'confirm')).toHaveLength(0);
    expect(r2.h.toasts().join('|')).toMatch(/Remote tự bật lại ở thư mục này/);
    await waitFor(() => !!r2.h.rt.status().remote, 3000, 'status.remote');

    // thư mục khác: không tự bật
    const other = await mkRig({ keepAcct: r.acct, home: r.home, cwd: tmpDir('lc-other-'), login: false });
    await sleep(500);
    expect([...r.acct.hosts.values()].filter((h) => h.hostId !== id1)).toHaveLength(0);
    expect(other.h.rt.status().remote).toBeUndefined();
  });

  it('cài đặt remote.autoStart=false tắt tự bật', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    await r.h.cleanup();
    cleanups.pop();
    const r2 = await mkRig({ keepAcct: r.acct, home: r.home, cwd: r.cwd, login: false, settings: { 'remote.autoStart': false } });
    await sleep(600);
    expect(r2.acct.hosts.size).toBe(0);
    expect(r2.h.rt.status().remote).toBeUndefined();
  });

  it('`/remote off` rồi mở lại CLI: KHÔNG tự bật', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    await r.h.rt.submit('/remote off');
    await r.h.cleanup();
    cleanups.pop();
    const r2 = await mkRig({ keepAcct: r.acct, home: r.home, cwd: r.cwd, login: false });
    await sleep(600);
    expect(r2.acct.hosts.size).toBe(0);
  });
});

describe('Remote ↔ terminal', () => {
  async function onlineBrowser(r: Rig) {
    const host = [...r.acct.hosts.values()][0]!;
    const key = b64u(await deriveAccountKey(unb64u(host.accountKey!), host.hostId));
    const link = r.bus.link('web');
    const got: any[] = [];
    const rc = new RelayClient({ link: link as any, dev: ACCOUNT_DEV, key, onStream: (m: any) => got.push(m), onStatus: () => undefined, helloTimeoutMs: 300, pingMs: 100, watchdogMs: 4000 });
    link.start();
    rc.start();
    cleanups.push(() => {
      rc.stop();
      link.stop();
    });
    await waitFor(() => rc.state === 'online', 5000, 'trình duyệt online');
    return { rc, got };
  }

  it('dải trạng thái đổi theo số trình duyệt đang mở (status.remote.sessions) và chủ máy thấy cảnh báo', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    const b = await onlineBrowser(r);
    await waitFor(() => r.h.rt.status().remote?.sessions === 1, 4000, 'sessions=1');
    expect(r.h.rt.status().remote?.link).toBe('online');
    expect(r.h.toasts().some((t) => /đăng nhập cùng tài khoản/.test(t))).toBe(true);
    b.rc.stop();
  });

  it('thẻ xin quyền: trả lời «Cho phép» TỪ XA → hộp ở terminal tự đóng (permission_cancel) và công cụ chạy', async () => {
    const r = await mkRig({ script: [toolTurn([{ id: 'c1', name: 'write_file', input: { path: 'xa.txt', content: 'OK' } }]), textTurn('xong')] });
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    const b = await onlineBrowser(r);
    await b.rc.command({ type: 'send', text: 'tạo xa.txt' });
    await waitFor(() => r.h.events.some((e) => e.t === 'permission'), 6000, 'hộp quyền ở terminal');
    const perm = (r.h.events.find((e) => e.t === 'permission') as any).request;
    await waitFor(() => JSON.stringify(b.got).includes('tool_permission'), 4000, 'thẻ tới trình duyệt');
    await b.rc.command({ type: 'permission_response', id: perm.id, decision: 'allow' });
    await r.h.rt.idle();
    expect(r.h.events.some((e) => e.t === 'permission_cancel' && (e as any).id === perm.id)).toBe(true); // hộp ở terminal đóng
    expect(fs.readFileSync(`${r.cwd}/xa.txt`, 'utf8')).toBe('OK');
  });

  it('`/remote off` GỬI TỪ XA bị chặn — trình duyệt không tự tắt/đổi được Remote; /remote key cũng vậy', async () => {
    const r = await mkRig();
    await r.h.rt.submit('/remote');
    await r.h.rt.idle();
    await waitFor(() => r.acct.hosts.size === 1, 4000, 'báo danh');
    const b = await onlineBrowser(r);
    for (const t of ['/remote off', '/remote key', '/remote url', '/remote']) await expect(b.rc.command({ type: 'send', text: t })).rejects.toBeInstanceOf(Error);
    expect(r.h.rt.status().remote).toBeTruthy();
    expect(r.acct.hosts.size).toBe(1);
  });
});
