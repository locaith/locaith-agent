import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_API_VERSION, type RemoteCommand, type RemoteState } from '../src/core/remote/protocol';
import { ACCOUNT_DEV, b64u, deriveAccountKey, genEcdh, hmac, lp, macHello, randomBytes, unb64u } from '../src/core/remote/e2e';
import { PairError, RelayClient, pairWithHost, type ClientStatus, CommandError } from '../src/core/remote/relayClient';
import { RelayHost } from '../src/core/remote/relayHost';
import { RemoteServer, type RemoteBackend, type RemoteDevice, type RemoteStore } from '../src/core/remote/server';
import { RelayBus, type BusLink } from './helpers/relayBus';

const HOST_ID = b64u(randomBytes(16));
const MARKER = 'BÍ-MẬT-XYZ-không-được-lộ';

const STATE: RemoteState = {
  v: REMOTE_API_VERSION,
  host: { name: 'PC-TEST', workspace: 'demo', vscode: '1.90.0', ext: '0.5.2', platform: 'win32' },
  sessionId: 's1',
  title: 'Phiên thử',
  transcript: [],
  omitted: 0,
  todos: [],
  running: false,
  queued: [],
  provider: 'demo',
  model: 'demo-1',
  mode: 'default',
  thinkingLevel: 'medium',
  providers: [],
  sessions: [],
  context: null,
  allowBypass: false,
  remoteCanBypass: false,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 3000, what = 'điều kiện'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`hết giờ chờ ${what}`);
    await sleep(5);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function memStore(): RemoteStore & { list: RemoteDevice[] } {
  const s = { list: [] as RemoteDevice[], load: async () => s.list.map((d) => ({ ...d })), save: async (l: RemoteDevice[]) => void (s.list = l.map((d) => ({ ...d }))) };
  return s;
}

interface Rig {
  bus: RelayBus;
  srv: RemoteServer;
  host: RelayHost;
  hostLink: BusLink;
  store: ReturnType<typeof memStore>;
  cmds: { device: { id: string; label: string }; cmd: RemoteCommand }[];
  approvals: { label: string; sas: string }[];
  state: RemoteState;
  clock: { offset: number };
  setApprove(v: boolean | ((r: { label: string; sas: string }) => Promise<boolean>)): void;
  pair(label?: string): Promise<{ dev: string; key: string; sas: string }>;
  connect(p: { dev: string; key: string }, o?: { watchdogMs?: number }): Client;
  /** Khoá tài khoản hiện hành của máy (base64url 22 ký tự) hoặc null = tắt tin cậy theo tài khoản. Đổi được giữa chừng như khi người dùng xoay khoá/tắt cài đặt. */
  acct: { key: string | null };
  /** Mỗi lần một phiên «tài khoản» được xác lập: số phiên «tài khoản» đang mở lúc đó. */
  accountEvents: number[];
  /** Kết nối như trình duyệt đăng nhập đúng tài khoản: thiết bị ACCOUNT_DEV, K_dev suy ra từ `accountKey` (HKDF theo mã máy). */
  connectAccount(accountKey: string, o?: { watchdogMs?: number }): Promise<Client>;
}

interface Client {
  rc: RelayClient;
  link: BusLink;
  got: any[];
  statuses: ClientStatus[];
  status(): ClientStatus;
}

function mkRig(o: { canBypass?: boolean; idleDays?: number; failCmd?: boolean; hostTiming?: object; accountKey?: string | null } = {}): Rig {
  const bus = new RelayBus();
  const store = memStore();
  const cmds: Rig['cmds'] = [];
  const clock = { offset: 0 }; // thời gian của rig = giờ thật + offset (cộng offset để "tua" nhanh mà các bộ hẹn giờ thật vẫn chạy)
  const state = structuredClone(STATE);
  const backend: RemoteBackend = {
    info: () => STATE.host,
    prepare: async () => {},
    state: () => state,
    command: async (device, cmd) => {
      if (o.failCmd) throw new Error('boom');
      cmds.push({ device, cmd });
    },
  };
  const srv = new RemoteServer(store, backend, { ports: [0], now: () => Date.now() + clock.offset, allowedOrigins: () => [], idleDays: () => o.idleDays ?? 30, canBypass: () => !!o.canBypass });
  const hostLink = bus.link('host');
  const approvals: Rig['approvals'] = [];
  const acct: { key: string | null } = { key: o.accountKey ?? null };
  const accountEvents: number[] = [];
  let approve: (r: { label: string; sas: string }) => Promise<boolean> = async () => true;
  const host = new RelayHost({
    hostId: HOST_ID,
    server: srv,
    link: hostLink,
    approve: (r) => {
      approvals.push(r);
      return approve(r);
    },
    presence: () => ({ name: 'PC-TEST' }),
    accountKey: () => acct.key,
    onAccountSession: (e) => accountEvents.push(e.sessions),
    now: () => Date.now() + clock.offset,
    timing: { flushMs: 5, heartbeatMs: 80, sweepMs: 60, helloTimeoutMs: 800, idleMs: 2500, pairTtlMs: 60_000, ...o.hostTiming },
  });
  host.start();
  cleanups.push(() => {
    host.stop();
    srv.stop();
  });

  const rig: Rig = {
    bus,
    srv,
    host,
    hostLink,
    store,
    cmds,
    approvals,
    state,
    clock,
    acct,
    accountEvents,
    setApprove: (v) => {
      approve = typeof v === 'function' ? v : async () => v;
    },
    async connectAccount(accountKey, copts = {}) {
      return rig.connect({ dev: ACCOUNT_DEV, key: b64u(await deriveAccountKey(unb64u(accountKey), HOST_ID)) }, copts);
    },
    async pair(label = 'Chrome · Windows') {
      const { psk } = host.startPairing();
      const link = bus.link('web-pair');
      link.start();
      try {
        return await pairWithHost({ link, psk, label, resendMs: 100, timeoutMs: 4000 });
      } finally {
        link.stop();
      }
    },
    connect(p, copts = {}) {
      const link = bus.link('web');
      const got: any[] = [];
      const statuses: ClientStatus[] = [];
      const rc = new RelayClient({
        link,
        dev: p.dev,
        key: p.key,
        onStream: (m) => got.push(m),
        onStatus: (s) => statuses.push(s),
        helloTimeoutMs: 300,
        pingMs: 100,
        watchdogMs: copts.watchdogMs ?? 1500,
      });
      link.start();
      rc.start();
      cleanups.push(() => {
        rc.stop();
        link.stop();
      });
      return { rc, link, got, statuses, status: () => rc.state };
    },
  };
  return rig;
}

describe('ghép đôi qua relay', () => {
  it('thành công: hai bên có cùng mã SAS, host hỏi người dùng, thiết bị được lưu kèm K_dev, psk dùng một lần', async () => {
    const r = mkRig();
    const { psk } = r.host.startPairing();
    expect(r.host.pairingState).not.toBeNull();
    const link = r.bus.link('web');
    link.start();
    let sasSeen = '';
    const res = await pairWithHost({ link, psk, label: 'Chrome · Windows', onSas: (s) => (sasSeen = s), resendMs: 100 });
    expect(res.sas).toMatch(/^\d{3} \d{3}$/);
    expect(sasSeen).toBe(res.sas);
    expect(r.approvals).toEqual([{ label: 'Chrome · Windows', sas: res.sas }]); // hộp thoại hiện đúng cùng mã
    expect(r.store.list).toHaveLength(1);
    const d = r.store.list[0]!;
    expect(d).toMatchObject({ id: res.dev, kind: 'relay', hostId: HOST_ID, key: res.key, label: 'Chrome · Windows' });
    expect(d.tokenHash).toBeUndefined();
    expect(r.host.pairingState).toBeNull(); // một lần dùng
    // dùng lại cùng psk: không còn cửa sổ → host im lặng
    const again = pairWithHost({ link, psk, label: 'Kẻ khác', resendMs: 50, timeoutMs: 400 });
    await expect(again).rejects.toMatchObject({ code: 'bad_host' });
    expect(r.store.list).toHaveLength(1);
  });

  it('người dùng bấm Từ chối → máy khách nhận denied, không lưu thiết bị', async () => {
    const r = mkRig();
    r.setApprove(false);
    await expect(r.pair()).rejects.toMatchObject({ code: 'denied' });
    expect(r.store.list).toHaveLength(0);
    expect(r.host.pairingState).toBeNull();
  });

  it('sai psk: host im lặng và KHÔNG đóng cửa sổ ghép đôi (kẻ biết tên kênh không phá được); máy khách thật vẫn ghép được sau đó', async () => {
    const r = mkRig();
    const { psk } = r.host.startPairing();
    const link = r.bus.link('web');
    link.start();
    const wrong = b64u(randomBytes(16));
    await expect(pairWithHost({ link, psk: wrong, label: 'x', resendMs: 20, timeoutMs: 500 })).rejects.toBeInstanceOf(PairError);
    expect(r.approvals).toHaveLength(0);
    expect(r.host.pairingState).not.toBeNull(); // cửa sổ vẫn mở
    expect(r.store.list).toHaveLength(0);
    const ok = await pairWithHost({ link, psk, label: 'Máy thật', resendMs: 100, timeoutMs: 4000 }); // người dùng thật vẫn ghép được
    expect(ok.dev).toBeTruthy();
    expect(r.store.list).toHaveLength(1);
  });

  it('giới hạn tốc độ yêu cầu ghép đôi: bão pair_req giả không làm host tốn tài nguyên vô hạn nhưng cũng không làm hỏng việc ghép đôi', async () => {
    const r = mkRig();
    const { psk } = r.host.startPairing();
    const atk = r.bus.link('attacker');
    atk.start();
    const eph = await genEcdh();
    for (let i = 0; i < 200; i++) atk.send({ t: 'pair_req', v: 1, A: b64u(eph.pub), nC: b64u(randomBytes(16)), label: 'bão', mac: b64u(randomBytes(32)) });
    await sleep(300);
    expect(r.approvals).toHaveLength(0);
    expect(r.host.pairingState).not.toBeNull();
    expect(psk.length).toBeGreaterThan(10);
  });

  it('chưa mở cửa sổ ghép đôi thì mọi yêu cầu bị bỏ qua', async () => {
    const r = mkRig();
    const link = r.bus.link('web');
    link.start();
    await expect(pairWithHost({ link, psk: b64u(randomBytes(16)), label: 'x', resendMs: 50, timeoutMs: 300 })).rejects.toMatchObject({ code: 'bad_host' });
    expect(r.approvals).toHaveLength(0);
  });

  it('huỷ cửa sổ ghép đôi trong lúc chờ bấm → máy khách nhận expired và không có thiết bị nào được lưu', async () => {
    const r = mkRig();
    let release!: (v: boolean) => void;
    r.setApprove(() => new Promise<boolean>((res) => (release = res)));
    const p = r.pair();
    await waitFor(() => r.approvals.length === 1, 3000, 'hộp thoại xác nhận');
    r.host.cancelPairing();
    release(true);
    await expect(p).rejects.toMatchObject({ code: 'expired' });
    expect(r.store.list).toHaveLength(0);
  });

  it('chống đua: hai yêu cầu ghép đôi cùng lúc chỉ hỏi người dùng MỘT lần', async () => {
    const r = mkRig();
    let release!: (v: boolean) => void;
    r.setApprove(() => new Promise<boolean>((res) => (release = res)));
    const { psk } = r.host.startPairing();
    const l1 = r.bus.link('w1');
    const l2 = r.bus.link('w2');
    l1.start();
    l2.start();
    // Bên nào được hỏi trước do thứ tự hoàn tất các phép mã hoá bất đồng bộ (WebCrypto) quyết định → KHÔNG giả định "Một" luôn thắng:
    // chỉ kiểm điều cốt lõi — người dùng bị hỏi đúng MỘT lần, đúng một bên ghép đôi được, bên còn lại nhận PairError, chỉ lưu một thiết bị.
    const settled = Promise.allSettled([
      pairWithHost({ link: l1, psk, label: 'Một', resendMs: 30, timeoutMs: 1500 }),
      pairWithHost({ link: l2, psk, label: 'Hai', resendMs: 30, timeoutMs: 1500 }),
    ]);
    await waitFor(() => r.approvals.length >= 1, 3000, 'hộp thoại');
    await sleep(150);
    expect(r.approvals).toHaveLength(1);
    release(true);
    const res = await settled;
    const won = res.filter((x) => x.status === 'fulfilled');
    const lost = res.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(PairError);
    expect(r.store.list).toHaveLength(1);
    expect(r.approvals).toHaveLength(1);
  });

  it('pair_ok tới TRƯỚC pair_hello (relay đảo thứ tự) vẫn ghép đôi được', async () => {
    const r = mkRig();
    const { psk } = r.host.startPairing();
    const link = r.bus.link('web-late-hello');
    // trễ riêng pair_hello 120 ms: host cho phép tức thì nên pair_ok tới trước nó
    const deliver = link.receive.bind(link);
    link.receive = (m: unknown) => {
      if ((m as { t?: string })?.t === 'pair_hello') setTimeout(() => deliver(m), 120);
      else deliver(m);
    };
    link.start();
    const res = await pairWithHost({ link, psk, label: 'Chrome', resendMs: 5000, timeoutMs: 3000 });
    expect(res.dev).toBeTruthy();
    expect(res.sas).toMatch(/^\d{3} \d{3}$/);
    expect(r.store.list).toHaveLength(1);
    // pair_ok sai MAC đứng trước cũng không làm hỏng việc ghép đôi thật
    const r2 = mkRig();
    const { psk: psk2 } = r2.host.startPairing();
    const link2 = r2.bus.link('web-forged-ok');
    const deliver2 = link2.receive.bind(link2);
    let forged = false;
    link2.receive = (m: unknown) => {
      const w = m as { t?: string; r?: string };
      if (w?.t === 'pair_hello') {
        if (!forged) {
          forged = true;
          deliver2({ t: 'pair_ok', r: w.r, dev: 'giả', mac: 'AAAA' }); // tới trước hello, MAC sai
        }
        setTimeout(() => deliver2(m), 100);
      } else deliver2(m);
    };
    link2.start();
    const ok = await pairWithHost({ link: link2, psk: psk2, label: 'Chrome', resendMs: 5000, timeoutMs: 3000 });
    expect(ok.dev).not.toBe('giả');
    expect(r2.store.list).toHaveLength(1);
  });

  it('tên thiết bị có ký tự điều khiển được làm sạch trước khi hiện ở hộp thoại/lưu', async () => {
    const r = mkRig();
    await r.pair('Chrome\u0007\u0000 «lạ»');
    expect(r.approvals[0]!.label).toBe('Chrome «lạ»');
  });

  it('relay (và người nghe lén) không thấy psk, K_dev hay khoá riêng trên dây', async () => {
    const r = mkRig();
    const { psk } = r.host.startPairing();
    const link = r.bus.link('web');
    link.start();
    const res = await pairWithHost({ link, psk, label: 'Chrome', resendMs: 100 });
    const wire = r.bus.wireText();
    expect(wire).not.toContain(psk);
    expect(wire).not.toContain(res.key);
  });
});

describe('phiên mã hoá đầu-cuối', () => {
  async function ready(o?: Parameters<typeof mkRig>[0]) {
    const r = mkRig(o);
    const p = await r.pair();
    const c = r.connect(p);
    await waitFor(() => c.status() === 'online', 4000, 'trạng thái online');
    return { r, p, c };
  }

  it('bắt tay → nhận snapshot đúng trạng thái host; sự kiện sau đó tới đúng thứ tự', async () => {
    const { r, c } = await ready();
    const snap = c.got.find((m) => m.type === 'snapshot');
    expect(snap.state.title).toBe('Phiên thử');
    expect(typeof snap.epoch).toBe('string');
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'một' }] });
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'hai' }] });
    r.srv.publish('toast', { level: 'info', text: 'ba' });
    await waitFor(() => c.got.filter((m) => m.type !== 'snapshot').length === 3, 3000, '3 tin');
    expect(c.got.filter((m) => m.type !== 'snapshot').map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(c.got.at(-1)).toMatchObject({ type: 'toast', text: 'ba' });
    expect(r.host.sessionCount).toBe(1);
  });

  it('KHÔNG lộ bản rõ: nội dung hội thoại, lệnh và khoá không xuất hiện trên dây', async () => {
    const { r, p, c } = await ready();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: MARKER }] });
    await c.rc.command({ type: 'send', text: `${MARKER} gửi từ trình duyệt` });
    await waitFor(() => r.cmds.length === 1, 3000, 'lệnh');
    await waitFor(() => c.got.some((m) => m.type === 'events'), 3000, 'sự kiện');
    expect(JSON.stringify(c.got)).toContain(MARKER); // máy khách đọc được
    const wire = r.bus.wireText();
    expect(wire).not.toContain(MARKER);
    expect(wire).not.toContain(Buffer.from(MARKER).toString('base64'));
    expect(wire).not.toContain(p.key);
    expect(wire).not.toContain('Phiên thử'); // tiêu đề trong snapshot
    expect(wire).not.toContain('PC-TEST');
    expect(r.hostLink.tracked).toEqual({ name: 'PC-TEST' }); // chỉ hiện diện (không bí mật) đi dạng rõ
  });

  it('relay ĐẢO THỨ TỰ tin (như Supabase Realtime thật khi gửi dồn): snapshot lớn vẫn ghép được và sự kiện vẫn tới đúng thứ tự', async () => {
    const r = mkRig();
    r.state.title = 'y'.repeat(300_000); // ~9 mảnh gửi dồn
    r.bus.jitter = 30;
    const p = await r.pair();
    const c = r.connect(p);
    await waitFor(() => c.status() === 'online', 8000, 'online dù relay đảo thứ tự');
    expect(c.got[0].state.title.length).toBe(300_000);
    for (let i = 0; i < 120; i++) r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: String(i) }] });
    await waitFor(() => c.got.filter((m) => m.type === 'events').length >= 120, 10_000, '120 sự kiện');
    const seqs = c.got.filter((m) => m.type === 'events').map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(120);
    await c.rc.command({ type: 'send', text: 'lệnh qua relay đảo thứ tự' });
    expect(r.cmds.at(-1)).toMatchObject({ cmd: { type: 'send' } });
  });

  it('tin sự kiện tới TRƯỚC snapshot (đảo thứ tự) được giữ lại và áp sau snapshot, không mất', async () => {
    const { r, p } = await (async () => { const r = mkRig(); return { r, p: await r.pair() }; })();
    // dựng máy khách với đường truyền tự chế để chèn tin sự kiện trước snapshot
    const link = r.bus.link('web');
    const got: any[] = [];
    const rc = new RelayClient({ link, dev: p.dev, key: p.key, onStream: (m) => got.push(m), onStatus: () => undefined, helloTimeoutMs: 400, pingMs: 200 });
    link.start();
    rc.start();
    await waitFor(() => rc.state === 'online', 4000, 'online');
    expect(got[0].type).toBe('snapshot');
    // mô phỏng: một lần xin lại snapshot (sub không since) trong lúc sự kiện mới đang bay
    cleanups.push(() => rc.stop());
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'a' }] });
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'b' }] });
    await waitFor(() => got.filter((m) => m.type === 'events').length === 2, 3000, '2 sự kiện');
    expect(got.filter((m) => m.type === 'events').map((m) => m.events[0].text)).toEqual(['a', 'b']);
  });

  it('lệnh: hợp lệ → host thi hành đúng một lần với tên thiết bị; không hợp lệ bị từ chối với mã lỗi; bypass bị chặn', async () => {
    const { r, c } = await ready();
    await c.rc.command({ type: 'send', text: 'xin chào' });
    expect(r.cmds).toHaveLength(1);
    expect(r.cmds[0]).toMatchObject({ device: { label: 'Chrome · Windows' }, cmd: { type: 'send', text: 'xin chào' } });
    await expect(c.rc.command({ type: 'delete_session', id: 'x' })).rejects.toMatchObject({ code: 'unknown_command' });
    await expect(c.rc.command({ type: 'set_mode', mode: 'bypass' })).rejects.toMatchObject({ code: 'bypass_not_allowed' });
    await expect(c.rc.command('rác' as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(r.cmds).toHaveLength(1);
  });

  it('lệnh của host lỗi → máy khách nhận command_failed kèm thông báo', async () => {
    const { c } = await ready({ failCmd: true });
    await expect(c.rc.command({ type: 'stop' })).rejects.toMatchObject({ code: 'command_failed', message: 'boom' });
  });

  it('snapshot lớn hơn giới hạn một tin Realtime vẫn tới đủ (cắt mảnh + ghép lại)', async () => {
    const r = mkRig();
    r.state.title = 'x'.repeat(300_000); // ~300 KB > giới hạn 250 KB của Realtime nếu gửi một khung
    const p = await r.pair();
    const c = r.connect(p);
    await waitFor(() => c.status() === 'online', 5000, 'online');
    expect(c.got[0].state.title.length).toBe(300_000);
    const biggest = Math.max(...r.bus.wire.map((w) => JSON.stringify(w.msg).length));
    expect(biggest).toBeLessThan(80_000);
  });

  it('mọi tin trên dây đều nhỏ hơn 80 KB kể cả khi một sự kiện lớn', async () => {
    const { r, c } = await ready();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'y'.repeat(500_000) }] });
    await waitFor(() => c.got.some((m) => m.type === 'events'), 5000, 'sự kiện lớn');
    expect(Math.max(...r.bus.wire.map((w) => JSON.stringify(w.msg).length))).toBeLessThan(80_000);
  });

  it('gom sự kiện: nhiều publish liên tiếp đi trong rất ít khung', async () => {
    const { r, c } = await ready();
    const before = r.bus.wire.length;
    for (let i = 0; i < 60; i++) r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: String(i) }] });
    await waitFor(() => c.got.filter((m) => m.type === 'events').length === 60, 3000, '60 sự kiện');
    expect(r.bus.wire.length - before).toBeLessThan(20);
  });

  it('nối lại bù (resume): chỉ nhận phần thiếu, không nhận lại snapshot', async () => {
    const { r, p, c } = await ready();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'a' }] });
    await waitFor(() => c.got.some((m) => m.type === 'events'), 3000, 'a');
    c.rc.stop();
    c.link.stop();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'b' }] });
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'c' }] });
    // phiên mới của CÙNG máy khách giữ lastSeq? — dùng RelayClient mới nhưng khai báo since qua cùng đối tượng: tạo lại bằng cách start() lại
    const link2 = r.bus.link('web2');
    const got2: any[] = [];
    const rc2 = new RelayClient({ link: link2, dev: p.dev, key: p.key, onStream: (m) => got2.push(m), onStatus: () => {}, helloTimeoutMs: 300, pingMs: 100 });
    link2.start();
    rc2.start();
    cleanups.push(() => {
      rc2.stop();
      link2.stop();
    });
    await waitFor(() => got2.some((m) => m.type === 'snapshot'), 3000, 'snapshot cho máy khách mới');
    expect(got2.find((m) => m.type === 'snapshot').seq).toBe(3);
  });

  it('mất đường truyền rồi có lại: máy khách tự bắt tay lại và nhận phần bị lỡ (resume)', async () => {
    const { r, c } = await ready();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'trước' }] });
    await waitFor(() => c.got.some((m) => m.type === 'events'), 3000, 'trước');
    c.link.setUp(false);
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'lỡ-1' }] });
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'lỡ-2' }] });
    await sleep(100);
    c.link.setUp(true); // onLink(up) → bắt tay lại ngay
    await waitFor(() => c.got.some((m) => m.type === 'resume'), 4000, 'resume');
    await waitFor(() => c.got.filter((m) => m.type === 'events').length === 3, 3000, 'đủ 3 sự kiện');
    const texts = c.got.filter((m) => m.type === 'events').map((m) => m.events[0].text);
    expect(texts).toEqual(['trước', 'lỡ-1', 'lỡ-2']);
    expect(c.got.filter((m) => m.type === 'snapshot')).toHaveLength(1);
  });

  it('một tin sự kiện bị relay làm rớt: máy khách phát hiện hở số thứ tự (hoặc nhịp tim báo thiếu) và xin bù', async () => {
    const { r, c } = await ready();
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'một' }] });
    await waitFor(() => c.got.some((m) => m.type === 'events'), 3000, 'một');
    // rớt đúng khung chứa sự kiện "hai" (không biết nội dung — chỉ rớt khung d kế tiếp từ host)
    let dropped = false;
    r.bus.drop = (msg, from) => {
      if (!dropped && from === r.hostLink && msg.t === 'd') {
        dropped = true;
        return true;
      }
      return false;
    };
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'hai' }] });
    await waitFor(() => dropped, 2000, 'rớt');
    r.bus.drop = undefined;
    await sleep(100);
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'ba' }] });
    await waitFor(() => c.got.filter((m) => m.type === 'events').length >= 3, 6000, 'bù đủ');
    const texts = c.got.filter((m) => m.type === 'events').map((m) => m.events[0].text);
    expect(texts).toEqual(['một', 'hai', 'ba']);
  });

  it('thu hồi thiết bị từ VS Code: máy khách thấy "revoked" và KHÔNG còn nối lại được ("unpaired")', async () => {
    const { r, p, c } = await ready();
    await r.srv.revoke(p.dev);
    await waitFor(() => c.status() === 'revoked', 3000, 'revoked');
    expect(c.got.some((m) => m.type === 'bye' && m.reason === 'revoked')).toBe(true);
    // thử nối lại với khoá cũ → host trả hello_no
    const c2 = r.connect(p);
    await waitFor(() => c2.status() === 'unpaired', 3000, 'unpaired');
    expect(r.host.sessionCount).toBe(0);
  });

  it('máy khách tự huỷ ghép đôi (unpair): host thu hồi thiết bị', async () => {
    const { r, c } = await ready();
    c.rc.unpair();
    await waitFor(() => r.store.list.length === 0, 3000, 'đã xoá thiết bị');
    await waitFor(() => c.status() === 'revoked', 3000, 'revoked');
  });

  it('host khởi động lại (mất hết phiên): máy khách được báo reset và tự bắt tay lại, nhận snapshot mới', async () => {
    const { r, c } = await ready();
    const oldEpoch = c.got[0].epoch;
    // "khởi động lại": dừng host, dựng host mới cùng kho thiết bị, cùng kênh
    r.host.stop();
    await sleep(150);
    const srv2 = new RemoteServer(r.store, { info: () => STATE.host, prepare: async () => {}, state: () => r.state, command: async () => {} }, { ports: [0], allowedOrigins: () => [] });
    const link2 = r.bus.link('host2');
    const host2 = new RelayHost({ hostId: HOST_ID, server: srv2, link: link2, approve: async () => true, timing: { flushMs: 5, heartbeatMs: 80, sweepMs: 60, idleMs: 2500 } });
    host2.start();
    cleanups.push(() => {
      host2.stop();
      srv2.stop();
    });
    await waitFor(() => c.got.filter((m) => m.type === 'snapshot').length === 2, 6000, 'snapshot mới sau khi host khởi động lại');
    expect(c.got.filter((m) => m.type === 'snapshot')[1].epoch).not.toBe(oldEpoch);
    expect(c.status()).toBe('online');
  });

  it('chống phát lại: gửi lại nguyên một tin hello đã ghi lại không tạo thêm phiên', async () => {
    const { r } = await ready();
    const hello = r.bus.wire.find((w) => w.msg.t === 'hello')!.msg;
    const before = r.host.sessionCount;
    r.bus.link('attacker').start();
    r.bus.links.forEach((l) => l.name === 'attacker' && l.send(hello));
    await sleep(150);
    expect(r.host.sessionCount).toBe(before);
    expect(r.bus.wire.filter((w) => w.msg.t === 'hello_ok')).toHaveLength(1);
  });

  it('chống phát lại / giả mạo khung dữ liệu: khung cũ, khung bị sửa, khung từ phiên lạ đều bị bỏ qua', async () => {
    const { r, c } = await ready();
    const frame = r.bus.wire.filter((w) => w.msg.t === 'd' && w.from !== r.hostLink).at(-1)!.msg; // khung d cuối cùng của trình duyệt
    const cmdsBefore = r.cmds.length;
    const atk = r.bus.link('attacker');
    atk.start();
    atk.send(frame); // phát lại
    atk.send({ ...frame, c: frame.c.slice(0, -4) + 'AAAA' }); // sửa bản mã
    atk.send({ ...frame, q: frame.q + 1 }); // đổi số thứ tự
    atk.send({ ...frame, s: b64u(randomBytes(8)) }); // phiên lạ → host sẽ trả reset (cho sid lạ đó), không ảnh hưởng ai
    await sleep(200);
    expect(r.cmds.length).toBe(cmdsBefore);
    expect(c.status()).toBe('online');
    await c.rc.command({ type: 'stop' }); // phiên thật vẫn hoạt động
    expect(r.cmds.length).toBe(cmdsBefore + 1);
  });

  it('người lạ biết tên kênh nhưng không có K_dev: hello giả bị im lặng bỏ qua', async () => {
    const r = mkRig();
    const p = await r.pair();
    const atk = r.bus.link('attacker');
    atk.start();
    const eph = await genEcdh();
    const n = randomBytes(16);
    const fakeMac = await hmac(randomBytes(32), lp('hello', p.dev, eph.pub, n));
    const mark = r.bus.wire.length; // chỉ đếm những gì host nói SAU khi kẻ lạ bắt đầu
    atk.send({ t: 'hello', v: 1, dev: p.dev, A: b64u(eph.pub), n: b64u(n), mac: b64u(fakeMac) });
    await sleep(150);
    expect(r.host.sessionCount).toBe(0);
    expect(r.bus.wire.slice(mark).filter((w) => w.from === r.hostLink)).toHaveLength(0); // host không phản hồi gì (không lộ thiết bị có tồn tại hay không)
    // thiết bị lạ hoàn toàn
    atk.send({ t: 'hello', v: 1, dev: b64u(randomBytes(12)), A: b64u(eph.pub), n: b64u(randomBytes(16)), mac: b64u(fakeMac) });
    await sleep(100);
    expect(r.bus.wire.filter((w) => w.from === r.hostLink && w.msg.t === 'hello_no')).toHaveLength(1);
  });

  it('hello_no không thành bộ khuếch đại: tối đa vài phản hồi mỗi phút', async () => {
    const r = mkRig();
    const atk = r.bus.link('attacker');
    atk.start();
    const eph = await genEcdh();
    for (let i = 0; i < 40; i++) atk.send({ t: 'hello', v: 1, dev: b64u(randomBytes(12)), A: b64u(eph.pub), n: b64u(randomBytes(16)), mac: b64u(randomBytes(32)) });
    await sleep(300);
    expect(r.bus.wire.filter((w) => w.from === r.hostLink && w.msg.t === 'hello_no').length).toBeLessThanOrEqual(6);
  });

  it('thiết bị lâu không dùng quá idleDays bị host từ chối (expired) và bị thu hồi', async () => {
    const r = mkRig({ idleDays: 2 });
    const p = await r.pair();
    r.clock.offset += 3 * 86_400_000;
    const c = r.connect(p);
    await waitFor(() => c.status() === 'unpaired', 4000, 'unpaired');
    await waitFor(() => r.store.list.length === 0, 2000, 'đã thu hồi');
  });

  it('tối đa 5 phiên mỗi thiết bị: phiên cũ nhất bị đóng khi mở phiên thứ 6', async () => {
    const r = mkRig();
    const p = await r.pair();
    const cs = Array.from({ length: 6 }, () => r.connect(p));
    await waitFor(() => cs.every((c) => ['online', 'reconnecting'].includes(c.status()) || c.got.length > 0), 6000, 'kết nối');
    await sleep(300);
    expect(r.host.sessionCount).toBeLessThanOrEqual(5);
  });

  it('phiên im lặng quá hạn (không ping) bị host bỏ', async () => {
    const r = mkRig({ hostTiming: { idleMs: 400, sweepMs: 40 } });
    const p = await r.pair();
    const c = r.connect(p);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    c.rc.stop(); // ngừng ping/nói gì thêm
    await waitFor(() => r.host.sessionCount === 0, 3000, 'phiên bị bỏ');
  });

  it('host dừng: gửi bye "stopped" trước khi đóng', async () => {
    const { r, c } = await ready();
    r.host.stop();
    await waitFor(() => c.got.some((m) => m.type === 'bye'), 2000, 'bye');
    expect(c.got.find((m) => m.type === 'bye').reason).toBe('stopped');
  });

  it('khi chỉ dùng relay (không mở HTTP cục bộ) sự kiện vẫn được phát', async () => {
    const { r, c } = await ready();
    expect(r.srv.running).toBe(false);
    r.srv.publish('toast', { level: 'warn', text: 'chỉ relay' });
    await waitFor(() => c.got.some((m) => m.type === 'toast'), 3000, 'toast');
  });

  it('xử lý đồng thời nhiều lệnh theo đúng thứ tự gửi', async () => {
    const { r, c } = await ready();
    await Promise.all([1, 2, 3, 4, 5].map((i) => c.rc.command({ type: 'send', text: `lệnh ${i}` })));
    expect(r.cmds.map((x) => (x.cmd as any).text).sort()).toEqual(['lệnh 1', 'lệnh 2', 'lệnh 3', 'lệnh 4', 'lệnh 5']);
  });

  it('lệnh khi chưa kết nối bị từ chối ngay', async () => {
    const r = mkRig();
    const p = await r.pair();
    const c = r.connect(p);
    c.rc.stop();
    await expect(c.rc.command({ type: 'stop' })).rejects.toBeInstanceOf(CommandError);
  });

  it('khoá K_dev khác (ví dụ bị đánh cắp một phần / sai) không bắt tay được và không lộ gì', async () => {
    const r = mkRig();
    const p = await r.pair();
    const c = r.connect({ dev: p.dev, key: b64u(randomBytes(32)) });
    await sleep(400);
    expect(c.status()).not.toBe('online');
    expect(c.got).toHaveLength(0);
    expect(r.host.sessionCount).toBe(0);
    expect(unb64u(p.key).length).toBe(32);
  });
});

describe('tin cậy theo tài khoản (0.6.5): đúng tài khoản là vào được, không ghép đôi', () => {
  const KEY = b64u(randomBytes(16));
  const KEY2 = b64u(randomBytes(16));

  it('trình duyệt có khoá tài khoản vào ngay: không hộp thoại, không bản ghi thiết bị, nhận snapshot, ra lệnh được; host được báo có phiên «tài khoản»', async () => {
    const r = mkRig({ accountKey: KEY });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    expect(c.got.find((m) => m.type === 'snapshot')?.state.title).toBe('Phiên thử');
    expect(r.approvals).toHaveLength(0); // không «Cho phép»
    expect(r.store.list).toHaveLength(0); // không ghi gì vào kho thiết bị đã ghép
    expect(r.accountEvents).toEqual([1]);
    expect(r.host.sessionCount).toBe(1);
    await c.rc.command({ type: 'send', text: 'từ điện thoại' });
    expect(r.cmds).toHaveLength(1);
    expect(r.cmds[0]!.device.label).toBe('Tài khoản Locaith');
    expect(r.cmds[0]!.device.id.startsWith(`${ACCOUNT_DEV}:`)).toBe(true); // mã riêng theo phiên → giới hạn tốc độ/luồng không dồn chung
    expect(r.srv.status().devices.filter((d) => d.kind === 'relay')).toHaveLength(0); // không phải thiết bị «đã ghép» nên không có trong danh sách thu hồi
  });

  it('sự kiện tới đúng thứ tự và bị chặn lệnh nguy hiểm như mọi thiết bị khác (bypass chỉ khi cài đặt cho phép)', async () => {
    const r = mkRig({ accountKey: KEY });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'a' }] });
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: 'b' }] });
    await waitFor(() => c.got.filter((m) => m.type === 'events').length === 2, 3000, '2 sự kiện');
    expect(c.got.filter((m) => m.type === 'events').map((m) => m.events[0].text)).toEqual(['a', 'b']);
    await expect(c.rc.command({ type: 'set_mode', mode: 'bypass' })).rejects.toMatchObject({ code: 'bypass_not_allowed' });
    await expect(c.rc.command({ type: 'delete_session', id: 'x' })).rejects.toMatchObject({ code: 'unknown_command' });
  });

  it('KHÔNG vào được nếu sai khoá (người biết tên kênh nhưng không đăng nhập đúng tài khoản): im lặng, không phiên, không lộ gì', async () => {
    const r = mkRig({ accountKey: KEY });
    const mark = r.bus.wire.length;
    const c = await r.connectAccount(KEY2);
    await sleep(500);
    expect(c.status()).not.toBe('online');
    expect(c.got).toHaveLength(0);
    expect(r.host.sessionCount).toBe(0);
    expect(r.accountEvents).toEqual([]);
    expect(r.bus.wire.slice(mark).filter((w) => w.from === r.hostLink)).toHaveLength(0); // MAC sai → host không phản hồi gì
  });

  it('chưa bật tin cậy theo tài khoản (không có khoá): hello «tài khoản» được trả lời như thiết bị lạ → trình duyệt biết phải ghép đôi', async () => {
    const r = mkRig(); // acct.key = null
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'unpaired', 3000, 'unpaired');
    expect(r.host.sessionCount).toBe(0);
    expect(r.accountEvents).toEqual([]);
  });

  it('khoá sai định dạng (không phải 16 byte) bị coi như tắt tính năng — không bao giờ dùng làm khoá', async () => {
    const r = mkRig({ accountKey: 'abc' });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'unpaired', 3000, 'unpaired');
    expect(r.host.sessionCount).toBe(0);
  });

  it('xoay khoá: closeAccountSessions cắt NGAY phiên cũ ("revoked"), khoá cũ hết hiệu lực, khoá mới vào được', async () => {
    const r = mkRig({ accountKey: KEY });
    const old = await r.connectAccount(KEY);
    await waitFor(() => old.status() === 'online', 4000, 'online');
    r.acct.key = KEY2;
    r.host.closeAccountSessions();
    await waitFor(() => old.status() === 'revoked', 3000, 'revoked');
    expect(old.got.some((m) => m.type === 'bye' && m.reason === 'revoked')).toBe(true);
    await waitFor(() => r.host.sessionCount === 0, 2000, 'không còn phiên');
    const stale = await r.connectAccount(KEY); // trình duyệt giữ khoá cũ
    await sleep(400);
    expect(stale.status()).not.toBe('online');
    const fresh = await r.connectAccount(KEY2);
    await waitFor(() => fresh.status() === 'online', 4000, 'khoá mới vào được');
    expect(r.host.sessionCount).toBe(1);
  });

  it('tắt tin cậy theo tài khoản (khoá về null): nhịp bảo trì cắt phiên đang mở kể cả khi không ai gọi closeAccountSessions', async () => {
    const r = mkRig({ accountKey: KEY, hostTiming: { sweepMs: 40 } });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    r.acct.key = null;
    await waitFor(() => c.status() === 'revoked', 3000, 'revoked');
    await waitFor(() => r.host.sessionCount === 0, 2000, 'không còn phiên');
    const again = await r.connectAccount(KEY);
    await waitFor(() => again.status() === 'unpaired', 3000, 'không vào lại được khi đã tắt');
  });

  it('thiết bị đã ghép đôi kiểu cũ vẫn chạy song song; «unpair» của phiên tài khoản KHÔNG thu hồi thiết bị đã ghép nào', async () => {
    const r = mkRig({ accountKey: KEY });
    const p = await r.pair('Chrome · Windows');
    const dev = r.connect(p);
    const acc = await r.connectAccount(KEY);
    await waitFor(() => dev.status() === 'online' && acc.status() === 'online', 5000, 'cả hai online');
    expect(r.host.sessionCount).toBe(2);
    expect(r.store.list).toHaveLength(1);
    acc.rc.unpair();
    await waitFor(() => acc.status() === 'revoked', 3000, 'phiên tài khoản kết thúc');
    expect(r.store.list).toHaveLength(1); // thiết bị đã ghép còn nguyên
    expect(dev.status()).toBe('online');
    // ngược lại: thu hồi thiết bị đã ghép không đụng tới phiên tài khoản
    const acc2 = await r.connectAccount(KEY);
    await waitFor(() => acc2.status() === 'online', 4000, 'phiên tài khoản mới');
    await r.srv.revoke(p.dev);
    await waitFor(() => dev.status() === 'revoked', 3000, 'thiết bị đã ghép bị thu hồi');
    await sleep(250);
    expect(acc2.status()).toBe('online');
  });

  it('khoá tài khoản và K_dev của nó không bao giờ xuất hiện trên dây; nội dung vẫn mã hoá', async () => {
    const r = mkRig({ accountKey: KEY });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    r.srv.publish('events', { events: [{ t: 'notice', level: 'info', text: MARKER }] });
    await waitFor(() => c.got.some((m) => m.type === 'events'), 3000, 'sự kiện');
    const kDev = b64u(await deriveAccountKey(unb64u(KEY), HOST_ID));
    const wire = r.bus.wireText();
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain(kDev);
    expect(wire).not.toContain(MARKER);
    expect(wire).not.toContain('Phiên thử');
  });

  it('tối đa 10 phiên «tài khoản» cùng lúc: phiên cũ nhất bị đóng, host vẫn khoẻ', async () => {
    const r = mkRig({ accountKey: KEY });
    const cs: Client[] = [];
    for (let i = 0; i < 11; i++) cs.push(await r.connectAccount(KEY));
    await sleep(600);
    expect(r.host.sessionCount).toBeLessThanOrEqual(10);
    expect(r.accountEvents.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...r.accountEvents)).toBeLessThanOrEqual(10);
  });

  it('bảng giới hạn tốc độ lệnh không phình mãi khi phiên «tài khoản» nối lại liên tục (mỗi phiên là một mã mới)', async () => {
    const r = mkRig({ accountKey: KEY });
    const times = (r.srv as unknown as { cmdTimes: Map<string, number[]> }).cmdTimes;
    for (let i = 0; i < 400; i++) await r.srv.execCommand({ id: `${ACCOUNT_DEV}:s${i}`, label: 'Tài khoản Locaith' }, { type: 'stop' });
    expect(times.size).toBeGreaterThan(256); // chưa quá một phút: còn giữ để đếm đúng
    r.clock.offset += 61_000;
    await r.srv.execCommand({ id: `${ACCOUNT_DEV}:mới`, label: 'Tài khoản Locaith' }, { type: 'stop' });
    expect(times.size).toBe(1); // chỉ còn mã vừa dùng
  });

  /** Một hello «tài khoản» HỢP LỆ do chính test dựng (đúng MAC) — để thử phát lại / đến cùng lúc / không đi tiếp. */
  async function validHello(accountKey: string) {
    const eph = await genEcdh();
    const n = randomBytes(16);
    const kDev = await deriveAccountKey(unb64u(accountKey), HOST_ID);
    const mac = await macHello(kDev, { dev: ACCOUNT_DEV, A: eph.pub, n1: n });
    return { t: 'hello', v: 1, dev: ACCOUNT_DEV, A: b64u(eph.pub), n: b64u(n), mac: b64u(mac) };
  }

  it('phát lại hello đã ghi lại SAU rất lâu (quá 5 phút) vẫn bị từ chối: nonce nhớ theo số lượng, không theo thời gian', async () => {
    // idleMs/helloTimeoutMs lớn: tua đồng hồ của host thêm 6 phút không được làm phiên THẬT bị coi là im lặng (rồi nối lại bằng hello mới — làm lệch phép đếm hello_ok).
    const r = mkRig({ accountKey: KEY, hostTiming: { idleMs: 3_600_000, helloTimeoutMs: 3_600_000 } });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    const hello = r.bus.wire.find((w) => w.msg.t === 'hello')!.msg;
    const sessionsBefore = r.host.sessionCount;
    r.clock.offset += 6 * 60_000; // đã quá TTL cũ của nonce
    r.bus.link('attacker').start();
    r.bus.links.forEach((l) => l.name === 'attacker' && l.send(hello));
    await sleep(200);
    expect(r.host.sessionCount).toBe(sessionsBefore);
    expect(r.bus.wire.filter((w) => w.msg.t === 'hello_ok')).toHaveLength(1);
  });

  it('ba bản hello GIỐNG HỆT đến cùng lúc chỉ mở MỘT phiên (nonce được giữ chỗ trước khi kiểm MAC)', async () => {
    const r = mkRig({ accountKey: KEY, hostTiming: { helloTimeoutMs: 5000 } });
    const hello = await validHello(KEY);
    const links = [1, 2, 3].map((i) => r.bus.link(`dup${i}`));
    links.forEach((l) => l.start());
    links.forEach((l) => l.send(hello));
    await sleep(300);
    expect(r.bus.wire.filter((w) => w.msg.t === 'hello_ok')).toHaveLength(1);
    expect(r.host.sessionCount).toBe(1);
  });

  it('hello hợp lệ nhưng không đi tiếp («phiên ma») KHÔNG làm hiện thông báo «có trình duyệt vào»; bị dọn sau hạn bắt tay', async () => {
    const r = mkRig({ accountKey: KEY, hostTiming: { helloTimeoutMs: 300, sweepMs: 40 } });
    const hello = await validHello(KEY);
    const atk = r.bus.link('ghost');
    atk.start();
    atk.send(hello);
    await waitFor(() => r.host.sessionCount === 1, 2000, 'phiên ma được mở');
    await sleep(100);
    expect(r.accountEvents).toEqual([]); // chưa có khung dữ liệu nào giải mã được → không báo
    await waitFor(() => r.host.sessionCount === 0, 3000, 'phiên ma bị dọn');
    expect(r.accountEvents).toEqual([]);
  });

  it('phiên «tài khoản» tự «unpair»: đầu ra bị gỡ khỏi máy chủ (không còn Client mồ côi), thiết bị đã ghép không bị đụng tới', async () => {
    const r = mkRig({ accountKey: KEY });
    const p = await r.pair();
    const dev = r.connect(p);
    const acc = await r.connectAccount(KEY);
    await waitFor(() => dev.status() === 'online' && acc.status() === 'online', 5000, 'cả hai online');
    await waitFor(() => r.srv.status().streams === 2, 3000, 'hai luồng');
    acc.rc.unpair();
    await waitFor(() => acc.status() === 'revoked', 3000, 'phiên tài khoản kết thúc');
    await waitFor(() => r.srv.status().streams === 1, 3000, 'chỉ còn luồng của thiết bị đã ghép');
    expect(r.store.list).toHaveLength(1);
    expect(dev.status()).toBe('online');
  });

  it('chống phát lại: gửi lại nguyên một hello «tài khoản» đã ghi lại không tạo thêm phiên', async () => {
    const r = mkRig({ accountKey: KEY });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    const hello = r.bus.wire.find((w) => w.msg.t === 'hello')!.msg;
    const before = r.host.sessionCount;
    r.bus.link('attacker').start();
    r.bus.links.forEach((l) => l.name === 'attacker' && l.send(hello));
    await sleep(150);
    expect(r.host.sessionCount).toBe(before);
    expect(r.accountEvents).toEqual([1]);
    expect(r.bus.wire.filter((w) => w.msg.t === 'hello_ok')).toHaveLength(1);
  });

  it('hello giả mang mã thiết bị «tài khoản» nhưng ký bằng khoá khác bị bỏ qua, không làm hỏng phiên thật', async () => {
    const r = mkRig({ accountKey: KEY });
    const c = await r.connectAccount(KEY);
    await waitFor(() => c.status() === 'online', 4000, 'online');
    const atk = r.bus.link('attacker');
    atk.start();
    const eph = await genEcdh();
    const n = randomBytes(16);
    const fakeMac = await hmac(randomBytes(32), lp('hello', ACCOUNT_DEV, eph.pub, n));
    atk.send({ t: 'hello', v: 1, dev: ACCOUNT_DEV, A: b64u(eph.pub), n: b64u(n), mac: b64u(fakeMac) });
    await sleep(200);
    expect(r.host.sessionCount).toBe(1);
    expect(c.status()).toBe('online');
    await c.rc.command({ type: 'stop' });
    expect(r.cmds).toHaveLength(1);
  });
});
