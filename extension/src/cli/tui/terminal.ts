/**
 * Phiên terminal: raw mode, bracketed paste, hẹn giờ ESC đơn, khôi phục terminal khi thoát/crash/tín hiệu.
 * Khôi phục LUÔN đồng bộ và idempotent (hiện con trỏ, tắt bracketed paste, bỏ raw mode, reset kiểu).
 */

import { KeyParser, ctrlHMode, type CtrlHMode, type KeyEvent } from './keys';

export interface InStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(ev: 'data', fn: (d: string | Buffer) => void): unknown;
  off?(ev: 'data', fn: (d: string | Buffer) => void): unknown;
  removeListener?(ev: 'data', fn: (d: string | Buffer) => void): unknown;
}

export interface WriteStream {
  write(chunk: string): unknown;
}

export const BRACKETED_PASTE_ON = '\x1b[?2004h';
export const BRACKETED_PASTE_OFF = '\x1b[?2004l';
export const RESTORE_SEQ = '\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?2026l';

export interface SessionOptions {
  stdin: InStream;
  stdout: WriteStream;
  onEvent(e: KeyEvent): void;
  /** Gắn xử lý exit/tín hiệu/uncaught của process (chỉ khi dùng stdin/stdout THẬT). */
  processHandlers?: boolean;
  /** Tín hiệu SIGINT/SIGTERM/SIGHUP: trả true nếu đã xử lý (tự thoát êm); mặc định khôi phục rồi thoát. */
  onSignal?(sig: NodeJS.Signals): boolean | void;
  /** Lỗi không bắt được. */
  onCrash?(err: unknown): void;
  escTimeoutMs?: number;
  /** Cách hiểu byte 0x08. Mặc định: terminal THẬT (processHandlers) → đoán theo môi trường (conhost của Windows: Backspace thường); còn lại giữ 'ctrl-backspace'. */
  ctrlH?: CtrlHMode;
  /** Coi sẵn là terminal phân biệt Backspace (0x7f) với Ctrl+Backspace (0x08). Mặc định: chỉ khi người dùng ép LOCAITH_CTRL_H=ctrl-backspace (terminal thật). */
  strictCtrlH?: boolean;
}

export class TerminalSession {
  readonly parser: KeyParser;
  private active = false;
  private restored = true;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private dataHandler = (d: string | Buffer): void => this.onData(typeof d === 'string' ? d : d.toString('utf8'));
  private cleanups: Array<() => void> = [];

  constructor(private readonly o: SessionOptions) {
    const real = !!o.processHandlers;
    const strict = o.strictCtrlH ?? (real && (process.env.LOCAITH_CTRL_H ?? '').trim().toLowerCase() === 'ctrl-backspace');
    this.parser = new KeyParser({ ctrlH: o.ctrlH ?? (real ? ctrlHMode(process.env, process.platform) : 'ctrl-backspace'), deferCtrlH: true, ...(strict ? { strictCtrlH: true } : {}) });
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.restored = false;
    const { stdin, stdout } = this.o;
    try {
      if (stdin.isTTY) stdin.setRawMode?.(true);
    } catch {
      /* không đặt được raw mode (ví dụ ống) */
    }
    stdin.setEncoding?.('utf8');
    stdin.on('data', this.dataHandler);
    stdin.resume?.();
    stdout.write(BRACKETED_PASTE_ON + '\x1b[?25l');
    if (this.o.processHandlers) this.installProcessHandlers();
  }

  /** Khôi phục terminal (đồng bộ, gọi nhiều lần cũng an toàn). */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      this.o.stdout.write(RESTORE_SEQ);
    } catch {
      /* đóng rồi */
    }
    try {
      if (this.o.stdin.isTTY) this.o.stdin.setRawMode?.(false);
    } catch {
      /* bỏ qua */
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    const { stdin } = this.o;
    (stdin.off ?? stdin.removeListener)?.call(stdin, 'data', this.dataHandler);
    this.restore();
    try {
      stdin.pause?.();
    } catch {
      /* bỏ qua */
    }
    for (const c of this.cleanups.splice(0)) c();
  }

  /** Tạm dừng (Ctrl+Z): trả terminal về trạng thái thường. */
  suspend(): void {
    this.restore();
  }

  /** Quay lại sau SIGCONT. */
  resume(): void {
    if (!this.active) return;
    this.restored = false;
    try {
      if (this.o.stdin.isTTY) this.o.stdin.setRawMode?.(true);
    } catch {
      /* bỏ qua */
    }
    this.o.stdout.write(BRACKETED_PASTE_ON + '\x1b[?25l');
  }

  private onData(s: string): void {
    for (const e of this.parser.feed(s)) this.safeEmit(e);
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    if (this.parser.pending) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const e of this.parser.flush()) this.safeEmit(e);
      }, this.parser.pendingMs(this.o.escTimeoutMs ?? 30));
    }
  }

  private safeEmit(e: KeyEvent): void {
    try {
      this.o.onEvent(e);
    } catch (err) {
      try {
        this.o.onCrash?.(err);
      } catch {
        /* bỏ qua */
      }
    }
  }

  private installProcessHandlers(): void {
    const onExit = (): void => this.restore();
    process.on('exit', onExit);
    this.cleanups.push(() => process.off('exit', onExit));
    const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK' as NodeJS.Signals] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) {
      const h = (): void => {
        let handled = false;
        try {
          handled = !!this.o.onSignal?.(sig);
        } catch {
          handled = false;
        }
        if (handled) return;
        this.restore();
        process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129);
      };
      process.on(sig, h);
      this.cleanups.push(() => process.off(sig, h));
    }
    const onUncaught = (err: unknown): void => {
      this.restore();
      try {
        this.o.onCrash?.(err);
      } catch {
        /* bỏ qua */
      }
      try {
        process.stderr.write(`\nLocaith: lỗi không mong muốn: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      } catch {
        /* bỏ qua */
      }
      process.exit(1);
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    this.cleanups.push(() => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    });
    if (process.platform !== 'win32') {
      const onCont = (): void => this.resume();
      process.on('SIGCONT', onCont);
      this.cleanups.push(() => process.off('SIGCONT', onCont));
    }
  }
}
