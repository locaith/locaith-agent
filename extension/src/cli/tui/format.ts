/** Định dạng số / thời lượng / đường dẫn dùng chung cho giao diện. */

import { getLang, type Lang } from '../i18n';

/** 1234 → «1,2k» (vi) / «1.2k» (en); 1_500_000 → «1,5M». */
export function fmtTokens(n: number, lang: Lang = getLang()): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  const dec = (v: number): string => {
    const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
    return lang === 'vi' ? s.replace('.', ',') : s;
  };
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return dec(n / 1000) + 'k';
  return dec(n / 1_000_000) + 'M';
}

/** 12_000 → «12s»; 133_000 → «2 phút 13 giây» (vi) / «2m 13s» (en). */
export function fmtDuration(ms: number, lang: Lang = getLang(), compact = false): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return lang === 'vi' && !compact ? `${s} giây` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) {
    if (compact || lang === 'en') return r ? `${m}m ${r}s` : `${m}m`;
    return r ? `${m} phút ${r} giây` : `${m} phút`;
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return lang === 'vi' && !compact ? `${h} giờ ${mm} phút` : `${h}h ${mm}m`;
}

/** Rút gọn đường dẫn tuyệt đối thành tương đối với cwd (nếu nằm trong đó); dùng `/` cho gọn. */
export function relPath(p: string, cwd?: string): string {
  if (!p) return p;
  const norm = (x: string): string => x.replace(/\\/g, '/');
  const np = norm(p);
  if (cwd) {
    const nc = norm(cwd).replace(/\/+$/, '');
    if (np.toLowerCase().startsWith(nc.toLowerCase() + '/')) return np.slice(nc.length + 1);
    if (np.toLowerCase() === nc.toLowerCase()) return '.';
  }
  return np;
}

/** Cắt đoạn giữa của đường dẫn dài: `src/…/file.ts`. */
export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 8) return s.slice(0, Math.max(0, max - 1)) + '…';
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
