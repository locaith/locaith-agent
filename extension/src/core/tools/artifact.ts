/**
 * Công cụ artifact (4C — Code/Artifact Writer). Ẩn cho tới khi kỹ năng `artifacts` được nạp.
 *
 * `list_artifact_types` trả về TÀI LIỆU ĐẶC TẢ (Documentation-as-Tool-Output): model đọc giới hạn của từng loại
 * ngay trong kết quả công cụ rồi tự cân nhắc chọn loại phù hợp nhất với dữ liệu thực tế.
 */

import { newId } from '../../shared/transcript';
import type { ArtifactRecord, ToolDef } from '../engine/types';

export const ARTIFACT_MAX_CHARS = 400_000;
export const ARTIFACT_TYPES = ['html', 'svg', 'markdown'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const CDN_ALLOWLIST = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];

const SPEC = `# Các loại artifact hiện có

| Loại | Phù hợp | Giới hạn |
|---|---|---|
| \`html\` | Bảng/biểu đồ tương tác, thanh điểm, bộ lọc, trang giới thiệu, công cụ tính nhỏ. HTML + CSS + JS thuần trong MỘT tệp. | Chạy trong iframe cô lập: không fetch/XHR/WebSocket, không localStorage/cookie, không ảnh từ internet. Script/style ngoài chỉ từ ${CDN_ALLOWLIST.join(', ')}. Tối đa ~${Math.round(ARTIFACT_MAX_CHARS / 1000)}K ký tự. |
| \`svg\` | Sơ đồ, biểu tượng, infographic tĩnh. | Chỉ vector; không script, không <foreignObject>; không ảnh/phông ngoài. |
| \`markdown\` | Báo cáo, tài liệu, hướng dẫn có tiêu đề/bảng/danh sách/khối mã. | Không tương tác; HTML thô bị lọc. |

Khung xem trước đã nạp sẵn font Be Vietnam Pro và JetBrains Mono. Dùng \`create_artifact\` để tạo, \`update_artifact\` để sửa.`;

export const listArtifactTypesTool: ToolDef<Record<string, never>> = {
  name: 'list_artifact_types',
  description: 'List the artifact types with their capabilities and hard limits. Call it before choosing a type.',
  inputSchema: { type: 'object', properties: {} },
  risk: 'meta',
  concurrencySafe: true,
  hidden: true,
  async execute() {
    return { content: SPEC, summary: ARTIFACT_TYPES.join(', ') };
  },
};

interface CreateInput {
  title: string;
  type: ArtifactType;
  content: string;
}

/** Giá trị của một thuộc tính trong chuỗi thẻ HTML (không phân biệt thứ tự, dấu nháy kép/đơn/không nháy). */
function tagAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

const EXTERNAL_URL = /^\s*(?:https?:)?\/\/([^/?#\s"'<>]+)/i;

/**
 * Tìm tài nguyên bên ngoài mà artifact không được phép tải. CSP của khung xem trước chặn phần lớn; hàm này báo trước cho model để nó sửa, và chặn thêm những thứ
 * CSP KHÔNG chặn được:
 *  - `<link rel="prerender|prefetch|preload|dns-prefetch|preconnect|modulepreload">` tới địa chỉ ngoài: trình duyệt Chromium vẫn gửi yêu cầu (NoStatePrefetch) dù
 *    `default-src 'none'` — đưa dữ liệu ra ngoài qua URL. Chỉ cho phép `<link rel="stylesheet">` tới CDN trong danh sách.
 *  - `<meta http-equiv="refresh">` tới địa chỉ ngoài.
 */
export function findBlockedResources(html: string): string[] {
  const bad = new Set<string>();
  for (const m of html.matchAll(/<(script|link|meta)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    if (name === 'script') {
      const host = EXTERNAL_URL.exec(tagAttr(tag, 'src') ?? '')?.[1]?.toLowerCase();
      if (host && !CDN_ALLOWLIST.includes(host)) bad.add(host);
    } else if (name === 'link') {
      const host = EXTERNAL_URL.exec(tagAttr(tag, 'href') ?? '')?.[1]?.toLowerCase();
      if (!host) continue;
      const rel = (tagAttr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (rel.length === 1 && rel[0] === 'stylesheet') {
        if (!CDN_ALLOWLIST.includes(host)) bad.add(host);
      } else {
        bad.add(`${host} (thẻ <link rel="${rel.join(' ') || '?'}"> không được phép — chỉ <link rel="stylesheet"> tới CDN cho phép)`);
      }
    } else if ((tagAttr(tag, 'http-equiv') ?? '').toLowerCase() === 'refresh') {
      const host = EXTERNAL_URL.exec(/url\s*=\s*['"]?([^'"]+)/i.exec(tagAttr(tag, 'content') ?? '')?.[1] ?? '')?.[1]?.toLowerCase();
      if (host) bad.add(`${host} (meta refresh tới địa chỉ ngoài)`);
    }
  }
  return [...bad];
}

function validateContent(type: string, content: string): string | null {
  if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) return `Loại "${type}" không hợp lệ. Dùng: ${ARTIFACT_TYPES.join(', ')}.`;
  if (!content.trim()) return 'Nội dung artifact đang trống.';
  if (content.length > ARTIFACT_MAX_CHARS) {
    return `Artifact quá lớn (${content.length.toLocaleString('en-US')} ký tự, tối đa ${ARTIFACT_MAX_CHARS.toLocaleString('en-US')}). Rút gọn dữ liệu nhúng hoặc chia nhỏ.`;
  }
  if (type === 'html') {
    const blocked = findBlockedResources(content);
    if (blocked.length) return `Không tải được tài nguyên từ: ${blocked.join(', ')}. Chỉ được dùng ${CDN_ALLOWLIST.join(', ')} hoặc viết nội tuyến.`;
  }
  if (type === 'svg' && !/<svg[\s>]/i.test(content)) return 'Nội dung SVG phải có thẻ <svg>.';
  // SVG chỉ là vector tĩnh. <foreignObject> cho phép nhét HTML thô (kể cả <link rel=prerender>, một đường rò dữ liệu mà CSP không chặn được) vào bên trong nó.
  if (type === 'svg' && /<\s*(?:foreignObject|script|link|meta|iframe|object|embed|base)\b/i.test(content)) {
    return 'SVG chỉ được chứa vector: không dùng <foreignObject>, <script>, <link>, <meta>, <iframe>, <object>, <embed>. Cần HTML/tương tác thì dùng loại html.';
  }
  return null;
}

export const createArtifactTool: ToolDef<CreateInput> = {
  name: 'create_artifact',
  description:
    'Create an artifact (html | svg | markdown) shown in a preview panel next to the chat. Provide the COMPLETE content in one call. ' +
    'Call list_artifact_types first to read the limits of each type.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title shown on the artifact card (user\'s language).' },
      type: { type: 'string', enum: [...ARTIFACT_TYPES] },
      content: { type: 'string', description: 'Full source: one self-contained HTML file, an SVG document, or Markdown.' },
    },
    required: ['title', 'type', 'content'],
  },
  risk: 'write', // chỉ ghi vào bộ nhớ phiên, không đụng đĩa → coi như meta khi xin phép
  planSafe: true,
  concurrencySafe: false,
  hidden: true,
  streamsContent: true,
  contentField: 'content',
  validate: (input) => validateContent(input.type, input.content),
  async execute(input, ctx) {
    const now = Date.now();
    const rec: ArtifactRecord = {
      id: newId('art'),
      title: input.title.trim() || 'Artifact',
      type: input.type,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    ctx.session.artifacts[rec.id] = rec;
    ctx.emit({ t: 'artifact', id: ctx.assistantId, state: 'ready', artifactId: rec.id, title: rec.title, artifactType: rec.type, sizeChars: rec.content.length });
    return {
      content: `Đã tạo artifact "${rec.title}" (id: ${rec.id}, loại ${rec.type}, ${rec.content.length.toLocaleString('en-US')} ký tự). Người dùng có thể mở xem trước ở khung bên cạnh. Dùng update_artifact với id này để chỉnh sửa.`,
      summary: rec.type,
      display: `${rec.title} — ${rec.type}`,
    };
  },
};

interface UpdateInput {
  artifact_id: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  content?: string;
}

export const updateArtifactTool: ToolDef<UpdateInput> = {
  name: 'update_artifact',
  description:
    'Modify an existing artifact: either replace an exact string (old_string → new_string, must be unique unless replace_all) or provide new full `content`. Prefer small replacements.',
  inputSchema: {
    type: 'object',
    properties: {
      artifact_id: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
      content: { type: 'string', description: 'Complete replacement content (alternative to old_string/new_string).' },
    },
    required: ['artifact_id'],
  },
  risk: 'write',
  planSafe: true,
  concurrencySafe: false,
  hidden: true,
  streamsContent: true,
  contentField: 'new_string',
  async execute(input, ctx) {
    const rec = ctx.session.artifacts[input.artifact_id];
    if (!rec) return { content: `Không có artifact id "${input.artifact_id}".`, isError: true };

    let next: string;
    if (typeof input.content === 'string') {
      next = input.content;
    } else if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      if (input.old_string === '') return { content: 'old_string rỗng.', isError: true };
      const parts = rec.content.split(input.old_string);
      const n = parts.length - 1;
      if (n === 0) return { content: 'Không tìm thấy old_string trong artifact. Phải khớp chính xác từng ký tự.', isError: true };
      if (n > 1 && !input.replace_all) return { content: `old_string xuất hiện ${n} lần. Thêm ngữ cảnh để duy nhất hoặc đặt replace_all=true.`, isError: true };
      next = input.replace_all ? parts.join(input.new_string) : parts[0] + input.new_string + parts.slice(1).join(input.old_string);
    } else {
      return { content: 'Cần cả old_string và new_string, hoặc content.', isError: true };
    }

    const problem = validateContent(rec.type, next);
    if (problem) return { content: problem, isError: true };
    rec.content = next;
    rec.updatedAt = Date.now();
    rec.version++;
    ctx.emit({ t: 'artifact', id: ctx.assistantId, state: 'ready', artifactId: rec.id, title: rec.title, artifactType: rec.type, sizeChars: next.length });
    return { content: `Đã cập nhật artifact "${rec.title}" (phiên bản ${rec.version}).`, summary: `v${rec.version}` };
  },
};
