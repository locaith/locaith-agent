/**
 * Kho kết nối MCP. Mỗi địa chỉ từ xa dưới đây đã được THĂM DÒ THẬT ngày 2026-11-03 bằng yêu cầu `initialize` (không phải đoán):
 *   • 200 + serverInfo  → server mở, không cần đăng nhập (`auth: 'none'`);
 *   • 401 + `resource_metadata` + metadata OAuth đọc được + có đăng ký ứng dụng tự động (DCR) + PKCE S256 → `auth: 'oauth'` (đăng nhập một chạm);
 *   • DCR không có (Slack, Asana) hoặc dùng giao thức SSE cũ (Square) → `unsupported` (hiện thẻ mờ kèm lý do, không giả vờ chạy được).
 * Địa chỉ không trả lời hoặc không đọc được metadata (Pulumi, Atlassian, Zapier) KHÔNG có trong danh sách.
 */

import type { McpServerConfig } from './client';

export type McpCategory = 'dev' | 'pm' | 'data' | 'docs' | 'pay' | 'design' | 'comm' | 'search' | 'browser' | 'memory' | 'files';
export type McpAuthKind = 'none' | 'oauth' | 'github' | 'local';

export const CATALOG_VERIFIED_ON = '2026-11-03';
/** Tên server MCP của Bio-Memory-Locaith (cũng là khoá nhận biết trong lõi). */
export const BIO_SERVER_NAME = 'bio-memory-locaith';

export interface CatalogEntry {
  id: string;
  name: string;
  vendor: string;
  category: McpCategory;
  description: string;
  transport: 'http' | 'stdio';
  /** Địa chỉ Streamable HTTP (transport = http). */
  url?: string;
  /** Lệnh chạy cục bộ (transport = stdio). `${workspaceFolder}` và `${HOME}` được thay khi thêm. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  needsWorkspace?: boolean;
  auth: McpAuthKind;
  /** Lý do chưa hỗ trợ → thẻ mờ. */
  unsupported?: string;
  /** Lưu ý hiển thị dưới mô tả. */
  note?: string;
  /** Cần Node (npx) hay Python để chạy cục bộ. */
  needs?: 'node' | 'python';
  /** Do Locaith viết (nhãn "của Locaith"). */
  own?: boolean;
}

const http = (id: string, name: string, vendor: string, category: McpCategory, description: string, url: string, auth: McpAuthKind, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, vendor, category, description, transport: 'http', url, auth, ...extra,
});
const npx = (id: string, name: string, vendor: string, category: McpCategory, description: string, args: string[], extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, vendor, category, description, transport: 'stdio', command: 'npx', args: ['-y', ...args], auth: 'local', needs: 'node', ...extra,
});

export const CATALOG: CatalogEntry[] = [
  // ── Bộ nhớ ──
  {
    id: BIO_SERVER_NAME, name: 'Bio-Memory-Locaith', vendor: 'Locaith', category: 'memory', own: true, auth: 'local', needs: 'python', transport: 'stdio',
    description: 'Bộ nhớ sinh học dài hạn của Locaith (Bio-Agent OS): biết nhớ, biết quên, đúc luật. Một kho dữ liệu duy nhất cho mọi cuộc trò chuyện và mọi cửa sổ VS Code; không mất khi nén ngữ cảnh.',
    command: 'bio-agent-os', args: ['serve-mcp'],
  },
  npx('memory', 'Memory (Anthropic)', 'Anthropic', 'memory', 'Đồ thị tri thức đơn giản (server tham chiếu của Anthropic). KHÔNG phải Bio-Memory của Locaith.', ['@modelcontextprotocol/server-memory'], {
    env: { MEMORY_FILE_PATH: '${HOME}/.locaith/memory/anthropic-memory.jsonl' },
    note: 'Lưu vào tệp ~/.locaith/memory/anthropic-memory.jsonl (đặt cố định để không mất khi xoá bộ nhớ đệm npx).',
  }),
  // ── Phát triển ──
  http('github', 'GitHub', 'GitHub', 'dev', 'Repo, issue, pull request, Actions, quét mã… bằng chính tài khoản GitHub của bạn (đăng nhập bằng tài khoản đã đăng nhập trong VS Code).', 'https://api.githubcopilot.com/mcp/', 'github'),
  http('sentry', 'Sentry', 'Sentry', 'dev', 'Xem lỗi, sự cố và dự án trên Sentry ngay trong cuộc trò chuyện.', 'https://mcp.sentry.dev/mcp', 'oauth'),
  http('vercel', 'Vercel', 'Vercel', 'dev', 'Quản lý dự án, triển khai và nhật ký trên Vercel.', 'https://mcp.vercel.com', 'oauth'),
  http('cloudflare-bindings', 'Cloudflare (Workers & bindings)', 'Cloudflare', 'dev', 'Quản lý Workers, KV, R2, D1 trên Cloudflare.', 'https://bindings.mcp.cloudflare.com/mcp', 'oauth'),
  http('huggingface', 'Hugging Face', 'Hugging Face', 'dev', 'Tìm model, dataset, Space và bài báo trên Hugging Face.', 'https://huggingface.co/mcp', 'none'),
  npx('sequential-thinking', 'Sequential Thinking', 'Anthropic', 'dev', 'Suy luận từng bước có thể sửa/rẽ nhánh cho bài toán phức tạp.', ['@modelcontextprotocol/server-sequential-thinking']),
  // ── Quản lý dự án & cộng tác ──
  http('notion', 'Notion', 'Notion', 'pm', 'Đọc, tìm và ghi trang, cơ sở dữ liệu trong Notion.', 'https://mcp.notion.com/mcp', 'oauth'),
  http('linear', 'Linear', 'Linear', 'pm', 'Issue, dự án và chu kỳ trên Linear.', 'https://mcp.linear.app/mcp', 'oauth'),
  http('clickup', 'ClickUp', 'ClickUp', 'pm', 'Công việc, tài liệu và không gian ClickUp.', 'https://mcp.clickup.com/mcp', 'oauth'),
  http('monday', 'monday.com', 'monday.com', 'pm', 'Bảng, mục và cập nhật trên monday.com.', 'https://mcp.monday.com/mcp', 'oauth'),
  http('asana', 'Asana', 'Asana', 'pm', 'Dự án và công việc trên Asana.', 'https://mcp.asana.com/v2/mcp', 'oauth', { unsupported: 'Asana yêu cầu ứng dụng OAuth riêng của bạn (không cho đăng ký tự động) — chưa hỗ trợ.' }),
  // ── Giao tiếp ──
  http('slack', 'Slack', 'Slack', 'comm', 'Tìm và đọc kênh, gửi tin trên Slack.', 'https://mcp.slack.com/mcp', 'oauth', { unsupported: 'Slack yêu cầu ứng dụng OAuth riêng của bạn (không cho đăng ký tự động) — chưa hỗ trợ.' }),
  http('intercom', 'Intercom', 'Intercom', 'comm', 'Hội thoại và khách hàng trên Intercom.', 'https://mcp.intercom.com/mcp', 'oauth'),
  // ── Dữ liệu & hạ tầng ──
  http('supabase', 'Supabase', 'Supabase', 'data', 'Quản lý dự án, bảng và truy vấn Supabase.', 'https://mcp.supabase.com/mcp', 'oauth'),
  http('neon', 'Neon', 'Neon', 'data', 'Quản lý cơ sở dữ liệu Postgres trên Neon.', 'https://mcp.neon.tech/mcp', 'oauth'),
  http('prisma', 'Prisma Postgres', 'Prisma', 'data', 'Tạo và quản lý cơ sở dữ liệu Prisma Postgres.', 'https://mcp.prisma.io/mcp', 'oauth'),
  http('airtable', 'Airtable', 'Airtable', 'data', 'Đọc và ghi bản ghi, cấu trúc bảng trên Airtable.', 'https://mcp.airtable.com/mcp', 'oauth'),
  http('honeycomb', 'Honeycomb', 'Honeycomb', 'data', 'Truy vấn dữ liệu quan sát (trace, sự kiện) trên Honeycomb.', 'https://mcp.honeycomb.io/mcp', 'oauth'),
  http('datadog', 'Datadog', 'Datadog', 'data', 'Nhật ký, chỉ số và cảnh báo trên Datadog.', 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', 'oauth', { note: 'Chỉ site US1 (datadoghq.com).' }),
  // ── Thanh toán ──
  http('stripe', 'Stripe', 'Stripe', 'pay', 'Khách hàng, thanh toán, hoá đơn trên Stripe.', 'https://mcp.stripe.com', 'oauth'),
  http('paypal', 'PayPal', 'PayPal', 'pay', 'Giao dịch và hoá đơn PayPal.', 'https://mcp.paypal.com/mcp', 'oauth'),
  http('square', 'Square', 'Square', 'pay', 'Cửa hàng, đơn hàng và thanh toán Square.', 'https://mcp.squareup.com/sse', 'oauth', { unsupported: 'Square dùng giao thức SSE cũ — chưa hỗ trợ.' }),
  // ── Thiết kế & website ──
  http('figma', 'Figma', 'Figma', 'design', 'Đọc thiết kế, thành phần và biến từ Figma.', 'https://mcp.figma.com/mcp', 'oauth'),
  http('canva', 'Canva', 'Canva', 'design', 'Tạo và chỉnh thiết kế trên Canva.', 'https://mcp.canva.com/mcp', 'oauth'),
  http('webflow', 'Webflow', 'Webflow', 'design', 'Quản lý site và CMS trên Webflow.', 'https://mcp.webflow.com/mcp', 'oauth'),
  http('wix', 'Wix', 'Wix', 'design', 'Quản lý site Wix.', 'https://mcp.wix.com/mcp', 'oauth'),
  // ── Tài liệu & tra cứu (không cần đăng nhập) ──
  http('context7', 'Context7', 'Upstash', 'docs', 'Tài liệu mới nhất của thư viện/framework, ngay trong cuộc trò chuyện.', 'https://mcp.context7.com/mcp', 'none'),
  http('deepwiki', 'DeepWiki', 'Cognition', 'docs', 'Hỏi đáp về mọi kho GitHub công khai.', 'https://mcp.deepwiki.com/mcp', 'none'),
  http('microsoft-learn', 'Microsoft Learn', 'Microsoft', 'docs', 'Tra cứu tài liệu Microsoft, Azure, .NET chính thức.', 'https://learn.microsoft.com/api/mcp', 'none'),
  http('cloudflare-docs', 'Cloudflare Docs', 'Cloudflare', 'docs', 'Tra cứu tài liệu Cloudflare.', 'https://docs.mcp.cloudflare.com/mcp', 'none'),
  http('exa', 'Exa Search', 'Exa', 'search', 'Tìm kiếm web theo ngữ nghĩa.', 'https://mcp.exa.ai/mcp', 'none', { note: 'Gói miễn phí có giới hạn lượt dùng.' }),
  // ── Trình duyệt & tệp (chạy trên máy) ──
  npx('playwright', 'Playwright', 'Microsoft', 'browser', 'Điều khiển một trình duyệt riêng bằng Playwright (mở trang, bấm, chụp ảnh, kiểm thử web).', ['@playwright/mcp@latest']),
  npx('chrome-devtools', 'Chrome DevTools', 'Google', 'browser', 'Điều khiển và kiểm tra một trình duyệt Chrome đang chạy (hiệu năng, mạng, console).', ['chrome-devtools-mcp@latest']),
  npx('filesystem', 'Filesystem', 'Anthropic', 'files', 'Đọc/ghi tệp trong thư mục workspace qua MCP.', ['@modelcontextprotocol/server-filesystem', '${workspaceFolder}'], { needsWorkspace: true }),
];

export const CATEGORY_ORDER: McpCategory[] = ['memory', 'dev', 'pm', 'comm', 'data', 'pay', 'design', 'docs', 'search', 'browser', 'files'];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

const sub = (s: string, workspaceFolder: string | undefined, home: string): string => s.split('${workspaceFolder}').join(workspaceFolder ?? '').split('${HOME}').join(home);

/** Cấu hình MCP để thêm vào cài đặt cho một mục chạy cục bộ; null nếu thiếu workspace hoặc không phải mục cục bộ. */
export function localConfig(e: CatalogEntry, workspaceFolder: string | undefined, home: string): McpServerConfig | null {
  if (e.transport !== 'stdio' || !e.command || e.id === BIO_SERVER_NAME) return null;
  if (e.needsWorkspace && !workspaceFolder) return null;
  return {
    command: e.command,
    args: (e.args ?? []).map((a) => sub(a, workspaceFolder, home)),
    ...(e.env ? { env: Object.fromEntries(Object.entries(e.env).map(([k, v]) => [k, sub(v, workspaceFolder, home)])) } : {}),
  };
}

export interface ServerDescription {
  label?: string;
  note?: string;
  catalogId?: string;
}

const norm = (u: string): string => u.replace(/\/+$/, '').toLowerCase();

/** Nhận diện một cấu hình MCP có sẵn (do người dùng/plugin khai báo) để hiển thị đúng tên và nguồn gốc. */
export function describeServer(cfg: McpServerConfig): ServerDescription {
  if (cfg.url) {
    const e = CATALOG.find((x) => x.url && norm(x.url) === norm(cfg.url!));
    return e ? { label: `${e.name} (${e.vendor})`, catalogId: e.id } : {};
  }
  const joined = [cfg.command ?? '', ...(cfg.args ?? [])].join(' ');
  if (/bio-agent-os/i.test(joined)) return { label: 'Bio-Memory-Locaith', catalogId: BIO_SERVER_NAME, note: 'Bộ nhớ sinh học của Locaith — một kho dùng chung cho mọi cuộc trò chuyện.' };
  if (/@modelcontextprotocol\/server-memory/.test(joined)) {
    return { label: 'Memory (Anthropic)', catalogId: 'memory', note: 'Đồ thị tri thức của Anthropic — KHÔNG phải Bio-Memory của Locaith. Nếu chưa đặt MEMORY_FILE_PATH, dữ liệu nằm trong bộ nhớ đệm npx và có thể mất.' };
  }
  const e = CATALOG.find((x) => x.transport === 'stdio' && x.args?.some((a) => a.startsWith('@') || a.includes('mcp')) && (x.args ?? []).filter((a) => !a.startsWith('${')).every((a) => joined.includes(a)));
  return e ? { label: `${e.name} (${e.vendor})`, catalogId: e.id } : {};
}
