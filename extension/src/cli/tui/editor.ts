/**
 * Trình soạn thảo nhiều dòng thuần (không I/O): văn bản + vị trí con trỏ (chỉ số UTF-16, luôn nằm trên ranh giới cụm chữ),
 * phím emacs, ngắt dòng theo từ để vẽ, di chuyển lên/xuống theo hàng hiển thị.
 */

import { graphemes, graphemeWidth, stringWidth } from './width';

export interface VRow {
  /** Dòng logic (tách bởi \n) chứa hàng này. */
  line: number;
  /** [start, end) chỉ số trong văn bản — không gồm \n. */
  start: number;
  end: number;
}

const WORD_RE = /[\p{L}\p{N}_]/u;
const isWordCluster = (g: string): boolean => WORD_RE.test(g);

/** Ranh giới các cụm chữ của `text` (kể cả 0 và text.length). */
export function boundaries(text: string): number[] {
  const out = [0];
  let p = 0;
  for (const g of graphemes(text)) {
    p += g.length;
    out.push(p);
  }
  return out;
}

export function prevBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  const b = boundaries(text);
  for (let k = b.length - 1; k >= 0; k--) if (b[k] < i) return b[k];
  return 0;
}

export function nextBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const b = boundaries(text);
  for (const x of b) if (x > i) return x;
  return text.length;
}

/** Ngắt `text` thành các hàng hiển thị rộng tối đa `width` cột (ưu tiên ngắt sau dấu cách, bẻ cứng khi từ dài hơn dòng). */
export function layoutRows(text: string, width: number): VRow[] {
  const w = Math.max(1, width);
  const rows: VRow[] = [];
  let lineStart = 0;
  let lineNo = 0;
  for (const ln of text.split('\n')) {
    const gs = graphemes(ln);
    const n = gs.length;
    const off: number[] = [0];
    const wid: number[] = [];
    for (const g of gs) {
      off.push(off[off.length - 1] + g.length);
      wid.push(graphemeWidth(g));
    }
    let rowStart = 0;
    let rowW = 0;
    let lastBreak = -1;
    const push = (from: number, to: number): void => {
      rows.push({ line: lineNo, start: lineStart + off[from], end: lineStart + off[to] });
    };
    for (let gi = 0; gi < n; gi++) {
      if (gs[gi] !== ' ' && rowW + wid[gi] > w && gi > rowStart) {
        const brk = lastBreak > rowStart ? lastBreak : gi;
        push(rowStart, brk);
        rowStart = brk;
        rowW = 0;
        for (let k = brk; k < gi; k++) rowW += wid[k];
        lastBreak = -1;
      }
      rowW += wid[gi];
      if (gs[gi] === ' ') lastBreak = gi + 1;
    }
    push(rowStart, n);
    lineStart += ln.length + 1;
    lineNo++;
  }
  return rows;
}

/**
 * Một chữ được ghép từ dấu RỜI trong lúc gõ (bộ gõ «Unicode tổ hợp»): nhớ các điểm mã THEO ĐÚNG THỨ TỰ bộ gõ đã gửi (xem `Editor.backspace`).
 * Bộ gõ đếm số Backspace theo các điểm mã ấy — ệ có thể là 1 (dựng sẵn), 2 (ê + ◌̣) hay 3 (e + ◌̂ + ◌̣) — nên ô nhập phải xoá đúng từng điểm mã, không xoá cả chữ.
 */
interface ComposedLetter {
  /** Chỉ số UTF-16 của chữ trong `text` (dạng đã ghép NFC). */
  start: number;
  /** Chữ gốc rồi từng dấu, THEO THỨ TỰ BỘ GÕ GỬI — khác thứ tự chuẩn NFD khi dấu thanh gõ sau dấu mũ (ệ: e + ̂ + ̣, NFD là e + ̣ + ̂). Luôn ≥ 2 phần tử. */
  seq: string[];
}

/** Chỉ số ngay sau chữ đã ghép. */
const letterEnd = (r: ComposedLetter): number => r.start + r.seq.join('').normalize('NFC').length;

export class Editor {
  text = '';
  cursor = 0;
  killed = '';
  private desiredCol: number | null = null;
  /** Các chữ ghép từ dấu rời đang còn «nhớ cách gõ»; chỉ hiệu lực khi `text` vẫn y hệt `composedFor` (mọi sửa đổi khác tự làm mất hiệu lực). */
  private composed: ComposedLetter[] = [];
  private composedFor: string | null = null;

  private live(): ComposedLetter[] {
    return this.composedFor === this.text ? this.composed : [];
  }

  private remember(list: ComposedLetter[]): void {
    this.composed = list;
    this.composedFor = list.length ? this.text : null;
  }

  /** Quên cách gõ (con trỏ nhảy chỗ khác, nạp lại văn bản…): bộ gõ cũng đã bỏ bộ đệm của nó. */
  private forget(): void {
    this.composed = [];
    this.composedFor = null;
  }

  setText(s: string, cursor: number = s.length): void {
    this.text = s;
    this.cursor = Math.max(0, Math.min(cursor, s.length));
    this.desiredCol = null;
    this.forget();
  }

  clear(): void {
    this.setText('');
  }

  get empty(): boolean {
    return this.text.length === 0;
  }

  insert(s: string): void {
    if (!s) return;
    // Bộ gõ «Unicode tổ hợp» (UniKey/EVKey chọn bảng mã tổ hợp, bàn phím macOS…) gửi dấu như một ký tự RIÊNG đứng sau chữ gốc (e + U+0302 → ê). Ghép lại thành chữ dựng sẵn (NFC) để một
    // Backspace xoá đúng một chữ, độ rộng/ngắt dòng không lệch, và dấu không bị rơi ra thành một ô riêng. Chữ không có dấu kết hợp thì giữ NGUYÊN (không đụng nội dung dán).
    if (/\p{M}/u.test(s)) {
      if (this.cursor > 0 && /^\p{M}/u.test(s)) {
        const lead = /^\p{M}+/u.exec(s)![0];
        const p = prevBoundary(this.text, this.cursor);
        const old = this.live();
        const g = this.text.slice(p, this.cursor);
        // Điểm mã của chữ đứng trước THEO ĐÚNG THỨ TỰ bộ gõ đã gửi nếu biết; nếu không thì chính chữ đó (chữ dựng sẵn là MỘT điểm mã — bộ gõ «chỉ dấu thanh rời» gửi ê rồi mới tới dấu sắc).
        const known = old.find((r) => r.start === p && letterEnd(r) === this.cursor);
        const seq = [...(known ? known.seq : [...g]), ...lead];
        const merged = seq.join('').normalize('NFC');
        const delta = merged.length - (this.cursor - p);
        // Chỉ nhớ khi dấu thật sự dính vào chữ (một cụm): dấu đứng sau xuống dòng/ký tự điều khiển không dính, khỏi nhớ một «chữ» mà con trỏ không bao giờ dừng ở đó.
        const kept = [...old.filter((r) => letterEnd(r) <= p), ...(graphemes(merged).length === 1 ? [{ start: p, seq }] : []), ...old.filter((r) => r.start >= this.cursor).map((r) => ({ ...r, start: r.start + delta }))];
        this.text = this.text.slice(0, p) + merged + this.text.slice(this.cursor);
        this.cursor = p + merged.length;
        this.desiredCol = null;
        this.remember(kept);
        const rest = s.slice(lead.length);
        if (rest) this.insert(rest);
        return;
      }
      s = s.normalize('NFC');
    }
    const old = this.live();
    const at = this.cursor;
    this.text = this.text.slice(0, at) + s + this.text.slice(at);
    this.cursor += s.length;
    this.desiredCol = null;
    this.remember(old.filter((r) => letterEnd(r) <= at || r.start >= at).map((r) => (r.start >= at ? { ...r, start: r.start + s.length } : r)));
  }

  /**
   * Xoá lùi. Thường là một CỤM chữ (ê, ế, emoji ZWJ…). Ngoại lệ: chữ được ghép từ các dấu mà bộ gõ «Unicode tổ hợp» gõ RỜI thì mỗi Backspace bỏ ĐÚNG MỘT điểm mã bộ gõ đã gửi
   * (dấu cuối cùng) — như Notepad/Word, và đúng cách bộ gõ đó tính số Backspace: khi đổi dấu (ế → ề: «xoá dấu sắc, gõ dấu huyền») và khi người dùng nhấn Backspace trên chữ có dấu
   * (bộ gõ nuốt phím rồi gửi N Backspace, N = số điểm mã của chữ). Xoá cả chữ cho MỖI Backspace thì Backspace thừa nuốt các chữ đứng trước — «một lần nhấn mất cả cụm» — và dấu mới
   * rơi vào chữ sai («Việt» → «Vị̂t»: mất «e»). Cách gõ chỉ được nhớ trong lúc gõ liền; con trỏ nhảy chỗ khác hay sửa kiểu khác thì quay lại xoá cả chữ.
   */
  backspace(): void {
    if (this.cursor <= 0) return;
    const old = this.live();
    const p = prevBoundary(this.text, this.cursor);
    const known = old.find((r) => r.start === p && letterEnd(r) === this.cursor);
    if (known && known.seq.length > 1) {
      const seq = known.seq.slice(0, -1);
      const rest = seq.join('').normalize('NFC');
      const delta = rest.length - (this.cursor - p);
      const kept = [...old.filter((r) => letterEnd(r) <= p), ...(seq.length > 1 && graphemes(rest).length === 1 ? [{ start: p, seq }] : []), ...old.filter((r) => r.start >= this.cursor).map((r) => ({ ...r, start: r.start + delta }))];
      this.text = this.text.slice(0, p) + rest + this.text.slice(this.cursor);
      this.cursor = p + rest.length;
      this.desiredCol = null;
      this.remember(kept);
      return;
    }
    const removed = this.cursor - p;
    const kept = [...old.filter((r) => letterEnd(r) <= p), ...old.filter((r) => r.start >= this.cursor).map((r) => ({ ...r, start: r.start - removed }))];
    this.text = this.text.slice(0, p) + this.text.slice(this.cursor);
    this.cursor = p;
    this.desiredCol = null;
    this.remember(kept);
  }

  del(): void {
    if (this.cursor >= this.text.length) return;
    const n = nextBoundary(this.text, this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(n);
    this.desiredCol = null;
  }

  left(): void {
    this.cursor = prevBoundary(this.text, this.cursor);
    this.desiredCol = null;
    this.forget();
  }

  right(): void {
    this.cursor = nextBoundary(this.text, this.cursor);
    this.desiredCol = null;
    this.forget();
  }

  private wordLeftIndex(from: number): number {
    let i = from;
    const gsBefore = graphemes(this.text.slice(0, i));
    let k = gsBefore.length;
    while (k > 0 && !isWordCluster(gsBefore[k - 1])) {
      i -= gsBefore[k - 1].length;
      k--;
    }
    while (k > 0 && isWordCluster(gsBefore[k - 1])) {
      i -= gsBefore[k - 1].length;
      k--;
    }
    return i;
  }

  private wordRightIndex(from: number): number {
    let i = from;
    const gsAfter = graphemes(this.text.slice(i));
    let k = 0;
    while (k < gsAfter.length && !isWordCluster(gsAfter[k])) i += gsAfter[k++].length;
    while (k < gsAfter.length && isWordCluster(gsAfter[k])) i += gsAfter[k++].length;
    return i;
  }

  wordLeft(): void {
    this.cursor = this.wordLeftIndex(this.cursor);
    this.desiredCol = null;
    this.forget();
  }

  wordRight(): void {
    this.cursor = this.wordRightIndex(this.cursor);
    this.desiredCol = null;
    this.forget();
  }

  /** Ctrl+W: xoá từ trước con trỏ. */
  deleteWordBack(): void {
    const s = this.wordLeftIndex(this.cursor);
    if (s === this.cursor) return;
    this.killed = this.text.slice(s, this.cursor);
    this.text = this.text.slice(0, s) + this.text.slice(this.cursor);
    this.cursor = s;
    this.desiredCol = null;
  }

  /** Alt+D: xoá từ sau con trỏ. */
  deleteWordForward(): void {
    const e = this.wordRightIndex(this.cursor);
    if (e === this.cursor) return;
    this.killed = this.text.slice(this.cursor, e);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(e);
    this.desiredCol = null;
  }

  private lineBounds(at = this.cursor): [number, number] {
    const s = this.text.lastIndexOf('\n', at - 1) + 1;
    let e = this.text.indexOf('\n', at);
    if (e < 0) e = this.text.length;
    return [s, e];
  }

  /** Ctrl+A / Home: đầu dòng logic. */
  home(): void {
    this.cursor = this.lineBounds()[0];
    this.desiredCol = null;
    this.forget();
  }

  /** Ctrl+E / End: cuối dòng logic. */
  end(): void {
    this.cursor = this.lineBounds()[1];
    this.desiredCol = null;
    this.forget();
  }

  /** Ctrl+K: xoá tới cuối dòng (nếu đã ở cuối thì xoá dấu xuống dòng). */
  killToEnd(): void {
    const [, e] = this.lineBounds();
    const to = e === this.cursor && e < this.text.length ? e + 1 : e;
    if (to === this.cursor) return;
    this.killed = this.text.slice(this.cursor, to);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(to);
    this.desiredCol = null;
  }

  /** Ctrl+U: xoá từ đầu dòng tới con trỏ. */
  killToStart(): void {
    const [s] = this.lineBounds();
    const from = s === this.cursor && s > 0 ? s - 1 : s;
    if (from === this.cursor) return;
    this.killed = this.text.slice(from, this.cursor);
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
    this.cursor = from;
    this.desiredCol = null;
  }

  yank(): void {
    this.insert(this.killed);
  }

  /** Các hàng hiển thị theo chiều rộng nội dung. */
  rows(width: number): VRow[] {
    return layoutRows(this.text, width);
  }

  /** Hàng và cột hiển thị của con trỏ. */
  cursorPos(width: number): { row: number; col: number } {
    const rs = this.rows(width);
    let r = rs.findIndex((x) => this.cursor >= x.start && this.cursor < x.end);
    if (r < 0) {
      // cuối dòng logic (cursor == end của hàng cuối của dòng) hoặc cuối văn bản
      for (let i = rs.length - 1; i >= 0; i--) {
        if (this.cursor >= rs[i].start && this.cursor <= rs[i].end) {
          r = i;
          break;
        }
      }
    }
    if (r < 0) r = rs.length - 1;
    const row = rs[r];
    return { row: r, col: stringWidth(this.text.slice(row.start, Math.min(this.cursor, row.end))) };
  }

  /** Lên/xuống một hàng hiển thị; false nếu đã ở hàng đầu/cuối (để người gọi chuyển sang lịch sử). */
  moveVertical(dir: -1 | 1, width: number): boolean {
    const rs = this.rows(width);
    const { row, col } = this.cursorPos(width);
    const target = row + dir;
    if (target < 0 || target >= rs.length) return false;
    if (this.desiredCol === null) this.desiredCol = col;
    const t = rs[target];
    let acc = 0;
    let i = t.start;
    for (const g of graphemes(this.text.slice(t.start, t.end))) {
      const gw = graphemeWidth(g);
      if (acc + gw > this.desiredCol) break;
      acc += gw;
      i += g.length;
    }
    this.cursor = i;
    this.forget();
    return true;
  }

  /** Vẽ các hàng (đã gồm con trỏ giả đảo màu). `inverse` bọc ký tự dưới con trỏ. */
  renderRows(width: number, inverse: (s: string) => string, showCursor = true): { rows: string[]; cursorRow: number } {
    const rs = this.rows(width);
    const { row: cr } = this.cursorPos(width);
    const rows = rs.map((r, idx) => {
      const seg = this.text.slice(r.start, r.end);
      if (!showCursor || idx !== cr) return seg;
      const local = this.cursor - r.start;
      const before = seg.slice(0, local);
      const after = seg.slice(local);
      const g = graphemes(after)[0];
      if (!g) return before + inverse(' ');
      return before + inverse(g) + after.slice(g.length);
    });
    return { rows, cursorRow: cr };
  }
}
