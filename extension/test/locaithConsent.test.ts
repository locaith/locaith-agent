import { describe, expect, it } from 'vitest';
import { LOCAITH_NOTICE_VERSION, type ConsentGetResult, type ConsentPostResult } from '../src/core/providers/locaithGateway';
import { diagHash } from '../src/core/providers/gatewayDiagnostics';
import { LocaithBridge, LocaithConsent, headerSafe, type LocaithAccountLike, type MementoLike } from '../src/host/locaith';

const TOKEN = `lat_${'Qq1Ww2Ee3R'.repeat(5).slice(0, 43)}`;

class Memento implements MementoLike {
  data = new Map<string, unknown>();
  get<T>(key: string, d: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : d;
  }
  update(key: string, value: unknown): void {
    if (value === null || value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}

class Account implements LocaithAccountLike {
  usable = true;
  uid: string | undefined = 'user-1';
  tok: string | undefined = TOKEN;
  token = () => this.tok;
  userId = () => this.uid;
}

function setup(over: { get?: () => ConsentGetResult | Promise<ConsentGetResult>; post?: () => ConsentPostResult | Promise<ConsentPostResult>; memento?: Memento; account?: Account } = {}) {
  const memento = over.memento ?? new Memento();
  const account = over.account ?? new Account();
  const calls = { get: 0, post: [] as { token: string; version: number; client: string }[] };
  const client = {
    getConsent: async (token: string): Promise<ConsentGetResult> => {
      calls.get++;
      expect(token).toBe(TOKEN);
      return over.get ? over.get() : { ok: true, state: { accepted: false, version: 0, current: LOCAITH_NOTICE_VERSION } };
    },
    postConsent: async (token: string, version: number, clientLabel: string): Promise<ConsentPostResult> => {
      calls.post.push({ token, version, client: clientLabel });
      return over.post ? over.post() : { ok: true };
    },
  };
  let now = 1_700_000_000_000;
  const c = new LocaithConsent({ memento, account, client, clientLabel: 'vscode/0.6.0', now: () => now });
  return { c, memento, account, calls, tick: (ms: number) => (now += ms) };
}

describe('LocaithConsent — đồng ý thông báo dữ liệu theo tài khoản', () => {
  it('ban đầu chưa đồng ý; accept() gửi {version hiện hành, client} lên máy chủ rồi mới coi là đã đồng ý', async () => {
    const s = setup();
    expect(s.c.accepted()).toBe(false);
    expect(await s.c.accept()).toEqual({ ok: true });
    expect(s.calls.post).toEqual([{ token: TOKEN, version: LOCAITH_NOTICE_VERSION, client: 'vscode/0.6.0' }]);
    expect(s.c.accepted()).toBe(true);
    expect(s.memento.data.get('locaithAgent.locaith.consent')).toMatchObject({ account: 'user-1', version: LOCAITH_NOTICE_VERSION });
  });

  it('máy chủ lỗi → vẫn CHƯA đồng ý (thẻ ở lại), trả lỗi để hiện trong thẻ; không ghi bản đệm', async () => {
    for (const post of [{ ok: false, error: 'network' }, { ok: false, error: 'server' }, { ok: false, error: 'unauthorized' }, { ok: false, error: 'rejected', message: 'version' }] as ConsentPostResult[]) {
      const s = setup({ post: () => post });
      expect(await s.c.accept()).toEqual(post);
      expect(s.c.accepted()).toBe(false);
      expect(s.memento.data.size).toBe(0);
    }
  });

  it('chưa đăng nhập: accept() báo signed_out và không gọi mạng', async () => {
    const account = new Account();
    account.usable = false;
    const s = setup({ account });
    expect(await s.c.accept()).toEqual({ ok: false, error: 'signed_out' });
    expect(s.calls.post).toHaveLength(0);
    expect(s.c.accepted()).toBe(false);
  });

  it('bản đệm theo (tài khoản, phiên bản): đổi tài khoản → chưa đồng ý; phiên bản cũ hơn → chưa đồng ý; đăng xuất → chưa', async () => {
    const m = new Memento();
    m.update('locaithAgent.locaith.consent', { account: 'user-1', version: LOCAITH_NOTICE_VERSION, at: 1 });
    const a = new Account();
    expect(setup({ memento: m, account: a }).c.accepted()).toBe(true);
    a.uid = 'user-2';
    expect(setup({ memento: m, account: a }).c.accepted()).toBe(false);
    a.uid = 'user-1';
    a.usable = false;
    expect(setup({ memento: m, account: a }).c.accepted()).toBe(false);

    const old = new Memento();
    old.update('locaithAgent.locaith.consent', { account: 'user-1', version: LOCAITH_NOTICE_VERSION - 1, at: 1 });
    expect(setup({ memento: old }).c.accepted()).toBe(false);

    const junk = new Memento();
    junk.update('locaithAgent.locaith.consent', { account: 42, version: 'x' });
    expect(setup({ memento: junk }).c.accepted()).toBe(false);
  });

  it('refresh(): đã đồng ý ở MÁY KHÁC → coi là đã đồng ý, bỏ qua thẻ; chưa → vẫn chưa; hỏng mạng → giữ nguyên bản đệm', async () => {
    const other = setup({ get: () => ({ ok: true, state: { accepted: true, version: LOCAITH_NOTICE_VERSION, current: LOCAITH_NOTICE_VERSION } }) });
    await other.c.refresh();
    expect(other.c.accepted()).toBe(true);
    expect(other.calls.post).toHaveLength(0);

    const none = setup();
    await none.c.refresh();
    expect(none.c.accepted()).toBe(false);

    const m = new Memento();
    m.update('locaithAgent.locaith.consent', { account: 'user-1', version: LOCAITH_NOTICE_VERSION, at: 1 });
    const offline = setup({ memento: m, get: () => ({ ok: false, error: 'network' }) });
    await offline.c.refresh();
    expect(offline.c.accepted()).toBe(true); // mất mạng không được làm người dùng "mất" sự đồng ý đã có
  });

  it('refresh(): máy chủ nói KHÔNG còn đồng ý (đổi phiên bản, bản ghi bị xoá) → xoá bản đệm để hỏi lại; máy chủ đòi bản mới hơn → outdated', async () => {
    const m = new Memento();
    m.update('locaithAgent.locaith.consent', { account: 'user-1', version: LOCAITH_NOTICE_VERSION, at: 1 });
    const s = setup({ memento: m, get: () => ({ ok: true, state: { accepted: false, version: LOCAITH_NOTICE_VERSION, current: LOCAITH_NOTICE_VERSION + 1 } }) });
    expect(s.c.accepted()).toBe(true);
    await s.c.refresh();
    expect(s.c.accepted()).toBe(false);
    expect(s.c.outdated()).toBe(true);
    expect(m.data.has('locaithAgent.locaith.consent')).toBe(false);
  });

  it('refresh(): nhiều nơi gọi cùng lúc dùng chung MỘT lượt hỏi', async () => {
    const s = setup({ get: async () => ({ ok: true, state: { accepted: true, version: LOCAITH_NOTICE_VERSION, current: LOCAITH_NOTICE_VERSION } }) });
    await Promise.all([s.c.refresh(), s.c.refresh(), s.c.refresh()]);
    expect(s.calls.get).toBe(1);
  });

  it('withdraw(): tắt Locaith ở máy này; refresh() KHÔNG tự bật lại dù máy chủ còn bản ghi; đồng ý lại thì ghi bản ghi mới', async () => {
    const s = setup({ get: () => ({ ok: true, state: { accepted: true, version: LOCAITH_NOTICE_VERSION, current: LOCAITH_NOTICE_VERSION } }) });
    await s.c.accept();
    expect(s.c.accepted()).toBe(true);
    await s.c.withdraw();
    expect(s.c.accepted()).toBe(false);
    const gets = s.calls.get;
    await s.c.refresh();
    expect(s.calls.get).toBe(gets); // thậm chí không hỏi
    expect(s.c.accepted()).toBe(false);
    await s.c.accept();
    expect(s.c.accepted()).toBe(true);
    expect(s.calls.post).toHaveLength(2);
  });

  it('invalidate(): máy chủ vừa từ chối → bỏ bản đệm; onChange báo mọi thay đổi', async () => {
    const s = setup();
    let changes = 0;
    const sub = s.c.onChange(() => changes++);
    await s.c.accept();
    expect(changes).toBe(1);
    s.c.invalidate();
    expect(s.c.accepted()).toBe(false); // hiệu lực ngay
    await new Promise((r) => setTimeout(r, 0)); // báo cho bên nghe ngay sau khi ghi bản đệm xong
    expect(changes).toBe(2);
    sub.dispose();
    await s.c.accept();
    expect(changes).toBe(2);
  });
});

describe('LocaithBridge — token, tiêu đề, chốt chặn', () => {
  const make = (consent: boolean, usable = true) => {
    const a = new Account();
    a.usable = usable;
    const b = new LocaithBridge();
    b.attach(a, { accepted: () => consent });
    return { hooks: b.hooks('0.6.0'), a };
  };

  it('token chỉ trao khi tài khoản dùng được; chưa gắn thì không có token và chốt chặn CHẶN (an toàn mặc định)', () => {
    expect(make(true).hooks.token()).toBe(TOKEN);
    expect(make(true, false).hooks.token()).toBeUndefined();
    const lone = new LocaithBridge().hooks('0.6.0');
    expect(lone.token()).toBeUndefined();
    expect(lone.guard!()).toMatchObject({ kind: 'consent_required' });
  });

  it('chốt chặn: chưa đồng ý → lỗi consent_required (không thử lại); đã đồng ý → cho qua', () => {
    expect(make(false).hooks.guard!()).toMatchObject({ name: 'ProviderError', kind: 'consent_required', retryable: false, providerId: 'locaith' });
    expect(make(true).hooks.guard!()).toBeUndefined();
  });

  it('tiêu đề mỗi lời gọi: client + hàng chờ kiểu vé; phiên và vé chỉ khi có; ký tự lạ bị thay để hợp lệ với cổng', () => {
    const { hooks } = make(true);
    expect(hooks.headers({})).toEqual({ 'x-locaith-client': 'vscode/0.6.0', 'x-locaith-queue': 'ticket' });
    expect(hooks.headers({ sessionKey: 's_ab12', ticket: 'q_9f3c' })).toEqual({
      'x-locaith-client': 'vscode/0.6.0',
      'x-locaith-queue': 'ticket',
      'x-locaith-session': diagHash('session', 's_ab12'), // băm một chiều, không phải id thô
      'x-locaith-ticket': 'q_9f3c',
    });
    const odd = new LocaithBridge();
    odd.attach(new Account(), { accepted: () => true });
    expect(odd.hooks('0.6.0-beta+1 \n"x"').headers({ sessionKey: 'a\nb"c'.padEnd(200, 'z') })['x-locaith-client']).toMatch(/^vscode\/0\.6\.0-beta\+1x$/);
    expect(headerSafe('a\r\nb: c', 40)).toBe('a__b_ c');
    expect(odd.hooks('0.6.0').headers({ sessionKey: 'x'.repeat(300) })['x-locaith-session']).toMatch(/^[0-9a-f]{16}$/);
    // Không có header đồng ý nào nữa (đồng ý là bản ghi phía máy chủ theo tài khoản).
    expect(Object.keys(hooks.headers({ sessionKey: 's', ticket: 't' })).some((k) => /consent/i.test(k))).toBe(false);
  });
});
