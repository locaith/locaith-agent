/**
 * show_before_after (lane:customer-bugs) — đặt ảnh «Trước» và «Sau» của một thay đổi giao diện cạnh nhau trong khung chat.
 *
 * Công cụ KHÔNG tự chụp màn hình: model chụp bằng công cụ trình duyệt/Chrome/MCP có sẵn rồi lưu ảnh vào workspace hoặc thư mục tạm,
 * sau đó gọi công cụ này với hai đường dẫn. Ảnh đi tới giao diện qua `ToolResult.displayImages` → `tool_end.images` (đã có sẵn, Remote
 * thấy `imageCount` + `imageKeys`), và KHÔNG gửi lại cho model (không tốn token ảnh). Không thêm loại sự kiện/khối mới ⇒ bản cũ và trang Remote
 * cũ chỉ thấy dòng chữ «Trước: … → Sau: …» ở phần kết quả.
 *
 * An toàn: đường dẫn đi qua cùng bộ phân vùng/kiểm tra bí mật với read_file (ngoài workspace → hỏi; .env, khoá… → hỏi); chỉ nhận
 * PNG/JPEG/GIF/WebP, kiểm tra cả đuôi tệp lẫn chữ ký byte đầu (không đọc nhầm tệp khác đội lốt ảnh); trần kích thước phù hợp trần ảnh của giao diện.
 */
import * as path from 'node:path';
import type { ImageBlock } from '../types';
import type { PermissionNeed, ToolContext, ToolDef } from '../engine/types';
import { resolveUserPathReal } from '../fsutil/paths';
import { readPermission } from './fs';

/** Trần mỗi ảnh gửi lên giao diện: khớp `uiImages` ở dispatcher (base64 ≤ 3.000.000 ký tự ≈ 2,25 MB nhị phân). */
export const BEFORE_AFTER_MAX_BYTES = 2_250_000;
const LABEL_MAX = 40;
const CAPTION_MAX = 200;

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

interface Input {
  before: string;
  after: string;
  caption?: string;
  label_before?: string;
  label_after?: string;
}

/** Chữ ký byte đầu có khớp loại ảnh khai báo không. */
export function matchesImageSignature(bytes: Uint8Array, mediaType: string): boolean {
  const b = bytes;
  switch (mediaType) {
    case 'image/png':
      return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case 'image/jpeg':
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif':
      return b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
    case 'image/webp':
      return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    default:
      return false;
  }
}

/** Bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài — nhãn/chú thích do model đưa ra không được tin. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const showBeforeAfterTool: ToolDef<Input> = {
  name: 'show_before_after',
  description:
    'Show the user a BEFORE and AFTER image of a UI change side by side in the chat (a compare card they can zoom). ' +
    'Use it when you changed how a web page / app screen LOOKS (restyle, redesign, layout fix). First capture a "before" screenshot (browser tool, Chrome bridge, Playwright MCP… save it as an image file in the workspace or temp folder), ' +
    'make the change, capture an "after" screenshot of the SAME view and size, then call this tool with both image paths. Only PNG/JPEG/GIF/WebP, each up to about 2 MB. ' +
    'If no page can be captured, say so instead of faking an image. The images are NOT sent back to you; do not describe them as if you saw them unless you looked at them with another tool.',
  inputSchema: {
    type: 'object',
    properties: {
      before: { type: 'string', description: 'Path of the BEFORE image (workspace-relative or absolute).' },
      after: { type: 'string', description: 'Path of the AFTER image (same view and size as before).' },
      caption: { type: 'string', description: 'One short sentence about what changed (in the user\'s language).' },
      label_before: { type: 'string', description: 'Label for the before image (default "Trước"/"Before").' },
      label_after: { type: 'string', description: 'Label for the after image (default "Sau"/"After").' },
    },
    required: ['before', 'after'],
  },
  risk: 'read',
  concurrencySafe: true,
  hidden: true, // mở bằng kỹ năng ui-truoc-sau
  validate(input) {
    if (typeof input.before !== 'string' || !input.before.trim() || typeof input.after !== 'string' || !input.after.trim()) return 'Cần cả `before` và `after` (đường dẫn ảnh).';
    if (input.before.trim() === input.after.trim()) return '`before` và `after` đang là cùng một tệp: hãy chụp ảnh «sau» ra tệp khác.';
    return null;
  },
  async permission(input, ctx: ToolContext): Promise<PermissionNeed | null> {
    for (const p of [input.before, input.after]) {
      const need = readPermission(await resolveUserPathReal(ctx.host, p));
      if (need) return need;
    }
    return null;
  },
  async execute(input, ctx) {
    const images: ImageBlock[] = [];
    const rels: string[] = [];
    for (const [which, p] of [['trước', input.before], ['sau', input.after]] as const) {
      const r = await resolveUserPathReal(ctx.host, p);
      const mediaType = TYPES[path.extname(r.abs).toLowerCase()];
      if (!mediaType) return { content: `Ảnh «${which}» (${p}) không phải PNG/JPEG/GIF/WebP. Hãy lưu ảnh chụp thành .png hoặc .jpg.`, isError: true };
      const st = await ctx.host.stat(r.abs);
      if (!st || !st.isFile) return { content: `Không thấy ảnh «${which}»: ${p}. Hãy chụp và lưu ảnh trước rồi gọi lại.`, isError: true };
      if (st.size > BEFORE_AFTER_MAX_BYTES) {
        return { content: `Ảnh «${which}» (${p}) nặng ${(st.size / 1048576).toFixed(1)} MB, vượt trần ~2 MB của thẻ so sánh. Chụp vùng nhỏ hơn hoặc lưu .jpg rồi gọi lại.`, isError: true };
      }
      const bytes = await ctx.host.readBytes(r.abs);
      if (!matchesImageSignature(bytes, mediaType)) return { content: `Tệp «${which}» (${p}) không đúng định dạng ${mediaType} (nội dung không phải ảnh). Chụp và lưu lại.`, isError: true };
      images.push({ type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') });
      rels.push(r.rel);
    }
    const lb = cleanText(input.label_before, LABEL_MAX) || 'Trước';
    const la = cleanText(input.label_after, LABEL_MAX) || 'Sau';
    const caption = cleanText(input.caption, CAPTION_MAX);
    const line = `${lb}: ${rels[0]} → ${la}: ${rels[1]}`;
    return {
      content: `Đã hiển thị thẻ so sánh cho người dùng (${line})${caption ? `. Ghi chú: ${caption}` : ''}. Ảnh không gửi lại cho bạn; hãy tóm tắt thay đổi bằng lời, đừng mô tả chi tiết ảnh như thể bạn đã nhìn thấy.`,
      summary: '2 ảnh',
      display: line + (caption ? `\n${caption}` : ''),
      displayImages: images,
    };
  },
};
