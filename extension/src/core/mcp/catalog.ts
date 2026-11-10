/**
 * Kho kết nối MCP. Mỗi địa chỉ từ xa dưới đây đã được THĂM DÒ THẬT (ngày 2026-11-03, phần mở rộng và các mục cũ thăm dò lại 2026-11-10) bằng yêu cầu `initialize` (không phải đoán):
 *   • 200 + serverInfo  → server mở, không cần đăng nhập (`auth: 'none'`);
 *   • 401 + `resource_metadata` + metadata OAuth đọc được + có đăng ký ứng dụng tự động (DCR) + PKCE S256 → `auth: 'oauth'` (đăng nhập một chạm);
 *   • DCR không có (Slack, Asana) → `unsupported` (hiện thẻ mờ kèm lý do, không giả vờ chạy được).
 * Địa chỉ không trả lời hoặc không đọc được metadata (Pulumi) KHÔNG có trong danh sách.
 *
 * 0.7.7: thêm ~75 mục — Atlassian/Zapier nay đã có OAuth+DCR; Square đổi sang /mcp (hết «chưa hỗ trợ»), Datadog sang /v1/mcp; mục cần khoá API/ID khách hàng của người dùng khai `inputs`
 * (xem CatalogInput); những mục cần OAuth client RIÊNG của người dùng (Google Workspace chính thức, HubSpot) hoặc CIMD (ElevenLabs, MongoDB từ xa) chưa có vì luồng đăng nhập chưa hỗ trợ.
 */

/**
 * Phần cấu hình server MCP mà kho cần (cấu trúc con của `McpServerConfig` ở client.ts). Khai báo riêng để tệp này KHÔNG kéo `client.ts` (dùng kiểu của Node) vào chương trình dịch của webview —
 * harness giao diện (webview/dev) nhập kho thật để xem đủ mục.
 */
export interface CatalogServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export type McpCategory = 'dev' | 'pm' | 'data' | 'docs' | 'pay' | 'design' | 'comm' | 'search' | 'browser' | 'memory' | 'files' | 'office' | 'cloud' | 'crm' | 'auto';
/** 'key' (0.7.7) = máy chủ HTTP xác thực bằng khoá API do người dùng nhập (header) — xem `inputs`. */
export type McpAuthKind = 'none' | 'oauth' | 'github' | 'local' | 'key';

/** Ngày thăm dò địa chỉ/gói gần nhất (0.7.7: toàn bộ mục từ xa thăm dò lại, và các mục thêm mới 10/11 thăm dò OAuth/DCR hoặc `tools/list` + kiểm gói npm/PyPI còn sống, kho không archived). */
export const CATALOG_VERIFIED_ON = '2026-11-10';
/** Tên server MCP của Bio-Memory-Locaith (cũng là khoá nhận biết trong lõi). */
export const BIO_SERVER_NAME = 'bio-memory-locaith';

/**
 * (0.7.7) Một thứ người dùng PHẢI/NÊN nhập khi kết nối (khoá API, ID khách hàng OAuth của họ, địa chỉ máy chủ riêng…). Host hỏi lần lượt bằng hộp nhập của VS Code, lưu
 * trong SecretStorage (mã hoá bằng kho khoá hệ điều hành) và chỉ ghép vào cấu hình lúc KHỞI ĐỘNG server — không bao giờ ghi vào cài đặt hay hiện trên giao diện.
 */
export interface CatalogInput {
  /** `env`: tên biến môi trường. `header`: tên header HTTP. `arg`: cờ dòng lệnh (`--url`); bỏ trống = đối số vị trí. */
  key: string;
  kind: 'env' | 'header' | 'arg';
  /** Tên hiển thị trên hộp nhập. */
  label: string;
  /** Gợi ý: lấy giá trị ở đâu, định dạng ra sao. */
  help?: string;
  /** Giá trị bí mật (khoá, mật khẩu): ô nhập dạng mật khẩu, hiện «•••». Không dùng cho `arg` (đối số lộ trong danh sách tiến trình). */
  secret?: boolean;
  /** true = có thể để trống. Mặc định: bắt buộc. */
  optional?: boolean;
  /** `header`: chuỗi đứng trước giá trị, ví dụ `Bearer ` hay `Token token=`. */
  prefix?: string;
  /** Giá trị điền sẵn trong hộp nhập. */
  placeholder?: string;
}

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
  /** Cần Node (npx) hay Python/uv (uvx) để chạy cục bộ. */
  needs?: 'node' | 'python';
  /** (0.7.7) Thứ cần người dùng nhập khi kết nối (khoá API…). */
  inputs?: CatalogInput[];
  /** Do Locaith viết (nhãn "của Locaith"). */
  own?: boolean;
}

const http = (id: string, name: string, vendor: string, category: McpCategory, description: string, url: string, auth: McpAuthKind, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, vendor, category, description, transport: 'http', url, auth, ...extra,
});
const npx = (id: string, name: string, vendor: string, category: McpCategory, description: string, args: string[], extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, vendor, category, description, transport: 'stdio', command: 'npx', args: ['-y', ...args], auth: 'local', needs: 'node', ...extra,
});
/** (0.7.7) Gói Python chạy bằng `uvx` (cần cài uv: https://docs.astral.sh/uv/). */
const uvx = (id: string, name: string, vendor: string, category: McpCategory, description: string, args: string[], extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, vendor, category, description, transport: 'stdio', command: 'uvx', args, auth: 'local', needs: 'python', ...extra,
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
  http('datadog', 'Datadog', 'Datadog', 'data', 'Nhật ký, chỉ số và cảnh báo trên Datadog.', 'https://mcp.datadoghq.com/v1/mcp', 'oauth', { note: 'Chỉ site US1 (datadoghq.com).' }),
  // ── Thanh toán ──
  http('stripe', 'Stripe', 'Stripe', 'pay', 'Khách hàng, thanh toán, hoá đơn trên Stripe.', 'https://mcp.stripe.com', 'oauth'),
  http('paypal', 'PayPal', 'PayPal', 'pay', 'Giao dịch và hoá đơn PayPal.', 'https://mcp.paypal.com/mcp', 'oauth'),
  http('square', 'Square', 'Square', 'pay', 'Cửa hàng, đơn hàng và thanh toán Square.', 'https://mcp.squareup.com/mcp', 'oauth'),
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
  // ════ 0.7.7: mở rộng kho (khảo sát + thăm dò thật ngày 10/11/2026; xem docs/changes/mcp-catalog-077.md) ════
  // ── Văn phòng: Google Workspace, Microsoft 365, tệp văn phòng ──
  uvx('google-workspace-mcp', 'Google Workspace (Forms, Sheets, Docs, Drive, Apps Script)', 'taylorwilsdon (cộng đồng)', 'office', 'Điều khiển Google Forms, Sheets, Docs, Drive và Apps Script bằng API (nhanh hơn thao tác Chrome); dùng OAuth client của chính bạn.', ['workspace-mcp', '--tools', 'drive', 'docs', 'sheets', 'forms', 'appscript'], { note: 'Cần cài uv (Python) và tự tạo một OAuth client loại "Desktop app" trong Google Cloud (bật API Drive, Docs, Sheets, Forms, Apps Script). Lần đầu dùng, trợ lý gửi liên kết để bạn đăng nhập Google. Hướng dẫn: workspacemcp.com/quick-start.', inputs: [{ key: 'GOOGLE_OAUTH_CLIENT_ID', kind: 'env', label: 'Client ID OAuth (Google Cloud)', help: 'Google Cloud Console → APIs & Services → Credentials → OAuth client ID loại Desktop app.' }, { key: 'GOOGLE_OAUTH_CLIENT_SECRET', kind: 'env', label: 'Client secret OAuth', help: 'Mã bí mật của OAuth client ở trên.', secret: true }] }),
  uvx('google-sheets-sa', 'Google Sheets (tài khoản dịch vụ)', 'xing5 (cộng đồng)', 'office', 'Đọc/ghi Google Sheets qua tài khoản dịch vụ, không cần màn hình đồng ý OAuth; chỉ cần chia sẻ thư mục Drive cho tài khoản đó.', ['mcp-google-sheets@latest'], { note: 'Không cần màn hình đồng ý OAuth: tạo tài khoản dịch vụ, bật Sheets API + Drive API rồi chia sẻ bảng tính/thư mục cho email của tài khoản đó. Chỉ có Sheets/Drive, không có Forms hay Apps Script.', inputs: [{ key: 'SERVICE_ACCOUNT_PATH', kind: 'env', label: 'Đường dẫn tệp JSON của tài khoản dịch vụ', help: 'Ví dụ C:\\khoa\\service-account.json (tệp tải từ Google Cloud).' }, { key: 'DRIVE_FOLDER_ID', kind: 'env', label: 'ID thư mục Drive (tuỳ chọn)', help: 'Thư mục đã chia sẻ cho tài khoản dịch vụ; để trống nếu không giới hạn.', optional: true }] }),
  npx('google-apps-script-clasp', 'Google Apps Script (clasp)', 'Google (kho google/clasp)', 'office', 'Chế độ MCP (thử nghiệm) của clasp: tạo, clone, kéo và đẩy mã dự án Apps Script. Cần chạy "clasp login" và bật Apps Script API.', ['@google/clasp', 'mcp'], { note: 'Thử nghiệm (Google ghi rõ chưa phải sản phẩm hỗ trợ chính thức, chỉ một phần công cụ). Cần đã chạy «npx @google/clasp login» một lần (đăng nhập qua trình duyệt).' }),
  uvx('excel-local', 'Excel (tệp .xlsx cục bộ)', 'haris-musa (cộng đồng)', 'office', 'Đọc, tạo, sửa sổ làm việc Excel (.xlsx) trong thư mục workspace: ô, công thức, định dạng, biểu đồ, PivotTable.', ['excel-mcp-server', 'stdio', '--allow-dir', '${workspaceFolder}'], { needsWorkspace: true, note: 'Chạy hoàn toàn trên máy, không cần tài khoản; chỉ đọc/ghi tệp .xlsx trong thư mục workspace đang mở.' }),
  uvx('markitdown', 'MarkItDown (đọc PDF, Word, Excel, PowerPoint)', 'Microsoft', 'office', 'Chuyển PDF, Word, Excel, PowerPoint, HTML, ảnh… sang Markdown để mô hình đọc; máy chủ MCP của Microsoft, chạy cục bộ.', ['markitdown-mcp'], { note: 'Bản alpha. Đổi tệp PDF, Word, Excel, PowerPoint… thành văn bản để trợ lý đọc.' }),
  npx('microsoft-365-graph', 'Microsoft 365 (Outlook, OneDrive, Excel, Teams…)', 'Softeria (cộng đồng)', 'office', 'Outlook, Lịch, OneDrive, Excel, OneNote, Planner, Teams, SharePoint qua Microsoft Graph (300+ công cụ). Có --read-only và preset.', ['@softeria/ms-365-mcp-server'], { note: 'Mặc định chỉ có nhóm công cụ cá nhân (Outlook, Lịch, OneDrive, Excel, OneNote, To Do, Planner, Danh bạ). Lần đầu dùng, gọi công cụ login của máy chủ để đăng nhập Microsoft.' }),
  http('dropbox', 'Dropbox', 'Dropbox', 'files', 'Tìm, đọc, tải lên tệp trên Dropbox qua máy chủ MCP từ xa chính thức; đăng nhập OAuth một chạm.', 'https://mcp.dropbox.com/mcp', 'oauth'),
  // ── Dự án, cộng tác, cuộc họp ──
  http('atlassian-rovo', 'Atlassian (Jira, Confluence, Compass)', 'Atlassian', 'pm', 'Jira, Confluence và Compass của Atlassian qua máy chủ từ xa chính thức (v2); đăng nhập OAuth một chạm.', 'https://mcp.atlassian.com/v2/mcp', 'oauth'),
  http('trello', 'Trello', 'Atlassian', 'pm', 'Bảng, danh sách, thẻ, checklist và Planner của Trello qua máy chủ từ xa chính thức của Atlassian; đăng nhập OAuth.', 'https://mcp.trello.com/v1', 'oauth'),
  http('todoist', 'Todoist', 'Doist', 'pm', 'Công việc, dự án, nhãn và lịch hẹn trong Todoist qua máy chủ từ xa chính thức của Doist; đăng nhập OAuth.', 'https://ai.todoist.net/mcp', 'oauth'),
  http('calendly', 'Calendly', 'Calendly', 'pm', 'Loại sự kiện, lịch hẹn và khung giờ rảnh trên Calendly qua máy chủ MCP chính thức; đăng nhập OAuth.', 'https://mcp.calendly.com/', 'oauth'),
  http('fireflies', 'Fireflies', 'Fireflies.ai', 'pm', 'Tìm bản ghi cuộc họp, bản chép lời và tóm tắt trên Fireflies qua máy chủ MCP chính thức; đăng nhập OAuth.', 'https://api.fireflies.ai/mcp', 'oauth'),
  http('granola', 'Granola', 'Granola', 'pm', 'Tìm ghi chú và nội dung cuộc họp đã lưu trong Granola để làm ngữ cảnh khi viết tài liệu; đăng nhập OAuth.', 'https://mcp.granola.ai/mcp', 'oauth'),
  http('typeform', 'Typeform', 'Typeform', 'pm', 'Tạo và quản lý biểu mẫu/khảo sát Typeform và đọc phản hồi qua máy chủ MCP chính thức; thay thế Google Forms khi cần.', 'https://api.typeform.com/mcp', 'oauth'),
  http('miro', 'Miro', 'Miro', 'design', 'Đọc và tạo nội dung trên bảng Miro (sơ đồ, ghi chú, khung) qua máy chủ MCP chính thức; OAuth theo từng team.', 'https://mcp.miro.com/', 'oauth'),
  // ── Phát triển, lưu trữ mã, triển khai ──
  http('gitlab', 'GitLab', 'GitLab', 'dev', 'Issue, merge request, pipeline, mã nguồn trên GitLab (gitlab.com) qua máy chủ MCP chính thức; đăng nhập OAuth một chạm.', 'https://gitlab.com/api/v4/mcp', 'oauth'),
  http('netlify', 'Netlify', 'Netlify', 'dev', 'Tạo site, triển khai, quản lý biến môi trường và domain trên Netlify qua máy chủ MCP từ xa chính thức; OAuth.', 'https://mcp.netlify.com/mcp', 'oauth'),
  http('railway', 'Railway', 'Railway', 'dev', 'Quản lý dự án, dịch vụ, biến môi trường và triển khai trên Railway qua máy chủ MCP từ xa chính thức; OAuth.', 'https://mcp.railway.com', 'oauth'),
  http('hostinger', 'Hostinger', 'Hostinger', 'dev', 'Quản lý hosting, VPS, domain và DNS trên Hostinger qua máy chủ MCP từ xa chính thức; đăng nhập OAuth.', 'https://mcp.hostinger.com', 'oauth'),
  http('postman', 'Postman', 'Postman', 'dev', 'Workspace, collection, environment và API của Postman qua máy chủ MCP chính thức (chế độ Full; có /minimal và /code).', 'https://mcp.postman.com/mcp', 'oauth'),
  npx('azure-devops', 'Azure DevOps', 'Microsoft', 'dev', 'Work item, repo, pull request, pipeline của Azure DevOps; máy chủ chính thức của Microsoft, bắt buộc truyền tên tổ chức.', ['@azure-devops/mcp'], { note: 'Đăng nhập qua trình duyệt Microsoft ở lần chạy đầu.', inputs: [{ key: '', kind: 'arg', label: 'Tên tổ chức Azure DevOps', help: 'Phần sau dev.azure.com/ trong địa chỉ tổ chức của bạn.' }] }),
  http('render', 'Render', 'Render', 'dev', 'Quản lý dịch vụ web, cơ sở dữ liệu và nhật ký trên Render qua máy chủ MCP chính thức; dùng khoá API dạng Bearer.', 'https://mcp.render.com/mcp', 'key', { note: 'Khoá API Render có toàn quyền theo tài khoản — tạo ở Account Settings → API Keys.', inputs: [{ key: 'Authorization', kind: 'header', label: 'Khoá API Render', help: 'Dán khoá API Render (không cần gõ chữ Bearer).', secret: true, prefix: 'Bearer ' }] }),
  // ── Tự động hoá ──
  http('zapier', 'Zapier', 'Zapier', 'auto', 'Cầu nối tới hàng nghìn ứng dụng qua Zapier (Sheets, Gmail, Slack…); đăng nhập OAuth, quyền theo ứng dụng đã nối trong Zapier.', 'https://mcp.zapier.com/api/v1/connect', 'oauth'),
  http('make', 'Make', 'Make', 'auto', 'Chạy kịch bản (scenario) Make từ trò chuyện qua máy chủ MCP chính thức; đăng nhập OAuth hoặc khoá API theo vùng.', 'https://mcp.make.com/v2', 'oauth'),
  npx('n8n-mcp', 'n8n (dựng workflow)', 'czlonkowski (cộng đồng)', 'auto', 'Tra cứu node n8n và (khi có N8N_API_URL/KEY) tạo, sửa, chạy workflow n8n tự lưu trữ; dự án cộng đồng.', ['n8n-mcp'], { note: 'Không điền gì: chỉ tra cứu tài liệu các node n8n (chỉ đọc). Điền địa chỉ + khoá API n8n của bạn để tạo/sửa/chạy workflow.', inputs: [{ key: 'N8N_API_URL', kind: 'env', label: 'Địa chỉ n8n của bạn (tuỳ chọn)', help: 'Ví dụ https://n8n.congty.vn — để trống nếu chỉ cần tra cứu tài liệu.', optional: true }, { key: 'N8N_API_KEY', kind: 'env', label: 'Khoá API n8n (tuỳ chọn)', help: 'n8n → Settings → n8n API.', secret: true, optional: true }], env: { MCP_MODE: 'stdio', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true' } }),
  // ── Đám mây & vận hành (Google Cloud, Azure, AWS, Kubernetes, quan sát) ──
  npx('firebase', 'Firebase', 'Google (Firebase)', 'cloud', 'Quản lý dự án Firebase ngay trong trò chuyện qua firebase-tools (máy chủ MCP chính thức), dùng tài khoản đã "firebase login".', ['firebase-tools@latest', 'mcp'], { note: 'Cần đã chạy «npx firebase-tools login» một lần.' }),
  npx('google-cloud-cli', 'Google Cloud (gcloud)', 'Google (googleapis/gcloud-mcp)', 'cloud', 'Chạy lệnh gcloud bằng ngôn ngữ tự nhiên, dùng gcloud CLI đã đăng nhập trên máy. Máy chủ chính thức của Google Cloud.', ['@google-cloud/gcloud-mcp'], { note: 'Cần cài gcloud CLI và đã đăng nhập.' }),
  npx('google-cloud-observability', 'Google Cloud Observability', 'Google (googleapis/gcloud-mcp)', 'cloud', 'Đọc nhật ký, chỉ số và dấu vết trên Google Cloud Observability; máy chủ chính thức của Google, dùng ADC của gcloud.', ['@google-cloud/observability-mcp'], { note: 'Dùng thông tin đăng nhập mặc định của Google Cloud (ADC).' }),
  npx('azure-mcp', 'Azure', 'Microsoft', 'cloud', 'Quản lý tài nguyên Azure qua Azure MCP Server chính thức của Microsoft, dùng tài khoản Azure đã đăng nhập; có chế độ chỉ đọc.', ['@azure/mcp@latest', 'server', 'start'], { note: 'Bản beta. Dùng thông tin đăng nhập Azure có sẵn trên máy (az login).' }),
  uvx('aws-api', 'AWS API (awslabs)', 'AWS Labs', 'cloud', 'Chạy lệnh AWS CLI qua MCP chính thức của AWS Labs; nên bật READ_OPERATIONS_ONLY và dùng profile quyền tối thiểu.', ['awslabs.aws-api-mcp-server@latest'], { note: 'Cần AWS credentials trên máy. Locaith đặt sẵn CHỈ ĐỌC + hỏi trước khi ghi; muốn cho ghi, sửa READ_OPERATIONS_ONLY trong cài đặt MCP.', inputs: [{ key: 'AWS_API_MCP_PROFILE_NAME', kind: 'env', label: 'Tên profile AWS (tuỳ chọn)', help: 'Nên dùng profile có quyền tối thiểu; để trống = profile mặc định.', optional: true }, { key: 'AWS_REGION', kind: 'env', label: 'Vùng AWS (tuỳ chọn)', help: 'Ví dụ ap-southeast-1.', optional: true }], env: { READ_OPERATIONS_ONLY: 'true', REQUIRE_MUTATION_CONSENT: 'true' } }),
  http('aws-knowledge', 'AWS Knowledge', 'Amazon Web Services', 'docs', 'Tra cứu tài liệu, bài viết What\'s New và khả dụng theo vùng của AWS; không cần tài khoản, có giới hạn tốc độ.', 'https://knowledge-mcp.global.api.aws', 'none'),
  npx('kubernetes', 'Kubernetes', 'containers (Red Hat)', 'cloud', 'Quản lý cluster Kubernetes/OpenShift qua kubeconfig hiện có (pod, deployment, log…); có cấu hình read_only/disable_destructive.', ['kubernetes-mcp-server@latest'], { note: 'Dùng kubeconfig có sẵn trên máy.' }),
  http('cloudflare-api', 'Cloudflare (toàn bộ API, Code Mode)', 'Cloudflare', 'cloud', 'Toàn bộ Cloudflare API qua search()/execute()/docs() (Code Mode, ~1.000 token); OAuth chọn quyền khi đăng nhập hoặc token API.', 'https://mcp.cloudflare.com/mcp', 'oauth'),
  http('grafana-cloud', 'Grafana Cloud', 'Grafana Labs', 'cloud', 'Dashboard, truy vấn Prometheus/Loki, cảnh báo của Grafana Cloud qua máy chủ MCP từ xa; OAuth theo quyền RBAC của bạn (public preview).', 'https://mcp.grafana.com/mcp', 'oauth'),
  uvx('grafana-oss', 'Grafana (tự lưu trữ)', 'Grafana Labs', 'cloud', 'Dashboard, datasource, Prometheus, Loki và cảnh báo của Grafana tự lưu trữ hoặc Cloud qua token tài khoản dịch vụ.', ['mcp-grafana'], { inputs: [{ key: 'GRAFANA_URL', kind: 'env', label: 'Địa chỉ Grafana', help: 'Ví dụ https://grafana.congty.vn' }, { key: 'GRAFANA_SERVICE_ACCOUNT_TOKEN', kind: 'env', label: 'Token tài khoản dịch vụ Grafana', help: 'Grafana → Administration → Service accounts.', secret: true }] }),
  http('new-relic', 'New Relic', 'New Relic', 'cloud', 'Truy vấn dữ liệu, thực thể và cảnh báo New Relic qua máy chủ MCP chính thức; OAuth (khuyến nghị).', 'https://mcp.newrelic.com/mcp/', 'oauth'),
  http('pagerduty', 'PagerDuty', 'PagerDuty', 'cloud', 'Sự cố, dịch vụ, lịch trực của PagerDuty qua máy chủ MCP từ xa chính thức; xác thực bằng khoá API trong header Authorization.', 'https://mcp.pagerduty.com/mcp', 'key', { note: 'Xác thực bằng khoá API trong header Authorization (định dạng của PagerDuty, không phải Bearer).', inputs: [{ key: 'Authorization', kind: 'header', label: 'Khoá API PagerDuty', help: 'Dán khoá API (không cần gõ "Token token=").', secret: true, prefix: 'Token token=' }] }),
  http('cloudflare-browser', 'Cloudflare Browser Run', 'Cloudflare', 'browser', 'Tải trang web, chuyển sang Markdown và chụp ảnh màn hình trên hạ tầng Cloudflare (Browser Rendering); OAuth.', 'https://browser.mcp.cloudflare.com/mcp', 'oauth'),
  // ── Dữ liệu ──
  npx('toolbox-bigquery', 'BigQuery (MCP Toolbox)', 'Google (googleapis/mcp-toolbox)', 'data', 'Truy vấn BigQuery (liệt kê dataset/bảng, chạy SQL) qua MCP Toolbox chính thức của Google, dùng ADC của gcloud.', ['@toolbox-sdk/server', '--prebuilt', 'bigquery', '--stdio'], { note: 'Dùng thông tin đăng nhập mặc định của gcloud (ADC).', inputs: [{ key: 'BIGQUERY_PROJECT', kind: 'env', label: 'ID dự án Google Cloud chứa BigQuery', help: 'Ví dụ my-project-123456.' }, { key: 'BIGQUERY_LOCATION', kind: 'env', label: 'Vị trí dữ liệu (tuỳ chọn)', help: 'Ví dụ asia-southeast1.', optional: true }] }),
  npx('mongodb', 'MongoDB', 'MongoDB', 'data', 'Truy vấn và quản trị MongoDB/Atlas qua máy chủ chính thức của MongoDB; mặc định chạy --readOnly (bỏ cờ để cho phép ghi).', ['mongodb-mcp-server@latest', '--readOnly'], { note: 'Locaith bật sẵn chế độ CHỈ ĐỌC (--readOnly).', inputs: [{ key: 'MDB_MCP_CONNECTION_STRING', kind: 'env', label: 'Chuỗi kết nối MongoDB', help: 'mongodb://… hoặc mongodb+srv://…', secret: true }] }),
  uvx('postgres-pro', 'PostgreSQL Pro', 'crystaldba (cộng đồng)', 'data', 'PostgreSQL với phân tích chỉ mục, kế hoạch truy vấn và kiểm tra sức khoẻ; mặc định --access-mode=restricted (chỉ đọc).', ['postgres-mcp', '--access-mode=restricted'], { note: 'Chế độ restricted (chỉ đọc). Thay máy chủ @modelcontextprotocol/server-postgres đã bị bỏ.', inputs: [{ key: 'DATABASE_URI', kind: 'env', label: 'Chuỗi kết nối PostgreSQL', help: 'postgresql://người-dùng:mật-khẩu@máy-chủ:5432/tên-csdl', secret: true }] }),
  npx('pinecone', 'Pinecone', 'Pinecone', 'data', 'Quản lý index và truy vấn vector trên Pinecone (tìm kiếm ngữ nghĩa) qua máy chủ MCP chính thức; cần Node.js 22+.', ['@pinecone-database/mcp'], { note: 'Cần Node.js 22 trở lên.', inputs: [{ key: 'PINECONE_API_KEY', kind: 'env', label: 'Khoá API Pinecone', help: 'app.pinecone.io → API keys.', secret: true }] }),
  uvx('qdrant', 'Qdrant', 'Qdrant', 'data', 'Bộ nhớ ngữ nghĩa trên Qdrant (lưu và tìm theo vector, embedding fastembed); máy chủ MCP chính thức của Qdrant.', ['mcp-server-qdrant'], { note: 'Bộ nhớ vector, KHÔNG phải Bio-Memory của Locaith.', inputs: [{ key: 'QDRANT_URL', kind: 'env', label: 'Địa chỉ Qdrant', help: 'Ví dụ https://xxxx.cloud.qdrant.io:6333' }, { key: 'QDRANT_API_KEY', kind: 'env', label: 'Khoá API Qdrant (tuỳ chọn)', secret: true, optional: true }, { key: 'COLLECTION_NAME', kind: 'env', label: 'Tên collection mặc định' }] }),
  http('planetscale', 'PlanetScale', 'PlanetScale', 'data', 'Cơ sở dữ liệu PlanetScale (MySQL/Postgres): xem lược đồ, Insights và gợi ý tối ưu qua máy chủ MCP chính thức; OAuth.', 'https://mcp.pscale.dev/mcp/planetscale', 'oauth'),
  http('clickhouse-cloud', 'ClickHouse Cloud', 'ClickHouse', 'data', 'Truy vấn dữ liệu và xem dịch vụ ClickHouse Cloud qua máy chủ MCP từ xa chính thức; mọi truy vấn chỉ đọc (SELECT); OAuth.', 'https://mcp.clickhouse.cloud/mcp', 'oauth'),
  http('appwrite', 'Appwrite', 'Appwrite', 'data', 'Quản lý dự án Appwrite (cơ sở dữ liệu, xác thực, lưu trữ, function) qua máy chủ MCP từ xa chính thức; OAuth.', 'https://mcp.appwrite.io/', 'oauth'),
  http('posthog', 'PostHog', 'PostHog', 'data', 'Phân tích sản phẩm PostHog: sự kiện, funnel, feature flag, thử nghiệm A/B qua máy chủ MCP chính thức; OAuth.', 'https://mcp.posthog.com/mcp', 'oauth'),
  http('amplitude', 'Amplitude', 'Amplitude', 'data', 'Truy vấn biểu đồ, sự kiện và dashboard Amplitude (máy chủ Mỹ; có máy chủ EU riêng) qua MCP chính thức; OAuth.', 'https://mcp.amplitude.com/mcp', 'oauth'),
  http('mixpanel', 'Mixpanel', 'Mixpanel', 'data', 'Phân tích sự kiện, funnel, retention của Mixpanel qua máy chủ MCP chính thức theo vùng dữ liệu (US/EU/IN); OAuth.', 'https://mcp.mixpanel.com/mcp', 'oauth'),
  // ── CRM & marketing ──
  http('ahrefs', 'Ahrefs (SEO)', 'Ahrefs', 'crm', 'Dữ liệu SEO của Ahrefs (backlink, từ khoá, thứ hạng, site audit) qua máy chủ MCP chính thức; cần gói Lite trở lên.', 'https://api.ahrefs.com/mcp/mcp', 'oauth'),
  http('semrush', 'Semrush (SEO)', 'Semrush', 'crm', 'Dữ liệu SEO/quảng cáo/đối thủ của Semrush qua máy chủ MCP chính thức (Streamable HTTP); OAuth 2.1.', 'https://mcp.semrush.com/v2/mcp', 'oauth'),
  http('klaviyo', 'Klaviyo', 'Klaviyo', 'crm', 'Hồ sơ khách hàng, danh sách, chiến dịch email/SMS và báo cáo Klaviyo qua máy chủ MCP chính thức; OAuth, cần vai trò Owner/Admin/Manager.', 'https://mcp.klaviyo.com/mcp', 'oauth'),
  http('apollo', 'Apollo.io', 'Apollo.io', 'crm', 'Tìm khách hàng tiềm năng, làm giàu dữ liệu liên hệ và quản lý sequence trên Apollo.io qua MCP chính thức; OAuth.', 'https://mcp.apollo.io/mcp', 'oauth'),
  http('attio', 'Attio (CRM)', 'Attio', 'crm', 'Bản ghi, ghi chú, công việc và danh sách trong Attio CRM qua máy chủ MCP chính thức; đăng nhập OAuth.', 'https://mcp.attio.com/mcp', 'oauth'),
  // ── Tìm kiếm & thu thập web ──
  http('firecrawl', 'Firecrawl', 'Firecrawl', 'search', 'Cào trang web sang Markdown, tìm kiếm, phân tích tệp qua Firecrawl; OAuth chọn team (hoặc chế độ không khoá, có giới hạn ngày).', 'https://mcp.firecrawl.dev/v2/mcp-oauth', 'oauth'),
  http('tavily', 'Tavily', 'Tavily', 'search', 'Tìm kiếm web, trích xuất và thu thập nội dung tối ưu cho AI qua Tavily; đăng nhập OAuth hoặc dùng khoá API.', 'https://mcp.tavily.com/mcp/', 'oauth'),
  http('jina', 'Jina AI', 'Jina AI', 'search', 'Đọc URL, tìm web/arXiv, chụp màn hình, xếp hạng lại kết quả (12 công cụ); dùng được không cần khoá, khoá API là tuỳ chọn.', 'https://mcp.jina.ai/v1', 'none'),
  http('apify', 'Apify', 'Apify', 'search', 'Chạy hàng nghìn Actor của Apify (thu thập Google Maps, mạng xã hội, trang web) từ trò chuyện; OAuth hoặc token.', 'https://mcp.apify.com', 'oauth'),
  http('brightdata', 'Bright Data', 'Bright Data', 'search', 'Thu thập web qua proxy và trình duyệt của Bright Data (vượt chặn, dữ liệu có cấu trúc); token API hoặc OAuth.', 'https://mcp.brightdata.com/mcp', 'oauth'),
  uvx('fetch', 'Fetch', 'Anthropic (máy chủ tham chiếu)', 'search', 'Tải một địa chỉ web và chuyển sang Markdown để mô hình đọc; máy chủ tham chiếu của dự án MCP, chạy cục bộ.', ['mcp-server-fetch']),
  uvx('duckduckgo', 'DuckDuckGo Search', 'nickclyde (cộng đồng)', 'search', 'Tìm kiếm web bằng DuckDuckGo và đọc nội dung trang, không cần khoá API; dự án cộng đồng.', ['duckduckgo-mcp-server'], { note: 'Không cần khoá, không cần tài khoản.' }),
  npx('brave-search', 'Brave Search', 'Brave', 'search', 'Tìm kiếm web, tin tức, ảnh, video và địa điểm bằng Brave Search API; máy chủ chính thức của Brave (cần khoá API).', ['@brave/brave-search-mcp-server'], { inputs: [{ key: 'BRAVE_API_KEY', kind: 'env', label: 'Khoá API Brave Search', help: 'brave.com/search/api — có gói miễn phí.', secret: true }] }),
  npx('perplexity', 'Perplexity', 'Perplexity', 'search', 'Tìm kiếm và hỏi đáp có trích nguồn bằng Perplexity API; máy chủ MCP chính thức (cần khoá API).', ['@perplexity-ai/mcp-server'], { inputs: [{ key: 'PERPLEXITY_API_KEY', kind: 'env', label: 'Khoá API Perplexity', help: 'perplexity.ai → Settings → API.', secret: true }] }),
  // ── Tài liệu & tra cứu ──
  http('openai-docs', 'OpenAI Developer Docs', 'OpenAI', 'docs', 'Tra cứu tài liệu nhà phát triển OpenAI: tìm kiếm, liệt kê, đọc trang, danh sách endpoint và đặc tả OpenAPI; không cần đăng nhập.', 'https://developers.openai.com/mcp', 'none'),
  http('twilio-docs', 'Twilio Docs', 'Twilio', 'docs', 'Tìm và đọc tài liệu Twilio (SMS, Voice, WhatsApp, Verify…) phục vụ lập trình tích hợp; không cần đăng nhập.', 'https://mcp.twilio.com/docs', 'none'),
  http('bitrix24-docs', 'Bitrix24 REST Docs', 'Bitrix24', 'docs', 'Tra cứu tài liệu REST API Bitrix24 (phương thức, tham số, sự kiện, hướng dẫn) cho lập trình ứng dụng; không cần đăng nhập.', 'https://mcp-dev.bitrix24.com/mcp', 'none'),
  http('google-developer-knowledge', 'Google Developer Knowledge', 'Google', 'docs', 'Tra cứu tài liệu nhà phát triển của Google (Apps Script, Workspace, Firebase, Cloud…) qua khoá API; máy chủ chính thức.', 'https://developerknowledge.googleapis.com/mcp', 'key', { note: 'Tra cứu tài liệu Apps Script, Workspace, Firebase, Cloud… Cần khoá API Google Cloud (bật Developer Knowledge API).', inputs: [{ key: 'X-Goog-Api-Key', kind: 'header', label: 'Khoá API Google Cloud', help: 'Google Cloud Console → Credentials → API key (bật Developer Knowledge API).', secret: true }] }),
  // ── Thương mại, website, thanh toán, giao tiếp ──
  npx('shopify-dev', 'Shopify Dev (tài liệu, lược đồ GraphQL)', 'Shopify', 'dev', 'Tra cứu tài liệu Shopify, lược đồ Admin GraphQL và kiểm tra mã GraphQL cho lập trình ứng dụng/theme; không truy cập cửa hàng.', ['@shopify/dev-mcp@latest'], { note: 'Chỉ tài liệu và lược đồ GraphQL của Shopify; không quản lý cửa hàng.' }),
  http('wordpress-com', 'WordPress.com', 'Automattic', 'design', 'Quản lý mọi site trên tài khoản WordPress.com (bài viết, trang, bình luận, media…) qua một kết nối MCP chính thức; OAuth.', 'https://public-api.wordpress.com/wpcom/v2/mcp/v1', 'oauth'),
  npx('wordpress-mcp-adapter', 'WordPress / WooCommerce (tự lưu trữ)', 'Automattic', 'design', 'Nối site WordPress/WooCommerce (đã cài plugin MCP Adapter) vào trợ lý: sản phẩm, đơn hàng, nội dung theo quyền người dùng.', ['@automattic/mcp-wordpress-remote'], { note: 'Cần cài plugin WordPress/mcp-adapter trên website.', inputs: [{ key: 'WP_API_URL', kind: 'env', label: 'Địa chỉ website WordPress', help: 'Ví dụ https://congty.vn' }, { key: 'WP_API_USERNAME', kind: 'env', label: 'Tên người dùng WordPress (tuỳ chọn)', optional: true }, { key: 'WP_API_PASSWORD', kind: 'env', label: 'Application password WordPress (tuỳ chọn)', secret: true, optional: true }] }),
  http('sanity', 'Sanity', 'Sanity', 'design', 'Quản lý nội dung và lược đồ Sanity (CMS headless) qua máy chủ MCP từ xa chính thức; đăng nhập OAuth.', 'https://mcp.sanity.io', 'oauth'),
  http('resend', 'Resend (gửi email)', 'Resend', 'comm', 'Gửi email, quản lý domain, audience và broadcast trên Resend qua máy chủ MCP chính thức; OAuth.', 'https://mcp.resend.com/mcp', 'oauth'),
  npx('xero-local', 'Xero', 'Xero', 'pay', 'Hoá đơn, liên hệ, tài khoản kế toán và báo cáo Xero qua máy chủ MCP chính thức (Custom Connection); chạy cục bộ.', ['@xeroapi/xero-mcp-server@latest'], { note: 'Máy chủ từ xa của Xero không cho đăng ký ứng dụng tự động nên dùng bản chạy trên máy với ứng dụng Xero của bạn.', inputs: [{ key: 'XERO_CLIENT_ID', kind: 'env', label: 'Client ID ứng dụng Xero', help: 'developer.xero.com → My Apps.' }, { key: 'XERO_CLIENT_SECRET', kind: 'env', label: 'Client secret ứng dụng Xero', secret: true }] }),
  npx('slack-community', 'Slack (token cá nhân/bot)', 'korotovsky (cộng đồng)', 'comm', 'Đọc kênh, tin nhắn, DM và tìm kiếm Slack bằng token của bạn; đăng tin tắt mặc định. Cách dùng Slack khi mục chính thức chưa hỗ trợ.', ['slack-mcp-server@latest', '--transport', 'stdio'], { note: 'Dùng token xoxp-/xoxb- của ứng dụng Slack do bạn tạo. KHÔNG dùng token xoxc/xoxd lấy từ cookie trình duyệt (có thể vi phạm điều khoản của workspace).', inputs: [{ key: 'SLACK_MCP_XOXP_TOKEN', kind: 'env', label: 'Token Slack (xoxp-… hoặc xoxb-…)', help: 'api.slack.com/apps → OAuth & Permissions.', secret: true }] }),
  npx('discord', 'Discord (bot)', 'barryyip0625 (cộng đồng)', 'comm', 'Đọc và gửi tin nhắn, quản lý kênh Discord bằng bot của bạn; dự án cộng đồng.', ['mcp-discord'], { inputs: [{ key: 'DISCORD_TOKEN', kind: 'env', label: 'Token bot Discord', help: 'discord.com/developers → Bot → Reset Token.', secret: true }] }),
];

export const CATEGORY_ORDER: McpCategory[] = ['memory', 'dev', 'pm', 'office', 'comm', 'crm', 'data', 'cloud', 'auto', 'pay', 'design', 'docs', 'search', 'browser', 'files'];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

const sub = (s: string, workspaceFolder: string | undefined, home: string): string => s.split('${workspaceFolder}').join(workspaceFolder ?? '').split('${HOME}').join(home);

/** Cấu hình MCP để thêm vào cài đặt cho một mục chạy cục bộ; null nếu thiếu workspace hoặc không phải mục cục bộ. */
export function localConfig(e: CatalogEntry, workspaceFolder: string | undefined, home: string): CatalogServerConfig | null {
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
export function describeServer(cfg: CatalogServerConfig): ServerDescription {
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
