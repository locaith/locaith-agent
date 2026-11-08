/**
 * «Terminal ảo» cho kiểm thử: stdout giả ghi vào @xterm/headless; stdin giả đẩy phím vào.
 * Đọc màn hình: `screen()` (khung nhìn), `all()` (cả scrollback + khung nhìn), `cursor()`.
 */
import { EventEmitter } from 'node:events';
import xterm from '@xterm/headless';

const { Terminal } = xterm as unknown as { Terminal: new (o: Record<string, unknown>) => import('@xterm/headless').Terminal };

export class VT {
  readonly term: import('@xterm/headless').Terminal;
  columns: number;
  rows: number;
  isTTY = true;
  private chain: Promise<void> = Promise.resolve();
  private ev = new EventEmitter();
  raw: string[] = [];

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.term = new Terminal({ cols: columns, rows, scrollback: 5000, allowProposedApi: true });
  }

  // --- giao diện stdout ---
  write(s: string): boolean {
    this.raw.push(s);
    this.chain = this.chain.then(() => new Promise<void>((r) => this.term.write(s, () => r())));
    return true;
  }
  on(ev: string, fn: (...a: unknown[]) => void): this {
    this.ev.on(ev, fn);
    return this;
  }
  off(ev: string, fn: (...a: unknown[]) => void): this {
    this.ev.off(ev, fn);
    return this;
  }
  removeListener(ev: string, fn: (...a: unknown[]) => void): this {
    this.ev.off(ev, fn);
    return this;
  }
  getColorDepth(): number {
    return 24;
  }

  async settle(): Promise<void> {
    await this.chain;
    await new Promise<void>((r) => setTimeout(r, 0));
    await this.chain;
  }

  async resize(columns: number, rows = this.rows): Promise<void> {
    await this.settle();
    this.columns = columns;
    this.rows = rows;
    this.term.resize(columns, rows);
    this.ev.emit('resize');
    await new Promise<void>((r) => setTimeout(r, 40));
    await this.settle();
  }

  // --- đọc màn hình ---
  private line(i: number): string {
    return this.term.buffer.active.getLine(i)?.translateToString(true) ?? '';
  }
  /** Các dòng của khung nhìn hiện tại. */
  screen(): string[] {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.rows; i++) out.push(this.line(b.baseY + i));
    return out;
  }
  /** Toàn bộ buffer (scrollback + khung nhìn), bỏ dòng trống cuối. */
  all(): string[] {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(this.line(i));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  cursor(): { x: number; y: number } {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }
  /** Ô tại (x, y khung nhìn): chữ + cờ đảo/đậm. */
  cell(x: number, y: number): { ch: string; inverse: boolean; bold: boolean; fg: number; bg: number } {
    const b = this.term.buffer.active;
    const c = b.getLine(b.baseY + y)?.getCell(x);
    return { ch: c?.getChars() ?? '', inverse: !!c?.isInverse(), bold: !!c?.isBold(), fg: c?.getFgColor() ?? -1, bg: c?.getBgColor() ?? -1 };
  }
  text(): string {
    return this.all().join('\n');
  }
}

/** stdin giả. */
export class FakeIn extends EventEmitter {
  isTTY = true;
  raw = false;
  paused = true;
  setRawMode(m: boolean): this {
    this.raw = m;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  /** Gõ chuỗi thô. */
  type(s: string): void {
    this.emit('data', s);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
