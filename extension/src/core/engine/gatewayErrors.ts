/**
 * Thông điệp lỗi cổng Locaith theo NHÓM, kèm hành động (lane:gateway-client).
 *
 * Nhóm: hết hạn đăng nhập (do `accountInvalid` lo), hết hạn mức ngày, bị giới hạn tốc độ, cổng quá tải/bảo trì/xếp hàng, model không còn, mất mạng.
 * Tiếng Việt: giữ NGUYÊN lời cổng soạn (có giờ/hạn mức cụ thể) nếu có; tiếng Anh: câu chuẩn của nhóm (lời cổng là tiếng Việt).
 * Chỉ áp cho nhà cung cấp `locaith`; nhà cung cấp khác đi đường cũ trong handleProviderError.
 */

import { LOCAITH_PROVIDER_ID } from '../providers/locaithGateway';
import { planName, spanText } from '../../shared/usageFormat';
import type { ProviderError } from '../types';
import { t, type Lang, type StringKey } from './strings';

const GROUP: Record<string, StringKey> = {
  locaith_quota: 'gwQuota',
  locaith_rate_limited: 'gwRateLimited',
  locaith_unavailable: 'gwOverloaded',
  locaith_queue: 'gwOverloaded',
  locaith_model_not_found: 'gwModelGone',
};

/** Câu hiển thị cho lỗi cổng Locaith, hoặc undefined nếu không thuộc nhóm nào ở đây (để đường cũ xử lý). */
export function gatewayErrorText(err: ProviderError, lang: Lang): string | undefined {
  if (err.providerId !== LOCAITH_PROVIDER_ID || err.accountAuth) return undefined;
  // (0.7.9) Hết HẠN MỨC (phiên 5 giờ / tuần của gói, hoặc token miễn phí một lần): vi giữ lời cổng (đã có giờ làm mới và nơi nâng cấp), en dùng câu chuẩn dựng từ khối `entitlement`.
  const ent = err.entitlement;
  if (ent) {
    if (lang === 'vi' && err.verbatim && err.message) return err.message;
    if (ent.state === 'free_exhausted') return t(lang, 'gwFreeExhausted', { url: ent.upgradeUrl });
    const what = t(lang, ent.state === 'limit_week' ? 'gwWhatWeek' : 'gwWhat5h');
    const name = planName(ent.plan);
    const who = name ? t(lang, 'gwWhoPlan', { plan: name }) : t(lang, 'gwWhoFree');
    const head = ent.resetsInS !== undefined ? t(lang, 'gwLimitHead', { what, who, span: spanText(ent.resetsInS, lang) }) : t(lang, 'gwLimitHeadNoTime', { what, who });
    return `${head} ${ent.canUpgrade ? t(lang, 'gwTailUpgrade', { url: ent.upgradeUrl }) : t(lang, 'gwTailWait')}`;
  }
  // Hàng chờ/quá tải không mang mã cổng (HTTP 503/529 từ proxy phía trước cổng) cũng vào nhóm «quá tải».
  const key = (err.gatewayCode ? GROUP[err.gatewayCode] : undefined) ?? (err.kind === 'overloaded' || err.kind === 'queued' ? 'gwOverloaded' : undefined);
  if (key) return lang === 'vi' && err.verbatim && err.message ? err.message : t(lang, key);
  if (err.kind === 'network' || err.kind === 'timeout') return t(lang, 'gwOffline', { detail: err.message });
  return undefined;
}
