/** Định dạng số/thời gian theo ngôn ngữ giao diện (vi-VN: 1.234.567,89 · 12,4k). Thuần túy, test được. */

export type Lang = 'vi' | 'en';

const locale = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-US');

export function formatInt(n: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang)).format(Math.round(n));
}

export function formatDecimal(n: number, lang: Lang, maxFraction = 1): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: maxFraction }).format(n);
}

/** 12400 → "12,4k"; 1_250_000 → "1,3M". */
export function formatCompact(n: number, lang: Lang): string {
  if (n >= 1e6) return `${formatDecimal(n / 1e6, lang)}M`;
  if (n >= 1e3) return `${formatDecimal(n / 1e3, lang)}k`;
  return formatInt(n, lang);
}

/** Cửa sổ ngữ cảnh: 200_000 → "200k"; 1_000_000 và 1_048_576 → "1M"; 1_050_000 → "1,05M". */
export function formatContextWindow(n: number | undefined, lang: Lang): string {
  if (!n || n <= 0) return '';
  if (n >= 900_000) {
    // 1_048_576 (2^20) là "1M" theo cách gọi của các hãng; 1_050_000 là "1,05M" đúng như tài liệu OpenAI ghi.
    const m = n === 1_048_576 ? 1 : Math.round((n / 1_000_000) * 100) / 100;
    return `${formatDecimal(m, lang, 2)}M`;
  }
  return `${formatInt(Math.round(n / 1000), lang)}k`;
}

export function formatPercent(ratio: number, lang: Lang): string {
  return `${formatInt(Math.round(ratio * 100), lang)}%`;
}

export function formatBytes(n: number, lang: Lang): string {
  if (n < 1024) return `${formatInt(n, lang)} B`;
  if (n < 1024 * 1024) return `${formatDecimal(n / 1024, lang)} KB`;
  return `${formatDecimal(n / 1024 / 1024, lang)} MB`;
}

export function formatDuration(ms: number, lang: Lang): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 10) return `${formatDecimal(s, lang)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return lang === 'vi' ? `${m} phút ${rest} giây` : `${m}m ${rest}s`;
}

/** "3 phút trước", "hôm qua", "vừa xong" — luôn chữ thường vì thường nằm giữa dòng mô tả. */
export function formatRelativeTime(ts: number, now: number, lang: Lang): string {
  const diffSec = Math.round((ts - now) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' });
  let out: string;
  if (abs < 45) out = lang === 'vi' ? 'vừa xong' : 'just now';
  else if (abs < 3600) out = rtf.format(Math.round(diffSec / 60), 'minute');
  else if (abs < 86400) out = rtf.format(Math.round(diffSec / 3600), 'hour');
  else if (abs < 86400 * 30) out = rtf.format(Math.round(diffSec / 86400), 'day');
  else if (abs < 86400 * 365) out = rtf.format(Math.round(diffSec / (86400 * 30)), 'month');
  else out = rtf.format(Math.round(diffSec / (86400 * 365)), 'year');
  // Intl viết hoa chữ đầu theo ngữ cảnh đầu câu ("Hôm qua"); ở đây nó nằm giữa dòng nên hạ xuống.
  return out.charAt(0).toLowerCase() + out.slice(1);
}
