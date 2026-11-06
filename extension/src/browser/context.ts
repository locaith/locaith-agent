/**
 * Dựng nội dung tin nhắn người dùng gửi cho model (bản trình duyệt): văn bản + ảnh dán vào + nội dung các tab đính kèm +
 * `<browser_context>` mô tả tab đang xem. Thông tin hay đổi như tab hiện tại KHÔNG nằm trong system prompt (giữ prompt-cache).
 */

import type { ContentBlock, ImageBlock } from '../core/types';
import { buildDocParts } from '../shared/docWrap';
import type { AttachmentInfo } from '../shared/protocol';
import type { BrowserApi, TabLite } from './api';
import { hostOf, safeInline, safeUrl, wrapPage } from './tools/policy';

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TAB_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_SELECTION = 4_000;
/** Ngân sách chữ cho các tệp tải lên của một tin nhắn khi bên gọi không nêu (theo cửa sổ ngữ cảnh: xem docCharBudget). */
const DEFAULT_DOC_BUDGET = 200_000;

export interface BuildInput {
  text: string;
  attachments: AttachmentInfo[];
  api: BrowserApi;
  browserName: string;
  /** Gửi kèm tiêu đề + URL + đoạn bôi đen của tab đang xem. */
  attachTabContext: boolean;
  /** Tab trợ lý làm việc trong lượt này (tab đã gắn). Bỏ trống = tab đang xem lúc gửi. */
  anchor?: TabLite | null;
  /** Số ký tự tối đa cho chữ của TẤT CẢ tệp tải lên trong tin nhắn này. */
  docBudget?: number;
}

export interface BuiltBrowserContent {
  content: ContentBlock[];
  display: AttachmentInfo[];
  warnings: string[];
  /** Tab người dùng đang xem lúc gửi (nếu xác định được). */
  anchor: TabLite | null;
}

/** Tiêu đề do trang đặt → dọn xuống một dòng, bỏ ký tự ẩn và thẻ giả, cắt ngắn. */
export function cleanTitle(title: string, max = 120): string {
  return safeInline(title, max).replace(/"/g, "'");
}

export async function buildBrowserUserContent(inp: BuildInput): Promise<BuiltBrowserContent> {
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  const display: AttachmentInfo[] = [];
  const warnings: string[] = [];
  let budget = MAX_TOTAL_CHARS;

  const anchor = inp.anchor !== undefined ? inp.anchor : await inp.api.activeTab().catch(() => null);

  for (const a of inp.attachments) {
    if (a.kind === 'image') {
      if (!a.data || images.length >= MAX_IMAGES) {
        warnings.push(`Bỏ qua ảnh "${a.label}" (quá nhiều ảnh hoặc không có dữ liệu).`);
        continue;
      }
      if (Math.floor((a.data.length * 3) / 4) > MAX_IMAGE_BYTES) {
        warnings.push(`Bỏ qua ảnh "${a.label}" vì lớn hơn 5 MB.`);
        continue;
      }
      images.push({ type: 'image', mediaType: a.mediaType || 'image/png', data: a.data });
      display.push({ ...a, data: undefined });
      continue;
    }
    if (a.kind === 'tab') {
      const id = Number(/^tab:(\d+)$/.exec(a.path ?? '')?.[1]);
      if (!Number.isFinite(id)) continue;
      const tab = await inp.api.getTab(id);
      if (!tab) {
        warnings.push(`Tab "${a.label}" không còn.`);
        continue;
      }
      // Người dùng chủ động đính kèm tab này → đó là sự đồng ý cho lần đọc này.
      const res = await inp.api.callRuntime(id, 'read', { maxChars: MAX_TAB_CHARS });
      if (!res.ok || res.value?.ok === false) {
        warnings.push(`Không đọc được tab "${a.label}": ${res.ok ? res.value.message : res.message}`);
        continue;
      }
      const v = res.value;
      if (budget - v.text.length < 0) {
        warnings.push(`Bỏ qua tab "${a.label}": vượt giới hạn tổng dung lượng đính kèm.`);
        continue;
      }
      budget -= v.text.length;
      const more = v.totalChars > v.end ? `\n[… đã cắt, trang dài ${v.totalChars.toLocaleString('en-US')} ký tự; dùng page_read với start=${v.end} để đọc tiếp]` : '';
      parts.push(`<attached_tab id="${id}">\n${wrapPage(v.url, v.title, v.text)}${more}\n</attached_tab>`);
      display.push({ ...a, data: undefined });
      continue;
    }
  }

  // Tệp người dùng tải lên (PDF, Word, Excel, HTML, CSV, TXT): chữ đã được đọc sẵn ở bước chọn tệp, ở đây chỉ bọc khung dữ liệu và tính ngân sách chung.
  const docs = buildDocParts(inp.attachments, inp.docBudget ?? DEFAULT_DOC_BUDGET);
  parts.push(...docs.parts);
  display.push(...docs.display);
  warnings.push(...docs.warnings);

  const head = [await browserContextBlock(inp.api, inp.browserName, inp.attachTabContext, anchor), ...parts];
  const text = `${head.join('\n\n')}\n\n${inp.text}`;
  const content: ContentBlock[] = [...images, { type: 'text', text }];
  return { content, display, warnings, anchor };
}

/** Khối `<browser_context>`: trình duyệt nào, tab nào đang xem, đã có quyền đọc chưa, đoạn nào đang bôi đen. */
export async function browserContextBlock(api: BrowserApi, browserName: string, attachTabContext: boolean, anchor: TabLite | null): Promise<string> {
  const ctx: string[] = [`Browser: ${browserName}`];
  if (attachTabContext && anchor && !anchor.url) {
    // Không có quyền `tabs` / quyền truy cập trang thì trình duyệt giấu cả địa chỉ lẫn tiêu đề: nói thẳng là chưa biết, đừng bịa một tab rỗng.
    ctx.push(`Active tab: [${anchor.id}] — address and title unknown: the extension has no access to this tab yet (tell the user to click the extension icon while on that tab, or enable Settings → Site access, if you need to read it)`);
  } else if (attachTabContext && anchor) {
    // Tab đã gắn mà người dùng đang xem tab khác (đổi tab/cửa sổ để sao chép, tra cứu): KHÔNG nêu tab họ đang xem — chỉ nói tab bạn đang làm việc.
    ctx.push(
      anchor.active
        ? `Active tab (what the user is looking at): [${anchor.id}] "${cleanTitle(anchor.title)}" — ${safeUrl(anchor.url)}`
        : `Attached tab (the page you are working on; the user is viewing a different tab right now — stay on this tab): [${anchor.id}] "${cleanTitle(anchor.title)}" — ${safeUrl(anchor.url)}`,
    );
    if (/^https?:/i.test(anchor.url)) {
      // Thăm dò nhẹ: đọc được tab này không, và có đoạn bôi đen không.
      const sel = await api.callRuntime(anchor.id, 'selection').catch(() => null);
      if (sel && sel.ok) {
        ctx.push('Page access: granted');
        const text = sel.value?.text as string | undefined;
        // Đoạn bôi đen là chữ của trang (đã lọc phần ẩn) → nằm trong khung dữ liệu không đáng tin.
        if (text && text.length <= MAX_SELECTION) ctx.push(`Text the user selected on the page:\n${wrapPage(anchor.url, anchor.title, text)}`);
      } else if (sel && !sel.ok && (sel.code === 'no_access' || sel.code === 'restricted' || sel.code === 'no_runtime')) {
        ctx.push(`Page access: NOT granted for ${hostOf(anchor.url)} (tell the user to enable Settings → Site access, or click the extension icon on this tab, if you need to read it)`);
      } else {
        // Trang đang tải / chuyển đi / bận: chưa biết, không có nghĩa là bị cấm.
        ctx.push('Page access: unknown right now (the page is loading or busy) — try page_read');
      }
    } else {
      ctx.push('Page access: not available (browser internal page)');
    }
  } else if (attachTabContext) {
    ctx.push('Active tab: unknown (no regular tab in this window)');
  }
  return `<browser_context>\n${ctx.join('\n')}\n</browser_context>`;
}

const CONTEXT_RE = /<browser_context>[\s\S]*?<\/browser_context>/;

/** Thay khối `<browser_context>` cũ trong nội dung một tin nhắn bằng khối mới (chạy lại tin nhắn cũ: tab đang xem lúc này có thể khác lúc trước). */
export function withFreshContext(content: ContentBlock[], block: string): ContentBlock[] {
  return content.map((b) => (b.type === 'text' && CONTEXT_RE.test(b.text) ? { ...b, text: b.text.replace(CONTEXT_RE, () => block) } : b));
}
