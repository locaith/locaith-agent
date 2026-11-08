/**
 * Tiện ích nhỏ dùng chung trong lõi chạy CLI: ghi tệp nguyên tử, đọc JSON an toàn, chuẩn hoá đường dẫn, nhật ký (có che khoá).
 * Không import `vscode`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Đọc JSON; thiếu/hỏng → undefined (không ném). */
export function readJsonFile<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Đọc JSON và cho biết tệp có tồn tại nhưng hỏng không. */
export function readJsonDetailed(file: string): { exists: boolean; value?: unknown; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { exists: false };
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (!raw.trim()) return { exists: true, value: {} };
  try {
    return { exists: true, value: JSON.parse(raw) };
  } catch (err) {
    return { exists: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Đổi tên đè lên đích; Windows đôi khi báo EPERM/EBUSY (diệt virus giữ tệp) nên thử lại vài lần. */
export function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      const until = Date.now() + 15 * (i + 1);
      while (Date.now() < until) {
        /* chờ ngắn, đồng bộ */
      }
    }
  }
  throw lastErr;
}

/** Ghi nguyên tử (tệp tạm + đổi tên). `mode` 0o600 cho tệp chứa khoá/phiên. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, ...(mode !== undefined ? { mode: 0o700 } : {}) });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* dọn tệp tạm không được thì thôi */
    }
    throw err;
  }
}

export async function writeFileAtomicAsync(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, ...(mode !== undefined ? { mode: 0o700 } : {}) });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, mode !== undefined ? { mode } : undefined);
    let lastErr: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        await new Promise((r) => setTimeout(r, 15 * (i + 1)));
      }
    }
    throw lastErr;
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Khoá so sánh đường dẫn: tuyệt đối, bỏ dấu `/` cuối, không phân biệt hoa/thường trên Windows/macOS. */
export function pathKey(p: string): string {
  let r = path.resolve(p);
  if (r.length > 1 && /[\\/]$/.test(r) && !/^[A-Za-z]:[\\/]$/.test(r)) r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Nhật ký ra tệp `~/.locaith/logs/cli.log` (xoay vòng 1 MB) + vòng đệm trong bộ nhớ cho /doctor.
 * Không bao giờ in ra terminal (sẽ làm hỏng giao diện) và che mọi khoá đã đăng ký.
 */
export class RuntimeLogger {
  private readonly secrets = new Set<string>();
  private readonly ring: string[] = [];
  private fileOk = true;

  constructor(
    private readonly file: string | null,
    private readonly debug: boolean,
  ) {}

  registerSecret(s: string | undefined): void {
    if (s && s.length >= 8) this.secrets.add(s);
  }

  private mask(msg: string): string {
    let out = msg;
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join('***');
    return out.replace(/\blat_[A-Za-z0-9_-]{20,}/g, 'lat_***').replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, 'sk-***');
  }

  log(level: LogLevel, message: string): void {
    if (level === 'debug' && !this.debug) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${this.mask(String(message)).replace(/\r?\n/g, ' ⏎ ').slice(0, 2000)}`;
    this.ring.push(line);
    if (this.ring.length > 200) this.ring.splice(0, this.ring.length - 200);
    if (!this.file || !this.fileOk) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size > 1_000_000) {
          fs.rmSync(`${this.file}.1`, { force: true });
          fs.renameSync(this.file, `${this.file}.1`);
        }
      } catch {
        /* chưa có tệp */
      }
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch {
      this.fileOk = false;
    }
  }

  recent(n = 30): string[] {
    return this.ring.slice(-n);
  }

  get path(): string | null {
    return this.file;
  }
}
