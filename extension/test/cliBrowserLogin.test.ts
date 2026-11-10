import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginWithBrowser, parsePastedLogin } from '../src/cli/browserLogin';

/** fetch THẬT, giữ lại trước khi stub — để trình duyệt giả gọi được vào cổng loopback thật. */
const realFetch = globalThis.fetch.bind(globalThis);

/**
 * Stub `fetch`: mọi lời gọi tới 127.0.0.1 đi vào cổng loopback thật, còn lại là "máy chủ Supabase" giả.
 */
function stubFetch(supabase: (body: Record<string, unknown>) => Response) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const s = String(url);
    if (s.includes('127.0.0.1')) return realFetch(s);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return supabase(body);
  });
}

/** Bắt chước trình duyệt: đọc URL uỷ quyền, rồi gọi ngược về cổng loopback kèm code + state. */
function fakeBrowser(o: { tamperState?: boolean; deny?: boolean } = {}) {
  return (url: string) => {
    const u = new URL(url);
    const q = new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1));
    const target = new URL(q.get('redirect')!);
    target.searchParams.set('code', 'code_abcdefghijklmnopqrstuv');
    target.searchParams.set('state', o.tamperState ? 'state_khong_khop_000000' : q.get('state')!);
    if (o.deny) target.searchParams.set('error', 'access_denied');
    setTimeout(() => {
      realFetch(target.toString()).catch(() => undefined);
    }, 10);
    return true;
  };
}

const opts = { webUrl: 'https://locaith.ai', supabaseUrl: 'https://supabase.test', anonKey: 'anon_key', label: 'may-test - Locaith CLI' };
const okToken = `lat_${'a'.repeat(43)}`;
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loginWithBrowser — cổng loopback thật', () => {
  it('nhận code + state khớp → đổi mã, trả token lat_… (không cần người dùng dán)', async () => {
    let sawBody: Record<string, unknown> = {};
    stubFetch((body) => {
      sawBody = body;
      return json({ ok: true, token: okToken, user: { name: 'Nguyễn Văn A', email_masked: 'an***@example.com' } });
    });

    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser(), timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.token).toBe(okToken);
      expect(r.user?.name).toBe('Nguyễn Văn A');
    }
    expect(sawBody.p_code).toBe('code_abcdefghijklmnopqrstuv');
    expect(String(sawBody.p_verifier)).toMatch(/^[A-Za-z0-9_.~-]{43}$/);
  });

  it('URL mở ra có challenge/redirect đúng dạng máy chủ chấp nhận', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    let opened = '';
    const open = fakeBrowser();
    await loginWithBrowser({
      ...opts,
      timeoutMs: 5000,
      openUrl: (u) => {
        opened = u;
        return open(u);
      },
    });
    const u = new URL(opened);
    const q = new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1));
    expect(u.origin).toBe('https://locaith.ai');
    expect(u.hash.startsWith('#ext-auth')).toBe(true);
    expect(q.get('client')).toBe('vscode'); // trang «Cho phép» chỉ nhận client=vscode
    expect(q.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(q.get('redirect')).toMatch(/^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/);
    expect(q.get('m_client')).toBe('cli');
  });

  it('state KHÔNG khớp → huỷ, báo lỗi state, KHÔNG đổi mã', async () => {
    let exchanged = false;
    stubFetch(() => {
      exchanged = true;
      return json({ ok: true, token: okToken });
    });
    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser({ tamperState: true }), timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, error: 'state' });
    expect(exchanged).toBe(false);
  });

  it('người dùng huỷ ở trang «Cho phép» → báo denied', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser({ deny: true }), timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, error: 'denied' });
  });

  it('máy chủ trả invalid_grant → báo exchange, KHÔNG trả token rác', async () => {
    stubFetch(() => json({ ok: false, error: 'invalid_grant' }));
    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser(), timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, error: 'exchange' });
  });

  it('token trả về sai định dạng lat_… → không nhận', async () => {
    stubFetch(() => json({ ok: true, token: 'token-rac' }));
    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser(), timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, error: 'exchange' });
  });

  it('không ai bấm «Cho phép» → hết giờ (timeout), không treo vô hạn', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    const t0 = Date.now();
    const r = await loginWithBrowser({ ...opts, openUrl: () => true, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

/** Lấy `state` + `redirect` từ liên kết CLI đưa ra (như người dùng nhìn thấy ở trình duyệt). */
function parseAuthUrl(url: string): { state: string; redirect: string } {
  const u = new URL(url);
  const q = new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1));
  return { state: q.get('state')!, redirect: q.get('redirect')! };
}

describe('parsePastedLogin — dán địa chỉ trang đích khi trình duyệt ở máy khác', () => {
  const S = 'state_hop_le_0123456789';
  const code = 'code_abcdefghijklmnopqrstuv';
  it('cả địa chỉ http://127.0.0.1:…/callback?code=…&state=… → mã', () => {
    expect(parsePastedLogin(`http://127.0.0.1:53123/callback?code=${code}&state=${S}`, S)).toEqual({ kind: 'code', code });
  });
  it('địa chỉ bị terminal ngắt dòng cứng (xuống dòng + dấu cách chen giữa) vẫn đọc được', () => {
    const wrapped = `http://127.0.0.1:53123/call\n  back?code=${code.slice(0, 10)}\n${code.slice(10)}&state=\n${S}\n`;
    expect(parsePastedLogin(wrapped, S)).toEqual({ kind: 'code', code });
  });
  it('chỉ phần code=…&state=… hoặc chỉ mã trần', () => {
    expect(parsePastedLogin(`?code=${code}&state=${S}`, S)).toEqual({ kind: 'code', code });
    expect(parsePastedLogin(`code=${code}&state=${S}`, S)).toEqual({ kind: 'code', code });
    expect(parsePastedLogin(code, S)).toEqual({ kind: 'code', code });
  });
  it('bỏ dấu nháy / ngoặc bao quanh khi sao chép', () => {
    expect(parsePastedLogin(`"http://127.0.0.1:1/callback?code=${code}&state=${S}"`, S)).toEqual({ kind: 'code', code });
    expect(parsePastedLogin(`<http://127.0.0.1:1/callback?code=${code}&state=${S}>`, S)).toEqual({ kind: 'code', code });
  });
  it('state KHÔNG khớp → state (không nhận mã); thiếu state thì vẫn nhận (PKCE vẫn bảo vệ)', () => {
    expect(parsePastedLogin(`http://127.0.0.1:1/callback?code=${code}&state=khac_hoan_toan_0000`, S)).toEqual({ kind: 'state' });
    expect(parsePastedLogin(`http://127.0.0.1:1/callback?code=${code}`, S)).toEqual({ kind: 'code', code });
  });
  it('error=access_denied → denied', () => {
    expect(parsePastedLogin(`http://127.0.0.1:1/callback?error=access_denied&state=${S}`, S)).toEqual({ kind: 'denied' });
  });
  it('token lat_… dán thẳng → token', () => {
    expect(parsePastedLogin(okToken, S)).toEqual({ kind: 'token', token: okToken });
  });
  it('rác / liên kết đăng nhập (chưa có code) / trống → invalid', () => {
    expect(parsePastedLogin('', S).kind).toBe('invalid');
    expect(parsePastedLogin('xin chào', S).kind).toBe('invalid');
    expect(parsePastedLogin('https://locaith.ai/#ext-auth?client=vscode&state=abc', S).kind).toBe('invalid');
    expect(parsePastedLogin('http://127.0.0.1:1/callback', S).kind).toBe('invalid');
    expect(parsePastedLogin('abc', S).kind).toBe('invalid'); // quá ngắn để là mã
  });
  it('một CÂU chữ (có dấu cách) KHÔNG bị coi là mã trần, dù ghép lại đủ dài; chữ có dấu / ký tự lạ cũng không', () => {
    expect(parsePastedLogin('xin chao day khong phai dia chi', S).kind).toBe('invalid');
    expect(parsePastedLogin('đây là một câu tiếng Việt dài hơn hai mươi ký tự', S).kind).toBe('invalid');
    expect(parsePastedLogin('code.co.dau.cham.khong.hop.le.0123456789', S).kind).toBe('invalid'); // server chỉ nhận [A-Za-z0-9_-]
  });
});

describe('loginWithBrowser — trình duyệt ở MÁY KHÁC (dán địa chỉ)', () => {
  it('open:false → KHÔNG tự mở trình duyệt, đưa liên kết; dán địa chỉ trang đích → đổi mã, có token', async () => {
    let sawBody: Record<string, unknown> = {};
    stubFetch((body) => {
      sawBody = body;
      return json({ ok: true, token: okToken });
    });
    let opened = false;
    const notes: Array<[string, string | undefined]> = [];
    const r = await loginWithBrowser({
      ...opts,
      open: false,
      openUrl: () => ((opened = true), true),
      timeoutMs: 5000,
      notify: (m, u) => void notes.push([m, u]),
      askPaste: async () => {
        const { state, redirect } = parseAuthUrl(notes.find((n) => n[1])![1]!);
        return `${redirect}?code=code_tu_may_khac_0123456789&state=${state}`;
      },
    });
    expect(r).toEqual({ ok: true, token: okToken });
    expect(opened).toBe(false);
    expect(notes[0][1]).toMatch(/^https:\/\/locaith\.ai\/#ext-auth\?/); // liên kết được đưa ra
    expect(notes.some(([m, u]) => !u && /127\.0\.0\.1/.test(m))).toBe(true); // câu hướng dẫn «máy khác»
    expect(sawBody.p_code).toBe('code_tu_may_khac_0123456789');
    expect(String(sawBody.p_verifier)).toMatch(/^[A-Za-z0-9_.~-]{43}$/);
  });

  it('dán SAI trước (báo onPasteInvalid) rồi dán đúng → vẫn đăng nhập được', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    let url = '';
    const answers: string[] = [];
    let invalid = 0;
    const r = await loginWithBrowser({
      ...opts,
      open: false,
      timeoutMs: 5000,
      notify: (_m, u) => void (u && (url = u)),
      onPasteInvalid: () => void invalid++,
      askPaste: async () => {
        const { state, redirect } = parseAuthUrl(url);
        const a = answers.length === 0 ? 'địa chỉ gì đó không phải' : `${redirect}?code=code_dan_lan_hai_0123456789&state=${state}`;
        answers.push(a);
        return a;
      },
    });
    expect(r.ok).toBe(true);
    expect(invalid).toBe(1);
    expect(answers.length).toBe(2);
  });

  it('dán địa chỉ có state SAI → huỷ (state), KHÔNG đổi mã', async () => {
    let exchanged = false;
    stubFetch(() => ((exchanged = true), json({ ok: true, token: okToken })));
    const r = await loginWithBrowser({ ...opts, open: false, timeoutMs: 5000, askPaste: async () => 'http://127.0.0.1:1/callback?code=code_abcdefghijklmnopqrstuv&state=khac_hoan_toan_000000' });
    expect(r).toEqual({ ok: false, error: 'state' });
    expect(exchanged).toBe(false);
  });

  it('người dùng bấm Esc ở ô dán (askPaste trả null) → cancelled, không treo', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    const r = await loginWithBrowser({ ...opts, open: false, timeoutMs: 5000, askPaste: async () => null });
    expect(r).toEqual({ ok: false, error: 'cancelled' });
  });

  it('dán trống (Enter) → thôi hỏi nhưng VẪN nghe cổng loopback: trình duyệt cùng máy gọi về vẫn thắng', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    let asked = 0;
    const r = await loginWithBrowser({ ...opts, openUrl: fakeBrowser(), timeoutMs: 5000, askPaste: async () => (asked++, '') });
    expect(r).toEqual({ ok: true, token: okToken });
    expect(asked).toBe(1);
  });

  it('cổng loopback nhận được TRƯỚC → ô dán bị đóng (signal huỷ) và đăng nhập thành công', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    let aborted = false;
    const r = await loginWithBrowser({
      ...opts,
      openUrl: fakeBrowser(),
      timeoutMs: 5000,
      askPaste: (signal) =>
        new Promise<string | null>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          });
        }),
    });
    expect(r.ok).toBe(true);
    expect(aborted).toBe(true);
  });

  it('dán token lat_… sẵn có → dùng luôn, không gọi máy chủ đổi mã', async () => {
    let exchanged = false;
    stubFetch(() => ((exchanged = true), json({ ok: true, token: 'lat_' + 'z'.repeat(43) })));
    const r = await loginWithBrowser({ ...opts, open: false, timeoutMs: 5000, askPaste: async () => okToken });
    expect(r).toEqual({ ok: true, token: okToken });
    expect(exchanged).toBe(false);
  });

  it('hết giờ cũng đóng ô dán (không để hộp treo)', async () => {
    stubFetch(() => json({ ok: true, token: okToken }));
    let aborted = false;
    const r = await loginWithBrowser({
      ...opts,
      open: false,
      timeoutMs: 200,
      askPaste: (signal) =>
        new Promise<string | null>((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          }),
        ),
    });
    expect(r).toEqual({ ok: false, error: 'timeout' });
    expect(aborted).toBe(true);
  });
});
