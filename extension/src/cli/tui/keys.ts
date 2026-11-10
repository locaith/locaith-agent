/**
 * Bộ phân tích phím thô từ stdin (raw mode) → sự kiện phím có cấu trúc.
 *
 * Nhận: ký tự thường (nhiều byte UTF-8), điều khiển Ctrl+chữ, Alt+phím (ESC + ký tự), CSI/SS3 (mũi tên, Home/End, Del, PgUp/PgDn, F1–F12),
 * phím bổ trợ (`ESC[1;5C`), kitty/CSI-u (`ESC[13;2u`), modifyOtherKeys (`ESC[27;2;13~`), bracketed paste (`ESC[200~ … ESC[201~`, có thể
 * đến nhiều gói), và — vì ConPTY/terminal cũ không bật bracketed paste — đoán «dán» khi một gói chữ chứa xuống dòng lẫn chữ khác.
 * Chuỗi thoát chưa đủ (bị cắt giữa chừng giữa hai gói) được giữ lại; `flush()` (gọi sau ~25 ms yên lặng) biến ESC đơn thành phím Esc.
 */

export interface Key {
  /** Tên phím: 'char' (ký tự in được, xem `text`), 'enter', 'tab', 'backspace', 'delete', 'escape', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'f1'…'f12', hoặc 'ctrl+x' đã tách vào cờ. */
  name: string;
  /** Với name === 'char': chuỗi ký tự (có thể nhiều ký tự nếu gõ nhanh). */
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Phím gốc thô để gỡ lỗi. */
  raw: string;
}

export type KeyEvent = { type: 'key'; key: Key } | { type: 'paste'; text: string };

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function mk(name: string, raw: string, m: Partial<Pick<Key, 'ctrl' | 'alt' | 'shift'>> = {}, text?: string): KeyEvent {
  return { type: 'key', key: { name, text, ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift, raw } };
}

/** Bit bổ trợ xterm: 1 + (shift 1 | alt 2 | ctrl 4 | meta 8). */
function mods(n: number): { shift: boolean; alt: boolean; ctrl: boolean } {
  const v = Math.max(0, n - 1);
  return { shift: !!(v & 1), alt: !!(v & 2) || !!(v & 8), ctrl: !!(v & 4) };
}

const CSI_LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const CSI_TILDE: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};

/** Từ mã ký tự Unicode (kitty / modifyOtherKeys) sang phím. */
function fromCodepoint(cp: number, m: { shift: boolean; alt: boolean; ctrl: boolean }, raw: string): KeyEvent | null {
  switch (cp) {
    case 13: return mk('enter', raw, m);
    case 9: return mk('tab', raw, m);
    case 27: return mk('escape', raw, m);
    case 127:
    case 8: return mk('backspace', raw, m);
    case 32: return mk('char', raw, m, ' ');
  }
  if (cp >= 0x20 && cp !== 0x7f) {
    const ch = String.fromCodePoint(cp);
    return mk('char', raw, m, m.shift && /[a-z]/.test(ch) ? ch.toUpperCase() : ch);
  }
  return null;
}

/**
 * Byte 0x08 (Ctrl+H) là gì?
 *  - Windows Terminal, VS Code, và đa số terminal Unix: Backspace gửi 0x7f, còn Ctrl+Backspace mới gửi 0x08 → 'ctrl-backspace' (xoá cả từ).
 *  - Console CỔ ĐIỂN của Windows (conhost: cmd.exe / PowerShell mở thẳng, Windows 10 mặc định) NGƯỢC LẠI: Backspace THƯỜNG là 0x08, Ctrl+Backspace là 0x7f.
 *    Coi 0x08 là «xoá cả từ» ở đó nghĩa là MỖI lần Backspace xoá luôn từ đứng trước — và bộ gõ tiếng Việt (UniKey, EVKey, OpenKey… gõ «ê» bằng Backspace rồi chèn lại chữ có dấu)
 *    nuốt mất cả từ mỗi khi gõ một dấu: «gõ đến đâu có dấu là mất chữ đến đó». Ở máy dùng Windows Terminal thì không thấy lỗi vì ở đó Backspace là 0x7f.
 * Không chắc (Windows không có WT_SESSION / TERM_PROGRAM=vscode) → coi là Backspace thường: lỡ xoá thừa cả từ tệ hơn nhiều so với việc Ctrl+Backspace chỉ xoá một chữ.
 */
export type CtrlHMode = 'ctrl-backspace' | 'backspace';

export function ctrlHMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CtrlHMode {
  // Lối thoát cho terminal lạ: LOCAITH_CTRL_H=backspace (0x08 là Backspace thường) hoặc ctrl-backspace (0x08 xoá cả từ).
  const forced = (env.LOCAITH_CTRL_H ?? '').trim().toLowerCase();
  if (forced === 'backspace' || forced === 'ctrl-backspace') return forced;
  if (platform !== 'win32') return 'ctrl-backspace';
  if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.ConEmuPID) return 'ctrl-backspace';
  return 'backspace';
}

export interface KeyParserOptions {
  /** Cách hiểu byte 0x08 (xem `CtrlHMode`). Mặc định 'ctrl-backspace' (giữ hành vi cũ cho test và terminal Unix). */
  ctrlH?: CtrlHMode;
}

export class KeyParser {
  private buf = '';
  private paste: string[] | null = null;
  /** Đoán dán khi không có bracketed paste (mặc định bật). */
  heuristicPaste = true;

  constructor(private readonly opts: KeyParserOptions = {}) {}

  /** Đưa dữ liệu thô vào; trả về các sự kiện phân tích được. */
  feed(data: string): KeyEvent[] {
    this.buf += data;
    return this.drain(false);
  }

  /** Có dữ liệu chờ (ESC đơn hoặc chuỗi dở) — người gọi hẹn giờ rồi `flush()`. */
  get pending(): boolean {
    return this.buf.length > 0 && this.paste === null;
  }

  /** Hết thời gian chờ: coi phần còn lại là phím hoàn chỉnh (ESC đơn → Esc). */
  flush(): KeyEvent[] {
    return this.drain(true);
  }

  private drain(force: boolean): KeyEvent[] {
    const out: KeyEvent[] = [];
    for (;;) {
      if (this.paste !== null) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          // giữ đuôi có thể là đầu của mã kết thúc
          const keep = partialSuffix(this.buf, PASTE_END);
          this.paste.push(this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          if (force && this.buf) {
            this.paste.push(this.buf);
            this.buf = '';
          }
          return out;
        }
        this.paste.push(this.buf.slice(0, end));
        this.buf = this.buf.slice(end + PASTE_END.length);
        out.push({ type: 'paste', text: normalizePaste(this.paste.join('')) });
        this.paste = null;
        continue;
      }
      if (!this.buf) return out;
      const r = this.next(force);
      if (r === 'wait') return out;
      out.push(...r.events);
      this.buf = this.buf.slice(r.used);
    }
  }

  private next(force: boolean): 'wait' | { events: KeyEvent[]; used: number } {
    const b = this.buf;
    if (b.startsWith(PASTE_START)) {
      this.paste = [];
      this.buf = b.slice(PASTE_START.length);
      return { events: [], used: 0 };
    }
    if (PASTE_START.startsWith(b) && b.length < PASTE_START.length && !force) return 'wait';
    if (b[0] === ESC) return this.escape(force);

    // chữ thường: gom một đoạn liền không có ESC / điều khiển
    let n = 0;
    while (n < b.length && b[n] !== ESC && !(b.charCodeAt(n) < 0x20) && b.charCodeAt(n) !== 0x7f) n++;
    if (n > 0) {
      const text = b.slice(0, n);
      return { events: [mk('char', text, {}, text)], used: n };
    }
    // một byte điều khiển
    const c = b.charCodeAt(0);
    // đoán dán: cụm chữ có \r/\n lẫn chữ khác
    if ((c === 13 || c === 10) && this.heuristicPaste && b.length > 1) {
      let m = 0;
      while (m < b.length && b[m] !== ESC && (b.charCodeAt(m) >= 0x20 || b[m] === '\r' || b[m] === '\n' || b[m] === '\t') && b.charCodeAt(m) !== 0x7f) m++;
      const run = b.slice(0, m);
      if (/[^\r\n]/.test(run) && m === b.length) {
        return { events: [{ type: 'paste', text: normalizePaste(run) }], used: m };
      }
    }
    const raw = b[0];
    switch (c) {
      case 13: return { events: [mk('enter', raw)], used: 1 };
      case 10: return { events: [mk('char', raw, { ctrl: true }, 'j')], used: 1 }; // Ctrl+J = xuống dòng
      case 9: return { events: [mk('tab', raw)], used: 1 };
      case 8: return { events: [mk('backspace', raw, this.opts.ctrlH === 'backspace' ? {} : { ctrl: true })], used: 1 }; // Ctrl+H / Ctrl+Backspace — hay Backspace thường ở conhost: xem CtrlHMode
      case 127: return { events: [mk('backspace', raw)], used: 1 };
      case 0: return { events: [mk('char', raw, { ctrl: true }, ' ')], used: 1 };
    }
    if (c >= 1 && c <= 26) return { events: [mk('char', raw, { ctrl: true }, String.fromCharCode(96 + c))], used: 1 };
    if (c >= 28 && c <= 31) return { events: [mk('char', raw, { ctrl: true }, String.fromCharCode(64 + c))], used: 1 };
    return { events: [], used: 1 };
  }

  private escape(force: boolean): 'wait' | { events: KeyEvent[]; used: number } {
    const b = this.buf;
    if (b.length === 1) return force ? { events: [mk('escape', ESC)], used: 1 } : 'wait';
    const c1 = b[1];
    if (c1 === '[') return this.csi(force);
    if (c1 === 'O') {
      if (b.length < 3) return force ? { events: [mk('char', 'O', { alt: true, shift: true }, 'O')], used: 2 } : 'wait';
      const name = CSI_LETTER[b[2]];
      if (name) return { events: [mk(name, b.slice(0, 3))], used: 3 };
      if (b[2] === 'M') return { events: [mk('enter', b.slice(0, 3))], used: 3 };
      return { events: [], used: 3 };
    }
    if (c1 === ']' || c1 === 'P' || c1 === '_' || c1 === '^') {
      // OSC/DCS/APC/PM: bỏ nguyên chuỗi tới BEL hoặc ST (ví dụ trả lời truy vấn màu của terminal)
      const bel = b.indexOf('\x07');
      const st = b.indexOf('\x1b\\');
      const end = [bel >= 0 ? bel + 1 : -1, st >= 0 ? st + 2 : -1].filter((x) => x > 0).sort((a, z) => a - z)[0];
      if (end) return { events: [], used: end };
      return force ? { events: [], used: b.length } : 'wait';
    }
    // Alt + phím
    if (c1 === ESC) {
      // ESC ESC → Esc (đôi khi kèm Alt+mũi tên: ESC ESC [ A)
      if (b.length >= 3 && b[2] === '[') {
        const r = this.csi(force, 1);
        if (r === 'wait') return 'wait';
        const ev = r.events.map((e) => (e.type === 'key' ? { ...e, key: { ...e.key, alt: true } } : e));
        return { events: ev, used: r.used + 1 };
      }
      return { events: [mk('escape', ESC)], used: 1 };
    }
    const cp = b.codePointAt(1)!;
    const len = cp > 0xffff ? 2 : 1;
    const raw = b.slice(0, 1 + len);
    if (cp === 13 || cp === 10) return { events: [mk('enter', raw, { alt: true })], used: 2 };
    if (cp === 127 || cp === 8) return { events: [mk('backspace', raw, { alt: true })], used: 2 };
    if (cp === 9) return { events: [mk('tab', raw, { alt: true })], used: 2 };
    if (cp >= 1 && cp <= 26) return { events: [mk('char', raw, { alt: true, ctrl: true }, String.fromCharCode(96 + cp))], used: 2 };
    if (cp >= 0x20) {
      const ch = String.fromCodePoint(cp);
      return { events: [mk('char', raw, { alt: true }, ch)], used: 1 + len };
    }
    return { events: [mk('escape', ESC)], used: 1 };
  }

  private csi(force: boolean, offset = 0): 'wait' | { events: KeyEvent[]; used: number } {
    const b = this.buf.slice(offset);
    // ESC [ <params> <intermediates> <final>
    let i = 2;
    while (i < b.length && b.charCodeAt(i) >= 0x30 && b.charCodeAt(i) <= 0x3f) i++;
    while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x2f) i++;
    if (i >= b.length) return force ? { events: [], used: b.length } : 'wait';
    const final = b[i];
    const params = b.slice(2, i).replace(/[^0-9;:<=>?]/g, '');
    const raw = b.slice(0, i + 1);
    const used = i + 1;
    if (params.startsWith('<')) return { events: [], used }; // chuột SGR: không dùng
    const nums = params.split(';').map((x) => (x === '' ? NaN : parseInt(x.split(':')[0], 10)));
    const modN = nums.length >= 2 && Number.isFinite(nums[1]) ? nums[1] : 1;
    const m = mods(modN);
    if (final === 'Z') return { events: [mk('tab', raw, { shift: true })], used };
    if (final === 'u') {
      const cp = nums[0];
      if (Number.isFinite(cp)) {
        const ev = fromCodepoint(cp, m, raw);
        if (ev) return { events: [ev], used };
      }
      return { events: [], used };
    }
    if (final === '~') {
      const n0 = nums[0];
      if (n0 === 27 && nums.length >= 3) {
        // modifyOtherKeys: ESC [ 27 ; mod ; cp ~
        const ev = fromCodepoint(nums[2], mods(Number.isFinite(nums[1]) ? nums[1] : 1), raw);
        return { events: ev ? [ev] : [], used };
      }
      const name = CSI_TILDE[n0];
      return { events: name ? [mk(name, raw, m)] : [], used };
    }
    const name = final === 'R' ? undefined : CSI_LETTER[final]; // ESC[r;cR là báo vị trí con trỏ, không phải F3
    if (name) return { events: [mk(name, raw, m)], used };
    return { events: [], used }; // bỏ qua (báo cáo vị trí con trỏ, focus in/out…)
  }
}

function partialSuffix(s: string, token: string): number {
  const max = Math.min(token.length - 1, s.length);
  for (let n = max; n > 0; n--) if (s.endsWith(token.slice(0, n))) return n;
  return 0;
}

/** Chuẩn hoá chữ dán: CRLF/CR → LF, bỏ mã điều khiển lạ (giữ \n và \t), tab → 4 dấu cách. */
export function normalizePaste(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Chuỗi mô tả phím cho gỡ lỗi/test: 'ctrl+a', 'alt+enter', 'shift+tab', 'x'. */
export function describeKey(k: Key): string {
  const parts: string[] = [];
  if (k.ctrl) parts.push('ctrl');
  if (k.alt) parts.push('alt');
  if (k.shift && k.name !== 'char') parts.push('shift');
  parts.push(k.name === 'char' ? (k.text ?? '') : k.name);
  return parts.join('+');
}

/** Phím này có phải ký tự gõ thường (có thể chèn vào ô nhập)? */
export function isPrintable(k: Key): boolean {
  return k.name === 'char' && !k.ctrl && !k.alt && !!k.text;
}
