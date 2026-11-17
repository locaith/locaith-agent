import { describe, expect, it } from 'vitest';
import type { AccountResult } from '../src/core/providers/locaithGateway';
import { LocaithConsent, USAGE_MIN_REFRESH_MS, type LocaithAccountLike, type MementoLike } from '../src/host/locaith';
import { percentText, planName, spanText } from '../src/shared/usageFormat';

// (0.7.9) Hạn mức kiểu Anthropic ở phía host: đọc GET /account, chuẩn hoá thành phần trăm + giờ làm mới, đệm, giãn cách, chống lẫn tài khoản.

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

const ACCOUNT_OK: AccountResult = {
  ok: true,
  account: { ok: true, plan: 'plus', entitlement: { state: 'ok', plan: 'plus', usage: { session: { percent: 37.5, resets_in_s: 7800 }, week: { percent: 12 } }, session_hours: 5, week_hours: 168, can_upgrade: true } },
};

function setup(over: { account?: Account; reply?: () => AccountResult | Promise<AccountResult>; noGetAccount?: boolean } = {}) {
  const account = over.account ?? new Account();
  const calls: string[] = [];
  const client = {
    getConsent: async () => ({ ok: true as const, state: { accepted: true, version: 1, current: 1 } }),
    postConsent: async () => ({ ok: true as const }),
    ...(over.noGetAccount
      ? {}
      : {
          getAccount: async (token: string): Promise<AccountResult> => {
            calls.push(token);
            return over.reply ? over.reply() : ACCOUNT_OK;
          },
        }),
  };
  let now = 1_800_000_000_000;
  const c = new LocaithConsent({ memento: new Memento(), account, client, clientLabel: 'vscode/0.7.9', now: () => now });
  return { c, account, calls, tick: (ms: number) => (now += ms), now: () => now };
}

describe('LocaithConsent.refreshUsage — mức đã dùng của hạn mức', () => {
  it('đọc GET /account bằng token của tài khoản, chuẩn hoá thành phần trăm + giờ làm mới (không số tiền) và báo cho người nghe', async () => {
    const s = setup();
    let notified = 0;
    s.c.onChange(() => void notified++);
    expect(s.c.usage()).toBeUndefined();
    await s.c.refreshUsage();
    expect(s.calls).toEqual([TOKEN]);
    expect(s.c.usage()).toEqual({
      plan: 'plus',
      state: 'ok',
      session: { percent: 37.5, resetsInS: 7800 },
      week: { percent: 12 },
      sessionHours: 5,
      weekHours: 168,
      canUpgrade: true,
      upgradeUrl: 'https://locaith.ai/#upgrade',
      at: s.now(),
    });
    expect(notified).toBe(1);
    expect(JSON.stringify(s.c.usage())).not.toMatch(/\$|usd|dollar/i);
  });

  it('không ép: tối đa một lần mỗi 15 giây; ép (vừa hết hạn mức) thì đọc ngay; nhiều nơi hỏi cùng lúc dùng chung MỘT lượt gọi', async () => {
    const s = setup();
    await s.c.refreshUsage();
    await s.c.refreshUsage();
    expect(s.calls).toHaveLength(1);
    s.tick(USAGE_MIN_REFRESH_MS - 1);
    await s.c.refreshUsage();
    expect(s.calls).toHaveLength(1);
    s.tick(2);
    await s.c.refreshUsage();
    expect(s.calls).toHaveLength(2);
    await s.c.refreshUsage(true);
    expect(s.calls).toHaveLength(3);
    const parallel = setup();
    await Promise.all([parallel.c.refreshUsage(true), parallel.c.refreshUsage(true), parallel.c.refreshUsage(true)]);
    expect(parallel.calls).toHaveLength(1);
  });

  it('mất mạng / cổng cũ / lỗi lạ: giữ bản đã đọc, không ném; token bị từ chối (401) thì xoá (không hiện số của phiên cũ)', async () => {
    let mode: 'ok' | 'network' | 'unsupported' | 'server' | 'unauthorized' | 'boom' = 'ok';
    const s = setup({
      reply: () => {
        if (mode === 'boom') throw new Error('boom');
        return mode === 'ok' ? ACCOUNT_OK : { ok: false, error: mode };
      },
    });
    await s.c.refreshUsage();
    const first = s.c.usage();
    expect(first?.session?.percent).toBe(37.5);
    for (const m of ['network', 'unsupported', 'server', 'boom'] as const) {
      mode = m;
      await expect(s.c.refreshUsage(true)).resolves.toBeUndefined();
      expect(s.c.usage()).toEqual(first);
    }
    mode = 'unauthorized';
    await s.c.refreshUsage(true);
    expect(s.c.usage()).toBeUndefined();
  });

  it('khối entitlement không tính hạn mức (nội bộ / cổng cũ) → không có mức dùng để hiện; đăng xuất hoặc đổi tài khoản → không lộ số của người trước', async () => {
    const s = setup();
    await s.c.refreshUsage(true);
    expect(s.c.usage()).toBeDefined();
    s.account.usable = false;
    expect(s.c.usage()).toBeUndefined(); // đăng xuất
    s.account.usable = true;
    s.account.uid = 'user-2';
    expect(s.c.usage()).toBeUndefined(); // tài khoản khác: bản đệm của user-1 không được hiện
    const staff = setup({ reply: () => ({ ok: true, account: { ok: true, plan: 'internal', entitlement: { state: 'staff', plan: 'staff' } } }) });
    await staff.c.refreshUsage(true);
    expect(staff.c.usage()).toBeUndefined();
  });

  it('chưa đăng nhập: không gọi mạng và xoá bản cũ; client không có getAccount (đồ giả cũ): không làm gì', async () => {
    const s = setup();
    await s.c.refreshUsage(true);
    s.account.tok = undefined;
    await s.c.refreshUsage(true);
    expect(s.calls).toHaveLength(1);
    expect(s.c.usage()).toBeUndefined();
    const old = setup({ noGetAccount: true });
    await expect(old.c.refreshUsage(true)).resolves.toBeUndefined();
    expect(old.c.usage()).toBeUndefined();
  });
});

describe('usageFormat — chữ cho hạn mức', () => {
  it('spanText: khoảng chờ bằng chữ, làm tròn LÊN tới phút, không dưới 1 phút (vi và en)', () => {
    expect([1, 90, 3600, 7800, 18000, 190_000, 604_800].map((n) => spanText(n, 'vi'))).toEqual(['1 phút', '2 phút', '1 giờ', '2 giờ 10 phút', '5 giờ', '2 ngày 4 giờ', '7 ngày']);
    expect([1, 90, 3600, 7800, 18000, 190_000, 604_800].map((n) => spanText(n, 'en'))).toEqual(['1 min', '2 min', '1 h', '2 h 10 min', '5 h', '2 d 4 h', '7 d']);
    expect(spanText(Number.NaN, 'vi')).toBe('1 phút');
    expect(spanText(-30, 'en')).toBe('1 min');
  });
  it('percentText: nguyên; 100 chỉ khi thật sự hết (99,6 vẫn là 99)', () => {
    expect([0, 12.9, 37.5, 99.6, 100, 140, -3, Number.NaN].map(percentText)).toEqual(['0%', '12%', '37%', '99%', '100%', '100%', '0%', '0%']);
  });
  it('planName: tên thương mại của gói; free / lạ / rỗng → rỗng', () => {
    expect(['plus', ' PRO ', 'Ultra', 'free', 'max', '', undefined].map((p) => planName(p))).toEqual(['Plus', 'Pro', 'Ultra', '', '', '', '']);
  });
});
