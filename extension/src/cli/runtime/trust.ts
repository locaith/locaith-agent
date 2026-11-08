/**
 * Tin cậy thư mục (`~/.locaith/trusted.json`).
 *
 * Chưa tin cậy ⇒ cài đặt của DỰÁN (`.locaith/settings.json`, `settings.local.json`) chỉ được SIẾT CHẶT (luật ask/deny);
 * hooks, MCP, lệnh tuỳ chỉnh của dự án và luật allow của dự án không chạy. Thư mục con thừa hưởng tin cậy của thư mục cha.
 */

import * as path from 'node:path';
import { pathKey, readJsonFile, writeFileAtomic } from './util';

interface TrustFile {
  version: 1;
  trusted: string[];
}

export function trustFile(home: string): string {
  return path.join(home, '.locaith', 'trusted.json');
}

function readTrusted(home: string): string[] {
  const j = readJsonFile<Partial<TrustFile>>(trustFile(home));
  return Array.isArray(j?.trusted) ? j!.trusted!.filter((x): x is string => typeof x === 'string') : [];
}

/** Thư mục (hoặc một thư mục cha của nó) đã được tin cậy? */
export function isDirTrusted(home: string, dir: string): boolean {
  const key = pathKey(dir);
  const homeKey = pathKey(home);
  for (const t of readTrusted(home)) {
    const tk = pathKey(t);
    // Không bao giờ coi cả thư mục «nhà» hay gốc ổ đĩa là đã tin cậy chỉ vì nó nằm trong danh sách cũ.
    if (key === tk) return true;
    if (tk === homeKey || path.parse(tk).root.toLowerCase() === tk.toLowerCase()) continue;
    const sep = path.sep;
    if (key.startsWith(tk.endsWith(sep) ? tk : tk + sep)) return true;
  }
  return false;
}

export function trustDir(home: string, dir: string): void {
  const list = readTrusted(home);
  const abs = path.resolve(dir);
  if (list.some((t) => pathKey(t) === pathKey(abs))) return;
  writeFileAtomic(trustFile(home), JSON.stringify({ version: 1, trusted: [...list, abs] } satisfies TrustFile, null, 2) + '\n', 0o600);
}

export function untrustDir(home: string, dir: string): void {
  const list = readTrusted(home);
  const next = list.filter((t) => pathKey(t) !== pathKey(dir));
  if (next.length === list.length) return;
  writeFileAtomic(trustFile(home), JSON.stringify({ version: 1, trusted: next } satisfies TrustFile, null, 2) + '\n', 0o600);
}
