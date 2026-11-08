/**
 * Bộ vẽ «vùng sống»: dòng đã hoàn chỉnh được IN THẲNG vào scrollback của terminal; chỉ một vùng nhỏ ở đáy (spinner, ô nhập, dải trạng thái…)
 * được vẽ lại bằng CSI (lùi con trỏ lên đầu vùng, ghi đè từng dòng + xoá phần thừa, xoá xuống cuối).
 *
 * Nguyên tắc:
 *  - con trỏ thật luôn đỗ ở CUỐI dòng cuối của vùng sống và bị ẩn (con trỏ trong ô nhập là con trỏ giả đảo màu);
 *  - mỗi khung bọc trong synchronized output `ESC[?2026h … l` để không nháy;
 *  - dòng cuối không bao giờ rộng đúng bằng số cột (tránh trạng thái «chờ cuộn» làm `ESC[J` xoá mất ký tự cuối);
 *  - đổi cỡ cửa sổ: ước lượng số hàng thật mà vùng sống chiếm sau khi terminal tự ngắt dòng rồi vẽ lại;
 *  - không bao giờ xoá màn hình trừ `clearScreen()`.
 */

import { stringWidth, truncateAnsi } from './width';

export interface OutStream {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on?(ev: 'resize', fn: () => void): unknown;
  off?(ev: 'resize', fn: () => void): unknown;
  removeListener?(ev: 'resize', fn: () => void): unknown;
}

const ESC = '\x1b';
const CSI = `${ESC}[`;
export const SYNC_ON = `${CSI}?2026h`;
export const SYNC_OFF = `${CSI}?2026l`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
const EL = `${CSI}K`;
const ED0 = `${CSI}J`;

export interface ScreenOptions {
  sync?: boolean;
  /** Tối đa số khung mỗi giây (mặc định ~60). */
  minFrameMs?: number;
}

export class Screen {
  private pending: string[] = [];
  private live: string[] = [];
  private prevLive: string[] = [];
  private prevRows = 0;
  private prevCols = 0;
  private forceFull = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFrame = 0;
  private closed = false;
  private resizeHandler: (() => void) | null = null;
  private readonly sync: boolean;
  private readonly minFrameMs: number;
  /** Gọi sau khi đổi cỡ (người dùng dựng lại nội dung vùng sống theo cột mới). */
  onResize: (() => void) | null = null;
  /** Số byte đã ghi (kiểm thử / đo). */
  bytesWritten = 0;
  frames = 0;

  constructor(
    private readonly out: OutStream,
    o: ScreenOptions = {},
  ) {
    this.sync = o.sync !== false;
    this.minFrameMs = o.minFrameMs ?? 16;
    this.prevCols = this.cols;
    this.resizeHandler = () => this.handleResize();
    this.out.on?.('resize', this.resizeHandler);
  }

  get cols(): number {
    const c = this.out.columns;
    return typeof c === 'number' && c > 0 ? c : 80;
  }

  get rows(): number {
    const r = this.out.rows;
    return typeof r === 'number' && r > 0 ? r : 24;
  }

  /** Xếp dòng vào scrollback (hiện ở khung kế tiếp, phía trên vùng sống). Mỗi phần tử là MỘT dòng (đã ngắt vừa chiều rộng). */
  print(lines: string[]): void {
    if (this.closed || !lines.length) return;
    for (const l of lines) this.pending.push(l);
    this.schedule();
  }

  /** Đặt nội dung vùng sống (mỗi phần tử một dòng, không có \n). */
  setLive(lines: string[]): void {
    if (this.closed) return;
    this.live = lines;
    this.schedule();
  }

  get liveLines(): readonly string[] {
    return this.live;
  }

  /** Yêu cầu vẽ (gộp nhiều lần gọi). */
  schedule(): void {
    if (this.closed || this.timer) return;
    const wait = Math.max(0, this.lastFrame + this.minFrameMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Vẽ NGAY. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    this.draw();
  }

  private write(s: string): void {
    if (!s) return;
    this.bytesWritten += s.length;
    try {
      this.out.write(s);
    } catch {
      /* stdout đóng (EPIPE): bỏ qua */
    }
  }

  private fit(l: string, cols: number, last: boolean): string {
    const w = stringWidth(l);
    const max = last ? cols - 1 : cols;
    return w > max ? truncateAnsi(l, max) : l;
  }

  private draw(): void {
    this.lastFrame = Date.now();
    this.frames++;
    const cols = this.cols;
    const rows = this.rows;
    const commit = this.pending;
    this.pending = [];
    let live = this.live.length ? this.live : [''];
    // vùng sống không được cao hơn màn hình: bỏ bớt phần trên (nội dung dở), giữ phần dưới (ô nhập + dải trạng thái)
    const cap = Math.max(1, rows - 1);
    if (live.length > cap) live = live.slice(live.length - cap);
    const lines = live.map((l, i) => this.fit(l, cols, i === live.length - 1));

    let out = this.sync ? SYNC_ON : '';
    if (this.prevRows > 1) out += `${CSI}${this.prevRows - 1}A`;
    out += '\r';
    const diffable = !this.forceFull && commit.length === 0 && this.prevLive.length === lines.length && this.prevRows === lines.length;
    for (const c of commit) {
      const l = this.fit(c, cols, false);
      out += l + (stringWidth(l) < cols ? EL : '') + '\r\n';
    }
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) out += '\r\n';
      // không bỏ qua dòng cuối: con trỏ phải kết thúc ở CUỐI dòng cuối (trước `ESC[J`)
      if (diffable && i < lines.length - 1 && this.prevLive[i] === lines[i]) continue;
      out += lines[i] + (stringWidth(lines[i]) < cols ? EL : '');
    }
    out += ED0;
    if (this.sync) out += SYNC_OFF;
    this.write(out);

    this.prevLive = lines;
    this.prevRows = lines.length;
    this.prevCols = cols;
    this.forceFull = false;
  }

  /** Số hàng thật mà các dòng chiếm khi rộng `cols` (terminal tự ngắt dòng dài). */
  static rowsOccupied(lines: readonly string[], cols: number): number {
    let n = 0;
    for (const l of lines) n += Math.max(1, Math.ceil(stringWidth(l) / Math.max(1, cols)));
    return n;
  }

  private handleResize(): void {
    if (this.closed) return;
    const cols = this.cols;
    if (cols !== this.prevCols && this.prevRows > 0) {
      // terminal ngắt dòng lại nội dung vùng sống theo chiều rộng mới (khi hẹp đi); ước lượng số hàng thật rồi vẽ lại hoàn toàn
      this.prevRows = Math.min(Screen.rowsOccupied(this.prevLive, cols), this.rows);
    }
    this.forceFull = true;
    this.prevCols = cols;
    try {
      this.onResize?.();
    } catch {
      /* người nghe lỗi không được làm sập giao diện */
    }
    this.schedule();
  }

  /** Xoá toàn bộ màn hình + scrollback (chỉ /clear, Ctrl+L kiểu «sạch»). */
  clearScreen(scrollback = true): void {
    if (this.closed) return;
    this.write(`${CSI}2J${scrollback ? CSI + '3J' : ''}${CSI}H`);
    this.prevRows = 0;
    this.prevLive = [];
    this.forceFull = true;
    this.pending = [];
    this.schedule();
  }

  /** Đẩy nội dung đang hiện lên scrollback (không mất gì) rồi bắt đầu từ đầu màn hình. */
  pushScreenToScrollback(): void {
    if (this.closed) return;
    this.flush();
    this.write(`\r\n`.repeat(this.rows) + `${CSI}H`);
    this.prevRows = 0;
    this.prevLive = [];
    this.forceFull = true;
    this.schedule();
  }

  /** Xoá vùng sống, hiện con trỏ ở dòng trống đầu tiên bên dưới nội dung đã in. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    let out = this.sync ? SYNC_ON : '';
    if (this.prevRows > 1) out += `${CSI}${this.prevRows - 1}A`;
    out += `\r${ED0}${this.sync ? SYNC_OFF : ''}`;
    this.write(out);
    this.prevRows = 0;
    this.prevLive = [];
    if (this.resizeHandler) {
      (this.out.off ?? this.out.removeListener)?.call(this.out, 'resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }
}
