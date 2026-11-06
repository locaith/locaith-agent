/**
 * Tiện ích chuỗi thuần túy (không phụ thuộc DOM) — được test bằng vitest.
 * Trọng tâm: so khớp không phân biệt dấu tiếng Việt, phân tích đường dẫn, trigger @ và /.
 */

/** Bỏ dấu + hạ chữ thường: "Tài liệu Đặng" → "tai lieu dang". */
export function normalizeVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function tokenScore(token: string, hay: string): number | null {
  if (hay === token) return 1000;
  if (hay.startsWith(token)) return 800 - Math.min(hay.length - token.length, 200);
  const idx = hay.indexOf(token);
  if (idx > 0) {
    const prev = hay[idx - 1];
    const wordStart = !/[a-z0-9]/.test(prev);
    return (wordStart ? 600 : 400) - Math.min(idx, 200);
  }
  // Dãy con (các ký tự xuất hiện theo thứ tự): "mdl" khớp "model".
  let h = 0;
  let gaps = 0;
  for (let i = 0; i < token.length; i++) {
    const found = hay.indexOf(token[i], h);
    if (found < 0) return null;
    gaps += found - h;
    h = found + 1;
  }
  return 100 - Math.min(gaps, 90);
}

/** Điểm khớp (cao hơn = tốt hơn), null nếu không khớp. Không phân biệt dấu. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalizeVi(query).trim();
  if (!q) return 0;
  const hay = normalizeVi(text);
  const tokens = q.split(/\s+/);
  let total = 0;
  for (const tk of tokens) {
    const s = tokenScore(tk, hay);
    if (s === null) return null;
    total += s;
  }
  return Math.round(total / tokens.length);
}

/** Lọc + xếp hạng theo điểm khớp; giữ thứ tự gốc khi bằng điểm. Query rỗng → giữ nguyên. */
export function filterByQuery<T>(items: readonly T[], query: string, fields: (item: T) => string | string[]): T[] {
  if (!query.trim()) return items.slice();
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const f = fields(item);
    const list = Array.isArray(f) ? f : [f];
    let best: number | null = null;
    for (const text of list) {
      const s = fuzzyScore(query, text);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}

// ─────────────────────────────────────────────────────────────────────────────
// Đường dẫn & URL
// ─────────────────────────────────────────────────────────────────────────────

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

export function dirname(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i > 0 ? clean.slice(0, i) : '';
}

/** Hostname gọn của URL ("https://www.artificialanalysis.ai/x" → "artificialanalysis.ai"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || url;
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|css|scss|less|html|htm|vue|svelte|go|rs|java|kt|c|h|cpp|hpp|cs|php|rb|sh|ps1|bat|cmd|yml|yaml|toml|ini|txt|sql|xml|svg|csv|env|lock|gradle|swift|dart|lua|ipynb|dockerfile';
const FILE_RE = new RegExp(
  `^(?:\\./|\\.\\./|/|[A-Za-z]:[\\\\/])?(?:[\\p{L}\\p{N}_@.+~-]+[\\\\/])*[\\p{L}\\p{N}_@.+~-]+\\.(?:${FILE_EXT})(?::(\\d+)(?::(\\d+))?|#L(\\d+)(?:-L?(\\d+))?)?$`,
  'iu',
);

/** `src/app.ts:12` → { path: 'src/app.ts', line: 12 }; không giống đường dẫn tệp → null. */
export function parseFileRef(text: string): { path: string; line?: number } | null {
  const s = text.trim();
  if (!s || s.length > 260 || /\s/.test(s) || s.includes('://')) return null;
  const m = FILE_RE.exec(s);
  if (!m) return null;
  const line = m[1] ?? m[3];
  const path = s.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  return line ? { path, line: Number(line) } : { path };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger trong ô nhập
// ─────────────────────────────────────────────────────────────────────────────

/** `@` ở đầu từ tại vị trí con trỏ → { start, end, query }. `end` kéo tới hết từ để thay thế trọn vẹn. */
export function mentionAtCaret(text: string, caret: number): { start: number; end: number; query: string } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const upto = text.slice(start, caret);
  if (!upto.startsWith('@')) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end, query: upto.slice(1) };
}

/** Tin nhắn bắt đầu bằng `/lệnh` và con trỏ còn nằm trong từ đầu tiên → { query }. */
export function slashAtCaret(text: string, caret: number): { query: string } | null {
  const lead = text.length - text.trimStart().length;
  if (text[lead] !== '/' || caret <= lead) return null;
  const upto = text.slice(lead + 1, caret);
  if (/\s/.test(upto)) return null;
  return { query: upto };
}

/** "/model gpt-6-astra" → { command: 'model', args: 'gpt-6-astra' } nếu `model` là lệnh đã biết. */
export function parseSlashCommand(
  text: string,
  known: readonly { name: string }[],
): { command: string; args: string } | null {
  const m = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const hit = known.find((k) => k.name.replace(/^\//, '').toLowerCase() === name);
  return hit ? { command: hit.name.replace(/^\//, ''), args: (m[2] ?? '').trim() } : null;
}

/** Lệnh cần thêm đối số: chọn từ menu chỉ chèn "/lệnh " để người dùng gõ tiếp. */
export const SLASH_COMMANDS_WITH_ARGS = new Set(['model', 'mode', 'thinking', 'rename']);

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Chuẩn hoá URI kéo-thả từ Explorer của VS Code thành đường dẫn tương đối theo workspace. */
export function relativizeUri(uri: string, folders: readonly string[]): string | null {
  let p = uri.trim();
  if (!p || p.startsWith('#')) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = norm(p);
  for (const f of folders) {
    const folder = norm(f);
    if (target.toLowerCase() === folder.toLowerCase()) return '.';
    if (target.toLowerCase().startsWith(folder.toLowerCase() + '/')) return target.slice(folder.length + 1);
  }
  return null;
}
