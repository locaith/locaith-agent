/**
 * Phần thuần (không đụng DOM) của bộ đọc trang — tách ra để kiểm thử trong Node và để runtime trong trang dùng chung.
 */

// Dựng regex từ mã ký tự: tệp nguồn không chứa ký tự ẩn/tổ hợp khó nhìn (công cụ ghi tệp có thể đổi \uXXXX thành ký tự thật).
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
const SPACES = new RegExp(`[\\s${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]+`, 'g');

/** Bỏ dấu + hạ chữ thường: "Đăng nhập" khớp "dang nhap". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

/** Gộp mọi khoảng trắng (kể cả NBSP, ký tự rộng 0, xuống dòng) thành một dấu cách. */
export function collapse(s: string): string {
  return s.replace(SPACES, ' ').trim();
}

/** Như `collapse` nhưng KHÔNG cắt đầu/đuôi: dùng khi ghép nhiều đoạn chữ liền nhau. */
export function squeeze(s: string): string {
  return s.replace(SPACES, ' ');
}

/**
 * `fold` kèm bản đồ vị trí: chuỗi đã bỏ dấu + chỉ số của từng ký tự trong chuỗi GỐC (để cắt đoạn trích có dấu quanh chỗ khớp).
 * Ký tự gốc bị bỏ hẳn (dấu thanh rời) không có mục trong `idx`.
 */
export function foldMap(s: string): { f: string; idx: number[] } {
  let f = '';
  const idx: number[] = [];
  let i = 0;
  for (const ch of s) {
    const g = fold(ch);
    for (let k = 0; k < g.length; k++) {
      f += g[k];
      idx.push(i);
    }
    i += ch.length;
  }
  return { f, idx };
}

/** Cắt không làm đứt cặp thay thế (emoji) và thêm dấu chấm lửng. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // không dừng giữa một cặp thay thế
  return s.slice(0, end).trimEnd() + '…';
}

/** Đích của liên kết, rút gọn: cùng nguồn → đường dẫn; khác nguồn → host + đường dẫn. */
export function shortUrl(href: string, baseUrl: string, max = 90): string {
  try {
    const u = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    // Trang cục bộ (file:) — chỉ dùng khi thử nghiệm: hiện đường dẫn tương đối thay vì chỉ chữ "file".
    if (u.protocol === 'file:' && base.protocol === 'file:') return clip(u.pathname.split('/').pop() + u.hash || u.pathname, max);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol.replace(':', '');
    const path = u.pathname + u.search + u.hash;
    const text = u.origin === base.origin ? path || '/' : u.host + (path === '/' ? '' : path);
    return clip(text, max);
  } catch {
    return clip(href, max);
  }
}

/**
 * Tên/nhãn trường gợi ý dữ liệu nhạy cảm (mật khẩu, thẻ, mã xác thực). Khớp theo TỪ (không khớp giữa chữ dài hơn): "passenger", "passport", "bypass"
 * không phải mật khẩu. Gợi ý được chuẩn hoá trước (xem `normalizeHints`): camelCase, gạch dưới, gạch nối → khoảng trắng.
 */
const SENSITIVE_NAME = new RegExp(
  [
    '\\b(?:pass(?:word|wd|code|phrase)?|pwd|passwd)\\b',
    'm[aậ]t\\s*kh[aẩ]u',
    '\\b(?:card|credit|debit|cc|ccv)\\s*(?:number|num|no|nbr)\\b',
    '\\bcc\\s*num\\b',
    '\\b(?:cvv|cvc|cvv2|cvc2|csc)\\b',
    'security\\s*code',
    's[oố]\\s*th[eẻ]',
    'm[aã]\\s*(?:b[aả]o\\s*m[aậ]t|x[aá]c\\s*(?:th[uự]c|nh[aậ]n)|otp)',
    '\\b(?:otp|totp|2fa|mfa)\\b',
    '\\bone\\s*time\\s*(?:password|passcode|pass|code|pin|token)\\b',
    '\\b(?:sms|verification|verify|auth|authentication)\\s*code\\b',
    '\\bpin(?:\\s*code)?\\b',
    '\\b(?:iban|swift)\\b',
  ].join('|'),
  'i',
);

const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-type']);

export type Sensitivity = 'password' | 'payment' | 'otp' | null;

/** camelCase / snake_case / kebab-case → các từ cách nhau bằng dấu cách ("ccNumber" → "cc Number", "card_no" → "card no"). */
function normalizeHints(s: string): string {
  return s.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_\-.[\]]+/g, ' ');
}

export function classifySensitive(opts: { type?: string; autocomplete?: string; hints?: string[] }): Sensitivity {
  const type = (opts.type ?? '').toLowerCase();
  if (type === 'password') return 'password';
  const tokens = (opts.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t === 'current-password' || t === 'new-password') return 'password';
    if (t === 'one-time-code') return 'otp';
    if (SENSITIVE_AUTOCOMPLETE.has(t)) return 'payment';
  }
  const hay = normalizeHints((opts.hints ?? []).filter(Boolean).join(' '));
  if (hay && SENSITIVE_NAME.test(hay)) {
    if (/\b(?:otp|totp|2fa|mfa)\b|\bone\s*time\b|\b(?:sms|verification|verify|auth|authentication)\s*code\b|x[aá]c\s*(?:th[uự]c|nh[aậ]n)|b[aả]o\s*m[aậ]t\s*(?:otp|m[aã])/i.test(hay)) return 'otp';
    if (/\b(?:card|credit|debit|cc|ccv|cvv|cvc|cvv2|cvc2|csc|iban|swift)\b|security\s*code|s[oố]\s*th[eẻ]|th[eẻ]/i.test(hay)) return 'payment';
    return 'password';
  }
  return null;
}

/**
 * Màu coi như vô hình (alpha ≈ 0): `transparent`, `rgba(r,g,b,0)`, `hsla(…,0)`, và dạng có dấu gạch chéo `rgb(r g b / 0)`, `rgb(r g b / 0%)`,
 * `color(srgb r g b / 0)`. Ngưỡng 5% — chữ mờ hơn mức đó không đọc được bằng mắt.
 */
export function isTransparentColor(color: string): boolean {
  const c = (color ?? '').trim().toLowerCase();
  if (!c) return false;
  if (c === 'transparent') return true;
  const slash = /\/\s*([\d.]+)\s*(%?)\s*\)\s*$/.exec(c);
  if (slash) {
    const a = parseFloat(slash[1]);
    return Number.isFinite(a) && (slash[2] ? a / 100 : a) <= 0.05;
  }
  const m = /^(?:rgba|hsla)\(([^)]*)\)$/.exec(c);
  if (!m) return false;
  const parts = m[1].split(/[,\s]+/).filter(Boolean);
  if (parts.length < 4) return false;
  const a = parseFloat(parts[3]);
  return Number.isFinite(a) && (parts[3].endsWith('%') ? a / 100 : a) <= 0.05;
}

/** Ma trận `transform` tính toán suy biến (co về 0 hoặc gần 0) → nội dung không nhìn thấy. `rotate`/`flip` có định thức 1 nên không bị loại. */
export function isDegenerateTransform(transform: string): boolean {
  const m = /^matrix\(([^)]*)\)$/.exec((transform ?? '').trim());
  if (!m) return false;
  const v = m[1].split(',').map((x) => parseFloat(x));
  if (v.length < 4 || v.slice(0, 4).some((x) => !Number.isFinite(x))) return false;
  return Math.abs(v[0] * v[3] - v[1] * v[2]) < 0.0025;
}

/**
 * Nhãn trợ năng (aria-label) có KHÁC chữ người dùng nhìn thấy không? So sau khi bỏ dấu/khoảng trắng; một bên chứa bên kia thì coi là khớp.
 * Dùng để cảnh báo trong thẻ xin phép: `<button aria-label="Hủy">Chuyển tiền</button>`.
 */
export function labelsDiffer(visible: string, aria: string): boolean {
  const words = (s: string) => new Set(fold(collapse(s)).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const a = words(visible);
  const b = words(aria);
  if (a.size === 0 || b.size === 0) return false; // chữ hiển thị chỉ là biểu tượng (×, ☰) → không so được, đó là kiểu nút biểu tượng thông thường
  const subset = (x: Set<string>, y: Set<string>) => [...x].every((w) => y.has(w));
  // So theo TỪ, không theo chuỗi con: "huy" nằm trong "chuyen" nhưng "Hủy" không phải "Chuyển tiền".
  return !(subset(a, b) || subset(b, a));
}

/** Vai trò (ARIA gần đúng) của một ô <input> theo kiểu. */
export function roleOfInput(type: string): string {
  switch (type.toLowerCase()) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    case 'file':
      return 'file-upload';
    case 'color':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'time':
    case 'week':
      return 'picker';
    default:
      return 'textbox';
  }
}

export interface SnapshotItem {
  ref: number;
  role: string;
  name: string;
  /** Các cờ trạng thái: checked, disabled, expanded… */
  states?: string[];
  value?: string;
  href?: string;
  /** Ngoài khung nhìn: phía dưới/trên. */
  off?: 'below' | 'above';
  /** Ghi chú ngắn (placeholder, kiểu ô nhập, số lựa chọn…). */
  note?: string;
}

/** Một dòng trong ảnh chụp: `[12] button "Đặt hàng" (disabled)`. */
export function formatSnapshotLine(it: SnapshotItem): string {
  let s = `[${it.ref}] ${it.role}`;
  if (it.name) s += ` "${it.name.replace(/"/g, "'")}"`;
  if (it.value !== undefined) s += ` value="${it.value.replace(/"/g, "'")}"`;
  if (it.href) s += ` → ${it.href}`;
  const extra = [...(it.states ?? []), ...(it.note ? [it.note] : [])];
  if (extra.length) s += ` (${extra.join(', ')})`;
  if (it.off) s += it.off === 'below' ? ' ↓' : ' ↑';
  return s;
}

/** Khoá phím → thuộc tính của KeyboardEvent. */
export function keyInfo(key: string): { key: string; code: string; keyCode: number } {
  const named: Record<string, [string, number]> = {
    Enter: ['Enter', 13],
    Escape: ['Escape', 27],
    Esc: ['Escape', 27],
    Tab: ['Tab', 9],
    Backspace: ['Backspace', 8],
    Delete: ['Delete', 46],
    ArrowUp: ['ArrowUp', 38],
    ArrowDown: ['ArrowDown', 40],
    ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39],
    Home: ['Home', 36],
    End: ['End', 35],
    PageUp: ['PageUp', 33],
    PageDown: ['PageDown', 34],
    Space: ['Space', 32],
    ' ': ['Space', 32],
  };
  const hit = named[key];
  if (hit) return { key: key === 'Space' ? ' ' : key === 'Esc' ? 'Escape' : key, code: hit[0], keyCode: hit[1] };
  if (key.length === 1) {
    const up = key.toUpperCase();
    const isLetter = /[A-Z]/.test(up);
    return { key, code: isLetter ? `Key${up}` : /\d/.test(key) ? `Digit${key}` : key, keyCode: up.charCodeAt(0) };
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) return { key, code: key, keyCode: 111 + Number(key.slice(1)) };
  return { key, code: key, keyCode: 0 };
}

/** Tách chuỗi kiểu "Control+Shift+a" thành phím chính và các phím bổ trợ. */
export function parseKeyCombo(combo: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const out = { key: '', ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'control' || l === 'ctrl') out.ctrl = true;
    else if (l === 'shift') out.shift = true;
    else if (l === 'alt' || l === 'option') out.alt = true;
    else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'win') out.meta = true;
    else out.key = p;
  }
  if (!out.key && parts.length) out.key = parts[parts.length - 1];
  return out;
}
