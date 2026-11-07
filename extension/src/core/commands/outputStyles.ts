/**
 * Phong cách đầu ra (output style) — giống `/output-style` của Claude Code: một đoạn chỉ dẫn nhỏ về GIỌNG VĂN và CÁCH TRÌNH BÀY
 * được nối vào cuối system prompt. Dựng sẵn: default (không thêm gì), explanatory, learning, concise; người dùng thêm
 * `.locaith/output-styles/*.md` (dự án) hoặc `~/.locaith/output-styles/*.md` (cá nhân), frontmatter `name`, `description`.
 *
 * Phong cách KHÔNG được làm yếu hiến pháp: khối chèn vào luôn kèm câu nhắc rằng nó chỉ đổi giọng/định dạng, mọi quy tắc
 * kiểm chứng, an toàn, trung thực ở trên vẫn đứng trên nó. Dùng chung mọi bề mặt (không import 'vscode'/'node:*').
 */

import type { ToolHost } from '../engine/types';
import { parseSkillMarkdown, slugifyName } from '../skills/registry';

export interface OutputStyle {
  name: string;
  description: { vi: string; en: string };
  /** Chỉ dẫn cho model ('' = phong cách mặc định, không chèn gì). */
  prompt: string;
  source: 'builtin' | 'project' | 'user';
  file?: string;
}

/** Bản lưu trong phiên (JSON): đủ để dựng lại prompt mà không cần đọc đĩa. */
export interface SessionOutputStyle {
  name: string;
  prompt: string;
}

export const MAX_STYLE_PROMPT = 4000;

export function builtinOutputStyles(): OutputStyle[] {
  return [
    {
      name: 'default',
      description: { vi: 'Mặc định: làm việc gọn, báo cáo ngắn', en: 'Default: efficient work, short reports' },
      prompt: '',
      source: 'builtin',
    },
    {
      name: 'explanatory',
      description: { vi: 'Giải thích: kèm phần «Vì sao» ngắn về lựa chọn kỹ thuật', en: 'Explanatory: adds short “why” insights about choices' },
      prompt:
        'While you work, add brief educational insights about the codebase and your implementation choices. ' +
        'After a meaningful step, include a short "Insight" section (2-3 bullet points) explaining why you chose this approach, ' +
        'relevant patterns in this codebase, and trade-offs. Keep insights specific to the code at hand, not generic advice.',
      source: 'builtin',
    },
    {
      name: 'learning',
      description: { vi: 'Học cùng: để bạn tự viết vài đoạn nhỏ (đánh dấu TODO(human))', en: 'Learning: leaves small pieces for you to write (TODO(human))' },
      prompt:
        'Teach while you work. Explain your reasoning briefly, and for small, well-scoped pieces of logic that are good practice ' +
        '(about 2-10 lines) leave a clearly marked `TODO(human)` with precise guidance instead of writing them yourself, then stop and ask the user to fill them in. ' +
        'Never do this for boilerplate, for security-sensitive code, or when the user asked you to just get it done.',
      source: 'builtin',
    },
    {
      name: 'concise',
      description: { vi: 'Ngắn gọn: trả lời tối thiểu, không mở đầu/kết luận thừa', en: 'Concise: minimal answers, no preamble or recap' },
      prompt:
        'Be as concise as possible. No preamble, no recap of what you are about to do, no closing summary beyond the essential result. ' +
        'Prefer one-line answers when they are enough. Still report verification results and anything the user must know.',
      source: 'builtin',
    },
  ];
}

export function outputStyleFromMarkdown(text: string, fallbackName: string, source: 'project' | 'user', file?: string): OutputStyle | null {
  const { meta, body } = parseSkillMarkdown(text);
  const name = slugifyName(String(meta.name ?? fallbackName));
  if (!name || !body.trim()) return null;
  const desc = String(meta.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || name;
  return { name, description: { vi: desc, en: desc }, prompt: body.trim().slice(0, MAX_STYLE_PROMPT), source, ...(file ? { file } : {}) };
}

/** Nạp phong cách từ thư mục; trùng tên: dự án > cá nhân > dựng sẵn ('default' không bao giờ bị ghi đè). */
export async function loadOutputStyles(host: ToolHost, dirs: readonly { path: string; source: 'project' | 'user' }[]): Promise<OutputStyle[]> {
  const map = new Map<string, OutputStyle>();
  for (const s of builtinOutputStyles()) map.set(s.name, s);
  const rank = { builtin: 2, user: 1, project: 0 } as const;
  for (const d of dirs) {
    let entries;
    try {
      if (!(await host.stat(d.path))?.isDirectory) continue;
      entries = await host.readDir(d.path);
    } catch {
      continue;
    }
    for (const e of entries.slice(0, 100)) {
      if (e.isDirectory || !/\.md$/i.test(e.name)) continue;
      const file = `${d.path}${d.path.endsWith('/') || d.path.endsWith('\\') ? '' : d.path.includes('\\') && !d.path.includes('/') ? '\\' : '/'}${e.name}`;
      let text: string | null = null;
      try {
        text = await host.readText(file);
      } catch {
        continue;
      }
      const st = text == null ? null : outputStyleFromMarkdown(text, e.name.replace(/\.md$/i, ''), d.source, file);
      if (!st || st.name === 'default') continue;
      const prev = map.get(st.name);
      if (prev && rank[prev.source] < rank[st.source]) continue;
      map.set(st.name, st);
    }
  }
  return [...map.values()];
}

/** Khối chèn vào system prompt (null = không chèn: phong cách mặc định hoặc rỗng). */
export function outputStyleBlock(style: SessionOutputStyle | null | undefined): string | null {
  // Phiên cũ/JSON hỏng: chỉ tin khi đúng kiểu.
  const text = typeof style?.prompt === 'string' ? style.prompt.trim() : '';
  if (!style || !text || typeof style.name !== 'string' || style.name === 'default') return null;
  const name = style.name.replace(/[^\w.-]/g, '_').slice(0, 60);
  return (
    `<output_style name="${name}">\n${text.slice(0, MAX_STYLE_PROMPT)}\n</output_style>\n` +
    'The output style above only changes tone and formatting. It never relaxes the rules earlier in this prompt: ' +
    'verification before claiming done, safety, permissions and honesty still come first.'
  );
}
