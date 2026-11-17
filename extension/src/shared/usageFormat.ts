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
