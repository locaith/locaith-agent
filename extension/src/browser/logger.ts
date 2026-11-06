import type { LogLevel } from '../core/types';
import { maskSecrets } from '../shared/maskSecrets';

const MAX_LINES = 500;

/** Nhật ký trong bộ nhớ (hiện ở Cài đặt → Nhật ký) + console. Mọi dòng đều được che khoá API. */
export class BrowserLogger {
  private readonly secrets = new Set<string>();
  private readonly buffer: string[] = [];
  private readonly listeners = new Set<() => void>();

  registerSecret(value: string | undefined): void {
    if (value && value.length >= 8) this.secrets.add(value);
  }

  log(level: LogLevel, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [${level.toUpperCase()}] ${maskSecrets(message, this.secrets)}`;
    this.buffer.push(line);
    if (this.buffer.length > MAX_LINES) this.buffer.splice(0, this.buffer.length - MAX_LINES);
    (level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.info)(`[ND] ${line}`);
    for (const l of this.listeners) l();
  }

  lines(): string[] {
    return [...this.buffer];
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
