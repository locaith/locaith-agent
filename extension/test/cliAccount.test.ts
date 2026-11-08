import { describe, expect, it } from 'vitest';
import { loginCmd, whoamiCmd, type AccountDeps } from '../src/cli/account';
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
