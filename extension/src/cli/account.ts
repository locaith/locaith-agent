/** `locaith login` và `locaith whoami` — tách riêng để giữ index.ts dễ đọc. Chuỗi hiển thị vi/en qua `i18n` (khoá `cli.acct.*`, xem strings.ts). */

import { LocaithGatewayClient } from '../core/providers/locaithGateway';
import type { ModelInfo } from '../core/types';
import type { BrowserLoginOptions, BrowserLoginResult } from './browserLogin';
import { t } from './i18n';
import './strings';

/** Cách giao diện nhận thông báo / cho dán địa chỉ khi đăng nhập qua trình duyệt (onboarding của TUI dùng hộp thoại; `locaith login` dùng dòng lệnh). */
export type BrowserLoginHooks = Pick<BrowserLoginOptions, 'notify' | 'askPaste' | 'onPasteInvalid' | 'open'>;

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
  browserLogin?(hooks?: BrowserLoginHooks): Promise<BrowserLoginResult>;
  /**
   * Chạy BÊN TRONG màn hình hướng dẫn lần đầu (onboarding): không in ✔ trong chữ (giao diện tự thêm) và không nhắc
   * «tiếp theo: whoami, consent» vì chính onboarding sẽ làm các bước đó ngay sau.
   */
  embedded?: boolean;
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
  const tick = d.embedded ? '' : '✔ ';
  const cross = d.embedded ? '' : '✘ ';

  if (!token && !d.noBrowser && d.browserLogin) {
    if (!d.json) d.err(t('cli.acct.opening'));
    const r = await d.browserLogin();
    if (r.ok) {
      token = r.token;
      via = 'browser';
      if (!d.json) d.err(tick + (r.user?.name ? t('cli.acct.authorizedFor', { who: `${r.user.name}${r.user.emailMasked ? ' · ' + r.user.emailMasked : ''}` }) : t('cli.acct.authorized')));
    } else {
      const known = ['timeout', 'state', 'denied', 'exchange', 'network', 'browser', 'cancelled'];
      const msg = t(known.includes(r.error) ? `cli.acct.why.${r.error}` : 'cli.acct.why.other');
      if (d.json) d.out(JSON.stringify({ ok: false, error: msg }));
      else {
        d.err(cross + msg);
        d.err('  ' + t('cli.acct.rerun'));
      }
      return 1;
    }
  }

  if (!token) token = (await d.ask(t('cli.acct.askToken'))).trim();
  if (!token) {
    if (d.json) d.out(JSON.stringify({ ok: false, error: t('cli.acct.noToken') }));
    else d.err(cross + t('cli.acct.noTokenEntered'));
    return 2;
  }

  const state = await checkToken(d, token);
  if (state !== 'ok') {
    const why = t(state === 'unauthorized' ? 'cli.acct.bad.unauthorized' : state === 'network' ? 'cli.acct.bad.network' : 'cli.acct.bad.server');
    if (d.json) d.out(JSON.stringify({ ok: false, error: why }));
    else d.err(cross + why);
    return 1;
  }
  const file = d.writeKey(token);
  if (d.json) d.out(JSON.stringify({ ok: true, configFile: file, tokenPrefix: token.slice(0, 4) + '…', via }));
  else if (d.embedded) d.out(t('cli.acct.savedShort', { file }));
  else d.out(`${tick}${t('cli.acct.saved', { file })}\n  ${t('cli.acct.next')}`);
  return 0;
}

/**
 * Xem tài khoản đang dùng. Gói (free/pro/plus) và hạn mức lấy từ `/account`; cổng cũ chưa có endpoint đó
 * thì nói thẳng "xem trên locaith.ai" thay vì đoán.
 */
export async function whoamiCmd(d: AccountDeps): Promise<number> {
  const key = d.readKey();
  if (!key) {
    if (d.json) d.out(JSON.stringify({ ok: false, error: t('cli.acct.notLoggedIn') }));
    else d.err('✘ ' + t('cli.acct.notLoggedInHint'));
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
    d.out(`${t('cli.acct.who.account')}: ${authOk ? t('cli.acct.who.loggedIn', { prefix: key.slice(0, 4) + '…' }) : t('cli.acct.who.invalid')}`);
    if (card?.name) d.out(`${t('cli.acct.who.account')}: ${card.name}${card.email_masked ? ' · ' + card.email_masked : ''}`);
    d.out(`${t('cli.acct.who.plan')}: ${plan ?? t(unsupported ? 'cli.acct.who.planUnsupported' : 'cli.acct.who.planUnknown')}`);
    if (acct.ok && acct.account.limits?.unlimited) d.out(`${t('cli.acct.who.limits')}: ${t('cli.acct.who.unlimited')}`);
    if (consent.ok) d.out(`${t('cli.acct.who.consent')}: ${consent.state.accepted ? t('cli.acct.who.consentYes') : t('cli.acct.who.consentNo')}`);
    if (models) d.out(`${t('cli.acct.who.models')}: ${models.join(', ')}`);
  }
  return authOk ? 0 : 1;
}
