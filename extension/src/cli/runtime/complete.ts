/**
 * Gợi ý `@tệp` và `/lệnh` cho ô nhập: liệt kê tệp nhanh (ưu tiên `git ls-files`, rơi về quét thư mục), đệm ~5 giây, chấm điểm mờ
 * (khớp theo tên tệp / đoạn đường dẫn, không phân biệt dấu).
 */

import { spawn } from 'node:child_process';
import type { SlashCommandInfo } from '../../shared/protocol';
import { walk } from '../../core/fsutil/walk';
import type { Completion } from './contract';

const TTL_MS = 5000;
const MAX_FILES = 5000;

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

/** `git ls-files` (tệp đã theo dõi + chưa theo dõi nhưng không bị ignore). null = không dùng được git. */
function gitFiles(cwd: string, timeoutMs = 3000): Promise<string[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* đã thoát */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size > 20_000_000) {
        try {
          child.kill();
        } catch {
          /* đã thoát */
        }
        return finish(null);
      }
      chunks.push(d);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      finish(
        Buffer.concat(chunks)
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
          .map((p) => p.replace(/\\/g, '/')),
      );
    });
  });
}

export class FileIndexer {
  private files: string[] = [];
  private dirs: string[] = [];
  private at = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly cwd: string) {}

  invalidate(): void {
    this.at = 0;
  }

  private async load(): Promise<void> {
    let files = await gitFiles(this.cwd);
    if (!files || files.length === 0) {
      files = [];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      try {
        for await (const e of walk({ root: this.cwd, signal: ctl.signal, maxEntries: MAX_FILES })) if (!e.isDir) files.push(e.rel);
      } catch {
        /* quét lỗi: dùng phần đã có */
      } finally {
        clearTimeout(timer);
      }
    }
    if (files.length > MAX_FILES) files = files.slice(0, MAX_FILES);
    const dirSet = new Set<string>();
    for (const rel of files) {
      const parts = rel.split('/').slice(0, -1);
      for (let i = 1; i <= Math.min(4, parts.length); i++) dirSet.add(parts.slice(0, i).join('/'));
    }
    this.files = files;
    this.dirs = [...dirSet].sort();
    this.at = Date.now();
  }

  private async ensure(): Promise<void> {
    if (this.at && Date.now() - this.at < TTL_MS) return;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  async search(query: string, limit = 20): Promise<Completion[]> {
    await this.ensure();
    const q = fold(query.trim().replace(/^@/, '').replace(/^["']|["']$/g, '').replace(/\\/g, '/'));
    const pool: Array<{ path: string; isDir: boolean }> = [...this.files.map((p) => ({ path: p, isDir: false })), ...this.dirs.map((p) => ({ path: p, isDir: true }))];
    const toCompletion = (e: { path: string; isDir: boolean }): Completion => {
      const shown = e.isDir ? `${e.path}/` : e.path;
      const needsQuote = /\s/.test(shown);
      return { label: shown, insert: needsQuote ? `@"${shown}" ` : `@${shown} `, ...(e.isDir ? { detail: 'thư mục' } : e.path.includes('/') ? { detail: e.path.slice(0, e.path.lastIndexOf('/')) } : {}) };
    };
    if (!q) {
      // Không gõ gì: tệp/thư mục ở gốc trước (nông trước sâu), rồi theo thứ tự chữ.
      return pool
        .filter((e) => !e.path.includes('/'))
        .sort((a, b) => Number(a.isDir) - Number(b.isDir) || a.path.localeCompare(b.path))
        .slice(0, limit)
        .map(toCompletion);
    }
    const scored: Array<{ e: { path: string; isDir: boolean }; score: number }> = [];
    for (const e of pool) {
      const full = fold(e.path);
      const slash = full.lastIndexOf('/');
      const name = slash >= 0 ? full.slice(slash + 1) : full;
      let score = 0;
      if (full === q) score = 120;
      else if (name === q) score = 100;
      else if (name.startsWith(q)) score = 85;
      else if (full.startsWith(q)) score = 80;
      else if (full.split('/').some((seg) => seg.startsWith(q))) score = 70;
      else if (name.includes(q)) score = 60;
      else if (full.includes(q)) score = 45;
      else {
        // Chuỗi con theo thứ tự (kiểu fuzzy): chấm thấp, phạt khoảng cách giữa các ký tự khớp.
        let qi = 0;
        let last = -1;
        let gaps = 0;
        for (let i = 0; i < full.length && qi < q.length; i++) {
          if (full[i] === q[qi]) {
            if (last >= 0) gaps += i - last - 1;
            last = i;
            qi++;
          }
        }
        if (qi === q.length) score = Math.max(5, 30 - Math.min(24, gaps / 2));
      }
      if (score <= 0) continue;
      // Ưu tiên đường dẫn ngắn/nông, và tệp hơn thư mục khi điểm bằng nhau.
      score -= Math.min(20, full.length / 12) + full.split('/').length * 0.5;
      if (e.isDir) score -= 1;
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.path.localeCompare(b.e.path));
    return scored.slice(0, limit).map((s) => toCompletion(s.e));
  }
}

/** Gợi ý lệnh gạch chéo: tiền tố trước, rồi chứa. */
export function completeSlash(query: string, cmds: readonly SlashCommandInfo[], limit = 20): Completion[] {
  const q = fold(query.trim().replace(/^\//, ''));
  const rows = cmds
    .map((c) => {
      const n = fold(c.name);
      const score = !q ? 50 : n === q ? 100 : n.startsWith(q) ? 80 : n.includes(q) ? 50 : fold(c.description).includes(q) ? 20 : 0;
      return { c, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return rows.slice(0, limit).map((r) => ({ label: `/${r.c.name}`, insert: `/${r.c.name} `, detail: r.c.description }));
}
