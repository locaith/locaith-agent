/**
 * Khả năng terminal (màu, UTF-8, liên kết, synchronized output), bảng màu sáng/tối và bộ ký hiệu (Unicode / ASCII).
 *
 * Màu thương hiệu: gradient #22bcec → #625aec. Truecolor → 256 → 16 màu; `NO_COLOR` tắt MỌI màu (thuộc tính đảo/đậm/nghiêng vẫn dùng);
 * `LOCAITH_ASCII=1` hoặc locale không phải UTF-8 → ký hiệu ASCII.
 */

import { graphemes, stringWidth } from './width';

export type ColorDepth = 'none' | '16' | '256' | 'truecolor';

export interface Caps {
  color: ColorDepth;
  unicode: boolean;
  hyperlinks: boolean;
  /** Synchronized output `ESC[?2026h/l` (terminal không hiểu thì bỏ qua, nên mặc định bật). */
  sync: boolean;
  dark: boolean;
}

export interface CapsInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Độ sâu màu do stream báo (`getColorDepth()`): 1, 4, 8, 24. */
  colorDepth?: number;
  theme?: 'auto' | 'dark' | 'light';
  noColor?: boolean;
  ascii?: boolean;
}

export function detectCaps(i: CapsInput = {}): Caps {
  const env = i.env ?? process.env;
  const platform = i.platform ?? process.platform;
  const term = (env.TERM ?? '').toLowerCase();

  let color: ColorDepth;
  if (i.noColor || (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || term === 'dumb') color = 'none';
  else if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app' || /^(kitty|alacritty|wezterm)/.test(term)) color = 'truecolor';
  else if (i.colorDepth === 24) color = 'truecolor';
  else if (term.includes('256') || i.colorDepth === 8) color = '256';
  else if (i.colorDepth === 1) color = 'none';
  else if (platform === 'win32' && !term) color = 'truecolor'; // Windows 10+ hiểu 24-bit
  else color = i.colorDepth === 4 || term ? '16' : '256';
  if (env.FORCE_COLOR === '0') color = 'none';

  let unicode: boolean;
  if (i.ascii || env.LOCAITH_ASCII === '1' || /^(true|yes)$/i.test(env.LOCAITH_ASCII ?? '')) unicode = false;
  else if (term === 'linux' || term === 'dumb') unicode = false;
  else {
    const loc = (env.LC_ALL || env.LC_CTYPE || env.LANG || '').toLowerCase();
    if (!loc) unicode = true;
    else unicode = /utf-?8/.test(loc);
  }

  const hyperlinks =
    env.FORCE_HYPERLINK === '1' ||
    !!env.WT_SESSION ||
    !!env.KITTY_WINDOW_ID ||
    ['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper'].includes(env.TERM_PROGRAM ?? '') ||
    (parseInt(env.VTE_VERSION ?? '0', 10) >= 5000);

  let dark = true;
  if (i.theme === 'light') dark = false;
  else if (i.theme === 'dark') dark = true;
  else {
    const fgbg = env.COLORFGBG;
    if (fgbg) {
      const bg = parseInt(fgbg.split(';').pop() ?? '', 10);
      if (Number.isFinite(bg)) dark = !(bg === 7 || bg === 15 || (bg >= 9 && bg <= 15 && bg !== 8));
    }
  }

  return { color, unicode, hyperlinks, sync: term !== 'dumb' && term !== 'linux' && env.LOCAITH_NO_SYNC !== '1', dark };
}

// ─────────────────────────── màu ───────────────────────────

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const c = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

const ANSI16: RGB[] = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

export function rgbTo16(r: number, g: number, b: number): number {
  let best = 0;
  let bd = Infinity;
  ANSI16.forEach(([R, G, B], i) => {
    const d = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

export function fgSeq(depth: ColorDepth, rgb: RGB): string {
  switch (depth) {
    case 'truecolor': return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    case '256': return `\x1b[38;5;${rgbTo256(...rgb)}m`;
    case '16': {
      const n = rgbTo16(...rgb);
      return `\x1b[${n < 8 ? 30 + n : 90 + n - 8}m`;
    }
    default: return '';
  }
}

export function bgSeq(depth: ColorDepth, rgb: RGB): string {
  switch (depth) {
    case 'truecolor': return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    case '256': return `\x1b[48;5;${rgbTo256(...rgb)}m`;
    case '16': {
      const n = rgbTo16(...rgb);
      return `\x1b[${n < 8 ? 40 + n : 100 + n - 8}m`;
    }
    default: return '';
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

export const BRAND_FROM = '#22bcec';
export const BRAND_TO = '#625aec';

// ─────────────────────────── ký hiệu ───────────────────────────

export interface Glyphs {
  bullet: string;
  result: string;
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
  spinner: string[];
  prompt: string;
  caret: string;
  think: string;
  down: string;
  up: string;
  ellipsis: string;
  sep: string;
  todo: { pending: string; in_progress: string; completed: string; blocked: string };
  ok: string; fail: string;
  branch: string;
  modeArrows: string;
  listBullet: string;
  quote: string;
  rule: string;
  check: string;
  dash: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  bullet: '●', result: '⎿', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
  spinner: ['·', '✢', '✳', '✶', '✻', '✽'], prompt: '>', caret: '❯', think: '✻', down: '↓', up: '↑', ellipsis: '…', sep: '·',
  todo: { pending: '☐', in_progress: '◐', completed: '☒', blocked: '⊘' },
  ok: '✔', fail: '✘', branch: '⎇', modeArrows: '⏵⏵', listBullet: '•', quote: '▎', rule: '─', check: '✓', dash: '—',
};

export const ASCII_GLYPHS: Glyphs = {
  bullet: '*', result: '`-', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
  spinner: ['|', '/', '-', '\\'], prompt: '>', caret: '>', think: '*', down: 'v', up: '^', ellipsis: '...', sep: '-',
  todo: { pending: '[ ]', in_progress: '[~]', completed: '[x]', blocked: '[!]' },
  ok: 'v', fail: 'x', branch: 'git:', modeArrows: '>>', listBullet: '-', quote: '|', rule: '-', check: 'v', dash: '-',
};

// ─────────────────────────── chủ đề ───────────────────────────

export type Style = (s: string) => string;

export interface Syntax {
  keyword: Style; string: Style; number: Style; comment: Style; fn: Style; type: Style; punct: Style; plain: Style;
}

export interface Theme {
  caps: Caps;
  g: Glyphs;
  plain: Style;
  bold: Style;
  dim: Style;
  italic: Style;
  underline: Style;
  strike: Style;
  inverse: Style;
  brand: Style;
  brand2: Style;
  muted: Style;
  faint: Style;
  ok: Style;
  warn: Style;
  err: Style;
  code: Style;
  heading: Style;
  /** Nền dòng tin người dùng. */
  userLine: Style;
  /** Dòng diff thêm/xoá (nền nhạt, hoặc chỉ đổi màu chữ khi 16 màu). */
  addLine: Style;
  delLine: Style;
  /** Vùng chữ thay đổi trong dòng (đậm hơn). */
  addWord: Style;
  delWord: Style;
  syntax: Syntax;
  /** Chữ nền gradient thương hiệu theo từng cụm chữ. `offset` ∈ [0,1] dịch pha. */
  gradient(text: string, offset?: number): string;
  /** Chữ chạy bóng: gradient có dải sáng đi qua tại vị trí `phase` ∈ [0,1]. */
  shimmer(text: string, phase: number): string;
  /** Màu gradient (hex→chuỗi SGR nền trước) tại t ∈ [0,1]. */
  gradientFg(t: number): string;
  /** Liên kết OSC 8 (nếu terminal hỗ trợ), nếu không → `text`. */
  link(url: string, text?: string): string;
  fgHex(hex: string): Style;
  bgHex(hex: string): Style;
  /** Màu nền cố định cho khung chọn/menu. */
  selected: Style;
}

const RESET = '\x1b[0m';

function wrapSgr(open: string, close: string): Style {
  return (s) => (s === '' || !open ? s : open + s.split(close).join(close + open) + close);
}

export function makeTheme(caps: Caps): Theme {
  const depth = caps.color;
  const on = depth !== 'none';
  const g = caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  const dark = caps.dark;
  const attr = (code: number, off: number): Style => wrapSgr(`\x1b[${code}m`, `\x1b[${off}m`);
  const fg = (hex: string): Style => (on ? wrapSgr(fgSeq(depth, hexToRgb(hex)), '\x1b[39m') : (s) => s);
  const bg = (hex: string): Style => (on ? wrapSgr(bgSeq(depth, hexToRgb(hex)), '\x1b[49m') : (s) => s);

  const P = dark
    ? { muted: '#9aa0b8', faint: '#6b7088', ok: '#4ade80', warn: '#fbbf24', err: '#f87171', code: '#7dd3fc', userBg: '#262a36', addBg: '#10361f', delBg: '#4a1b24', addWordBg: '#1d6a3a', delWordBg: '#8a2c3b', sel: '#3a3f55', kw: '#c4a7ff', str: '#86efac', num: '#fbbf77', com: '#6b7280', fn: '#7dd3fc', ty: '#f9a8d4', punct: '#9aa0b8' }
    : { muted: '#5b6178', faint: '#7d839c', ok: '#15803d', warn: '#b45309', err: '#dc2626', code: '#0369a1', userBg: '#e6e9f2', addBg: '#d3f2dd', delBg: '#fbd9dd', addWordBg: '#9be0b3', delWordBg: '#f4a3ae', sel: '#d5d9ea', kw: '#7c3aed', str: '#15803d', num: '#b45309', com: '#8a90a2', fn: '#0369a1', ty: '#be185d', punct: '#5b6178' };

  const from = hexToRgb(BRAND_FROM);
  const to = hexToRgb(BRAND_TO);
  const gradAt = (t: number): RGB => mix(from, to, Math.min(1, Math.max(0, t)));

  const gradient = (text: string, offset = 0): string => {
    if (!on) return text;
    const gs = graphemes(text);
    if (gs.length === 0) return text;
    let out = '';
    gs.forEach((c, i) => {
      const t = gs.length === 1 ? 0 : i / (gs.length - 1);
      const tt = (t + offset) % 1;
      // đi tới rồi quay lại để không có bước nhảy màu khi dịch pha
      const pp = tt <= 0.5 ? tt * 2 : (1 - tt) * 2;
      out += fgSeq(depth, gradAt(offset ? pp : t)) + c;
    });
    return out + '\x1b[39m';
  };

  const shimmer = (text: string, phase: number): string => {
    if (!on) return text;
    const gs = graphemes(text);
    const n = gs.length;
    if (n === 0) return text;
    let out = '';
    gs.forEach((c, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      const d = Math.abs(t - phase);
      const k = Math.max(0, 1 - d / 0.18);
      const base = gradAt(t);
      const lit = mix(base, [255, 255, 255], k * 0.75);
      out += fgSeq(depth, lit) + c;
    });
    return out + '\x1b[39m';
  };

  const link = (url: string, text?: string): string => {
    const label = text ?? url;
    return caps.hyperlinks ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : label;
  };

  const diffLine = (bgHex: string, fgHex: string): Style => (depth === 'truecolor' || depth === '256' ? bg(bgHex) : depth === '16' ? fg(fgHex) : (s) => s);

  const syn = (hex: string, extra?: Style): Style => {
    const f = fg(hex);
    return extra ? (s) => extra(f(s)) : f;
  };

  const bold = attr(1, 22);
  const theme: Theme = {
    caps,
    g,
    plain: (s) => s,
    bold,
    dim: depth === 'truecolor' || depth === '256' ? fg(P.muted) : attr(2, 22),
    italic: attr(3, 23),
    underline: attr(4, 24),
    strike: attr(9, 29),
    inverse: attr(7, 27),
    brand: fg(BRAND_FROM),
    brand2: fg(BRAND_TO),
    muted: depth === '16' ? attr(2, 22) : fg(P.muted),
    faint: depth === '16' ? attr(2, 22) : fg(P.faint),
    ok: fg(P.ok),
    warn: fg(P.warn),
    err: fg(P.err),
    code: fg(P.code),
    heading: (s) => bold(on ? fg(dark ? '#7fd8f5' : '#0b7aa0')(s) : s),
    userLine: depth === 'truecolor' || depth === '256' ? bg(P.userBg) : (s) => s,
    addLine: diffLine(P.addBg, P.ok),
    delLine: diffLine(P.delBg, P.err),
    addWord: depth === 'truecolor' || depth === '256' ? bg(P.addWordBg) : bold,
    delWord: depth === 'truecolor' || depth === '256' ? bg(P.delWordBg) : bold,
    syntax: {
      keyword: syn(P.kw, bold),
      string: syn(P.str),
      number: syn(P.num),
      comment: syn(P.com, attr(3, 23)),
      fn: syn(P.fn),
      type: syn(P.ty),
      punct: syn(P.punct),
      plain: (s) => s,
    },
    gradient,
    shimmer,
    gradientFg: (t) => fgSeq(depth, gradAt(t)),
    link,
    fgHex: fg,
    bgHex: bg,
    selected: depth === 'truecolor' || depth === '256' ? bg(P.sel) : attr(7, 27),
  };
  return theme;
}

/** Tiện ích: chèn mã reset cuối chuỗi nếu có mã ANSI mở. */
export function closeStyles(s: string): string {
  return s.includes('\x1b[') && !s.endsWith(RESET) ? s + RESET : s;
}

/** Thanh đệm có nền (căn trái) cho đủ `width`: dùng cho dòng tin người dùng. */
export function bar(style: Style, text: string, width: number): string {
  const w = stringWidth(text);
  return style(text + ' '.repeat(Math.max(0, width - w)));
}
