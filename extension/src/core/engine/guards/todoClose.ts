/**
 * Tự đóng danh sách việc ở lần nhắc THỨ BA (B03/B10, lane:loop-guards).
 *
 * 41/68 lượt bị nhắc todo mà không gọi todo_write; một phiên bị nhắc 59 lần liền. Nhắc thêm không đổi được gì — đến lần thứ ba engine
 * tự đưa danh sách về đúng thực tế rồi THÔI: việc có BẰNG CHỨNG trong vết chạy (đã ghi tệp / chạy lệnh có tên khớp việc) → 'completed';
 * việc còn lại → 'blocked' kèm lý do, để người dùng thấy ngay và quyết định. Hàm thuần trên RunTrace.
 */

import type { TodoItem } from '../../../shared/protocol';
import { foldVi } from '../../skills/registry';
import type { RunTrace } from '../seams';
import { t, type Lang } from '../strings';

const STOP = new Set(['việc', 'viec', 'cho', 'của', 'cua', 'với', 'voi', 'các', 'cac', 'một', 'mot', 'file', 'tệp', 'tep', 'the', 'and', 'for', 'with', 'into', 'from', 'this', 'that']);

/**
 * Động từ chung (chạy/run, sửa/fix, viết/ghi/tạo, git, npm...) KHÔNG phải bằng chứng: `git status` không phải commit, `npm run build` không phải chạy test.
 * Bỏ chúng khỏi cả tên việc lẫn vết lệnh; chỉ khớp từ ĐẶC TRƯNG của việc (test, build, lint, commit...).
 */
const GENERIC = new Set(['chay', 'run', 'thu', 'sua', 'fix', 'edit', 'chinh', 'viet', 'write', 'ghi', 'tao', 'create', 'them', 'add', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'node', 'doc', 'dung', 'status', 'diff', 'log']);

/** Nhóm từ đồng nghĩa ĐẶC TRƯNG việc ↔ lệnh (tiếng Việt không dấu ↔ tiếng Anh). Không có nhóm động từ chung. */
const SYNONYMS: string[][] = [
  ['test', 'kiem thu', 'kiemthu', 'vitest', 'jest', 'pytest', 'spec'],
  ['build', 'bien dich', 'compile', 'esbuild', 'webpack', 'vite'],
  ['typecheck', 'kieu', 'tsc'],
  ['lint', 'eslint'],
  ['format', 'prettier'],
  ['cai', 'install'],
  ['readme', 'changelog', 'docs', 'tai lieu', 'huong dan'],
  ['kiem tra', 'verify', 'check'],
];

function tokens(s: string): string[] {
  return foldVi(s)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .flatMap((w) => w.split(/[./-]/))
    .filter((w) => w.length >= 3 && !STOP.has(w) && !GENERIC.has(w));
}

function expand(words: string[], phrase = ''): Set<string> {
  const out = new Set(words);
  // cụm nhiều từ ("kiểm thử", "tài liệu") không tách được thành từ đơn → khớp trên cả câu đã bỏ dấu
  if (phrase) for (const group of SYNONYMS) if (group.some((g) => g.includes(' ') && phrase.includes(g))) for (const g of group) out.add(g.replace(/\s+/g, ''));
  for (const w of words) for (const group of SYNONYMS) if (group.some((g) => g.replace(/\s+/g, '') === w || g === w)) for (const g of group) out.add(g.replace(/\s+/g, ''));
  return out;
}

/** Từ khoá bằng chứng: tên tệp đã ghi + lệnh đã chạy thành công (chỉ lệnh gọi `ok`). */
export function evidenceTokens(trace: RunTrace): Set<string> {
  const words: string[] = [];
  for (const c of trace.calls) {
    if (!c.ok) continue;
    if (c.risk === 'write') {
      const p = c.input?.path;
      if (typeof p === 'string') words.push(...tokens(p));
    } else if (c.risk === 'exec') {
      const cmd = c.input?.command;
      if (typeof cmd === 'string') {
        const head = cmd.slice(0, 300);
        // 'commit' chỉ là bằng chứng khi lệnh thật sự là `git commit` (không phải chữ "commit" nằm trong lệnh khác).
        const toks = tokens(head).filter((w) => w !== 'commit');
        if (/\bgit\s+(?:-\S+\s+)*commit\b/.test(head)) toks.push('commit');
        words.push(...toks);
      }
      const d = c.input?.description;
      if (typeof d === 'string') words.push(...tokens(d).filter((w) => w !== 'commit'));
    }
  }
  return expand(words);
}

/** Việc có vết làm xong? Cần ít nhất một từ có nghĩa của tên việc nằm trong vết. */
export function hasEvidence(title: string, evidence: ReadonlySet<string>): boolean {
  const words = expand(tokens(title), foldVi(title).toLowerCase());
  for (const w of words) if (evidence.has(w)) return true;
  return false;
}

export interface AutoCloseResult {
  todos: TodoItem[];
  completed: string[];
  blocked: string[];
}

/** Trả về danh sách mới (không sửa mảng đầu vào) và tên các việc đã đổi trạng thái. */
export function autoCloseTodos(todos: readonly TodoItem[], trace: RunTrace, lang: Lang): AutoCloseResult {
  const evidence = evidenceTokens(trace);
  const completed: string[] = [];
  const blocked: string[] = [];
  const next = todos.map((x): TodoItem => {
    if (x.status === 'completed' || x.status === 'blocked') return x;
    if (hasEvidence(x.title, evidence)) {
      completed.push(x.title);
      return { ...x, status: 'completed' };
    }
    blocked.push(x.title);
    return { ...x, status: 'blocked', note: t(lang, 'todoBlockedNoEvidence') };
  });
  return { todos: next, completed, blocked };
}
