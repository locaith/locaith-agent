/** `locaith login` và `locaith whoami` — tách riêng để giữ index.ts dễ đọc. Chuỗi hiển thị vi/en qua `i18n` (khoá `cli.acct.*`, xem strings.ts). */

import { LOCAITH_UPGRADE_URL, LocaithGatewayClient, type AccountPayload } from '../core/providers/locaithGateway';
import type { ModelInfo } from '../core/types';
import type { BrowserLoginOptions, BrowserLoginResult } from './browserLogin';
import { getLang, t, type Lang as UsageLang } from './i18n';
import './strings';
import { percentText, planName, spanText } from '../shared/usageFormat';

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
 * Vài dòng nói tài khoản dùng Locaith-v5 thế nào (kiểu Anthropic): gói nào, đã dùng bao nhiêu % hạn mức phiên 5 giờ và hạn mức tuần và khi nào làm mới; hoặc token miễn phí
 * một lần đã dùng bao nhiêu %; hoặc đã hết hạn mức và nâng cấp ở đâu. Dựng từ khối `entitlement` của `/account` bằng chuỗi của CLI (vi/en) — không in lại câu tiếng Việt của
 * máy chủ để bản en đọc được; chỉ phần trăm và giờ làm mới, không bao giờ số tiền. Trả `undefined` khi cổng cũ chưa có khối này (hoặc trạng thái lạ).
 */
export function describeAccess(ent: NonNullable<AccountPayload['entitlement']> | undefined, plan: string | undefined, lang: UsageLang = getLang()): string[] | undefined {
  const state = ent?.state;
  if (!ent || !state) return undefined;
  const url = typeof ent.upgrade_url === 'string' && ent.upgrade_url ? ent.upgrade_url : LOCAITH_UPGRADE_URL;
  const hours = typeof ent.session_hours === 'number' && ent.session_hours > 0 ? Number(ent.session_hours.toFixed(1)) : 5;
  const name = planName(ent.plan ?? plan);
  const who = name ? t('cli.acct.who.ent.plan', { plan: name }) : t('cli.acct.who.ent.freeacct');
  const what5h = t('cli.acct.who.ent.what5h', { hours });
  const whatWeek = t('cli.acct.who.ent.whatWeek');
  const win = (w: { percent?: number; resets_in_s?: number } | undefined, what: string): string | undefined =>
    w && typeof w.percent === 'number'
      ? t('cli.acct.who.ent.win', {
          what,
          pct: percentText(w.percent),
          resets: typeof w.resets_in_s === 'number' ? t('cli.acct.who.ent.resets', { span: spanText(w.resets_in_s, lang) }) : t('cli.acct.who.ent.notStarted'),
        })
      : undefined;
  switch (state) {
    case 'ok':
    case 'limit_session':
    case 'limit_week': {
      const out = [who];
      const s5 = win(ent.usage?.session, what5h);
      const wk = win(ent.usage?.week, whatWeek);
      if (s5) out.push(s5);
      if (wk) out.push(wk);
      if (state !== 'ok') {
        const w = state === 'limit_week' ? ent.usage?.week : ent.usage?.session;
        const left = typeof w?.resets_in_s === 'number' ? spanText(w.resets_in_s, lang) : '—';
        out.push(t('cli.acct.who.ent.limit', { what: state === 'limit_week' ? whatWeek : what5h, span: left }) + (ent.can_upgrade !== false ? `; ${t('cli.acct.who.ent.upgrade', { url })}` : ''));
      }
      return out;
    }
    case 'free': {
      const c = ent.usage?.credit;
      return [who, ...(typeof c?.percent === 'number' ? [t('cli.acct.who.ent.credit', { pct: percentText(c.percent) })] : []), t('cli.acct.who.ent.buy', { url })];
    }
    case 'free_exhausted':
      return [who, t('cli.acct.who.ent.exhausted', { url })];
    case 'staff':
    case 'internal':
    case 'open':
    case 'unverified':
      return [t(`cli.acct.who.ent.${state}`)];
    default:
      return undefined;
  }
}

/**
 * Xem tài khoản đang dùng. Gói (free/plus/pro/ultra), mức đã dùng của Locaith-v5 (hạn mức phiên 5 giờ và tuần, hoặc token miễn phí một lần) và hạn mức lấy từ `/account`;
 * cổng cũ chưa có endpoint đó thì nói thẳng "xem trên locaith.ai" thay vì đoán.
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
    d.out(JSON.stringify({ ok: authOk, tokenPrefix: key.slice(0, 4) + '…', auth: authOk ? 'ok' : 'invalid', plan, account: card, limits: acct.ok ? acct.account.limits : null, entitlement: acct.ok ? acct.account.entitlement ?? null : null, consentAccepted: consent.ok ? consent.state.accepted : null, models }, null, 2));
  } else {
    d.out(`${t('cli.acct.who.account')}: ${authOk ? t('cli.acct.who.loggedIn', { prefix: key.slice(0, 4) + '…' }) : t('cli.acct.who.invalid')}`);
    if (card?.name) d.out(`${t('cli.acct.who.account')}: ${card.name}${card.email_masked ? ' · ' + card.email_masked : ''}`);
    d.out(`${t('cli.acct.who.plan')}: ${plan ?? t(unsupported ? 'cli.acct.who.planUnsupported' : 'cli.acct.who.planUnknown')}`);
    // Cổng từ 17/11/2026 nói rõ mức đã dùng (% và lúc làm mới của phiên 5 giờ / tuần, hoặc token miễn phí); cổng cũ chỉ có cờ `unlimited` của giai đoạn mở.
    const access = acct.ok ? describeAccess(acct.account.entitlement, plan ?? undefined) : undefined;
    if (access?.length) {
      d.out(`${t('cli.acct.who.access')}: ${access[0]}`);
      for (const line of access.slice(1)) d.out(`  ${line}`);
    } else if (acct.ok && acct.account.limits?.unlimited) d.out(`${t('cli.acct.who.limits')}: ${t('cli.acct.who.unlimited')}`);
    if (consent.ok) d.out(`${t('cli.acct.who.consent')}: ${consent.state.accepted ? t('cli.acct.who.consentYes') : t('cli.acct.who.consentNo')}`);
    if (models) d.out(`${t('cli.acct.who.models')}: ${models.join(', ')}`);
  }
  return authOk ? 0 : 1;
}
