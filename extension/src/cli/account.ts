/** `locaith login` và `locaith whoami` — tách riêng để giữ index.ts dễ đọc. */

import { LocaithGatewayClient } from '../core/providers/locaithGateway';
import type { ModelInfo } from '../core/types';
import type { BrowserLoginResult } from './browserLogin';

export interface AccountDeps {
  baseUrl: string;
  /** Khoá hiện có (env hoặc tệp cấu hình). */
  readKey(): string | undefined;
  /** Ghi khoá vào tệp cấu hình, trả đường dẫn. */
  writeKey(key: string): string;
  /** Hỏi token từ người dùng (stdin). */
  ask(message: string): Promise<string>;
  json: boolean;
  /** Lấy danh sách model qua đúng provider (để kiểm token có dùng được). */
  listModels(): Promise<ModelInfo[]>;
  out(line: string): void;
  err(line: string): void;
  /** Token người dùng đưa sẵn (`--token`) — không cần mở trình duyệt. */
  token?: string;
  /** `--no-browser`: không mở trình duyệt, hỏi dán token. */
  noBrowser?: boolean;
  /** Đăng nhập qua trình duyệt (PKCE + loopback). Không có = bản dựng không hỗ trợ. */
  browserLogin?(): Promise<BrowserLoginResult>;
}

/**
 * Kiểm token bằng endpoint thật: `/account` (KHÔNG đòi đã đồng ý thông báo dữ liệu — khác `/consent` trả 403
 * khi tài khoản chưa ghi nhận đồng ý, nên không dùng `/consent` để kết luận token sai).
 * Cổng cũ chưa có `/account` (404) thì lùi về `/consent` để bản CLI này vẫn dùng được.
 */
async function checkToken(d: AccountDeps, token: string): Promise<'ok' | 'unauthorized' | 'network' | 'server'> {
  const client = new LocaithGatewayClient({ baseUrl: () => d.baseUrl });
  const acct = await client.getAccount(token);
  if (acct.ok) return 'ok';
  if (acct.error === 'unauthorized') return 'unauthorized';
  if (acct.error !== 'unsupported') return acct.error; // network | server
  const consent = await client.getConsent(token);
  if (consent.ok) return 'ok';
  return consent.error;
}

/**
 * Đăng nhập: lấy token, KIỂM THẬT rồi mới lưu (sai token thì không ghi tệp).
 * Thứ tự: `--token` → trình duyệt (mặc định) → hỏi dán token (khi `--no-browser`).
 */
export async function loginCmd(d: AccountDeps): Promise<number> {
  let token = (d.token ?? '').trim();
  let via: 'token' | 'browser' = 'token';

  if (!token && !d.noBrowser && d.browserLogin) {
    if (!d.json) d.err('Đang mở trình duyệt để đăng nhập locaith.ai…');
    const r = await d.browserLogin();
    if (r.ok) {
      token = r.token;
      via = 'browser';
      if (!d.json)
        d.err(
          r.user?.name
            ? `✔ Đã uỷ quyền cho ${r.user.name}${r.user.emailMasked ? ' · ' + r.user.emailMasked : ''}.`
            : '✔ Đã uỷ quyền.',
        );
    } else {
      const why: Record<string, string> = {
        timeout: 'Hết thời gian chờ bấm «Cho phép» trong trình duyệt (3 phút).',
        state: 'Trình duyệt chuyển về không khớp phiên đăng nhập này — đã huỷ để an toàn.',
        denied: 'Yêu cầu uỷ quyền đã bị huỷ.',
        exchange: 'Mã uỷ quyền không dùng được (quá 5 phút hoặc đã dùng rồi).',
        network: 'Không kết nối được tới máy chủ tài khoản locaith.ai.',
        browser: 'Không mở được trình duyệt trên máy này.',
        cancelled: 'Đã huỷ đăng nhập.',
      };
      const msg = why[r.error] ?? 'Đăng nhập qua trình duyệt không thành công.';
      if (d.json) d.out(JSON.stringify({ ok: false, error: msg }));
      else {
        d.err('✘ ' + msg);
        d.err('  Chạy lại, hoặc dùng `locaith login --no-browser` để dán token thủ công.');
      }
      return 1;
    }
  }

  if (!token) token = (await d.ask('Dán token tài khoản Locaith (lat_…): ')).trim();
  if (!token) {
    if (d.json) d.out(JSON.stringify({ ok: false, error: 'Không có token.' }));
    else d.err('✘ Không có token nhập vào.');
    return 2;
  }

  const state = await checkToken(d, token);
  if (state !== 'ok') {
    const why =
      state === 'unauthorized'
        ? 'Token không hợp lệ hoặc đã hết hạn (Locaith trả 401).'
        : state === 'network'
          ? 'Không kết nối được tới cổng.'
          : 'Cổng trả lỗi.';
    if (d.json) d.out(JSON.stringify({ ok: false, error: why }));
    else d.err('✘ ' + why);
    return 1;
  }
  const file = d.writeKey(token);
  if (d.json) d.out(JSON.stringify({ ok: true, configFile: file, tokenPrefix: token.slice(0, 4) + '…', via }));
  else
    d.out(
      `✔ Đã lưu token vào ${file} (quyền 600) — đăng nhập bằng tài khoản locaith.ai.\n` +
        '  Tiếp theo: `locaith whoami`, và `locaith consent --yes` (một lần) trước lần chạy đầu.',
    );
  return 0;
}

/**
 * Xem tài khoản đang dùng. Gói (free/pro/plus) và hạn mức lấy từ `/account`; cổng cũ chưa có endpoint đó
 * thì nói thẳng "xem trên locaith.ai" thay vì đoán.
 */
export async function whoamiCmd(d: AccountDeps): Promise<number> {
  const key = d.readKey();
  if (!key) {
    if (d.json) d.out(JSON.stringify({ ok: false, error: 'Chưa đăng nhập.' }));
    else d.err('✘ Chưa đăng nhập. Chạy `locaith login`.');
    return 1;
  }
  const client = new LocaithGatewayClient({ baseUrl: () => d.baseUrl });
  const [acct, consent] = await Promise.all([client.getAccount(key), client.getConsent(key)]);
  let models: string[] | null = null;
  let authOk = consent.ok || acct.ok;
  try {
    models = (await d.listModels()).map((m) => m.id);
    authOk = true;
  } catch {
    models = null; // danh sách model lỗi không làm hỏng whoami; authOk giữ theo kết quả consent
  }
  const card = acct.ok ? acct.account.account : null;
  // Gói: ưu tiên /account; cổng cũ (unsupported) thì nói rõ là chưa có, không đoán.
  const plan: string | null = card?.plan ?? null;
  const unsupported = !acct.ok && acct.error === 'unsupported';
  if (d.json) {
    d.out(JSON.stringify({ ok: authOk, tokenPrefix: key.slice(0, 4) + '…', auth: authOk ? 'ok' : 'invalid', plan, account: card, limits: acct.ok ? acct.account.limits : null, consentAccepted: consent.ok ? consent.state.accepted : null, models }, null, 2));
  } else {
    d.out(`Tài khoản: ${authOk ? `đã đăng nhập (${key.slice(0, 4)}…)` : 'token KHÔNG hợp lệ hoặc đã hết hạn'}`);
    if (card?.name) d.out(`Tài khoản: ${card.name}${card.email_masked ? ' · ' + card.email_masked : ''}`);
    d.out(`Gói: ${plan ?? (unsupported ? 'cổng chưa có endpoint /account — xem trên locaith.ai' : 'cổng chưa trả thông tin gói — xem trên locaith.ai')}`);
    if (acct.ok && acct.account.limits?.unlimited) d.out('Hạn mức: không giới hạn (giai đoạn mở, không thu phí)');
    if (consent.ok) d.out(`Đồng ý thông báo dữ liệu: ${consent.state.accepted ? 'rồi' : 'CHƯA (chạy locaith consent --yes)'}`);
    if (models) d.out(`Model dùng được: ${models.join(', ')}`);
  }
  return authOk ? 0 : 1;
}
