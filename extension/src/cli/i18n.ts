/**
 * Chuỗi giao diện của Locaith CLI (vi/en). Mỗi nhóm viết chuỗi của mình ở tệp riêng rồi đăng ký bằng `registerStrings`:
 *
 *   registerStrings('tui', { vi: { 'welcome.tip': 'Mẹo: …' }, en: { 'welcome.tip': 'Tip: …' } });
 *   t('tui.welcome.tip')            // → theo ngôn ngữ hiện tại; thiếu bản en thì rơi về vi; thiếu cả hai thì trả khoá
 *   t('x.count', { n: 3 })          // thay {n}
 *
 * Mặc định tiếng Việt (thị trường của Locaith); đổi bằng `setLang` (cài đặt `language`, biến LOCAITH_LANG, hỏi ở lần chạy đầu).
 */

export type Lang = 'vi' | 'en';

const dict: Record<Lang, Record<string, string>> = { vi: {}, en: {} };
let current: Lang = 'vi';

export function registerStrings(ns: string, parts: { vi: Record<string, string>; en?: Record<string, string> }): void {
  for (const [k, v] of Object.entries(parts.vi)) dict.vi[`${ns}.${k}`] = v;
  for (const [k, v] of Object.entries(parts.en ?? {})) dict.en[`${ns}.${k}`] = v;
}

export function setLang(l: Lang): void {
  current = l === 'en' ? 'en' : 'vi';
}

export function getLang(): Lang {
  return current;
}

/** Ngôn ngữ mặc định từ môi trường: LOCAITH_LANG → LC_ALL/LANG bắt đầu bằng `en` → en; còn lại vi. */
export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const e = (env.LOCAITH_LANG ?? '').toLowerCase();
  if (e === 'en' || e === 'vi') return e;
  const loc = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '').toLowerCase();
  if (loc.startsWith('en') && !loc.startsWith('en_vn')) return 'en';
  return 'vi';
}

export function t(key: string, vars?: Record<string, string | number>, lang: Lang = current): string {
  const raw = dict[lang][key] ?? dict.vi[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : raw;
}
