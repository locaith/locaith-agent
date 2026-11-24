/**
 * Chữ cho hạn mức dùng mô hình Locaith (kiểu Anthropic: phiên 5 giờ + tuần) — dùng chung cho engine (thông báo lỗi), host, webview và CLI.
 * Thuần tuý, không import `vscode`. Không bao giờ có số tiền: chỉ phần trăm và khoảng chờ.
 */

export type UsageLang = 'vi' | 'en';

/**
 * Một khoảng chờ bằng chữ, làm tròn LÊN tới phút, không dưới 1 phút (đã hứa chờ bao lâu thì không được hứa ít hơn):
 * vi `2 giờ 10 phút` · `5 giờ` · `2 ngày 4 giờ` · `7 phút`; en `2 h 10 min` · `5 h` · `2 d 4 h` · `7 min`.
 */
export function spanText(seconds: number, lang: UsageLang): string {
  const total = Math.max(60, Math.ceil((Number.isFinite(seconds) ? seconds : 0) / 60) * 60);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (lang === 'vi') {
    if (d) return `${d} ngày${h ? ` ${h} giờ` : ''}`;
    if (h) return `${h} giờ${m ? ` ${m} phút` : ''}`;
    return `${m} phút`;
  }
  if (d) return `${d} d${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${m} min`;
}

/** Phần trăm để hiện: nguyên, 100 chỉ khi thật sự đã hết (99,6 % vẫn hiện 99 — còn dùng được thì không nói «100 %»). */
export function percentText(p: number): string {
  const v = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
  return `${v >= 100 ? 100 : Math.floor(v)}%`;
}

/** Tên gói để hiện (không dịch: tên thương mại). Gói lạ hoặc `free` → rỗng (người gọi tự nói «tài khoản miễn phí»). */
export function planName(plan: string | undefined): string {
  const p = (plan ?? '').trim().toLowerCase();
  return p === 'plus' ? 'Plus' : p === 'pro' ? 'Pro' : p === 'ultra' ? 'Ultra' : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// (0.7.15) MỘT dòng hạn mức để đặt trong chính ô nhập prompt
// ─────────────────────────────────────────────────────────────────────────────

/** Các phần của hạn mức, đủ để vẽ dải mà không phụ thuộc kiểu view của giao diện nào. */
export interface UsageShape {
  plan?: string;
  state: string;
  session?: { percent: number; resetsInS?: number } | null;
  week?: { percent: number; resetsInS?: number } | null;
  credit?: { percent: number } | null;
  sessionHours?: number;
  /** Lúc số liệu được đọc (ms) — cần để biết cửa sổ nào đã qua mốc làm mới. */
  at?: number;
}

/**
 * Dải hạn mức gộp thành MỘT câu ngắn: `Pro · 5 giờ 59% · tuần 19%`.
 *
 * Vì sao gộp: bản trước vẽ mỗi hạn mức một khối (nhãn + thanh + phần trăm + thời gian làm mới + nút mua),
 * chiếm trọn một hàng riêng dưới khung chat. Trong ô nhập chỉ còn một dòng chữ, không thêm khối nào.
 * Chỉ phần trăm — không bao giờ số tiền; thời gian làm mới để trong tooltip.
 */
export function usageInlineText(
  u: UsageShape,
  tr: (key: 'usage.free' | 'usage.sessionShort' | 'usage.weekShort' | 'usage.creditShort', vars?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  const name = planName(u.plan);
  // Gói trả phí: hiện tên gói. Tài khoản miễn phí: nói rõ "Miễn phí" để không ai tưởng đang dùng gói trả tiền.
  parts.push(name || tr('usage.free'));
  if (u.session) parts.push(`${tr('usage.sessionShort', { hours: u.sessionHours ?? 5 })} ${percentText(u.session.percent)}`);
  if (u.week) parts.push(`${tr('usage.weekShort')} ${percentText(u.week.percent)}`);
  if (u.credit) parts.push(`${tr('usage.creditShort')} ${percentText(u.credit.percent)}`);
  return parts.join(' · ');
}

/** Mức cảnh báo của dải: 0 bình thường · 1 gần cạn (≥80%) · 2 đã cạn (100% hoặc trạng thái giới hạn). */
export function usageLevel(u: UsageShape): 0 | 1 | 2 {
  const pcts = [u.session?.percent, u.week?.percent, u.credit?.percent].filter((x): x is number => typeof x === 'number');
  if (u.state.startsWith('limit') || u.state === 'free_exhausted' || pcts.some((x) => x >= 100)) return 2;
  if (pcts.some((x) => x >= 80)) return 1;
  return 0;
}
