/**
 * Độ rộng ký tự trên terminal + xử lý chuỗi có mã ANSI (cắt, ngắt dòng theo từ).
 *
 * Quy ước: chữ dựng sẵn tiếng Việt (ế, ợ, ữ…) rộng 1; dấu kết hợp (U+0300…) rộng 0 (kể cả khi gõ dạng NFD);
 * CJK/Hangul/kana và emoji dạng hình rộng 2; ký tự điều khiển rộng 0. Một «cụm chữ» (grapheme) là đơn vị nhỏ nhất
 * khi cắt — không bao giờ tách dấu khỏi chữ gốc hay tách chuỗi emoji ZWJ.
 *
 * Thuần tuý, không phụ thuộc môi trường chạy (test trực tiếp được).
 */

const ZERO_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI_PRES_RE = /\p{Emoji_Presentation}/u;
const PICTO_RE = /\p{Extended_Pictographic}/u;

/** Phạm vi East Asian Wide/Fullwidth (không gồm emoji — emoji xét riêng). */
function isWideCp(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Độ rộng của MỘT điểm mã. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  const ch = String.fromCodePoint(cp);
  if (ZERO_RE.test(ch)) return 0;
  if (isWideCp(cp) || EMOJI_PRES_RE.test(ch)) return 2;
  return 1;
}

let segmenter: Intl.Segmenter | undefined;
function seg(): Intl.Segmenter | undefined {
  if (segmenter) return segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch {
    segmenter = undefined;
  }
  return segmenter;
}

/** Tách thành các cụm chữ. */
export function graphemes(s: string): string[] {
  if (!s) return [];
  if (/^[\x20-\x7e]*$/.test(s)) return s.split('');
  const sg = seg();
  if (sg) return Array.from(sg.segment(s), (x) => x.segment);
  return Array.from(s);
}

/** Độ rộng một cụm chữ (không chứa mã ANSI). */
export function graphemeWidth(g: string): number {
  if (!g) return 0;
  const cp0 = g.codePointAt(0)!;
  if (g.length === 1) return charWidth(cp0);
  // chuỗi emoji: VS16 (FE0F) biến ký hiệu chữ thành hình rộng 2; ZWJ ghép nhiều hình thành một; cờ (regional indicator) rộng 2
  if (g.includes('️') && PICTO_RE.test(g)) return 2;
  if (g.includes('‍') && PICTO_RE.test(g)) return 2;
  if (cp0 >= 0x1f1e6 && cp0 <= 0x1f1ff) return 2;
  // chữ gốc + các dấu kết hợp: rộng bằng chữ gốc (dấu rộng 0)
  let w = 0;
  for (const ch of g) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (cw > w) w = cw;
  }
  return w;
}

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s;
}

/** Độ rộng hiển thị của chuỗi (bỏ qua mã ANSI; `\t` tính 1). */
export function stringWidth(s: string): number {
  const p = stripAnsi(s);
  if (/^[\x20-\x7e]*$/.test(p)) return p.length;
  let w = 0;
  for (const g of graphemes(p)) w += g === '\t' ? 1 : graphemeWidth(g);
  return w;
}

/** Cắt chuỗi THUẦN (không ANSI) cho vừa `max` cột, thêm `ellipsis` nếu cắt. */
export function truncatePlain(s: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (stringWidth(s) <= max) return s;
  const ew = stringWidth(ellipsis);
  let w = 0;
  let out = '';
  for (const g of graphemes(s)) {
    const gw = graphemeWidth(g);
    if (w + gw > max - ew) break;
    out += g;
    w += gw;
  }
  return out + ellipsis;
}

/** Phần tử của chuỗi có ANSI: mã điều khiển (rộng 0) hoặc một cụm chữ. */
export interface Tok {
  esc?: string;
  text?: string;
  w: number;
}

export function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  const re = new RegExp(ANSI_RE.source, 'g');
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    for (const g of graphemes(t)) out.push({ text: g, w: g === '\t' ? 1 : graphemeWidth(g) });
  };
  while ((m = re.exec(s))) {
    if (m.index > last) pushText(s.slice(last, m.index));
    out.push({ esc: m[0], w: 0 });
    last = m.index + m[0].length;
  }
  if (last < s.length) pushText(s.slice(last));
  return out;
}

/** Theo dõi trạng thái SGR / liên kết OSC 8 để đóng ở cuối dòng và mở lại ở đầu dòng kế (khi ngắt dòng giữa đoạn có kiểu). */
class StyleState {
  sgr: string[] = [];
  link = '';
  feed(esc: string): void {
    if (esc.startsWith('\x1b[') && esc.endsWith('m')) {
      const body = esc.slice(2, -1);
      if (body === '' || body === '0') this.sgr = [];
      else this.sgr.push(esc);
    } else if (esc.startsWith('\x1b]8;')) {
      const m = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/.exec(esc);
      this.link = m && m[1] ? esc : '';
    }
  }
  open(): string {
    return this.sgr.join('') + this.link;
  }
  close(): string {
    return (this.link ? '\x1b]8;;\x1b\\' : '') + (this.sgr.length ? '\x1b[0m' : '');
  }
}

/** Cắt chuỗi CÓ ANSI cho vừa `max` cột; phần bị cắt thay bằng `ellipsis`; luôn đóng kiểu ở cuối. */
export function truncateAnsi(s: string, max: number, ellipsis = '…'): string {
  if (stringWidth(s) <= max) return s;
  if (max <= 0) return '';
  const ew = stringWidth(ellipsis);
  const st = new StyleState();
  let out = '';
  let w = 0;
  for (const t of tokenize(s)) {
    if (t.esc !== undefined) {
      out += t.esc;
      st.feed(t.esc);
      continue;
    }
    if (w + t.w > max - ew) break;
    out += t.text;
    w += t.w;
  }
  return out + st.close() + ellipsis;
}

export interface WrapOptions {
  /** Tiền tố dòng đầu (ví dụ `● `); độ rộng của nó bị trừ khỏi chiều rộng. */
  first?: string;
  /** Tiền tố các dòng sau (thụt lề treo). */
  rest?: string;
  /** Giữ khoảng trắng (khối mã): chỉ ngắt cứng theo độ rộng, không nuốt khoảng trắng đầu/cuối. */
  pre?: boolean;
}

function isSpaceTok(t: Tok): boolean {
  return t.text === ' ' || t.text === '\t';
}

/**
 * Ngắt dòng theo từ, nhận biết ANSI/OSC8, tôn trọng độ rộng ký tự. Từ dài hơn một dòng bị bẻ theo cụm chữ.
 * CJK có thể ngắt giữa hai chữ. Xuống dòng `\n` trong đầu vào giữ nguyên (mỗi đoạn xử lý riêng).
 */
export function wrapAnsi(input: string, width: number, o: WrapOptions = {}): string[] {
  const first = o.first ?? '';
  const rest = o.rest ?? '';
  const fw = stringWidth(first);
  const rw = stringWidth(rest);
  const lines: string[] = [];
  let firstLine = true;
  for (const para of input.split('\n')) {
    const toks = tokenize(para);
    const st = new StyleState();
    const maxW = (): number => Math.max(1, width - (firstLine ? fw : rw));
    let cur = '';
    let curW = 0;
    let pendSpace: Tok[] = []; // khoảng trắng chờ (chỉ ghi ra nếu sau đó còn chữ trên cùng dòng)
    let word: Tok[] = [];
    let wordW = 0;
    let lineHasText = false;

    const startLine = (): void => {
      cur = st.open();
      curW = 0;
      lineHasText = false;
    };
    const endLine = (): void => {
      const prefix = firstLine ? first : rest;
      lines.push(prefix + cur + st.close());
      firstLine = false;
      startLine();
    };
    const emitTok = (t: Tok): void => {
      if (t.esc !== undefined) {
        cur += t.esc;
        st.feed(t.esc);
      } else {
        cur += t.text;
        curW += t.w;
        if (t.text !== ' ') lineHasText = true;
      }
    };
    const flushWord = (): void => {
      if (word.length === 0) return;
      const spW = pendSpace.reduce((a, b) => a + b.w, 0);
      if (curW + spW + wordW <= maxW()) {
        for (const s of pendSpace) emitTok(s);
        for (const t of word) emitTok(t);
      } else if (wordW <= maxW() && lineHasText) {
        // xuống dòng mới, bỏ khoảng trắng chờ
        endLine();
        for (const t of word) emitTok(t);
      } else {
        // từ dài hơn cả dòng (hoặc dòng đang trống): bẻ cứng
        if (lineHasText && curW + spW < maxW()) for (const s of pendSpace) emitTok(s);
        else if (lineHasText) endLine();
        for (const t of word) {
          if (t.esc !== undefined) {
            emitTok(t);
            continue;
          }
          if (curW + t.w > maxW() && curW > 0) endLine();
          emitTok(t);
        }
      }
      pendSpace = [];
      word = [];
      wordW = 0;
    };

    startLine();
    for (const t of toks) {
      if (t.esc !== undefined) {
        if (o.pre) emitTok(t);
        else word.push(t);
        continue;
      }
      if (isSpaceTok(t) && !o.pre) {
        flushWord();
        // khoảng trắng đầu dòng văn bản (thụt lề trong đầu vào) được giữ ở dòng đầu của đoạn
        pendSpace.push(t);
        continue;
      }
      if (o.pre) {
        if (curW + t.w > maxW() && curW > 0) endLine();
        emitTok(t);
        continue;
      }
      word.push(t);
      wordW += t.w;
      if (t.w >= 2) flushWord(); // CJK: cho phép ngắt sau mỗi chữ rộng
    }
    flushWord();
    // khoảng trắng đầu đoạn mà không có chữ nào theo sau: bỏ
    const prefix = firstLine ? first : rest;
    lines.push(prefix + cur + st.close());
    firstLine = false;
  }
  return lines;
}

/** Căn trái/phải: đệm khoảng trắng cho đủ `width` cột (không cắt). */
export function padEnd(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/** Căn giữa. */
export function padCenter(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + s + ' '.repeat(width - w - left);
}
