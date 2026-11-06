import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginWithBrowser } from '../src/cli/browserLogin';

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
