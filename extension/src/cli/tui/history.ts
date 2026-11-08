/**
 * Lịch sử ô nhập: lưu `~/.locaith/history` (JSON mỗi dòng, 300 mục, quyền 600), duyệt ↑/↓ có giữ bản nháp, tìm ngược (Ctrl+R).
 * Mọi lỗi đĩa đều bị nuốt: mất lịch sử không được làm hỏng giao diện.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const HISTORY_MAX = 300;

export function defaultHistoryFile(home: string = os.homedir()): string {
  return path.join(home, '.locaith', 'history');
}

function parseLine(line: string): string | null {
  if (!line.trim()) return null;
  if (line.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(line);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  return line; // tương thích dạng thô
}

export class History {
  entries: string[] = [];
  private idx = -1;
  private draft = '';

  constructor(
    private readonly file: string | null,
    private readonly max = HISTORY_MAX,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      for (const l of raw.split(/\r?\n/)) {
        const e = parseLine(l);
        if (e !== null) this.entries.push(e);
      }
      if (this.entries.length > this.max) this.entries = this.entries.slice(-this.max);
    } catch {
      /* chưa có tệp */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data = this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        fs.writeFileSync(this.file, data, { mode: 0o600 });
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* bỏ qua */
        }
      }
    } catch {
      /* đĩa lỗi / không ghi được: bỏ qua */
    }
  }

  add(text: string): void {
    const t = text.replace(/\s+$/, '');
    this.resetNav();
    if (!t.trim()) return;
    if (this.entries[this.entries.length - 1] === t) return;
    this.entries.push(t);
    if (this.entries.length > this.max) this.entries = this.entries.slice(-this.max);
    this.save();
  }

  resetNav(): void {
    this.idx = -1;
    this.draft = '';
  }

  /** ↑: mục cũ hơn (lần đầu ghi nhớ bản nháp hiện tại). undefined = hết. */
  prev(current: string): string | undefined {
    if (!this.entries.length) return undefined;
    if (this.idx === -1) {
      this.draft = current;
      this.idx = this.entries.length - 1;
    } else if (this.idx > 0) this.idx--;
    else return undefined;
    return this.entries[this.idx];
  }

  /** ↓: mục mới hơn; qua mục mới nhất thì trả bản nháp. */
  next(): string | undefined {
    if (this.idx === -1) return undefined;
    if (this.idx < this.entries.length - 1) {
      this.idx++;
      return this.entries[this.idx];
    }
    this.idx = -1;
    const d = this.draft;
    this.draft = '';
    return d;
  }

  get navigating(): boolean {
    return this.idx !== -1;
  }

  /** Tìm ngược: trả chỉ số mục (từ `from` lùi về 0) chứa `query` (không phân biệt hoa thường); -1 nếu không có. */
  search(query: string, from: number = this.entries.length - 1): number {
    if (!query) return -1;
    const q = query.toLowerCase();
    for (let i = Math.min(from, this.entries.length - 1); i >= 0; i--) if (this.entries[i].toLowerCase().includes(q)) return i;
    return -1;
  }
}
