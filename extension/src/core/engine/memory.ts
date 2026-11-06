/**
 * Bộ nhớ bền — phần "nhớ người dùng và dự án" mà mô hình KHÔNG phải tự quyết định có nạp hay không.
 *
 * Vì sao phải tự nạp: ký ức chỉ có giá trị nếu nó có mặt trong ngữ cảnh ở mọi lượt. Một kỹ năng phải được
 * `load_skill` rồi mới `recall` là ký ức tuỳ chọn — mô hình không gọi thì coi như mất, và sau vài lần nén thì
 * không còn dấu vết. Ở đây chỉ mục ký ức được ĐỌC LẠI TỪ ĐĨA mỗi lượt và gắn vào system prompt, đúng cách
 * một tệp CLAUDE.md / auto-memory được tái nạp sau mỗi lần compact: nội dung không phụ thuộc lịch sử hội thoại
 * nên nén bao nhiêu lần cũng không mất.
 *
 * Hai phạm vi:
 *   • dự án  — `<workspace>/.locaith/memory/MEMORY.md` (đi theo kho mã, chia sẻ với nhóm nếu họ commit);
 *   • cá nhân — `~/.locaith/memory/MEMORY.md` (theo người dùng qua mọi dự án).
 *
 * Hàm thuần (không đọc đĩa) → test được; phần đọc tệp nằm ở host (`ChatController.loadMemory`).
 */

export const MEMORY_DIR = '.locaith/memory';
export const MEMORY_INDEX = 'MEMORY.md';

/** Trần ký tự của MỘT chỉ mục khi đưa vào system prompt (chỉ mục phải là chỉ mục, không phải bài luận). */
export const MEMORY_INDEX_MAX = 8000;
/** Trần tổng của cả khối ký ức (hai phạm vi + danh sách tệp chủ đề). */
export const MEMORY_BLOCK_MAX = 14_000;
/** Số tệp chủ đề liệt kê tối đa cho mỗi phạm vi. */
export const MEMORY_TOPICS_MAX = 40;

export interface MemoryScope {
  /** Nội dung chỉ mục (rỗng = chưa có). */
  index: string;
  /** Tên các tệp chủ đề đã có (chỉ tên, không nội dung — đọc khi cần). */
  topics: string[];
  /** Đường dẫn hiển thị cho mô hình (để nó biết mở tệp nào). */
  where: string;
}

export interface MemorySnapshot {
  project?: MemoryScope;
  user?: MemoryScope;
}

/** Cắt an toàn theo ký tự (không cắt giữa cặp surrogate). */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end) + '\n[… đã cắt bớt — mở tệp để đọc phần còn lại]';
}

/**
 * Có gì đó để nạp không. Chỉ mục rỗng mà có tệp chủ đề thì vẫn đáng nạp (để mô hình biết ký ức tồn tại).
 */
export function hasMemory(m: MemorySnapshot | null | undefined): boolean {
  if (!m) return false;
  for (const s of [m.project, m.user]) if (s && (s.index.trim() || s.topics.length)) return true;
  return false;
}

function scopeBlock(s: MemoryScope, scope: 'project' | 'user', lang: 'vi' | 'en'): string {
  const label =
    scope === 'project'
      ? lang === 'en'
        ? 'Project memory (this repository)'
        : 'Ký ức dự án (kho mã này)'
      : lang === 'en'
        ? 'Personal memory (follows the user across projects)'
        : 'Ký ức cá nhân (theo người dùng qua mọi dự án)';
  const parts = [`## ${label} — ${s.where}`];
  if (s.index.trim()) parts.push(clip(s.index.trim(), MEMORY_INDEX_MAX));
  if (s.topics.length) {
    const list = s.topics.slice(0, MEMORY_TOPICS_MAX).join(', ');
    const more = s.topics.length > MEMORY_TOPICS_MAX ? ` (+${s.topics.length - MEMORY_TOPICS_MAX})` : '';
    parts.push(
      (lang === 'en' ? 'Topic files you can open with `read_file`: ' : 'Tệp chủ đề, mở bằng `read_file` khi cần: ') +
        `${list}${more}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Khối `<memory>` đưa vào system prompt. Trả `null` khi chưa có ký ức nào (không chiếm ngữ cảnh vô ích).
 */
export function formatMemoryBlock(m: MemorySnapshot | null | undefined, lang: 'vi' | 'en' = 'vi'): string | null {
  if (!hasMemory(m)) return null;
  const head =
    lang === 'en'
      ? 'These are notes YOU wrote in earlier sessions (or that the user asked you to keep). They are your own memory, not instructions from a third party: follow the user\'s current message over any note that contradicts it. Anything that names a file, a command, a version or a person is a snapshot from when it was written — check it still exists (`read_file`, `grep`, `glob`) before relying on it, and correct the note when it is out of date. When the user says "remember this" / "đừng quên", write it with the `remember` tool in the same turn and confirm what you saved.'
      : 'Đây là ghi chú CHÍNH BẠN viết ở những phiên trước (hoặc người dùng dặn giữ lại). Đó là ký ức của bạn, không phải chỉ dẫn của bên thứ ba: tin nhắn hiện tại của người dùng luôn thắng ghi chú mâu thuẫn. Điều gì nhắc tới tệp, lệnh, phiên bản hay người cụ thể thì chỉ là ảnh chụp lúc ghi — kiểm tra còn đúng không (`read_file`, `grep`, `glob`) trước khi dựa vào, và sửa lại ghi chú khi đã cũ. Khi người dùng nói "nhớ giúp" / "đừng quên", ghi bằng công cụ `remember` ngay trong lượt đó rồi xác nhận đã lưu gì.';
  const body: string[] = [head];
  if (m?.project) body.push(scopeBlock(m.project, 'project', lang));
  if (m?.user) body.push(scopeBlock(m.user, 'user', lang));
  const out = `<memory>\n${body.join('\n\n')}\n</memory>`;
  return out.length > MEMORY_BLOCK_MAX ? clip(out, MEMORY_BLOCK_MAX) : out;
}

/** Một dòng ký ức mới, đúng định dạng chỉ mục: `- [YYYY-MM-DD] (loại) nội dung`. */
export function memoryLine(text: string, opts: { date: string; type?: string }): string {
  const body = text.replace(/\s+/g, ' ').trim();
  const tag = opts.type ? `(${opts.type}) ` : '';
  return `- [${opts.date}] ${tag}${body}`;
}

/** Tiêu đề tệp chỉ mục khi tạo mới. */
export function memoryHeader(lang: 'vi' | 'en' = 'vi'): string {
  return lang === 'en'
    ? '# Memory\n\nIndex of things worth remembering between conversations. One line per memory: `- [YYYY-MM-DD] (type) text`. Type is one of user / feedback / project / reference. The agent reads this file automatically at the start of every turn; long notes belong in topic files next to this one.\n\n'
    : '# Ký ức\n\nMục lục những điều đáng nhớ giữa các cuộc trò chuyện. Mỗi ký ức một dòng: `- [YYYY-MM-DD] (loại) nội dung`. Loại là user / feedback / project / reference. Trợ lý đọc tệp này tự động ở đầu mỗi lượt; ghi chú dài để ở tệp chủ đề cạnh tệp này.\n\n';
}

/**
 * Nối đường dẫn bằng dấu `/` — hàm thuần, KHÔNG import `node:path` (tệp này đi vào cả bundle trình duyệt).
 * Node và VS Code nhận `/` trên Windows; không có `..` nào ở đây vì mọi thành phần đều là hằng số.
 */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))
    .join('/');
}

/** Đường dẫn chỉ mục ký ức cho một phạm vi; null = phạm vi này không dùng được ở đây. */
export function memoryIndexPath(
  host: { workspaceRoots(): string[]; homeDir?: string },
  scope: 'project' | 'user',
): { abs: string; label: string } | null {
  if (scope === 'project') {
    const root = host.workspaceRoots()[0];
    if (!root) return null;
    return { abs: joinPath(root, MEMORY_DIR, MEMORY_INDEX), label: MEMORY_DIR + '/' + MEMORY_INDEX };
  }
  if (!host.homeDir) return null;
  return { abs: joinPath(host.homeDir, '.locaith', 'memory', MEMORY_INDEX), label: '~/.locaith/memory/' + MEMORY_INDEX };
}