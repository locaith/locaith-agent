import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileHit } from '../shared/protocol';

const EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,.nuxt,__pycache__,.venv,venv,target,.cache,coverage,.vscode-test}/**';
const TTL_MS = 30_000;

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

/** Chỉ mục tên tệp của workspace cho ô gợi ý @ (khớp không phân biệt dấu). */
export class FileIndex implements vscode.Disposable {
  private files: FileHit[] = [];
  private dirs: FileHit[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const invalidate = () => (this.loadedAt = 0);
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  private async ensure(): Promise<void> {
    if (Date.now() - this.loadedAt < TTL_MS && this.files.length > 0) return;
    if (!this.loading) {
      this.loading = (async () => {
        const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, 20_000);
        const files: FileHit[] = [];
        const dirSet = new Set<string>();
        for (const u of uris) {
          const rel = vscode.workspace.asRelativePath(u, false).split(path.sep).join('/');
          const name = rel.slice(rel.lastIndexOf('/') + 1);
          files.push({ path: rel, name, dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' });
          // Chỉ gom thư mục tới độ sâu 3 để danh sách gợi ý không phình to.
          const parts = rel.split('/').slice(0, -1);
          for (let i = 1; i <= Math.min(3, parts.length); i++) dirSet.add(parts.slice(0, i).join('/'));
        }
        this.files = files;
        this.dirs = [...dirSet].map((d) => ({ path: d, name: d.slice(d.lastIndexOf('/') + 1), dir: d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '', isDir: true }));
        this.loadedAt = Date.now();
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  async search(query: string, limit = 30): Promise<FileHit[]> {
    await this.ensure();
    const q = fold(query.trim());
    const pool = [...this.files, ...this.dirs];
    if (!q) return pool.slice(0, limit);
    const scored: { hit: FileHit; score: number }[] = [];
    for (const hit of pool) {
      const name = fold(hit.name);
      const full = fold(hit.path);
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (full.includes(q)) score = 40;
      else {
        // khớp từng ký tự theo thứ tự (kiểu fuzzy) trên đường dẫn
        let i = 0;
        for (const ch of full) if (ch === q[i]) i++;
        if (i === q.length) score = 20;
      }
      if (score > 0) scored.push({ hit, score: score - Math.min(15, hit.path.length / 20) + (hit.isDir ? 0 : 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.hit);
  }

  dispose(): void {
    this.watcher.dispose();
  }
}
