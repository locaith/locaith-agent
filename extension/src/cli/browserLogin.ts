/**
 * Đăng nhập CLI bằng trình duyệt: mã uỷ quyền + PKCE (RFC 7636) + cổng loopback.
 *
 * Luồng (giống extension VS Code, không cần cài VS Code):
 *   1. CLI tạo `verifier` ngẫu nhiên, `challenge` = b64url(sha256(verifier)), `state` ngẫu nhiên.
 *   2. CLI mở  http://127.0.0.1:<cổng ngẫu nhiên>/callback  làm đích chuyển hướng.
 *   3. CLI mở  https://locaith.ai/#ext-auth?client=vscode&challenge=…&state=…&redirect=…
 *      → người dùng đăng nhập locaith.ai (nếu chưa) và bấm «Cho phép» (KHÔNG BAO GIỜ tự cho phép).
 *   4. Trình duyệt chuyển về loopback kèm `code`; CLI kiểm `state` rồi đổi `code` + `verifier`
 *      lấy token thiết bị (`lat_…`, chỉ trả đúng MỘT lần).
 *
 * Vì sao an toàn:
 *   • `code` chỉ dùng được khi có `verifier` (nằm trong bộ nhớ tiến trình CLI, không ra khỏi máy).
 *   • Loopback chỉ nghe trên 127.0.0.1, chỉ nhận đúng `/callback`, chỉ nhận MỘT lượt, có hạn giờ.
 *   • `state` chống việc trang lạ chuyển hướng hộ.
 *   • Không in `code`/`verifier`/token ra màn hình hay tệp nhật ký.
 * Máy chủ vẫn kiểm lại tất cả (ext_private.redirect_ok, đốt mã ở lần thử đầu, lưu băm token).
 *
 * Không import `vscode`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { t } from './i18n';
import './strings';

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Token thiết bị Locaith: `lat_` + 43 ký tự base64url (giữ đúng như máy chủ sinh). */
export const TOKEN_RE = /^lat_[A-Za-z0-9_-]{43}$/;
/** Verifier PKCE phải khớp `^[A-Za-z0-9_.~-]{43,128}$` của ext_auth_exchange. */
export const VERIFIER_RE = /^[A-Za-z0-9_.~-]{43,128}$/;

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Cặp verifier/challenge PKCE (S256), verifier 43 ký tự base64url. */
export function makePkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier, 'utf8').digest());
  return { verifier, challenge };
}

export type BrowserLoginError = 'timeout' | 'state' | 'denied' | 'exchange' | 'network' | 'browser' | 'cancelled';

export type BrowserLoginResult = { ok: true; token: string; user?: { name?: string; emailMasked?: string } } | { ok: false; error: BrowserLoginError };

/** Mã uỷ quyền một lần — đúng định dạng máy chủ chấp nhận (ext_auth_exchange: `^[A-Za-z0-9_-]{20,64}$`; thực tế base64url của 20 byte = 27 ký tự). */
const CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;

export type PastedLogin = { kind: 'code'; code: string } | { kind: 'token'; token: string } | { kind: 'denied' } | { kind: 'state' } | { kind: 'invalid' };

/**
 * Đọc thứ người dùng DÁN khi trình duyệt ở MÁY KHÁC (SSH, máy ảo, WSL không chuyển cổng…) nên trang «Cho phép» không gọi ngược về cổng loopback của CLI được:
 * trình duyệt báo «không truy cập được 127.0.0.1» nhưng thanh địa chỉ vẫn giữ `http://127.0.0.1:<cổng>/callback?code=…&state=…` — chép địa chỉ đó là đủ.
 * Nhận: cả địa chỉ (xuống dòng/dấu cách do ngắt dòng cứng của terminal bị bỏ), chỉ phần `code=…&state=…`, chỉ mã, hoặc token `lat_…` có sẵn.
 * `state` (nếu có) PHẢI khớp phiên này; mã vẫn vô dụng nếu thiếu `verifier` nằm trong bộ nhớ tiến trình CLI (PKCE).
 */
export function parsePastedLogin(input: string, state: string): PastedLogin {
  const trimmed = input.trim().replace(/^["'<(]+|[>"')]+$/g, '');
  const s = trimmed.replace(/\s+/g, '');
  if (!s) return { kind: 'invalid' };
  if (TOKEN_RE.test(s)) return { kind: 'token', token: s };
  let params: URLSearchParams | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      params = new URL(s).searchParams;
    } catch {
      return { kind: 'invalid' };
    }
  } else if (/(?:^|[?&])(?:code|error)=/.test(s)) {
    params = new URLSearchParams(s.replace(/^[^?]*\?/, ''));
  }
  if (params) {
    if (params.get('error')) return { kind: 'denied' };
    const code = params.get('code');
    if (!code || !CODE_RE.test(code)) return { kind: 'invalid' };
    const got = params.get('state');
    if (got !== null && got !== state) return { kind: 'state' };
    return { kind: 'code', code };
  }
  // Mã TRẦN: phải là MỘT cụm liền như người dùng dán (một câu chữ có dấu cách không được coi là mã, kẻo gửi chữ vô nghĩa lên máy chủ đổi mã).
  return /^\S+$/.test(trimmed) && CODE_RE.test(s) ? { kind: 'code', code: s } : { kind: 'invalid' };
}

export interface BrowserLoginOptions {
  /** Gốc trang web (https://locaith.ai). */
  webUrl: string;
  /** Gốc Supabase (REST /rest/v1/rpc/…). */
  supabaseUrl: string;
  /** Khoá công khai (anon) — đã nằm trong mã trang web. */
  anonKey: string;
  /** Nhãn thiết bị hiển thị ở trang «Cho phép» (≤ 60 ký tự an toàn). */
  label: string;
  /** Chờ người dùng bấm «Cho phép» bao lâu (mặc định 180 s). */
  timeoutMs?: number;
  /** Mở trình duyệt; trả false nếu không mở được (bài test thay bằng hàm giả). */
  openUrl?: (url: string) => boolean;
  /** Báo tiến trình cho người dùng (URL để mở tay). */
  notify?: (message: string, url?: string) => void;
  /** false = KHÔNG tự mở trình duyệt, chỉ đưa liên kết (người dùng mở ở máy nào cũng được rồi dán địa chỉ trang đích về qua `askPaste`). Mặc định true. */
  open?: boolean;
  /**
   * Cho người dùng DÁN lại địa chỉ trang đích / mã khi trình duyệt ở máy khác (xem `parsePastedLogin`). Chạy SONG SONG với việc chờ cổng loopback: bên nào xong trước thắng.
   * `signal` bị huỷ khi đã đăng nhập xong bằng đường loopback (để đóng ô nhập). Trả null = người dùng bỏ (huỷ đăng nhập); chuỗi rỗng = chỉ muốn chờ trình duyệt (thôi hỏi).
   * Hỏi lại tối đa vài lần nếu dán sai (`onPasteInvalid` báo lý do).
   */
  askPaste?: (signal: AbortSignal) => Promise<string | null>;
  onPasteInvalid?: () => void;
}

/** Mở trình duyệt mặc định của hệ điều hành bằng argv (không qua shell → URL có `&` vẫn nguyên vẹn). */
export function openInBrowser(url: string): boolean {
  // LOCAITH_NO_BROWSER=1: máy không có trình duyệt / không muốn tự mở (SSH, container, CI) → coi như không mở được: CLI đưa LIÊN KẾT và cho dán địa chỉ trang đích.
  if (process.env.LOCAITH_NO_BROWSER === '1') return false;
  try {
    const os = platform();
    const cmd = os === 'win32' ? 'explorer.exe' : os === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined); // không có trình duyệt: người dùng vẫn còn URL để mở tay
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const html = (title: string, body: string): string =>
  `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#111">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

/** Nhãn thiết bị: chỉ ký tự an toàn, ≤ 60 (máy chủ cắt thêm). */
export function deviceLabel(host = hostname(), os = platform()): string {
  const clean = (v: string, re: RegExp) => v.replace(re, '').replace(/\s+/g, ' ').trim();
  const h = clean(host, /[^A-Za-z0-9 ._()-]/g) || 'May';
  const o = clean(os, /[^A-Za-z0-9 ._-]/g) || 'node';
  return `${h} - Locaith CLI - ${o}`.slice(0, 60);
}

/** Đổi mã uỷ quyền lấy token thiết bị (băm SHA-256, chỉ trả đúng một lần). */
async function exchange(o: BrowserLoginOptions, code: string, verifier: string): Promise<BrowserLoginResult> {
  let r: Response;
  try {
    r = await fetch(`${o.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/ext_auth_exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: o.anonKey, authorization: `Bearer ${o.anonKey}` },
      body: JSON.stringify({ p_code: code, p_verifier: verifier, p_meta: { client: 'cli', platform: platform(), app: 'locaith-cli' } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!r.ok) return { ok: false, error: r.status === 401 || r.status === 403 ? 'exchange' : 'network' };
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (!j || j.ok !== true || typeof j.token !== 'string' || !TOKEN_RE.test(j.token)) return { ok: false, error: 'exchange' };
  const card = (j.user ?? null) as Record<string, unknown> | null;
  return {
    ok: true,
    token: j.token,
    ...(card && typeof card === 'object'
      ? {
          user: {
            ...(typeof card.name === 'string' ? { name: card.name } : {}),
            ...(typeof card.email_masked === 'string' ? { emailMasked: card.email_masked } : {}),
          },
        }
      : {}),
  };
}

/**
 * Chạy trọn luồng đăng nhập qua trình duyệt. Người dùng phải tự bấm «Cho phép»;
 * hàm KHÔNG tự uỷ quyền thay người dùng.
 */
export async function loginWithBrowser(o: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const { verifier, challenge } = makePkce();
  const state = b64url(randomBytes(16));
  const timeoutMs = o.timeoutMs ?? 180_000;
  const openUrl = o.openUrl ?? openInBrowser;

  let server: Server | undefined;
  let done = false;
  const close = () => {
    done = true;
    try {
      server?.close();
    } catch {
      /* đã đóng */
    }
  };

  try {
    const port = await new Promise<number>((resolve, reject) => {
      server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
    });

    const redirect = `http://127.0.0.1:${port}/callback`;
    const q = new URLSearchParams({
      client: 'vscode', // trang «Cho phép» chỉ nhận client=vscode (dùng chung luồng với extension)
      challenge,
      state,
      redirect,
      label: o.label,
      m_client: 'cli',
      m_platform: platform(),
      m_app: 'locaith-cli',
    });
    const url = `${o.webUrl.replace(/\/+$/, '')}/#ext-auth?${q.toString()}`;

    const codeOrError = await new Promise<{ code?: string; token?: string; error?: string }>((resolve) => {
      const ac = new AbortController();
      const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
      const finish = (v: { code?: string; token?: string; error?: string }) => {
        clearTimeout(timer);
        ac.abort(); // đóng ô «dán địa chỉ» nếu còn mở
        resolve(v);
      };

      server!.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== '/callback') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        if (done) {
          res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('gone');
          return;
        }
        done = true;
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const gotState = u.searchParams.get('state');
        const okay = !err && !!code && gotState === state;

        res.writeHead(okay ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          okay
            ? html('Đã uỷ quyền xong', 'Bạn có thể đóng thẻ này và quay lại cửa sổ dòng lệnh — Locaith CLI đang hoàn tất đăng nhập.')
            : html('Không hoàn tất được', 'Yêu cầu không hợp lệ hoặc đã bị huỷ. Quay lại cửa sổ dòng lệnh và chạy lại <code>locaith login</code>.'),
        );
        server!.close();

        if (err) finish({ error: 'denied' });
        else if (!code) finish({ error: 'exchange' });
        else if (gotState !== state) finish({ error: 'state' });
        else finish({ code });
      });

      // Liên kết LUÔN được đưa cho người dùng (trước đây ở màn hình đầu tiên nó đi qua console.error, bị giao diện terminal che mất → «cứ đơ ở đó»).
      if (o.open === false) o.notify?.(t('cli.acct.manual'), url);
      else if (!openUrl(url)) o.notify?.(t('cli.acct.browserFailed'), url); // vẫn chờ, người dùng mở tay
      else o.notify?.(t('cli.acct.browserOpened'), url);

      // Trình duyệt ở máy khác thì cổng loopback không bao giờ nhận được gì: cho DÁN lại địa chỉ trang đích (chạy song song, bên nào xong trước thắng).
      if (o.askPaste) {
        o.notify?.(t('cli.acct.pasteHint'));
        void (async () => {
          for (let attempt = 0; attempt < 8 && !done && !ac.signal.aborted; attempt++) {
            const text = await o.askPaste!(ac.signal).catch(() => null);
            if (done || ac.signal.aborted) return;
            if (text === null) {
              close();
              finish({ error: 'cancelled' });
              return;
            }
            if (text.trim() === '') return; // «chỉ chờ trình duyệt»: thôi hỏi, vẫn nghe cổng loopback
            const p = parsePastedLogin(text, state);
            if (p.kind === 'code') {
              close();
              finish({ code: p.code });
              return;
            }
            if (p.kind === 'token') {
              close();
              finish({ token: p.token });
              return;
            }
            if (p.kind === 'denied' || p.kind === 'state') {
              close();
              finish({ error: p.kind });
              return;
            }
            o.onPasteInvalid?.();
          }
        })();
      }
    });

    if (codeOrError.token) {
      close();
      return { ok: true, token: codeOrError.token };
    }
    if (!codeOrError.code) {
      close();
      return { ok: false, error: (codeOrError.error as BrowserLoginError) ?? 'exchange' };
    }

    // Đổi mã trước khi đóng máy chủ để giữ verifier trong cùng một luồng.
    const out = await exchange(o, codeOrError.code, verifier);
    close();
    return out;
  } catch {
    close();
    return { ok: false, error: 'network' };
  }
}
