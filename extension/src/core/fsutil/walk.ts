/**
 * Duyệt cây thư mục có bỏ qua thư mục nặng (node_modules, .git…) và theo `.gitignore` ở thư mục gốc.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globToRegExp } from './glob';

export const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.gradle',
  '.idea',
  'coverage',
  '.vscode-test',
]);

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export class GitIgnore {
  private readonly rules: IgnoreRule[] = [];

  static async load(root: string): Promise<GitIgnore> {
    const gi = new GitIgnore();
    try {
      const text = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8');
      gi.parse(text);
    } catch {
      /* không có .gitignore */
    }
    return gi;
  }

  parse(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }
      let dirOnly = false;
      if (line.endsWith('/')) {
        dirOnly = true;
        line = line.slice(0, -1);
      }
      const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
      line = line.replace(/^\//, '');
      if (!line) continue;
      try {
        const body = globToRegExp(line).source.slice(1, -1); // bỏ ^ và $
        // Không neo: khớp ở mọi độ sâu. Có neo: khớp từ gốc. Luôn cho phép khớp cả thư mục cha (…/x/**).
        const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`, 'i');
        this.rules.push({ re, negate, dirOnly });
      } catch {
        /* bỏ qua mẫu hỏng */
      }
    }
  }

  /**
   * Thư mục bị bỏ qua thì cả cây bên dưới bị cắt ngay khi duyệt (như git), nên mẫu "chỉ thư mục"
   * (`build/`) chỉ cần so với thư mục.
   */
  ignored(rel: string, isDir: boolean): boolean {
    if (rel.length > 2048) return false; // đường dẫn dài bất thường: không đem so khớp (chi phí backtrack)
    let result = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) result = !r.negate;
    }
    return result;
  }
}

export interface WalkEntry {
  abs: string;
  /** Tương đối theo gốc, dấu '/'. */
  rel: string;
  isDir: boolean;
}

export interface WalkOptions {
  root: string;
  signal: AbortSignal;
  maxEntries?: number;
  useGitignore?: boolean;
  ignoreDirs?: Set<string>;
  includeDirs?: boolean;
  maxDepth?: number;
}

export async function* walk(opts: WalkOptions): AsyncGenerator<WalkEntry, void, void> {
  const { root, signal } = opts;
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const gi = opts.useGitignore === false ? new GitIgnore() : await GitIgnore.load(root);
  let count = 0;
  const max = opts.maxEntries ?? 50_000;
  const maxDepth = opts.maxDepth ?? 64;

  async function* rec(dir: string, relDir: string, depth: number): AsyncGenerator<WalkEntry, void, void> {
    if (signal.aborted || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (signal.aborted || count >= max) return;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // tránh vòng lặp và thoát ra ngoài
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name) || gi.ignored(rel, true)) continue;
        if (opts.includeDirs) {
          count++;
          yield { abs, rel, isDir: true };
        }
        yield* rec(abs, rel, depth + 1);
      } else if (e.isFile()) {
        if (gi.ignored(rel, false)) continue;
        count++;
        yield { abs, rel, isDir: false };
      }
    }
  }

  yield* rec(root, '', 0);
}
