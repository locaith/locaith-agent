import { describe, expect, it } from 'vitest';
import { loginCmd, whoamiCmd, type AccountDeps } from '../src/cli/account';
import { setLang } from '../src/cli/i18n';
import { deviceLabel, makePkce, TOKEN_RE, VERIFIER_RE } from '../src/cli/browserLogin';
import { LocaithGatewayClient } from '../src/core/providers/locaithGateway';

type ConsentOut = { ok: true; state: { accepted: boolean; version: number; current: number } } | { ok: false; error: 'unauthorized' | 'network' | 'server' };
type AccountOut = { ok: true; account: { ok: boolean; account?: { name?: string; email_masked?: string; plan?: string } | null; plan?: string; limits?: { unlimited?: boolean } } } | { ok: false; error: 'unauthorized' | 'unsupported' | 'network' | 'server' };

/** Máy chủ giả tối thiểu cho cổng Locaith: /account + /consent + models, trả 401 khi token sai. */
function rig(o: { token?: string; modelsFail?: boolean; account?: AccountOut; consent?: ConsentOut; browser?: 'none' | 'ok' | 'timeout' | 'denied' } = {}) {
  const state = { token: o.token ?? 'lat_good_token_0001', files: new Map<string, string>(), prompts: [] as string[], out: [] as string[], err: [] as string[], browserCalls: 0 };
  const deps: AccountDeps = {
    baseUrl: 'http://127.0.0.1:1/v1',
    readKey: () => state.token,
    writeKey: (k) => {
      state.files.set('cli.json', k);
      return '/tmp/cli.json';
    },
    ask: async (m) => {
      state.prompts.push(m);
      return state.token;
    },
    json: false,
    listModels: async () => {
      if (o.modelsFail) throw new Error('models down');
      return [{ id: 'locaith-v5-flash', label: 'Locaith V5 Flash' }];
    },
    out: (l) => state.out.push(l),
    err: (l) => state.err.push(l),
  };
  // Chỉ gắn luồng trình duyệt khi bài test muốn — mặc định KHÔNG có (như bản dựng cũ), để test đường dán token.
  if (o.browser && o.browser !== 'none') {
    deps.browserLogin = async () => {
      state.browserCalls++;
      return o.browser === 'ok'
        ? { ok: true as const, token: 'lat_from_browser_000000000000000000000000000000', user: { name: 'Nguyễn Văn A' } }
        : { ok: false as const, error: o.browser as 'timeout' | 'denied' };
    };
  }
  return { deps, state };
}

/** Thay /account + /consent của client để bài test không cần mạng. */
function stub(impl: { account?: AccountOut; consent?: ConsentOut }) {
  const origAccount = LocaithGatewayClient.prototype.getAccount;
  const origConsent = LocaithGatewayClient.prototype.getConsent;
  LocaithGatewayClient.prototype.getAccount = async function () {
    return (
      impl.account ?? { ok: true, account: { ok: true, account: { name: 'Nguyễn Văn A', plan: 'free' }, plan: 'free', limits: { unlimited: true } } }
    ) as never;
  };
  LocaithGatewayClient.prototype.getConsent = async function () {
    return (impl.consent ?? { ok: true, state: { accepted: false, version: 0, current: 1 } }) as never;
  };
  return () => {
    LocaithGatewayClient.prototype.getAccount = origAccount;
    LocaithGatewayClient.prototype.getConsent = origConsent;
  };
}

describe('locaith login — dán token', () => {
  it('token hợp lệ → lưu tệp, báo 600, không in token đầy đủ', async () => {
    const restore = stub({});
    try {
      const { deps, state } = rig();
      expect(await loginCmd(deps)).toBe(0);
      expect(state.files.get('cli.json')).toBe('lat_good_token_0001');
      expect(state.out.join('\n')).toContain('/tmp/cli.json');
      expect(state.out.join('\n')).not.toContain('lat_good_token_0001'); // chỉ in tiền tố
    } finally {
      restore();
    }
  });

  it('token SAI → từ chối, KHÔNG ghi tệp (không để lại cấu hình hỏng)', async () => {
    const restore = stub({ account: { ok: false, error: 'unauthorized' }, consent: { ok: false, error: 'unauthorized' } });
    try {
      const { deps, state } = rig({ token: 'lat_bad' });
      expect(await loginCmd(deps)).toBe(1);
      expect(state.files.size).toBe(0);
      expect(state.err.join('\n')).toContain('401');
    } finally {
      restore();
    }
  });

  it('không có token (bỏ trống) → mã thoát 2, không ghi tệp', async () => {
    const { deps, state } = rig({ token: '' });
    expect(await loginCmd(deps)).toBe(2);
    expect(state.files.size).toBe(0);
  });

  it('`--no-browser` → KHÔNG mở trình duyệt, hỏi dán tay', async () => {
    const restore = stub({});
    try {
      const { deps, state } = rig({ browser: 'ok' });
      (deps as { noBrowser?: boolean }).noBrowser = true;
      expect(await loginCmd(deps)).toBe(0);
      expect(state.browserCalls).toBe(0);
      expect(state.prompts.length).toBe(1);
      expect(state.files.get('cli.json')).toBe('lat_good_token_0001');
    } finally {
      restore();
    }
  });
});

describe('locaith login — qua trình duyệt', () => {
  it('uỷ quyền xong → lưu token nhận từ trình duyệt (không cần người dùng dán gì)', async () => {
    const restore = stub({});
    try {
      const { deps, state } = rig({ browser: 'ok' });
      expect(await loginCmd(deps)).toBe(0);
      expect(state.browserCalls).toBe(1);
      expect(state.prompts.length).toBe(0); // không hỏi dán token
      expect(state.files.get('cli.json')).toMatch(TOKEN_RE);
      expect(state.err.join('\n')).toContain('Nguyễn Văn A');
    } finally {
      restore();
    }
  });

  it('hết giờ chờ «Cho phép» → mã thoát 1, KHÔNG ghi tệp, chỉ cách khác', async () => {
    const restore = stub({});
    try {
      const { deps, state } = rig({ browser: 'timeout' });
      expect(await loginCmd(deps)).toBe(1);
      expect(state.files.size).toBe(0);
      expect(state.err.join('\n')).toContain('--no-browser');
    } finally {
      restore();
    }
  });

  it('người dùng huỷ → không ghi tệp, không thử dán token ngầm', async () => {
    const restore = stub({});
    try {
      const { deps, state } = rig({ browser: 'denied' });
      expect(await loginCmd(deps)).toBe(1);
      expect(state.files.size).toBe(0);
      expect(state.prompts.length).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('locaith whoami', () => {
  it('chưa đăng nhập → mã thoát 1 kèm hướng dẫn', async () => {
    const { deps, state } = rig({ token: '' });
    expect(await whoamiCmd(deps)).toBe(1);
    expect(state.err.join('\n')).toContain('locaith login');
  });

  it('/account có dữ liệu → in tài khoản, gói, hạn mức không giới hạn', async () => {
    const restore = stub({ consent: { ok: true, state: { accepted: true, version: 1, current: 1 } } });
    try {
      const { deps, state } = rig();
      expect(await whoamiCmd(deps)).toBe(0);
      const text = state.out.join('\n');
      expect(text).toContain('đã đăng nhập');
      expect(text).toContain('locaith-v5-flash');
      expect(text).toContain('Gói: free');
      expect(text).toContain('không giới hạn');
      expect(text).not.toContain('cổng chưa');
      expect(text).toContain('Đồng ý thông báo dữ liệu: đã đồng ý');
    } finally {
      restore();
    }
  });

  describe('cổng mới (từ 17/11/2026): quyền dùng Locaith-v5 = gói hoặc 1 lượt dùng thử miễn phí 1 ngày', () => {
    const accountWith = (entitlement: Record<string, unknown>, plan = 'free'): AccountOut =>
      ({ ok: true, account: { ok: true, account: { name: 'Nguyễn Văn A', plan }, plan, limits: { unlimited: false, note: 'x' }, entitlement } }) as never;
    const run = async (entitlement: Record<string, unknown>, plan?: string) => {
      const restore = stub({ account: accountWith(entitlement, plan), consent: { ok: true, state: { accepted: true, version: 1, current: 1 } } });
      try {
        const { deps, state } = rig();
        expect(await whoamiCmd(deps)).toBe(0);
        return state.out.join('\n');
      } finally {
        restore();
      }
    };

    it('đang dùng thử: còn bao lâu + nơi mua gói; KHÔNG còn «không giới hạn» / «giai đoạn mở»', async () => {
      const text = await run({ state: 'trial', plan: 'free', trial_hours: 24, trial_seconds_left: 3600 * 23 + 60 * 59 + 30, upgrade_url: 'https://locaith.ai/#upgrade' });
      expect(text).toContain('Dùng Locaith-v5: đang dùng thử miễn phí — còn 23 giờ 59 phút');
      expect(text).toContain('https://locaith.ai/#upgrade');
      expect(text).not.toMatch(/không giới hạn|giai đoạn mở|không thu phí/);
    });

    it('chưa gọi lần nào: nói thời gian dùng thử tính từ lần dùng đầu; hết dùng thử: nói mua gói ở đâu', async () => {
      expect(await run({ state: 'trial_unused', plan: 'free', trial_hours: 24 })).toContain('dùng thử miễn phí 1 ngày, tính từ lần dùng đầu tiên');
      const ended = await run({ state: 'trial_ended', plan: 'free', trial_hours: 24, upgrade_url: 'https://locaith.ai/#upgrade' });
      expect(ended).toContain('Dùng Locaith-v5: đã hết dùng thử miễn phí — mua gói tại https://locaith.ai/#upgrade');
      expect(ended).toContain('Gói: free');
    });

    it('gói trả phí: nêu gói và ngày hết hạn (nếu có); tài khoản nội bộ / chưa xác minh có câu riêng', async () => {
      expect(await run({ state: 'paid', plan: 'plus', plan_expires_at: '2026-12-13T10:13:26Z' }, 'plus')).toContain('gói plus đang hoạt động (đến 2026-12-13)');
      expect(await run({ state: 'paid', plan: 'pro' }, 'pro')).toMatch(/gói pro đang hoạt động$/m);
      expect(await run({ state: 'staff', plan: 'staff' })).toContain('không cần gói (tài khoản nội bộ)');
      expect(await run({ state: 'unverified', plan: 'unknown' })).toContain('chưa xác minh được gói');
    });

    it('địa chỉ mua gói thiếu → dùng địa chỉ chuẩn; trạng thái lạ → không in dòng (không đoán)', async () => {
      expect(await run({ state: 'trial_ended' })).toContain('https://locaith.ai/#upgrade');
      expect(await run({ state: 'weird_future_state' })).not.toContain('Dùng Locaith-v5');
    });

    it('bản tiếng Anh dùng chuỗi của CLI, không lặp lại câu tiếng Việt của máy chủ', async () => {
      setLang('en');
      try {
        const text = await run({ state: 'trial', plan: 'free', trial_hours: 24, trial_seconds_left: 5400 });
        expect(text).toContain('Locaith-v5 access: free trial — 1 h 30 min left');
        expect(text).not.toMatch(/dùng thử|còn/);
      } finally {
        setLang('vi');
      }
    });

    it('--json: thêm khối entitlement, các trường cũ (plan/limits/account/consentAccepted) giữ nguyên', async () => {
      const restore = stub({ account: accountWith({ state: 'trial', plan: 'free', trial_seconds_left: 10 }), consent: { ok: true, state: { accepted: true, version: 1, current: 1 } } });
      try {
        const { deps, state } = rig();
        deps.json = true;
        expect(await whoamiCmd(deps)).toBe(0);
        const j = JSON.parse(state.out.join('\n'));
        expect(j).toMatchObject({ ok: true, plan: 'free', limits: { unlimited: false }, consentAccepted: true, entitlement: { state: 'trial', trial_seconds_left: 10 } });
      } finally {
        restore();
      }
    });
  });

  it('cổng CŨ chưa có /account (404) nhưng /consent chạy → vẫn coi là đã đăng nhập, nói rõ chưa có endpoint', async () => {
    const restore = stub({ account: { ok: false, error: 'unsupported' }, consent: { ok: true, state: { accepted: false, version: 0, current: 1 } } });
    try {
      const { deps, state } = rig();
      expect(await whoamiCmd(deps)).toBe(0);
      const text = state.out.join('\n');
      expect(text).toContain('đã đăng nhập');
      expect(text).toContain('cổng chưa có endpoint /account');
    } finally {
      restore();
    }
  });

  it('token chết và danh sách model cũng lỗi → mã thoát 1', async () => {
    const restore = stub({ account: { ok: false, error: 'unauthorized' }, consent: { ok: false, error: 'unauthorized' } });
    try {
      const { deps, state } = rig({ modelsFail: true });
      expect(await whoamiCmd(deps)).toBe(1);
      expect(state.out.join('\n')).toContain('KHÔNG hợp lệ');
    } finally {
      restore();
    }
  });
});

describe('PKCE cho đăng nhập trình duyệt', () => {
  it('verifier 43 ký tự base64url, khớp biểu thức máy chủ; challenge cũng 43', () => {
    const { verifier, challenge } = makePkce();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(VERIFIER_RE);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('mỗi lần sinh là khác nhau (không dùng lại verifier)', () => {
    const a = makePkce();
    const b = makePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('nhãn thiết bị: chỉ ký tự an toàn, ≤ 60 ký tự, không rỗng', () => {
    const l = deviceLabel('MAY-CHU-01 (Windows) 🔥', 'win32');
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l).toContain('Locaith CLI');
    expect(l).not.toMatch(/[^A-Za-z0-9 ._()-]/);
    expect(deviceLabel('')).toContain('Locaith CLI');
  });
});
