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

  describe('cổng mới (từ 17/11/2026): hạn mức kiểu Anthropic — phiên 5 giờ + tuần cho gói, token miễn phí một lần cho tài khoản miễn phí', () => {
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
    const URL = 'https://locaith.ai/#upgrade';

    it('gói trả phí trong hạn mức: gói, % đã dùng và còn bao lâu làm mới của phiên 5 giờ và tuần; KHÔNG còn «không giới hạn» / «dùng thử»', async () => {
      const text = await run({ state: 'ok', plan: 'plus', session_hours: 5, usage: { session: { percent: 37.5, resets_in_s: 7800 }, week: { percent: 12, resets_in_s: 5 * 86400 + 3 * 3600 } }, can_upgrade: true, upgrade_url: URL }, 'plus');
      expect(text).toContain('Dùng Locaith-v5: gói Plus');
      expect(text).toContain('hạn mức 5 giờ: đã dùng 37% (làm mới sau 2 giờ 10 phút)');
      expect(text).toContain('hạn mức tuần: đã dùng 12% (làm mới sau 5 ngày 3 giờ)');
      expect(text).not.toMatch(/không giới hạn|dùng thử|giai đoạn mở|không thu phí/);
      expect(text).not.toMatch(/\$|usd/i);
    });

    it('cửa sổ chưa bắt đầu: nói «tính từ lần dùng đầu tiên»; độ dài phiên theo cổng', async () => {
      const text = await run({ state: 'ok', plan: 'pro', session_hours: 2, usage: { session: { percent: 0 }, week: { percent: 0 } } }, 'pro');
      expect(text).toContain('gói Pro');
      expect(text).toContain('hạn mức 2 giờ: đã dùng 0% (chưa bắt đầu — tính từ lần dùng đầu tiên)');
      expect(text).toContain('hạn mức tuần: đã dùng 0% (chưa bắt đầu — tính từ lần dùng đầu tiên)');
    });

    it('hết hạn mức phiên / tuần: nói HẾT, làm mới sau bao lâu và nâng cấp ở đâu; gói cao nhất thì không mời nâng cấp', async () => {
      const s = await run({ state: 'limit_session', plan: 'plus', usage: { session: { percent: 100, resets_in_s: 3600 }, week: { percent: 70, resets_in_s: 400000 } }, can_upgrade: true, upgrade_url: URL }, 'plus');
      expect(s).toContain('ĐÃ HẾT hạn mức 5 giờ — làm mới sau 1 giờ; nâng cấp tại ' + URL + ' để có thêm hạn mức');
      const w = await run({ state: 'limit_week', plan: 'ultra', usage: { session: { percent: 10, resets_in_s: 100 }, week: { percent: 100, resets_in_s: 2 * 86400 } }, can_upgrade: false }, 'ultra');
      expect(w).toContain('gói Ultra');
      expect(w).toContain('ĐÃ HẾT hạn mức tuần — làm mới sau 2 ngày');
      expect(w).not.toContain('nâng cấp tại');
    });

    it('tài khoản miễn phí: token miễn phí đã dùng bao nhiêu % (một lần, không làm mới) và mua gói ở đâu; hết hẳn thì nói ĐÃ HẾT', async () => {
      const free = await run({ state: 'free', plan: 'free', usage: { credit: { percent: 40 } }, upgrade_url: URL });
      expect(free).toContain('Dùng Locaith-v5: tài khoản miễn phí');
      expect(free).toContain('token miễn phí: đã dùng 40% (một lần, không làm mới)');
      expect(free).toContain('hết thì mua gói Plus, Pro hoặc Ultra tại ' + URL);
      const out = await run({ state: 'free_exhausted', plan: 'free', usage: { credit: { percent: 100 } }, upgrade_url: URL });
      expect(out).toContain('ĐÃ HẾT token miễn phí — mua gói Plus, Pro hoặc Ultra tại ' + URL);
    });

    it('tài khoản nội bộ / chưa xác minh có câu riêng; trạng thái lạ → không in dòng (không đoán); địa chỉ thiếu → địa chỉ chuẩn', async () => {
      expect(await run({ state: 'staff', plan: 'staff' })).toContain('không bị tính hạn mức (tài khoản nội bộ)');
      expect(await run({ state: 'unverified', plan: 'unknown' })).toContain('chưa xác minh được gói');
      expect(await run({ state: 'weird_future_state' })).not.toContain('Dùng Locaith-v5');
      expect(await run({ state: 'free_exhausted', usage: { credit: { percent: 100 } } })).toContain(URL);
    });

    it('bản tiếng Anh dùng chuỗi của CLI, không lặp lại câu tiếng Việt của máy chủ', async () => {
      setLang('en');
      try {
        const text = await run({ state: 'ok', plan: 'plus', session_hours: 5, usage: { session: { percent: 60.2, resets_in_s: 5400 }, week: { percent: 20, resets_in_s: 3 * 86400 } } }, 'plus');
        expect(text).toContain('Locaith-v5 access: Plus plan');
        expect(text).toContain('5-hour allowance: 60% used (renews in 1 h 30 min)');
        expect(text).toContain('weekly allowance: 20% used (renews in 3 d)');
        expect(text).not.toMatch(/dùng|làm mới|hạn mức/);
      } finally {
        setLang('vi');
      }
    });

    it('--json: thêm khối entitlement, các trường cũ (plan/limits/account/consentAccepted) giữ nguyên', async () => {
      const restore = stub({ account: accountWith({ state: 'ok', plan: 'plus', usage: { session: { percent: 1 } } }, 'plus'), consent: { ok: true, state: { accepted: true, version: 1, current: 1 } } });
      try {
        const { deps, state } = rig();
        deps.json = true;
        expect(await whoamiCmd(deps)).toBe(0);
        const j = JSON.parse(state.out.join('\n'));
        expect(j).toMatchObject({ ok: true, plan: 'plus', limits: { unlimited: false }, consentAccepted: true, entitlement: { state: 'ok', usage: { session: { percent: 1 } } } });
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
