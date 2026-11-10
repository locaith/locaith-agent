# Kho MCP và chợ plugin mở rộng (0.7.7)

Mảnh ghi chú cho CHANGELOG. Khảo sát + thăm dò thật ngày 10/11/2026 (OAuth/DCR hoặc `tools/list` cho máy chủ từ xa; npm/PyPI còn sống, kho không archived, tài liệu khớp lệnh cho máy chủ chạy trên máy).

## Kho MCP: 36 → 110 mục

- **Văn phòng (mới)**: Google Workspace (Forms, Sheets, Docs, Drive, Apps Script — `workspace-mcp`), Google Sheets bằng tài khoản dịch vụ, Apps Script (`clasp mcp`), Excel cục bộ, MarkItDown (PDF/Word/Excel/PowerPoint → Markdown), Microsoft 365 (Outlook, OneDrive, Excel, Teams…).
  Đây là thứ phiên của chị Duyên cần: điều khiển Google Forms/Sheets/Apps Script bằng API thay vì thao tác Chrome (chậm hơn và hỏi quyền mỗi lần).
- **Đám mây & vận hành (mới)**: Azure, Google Cloud (gcloud, Observability), Firebase, AWS API (đặt sẵn chỉ đọc + hỏi trước khi ghi), Kubernetes, Cloudflare API (Code Mode), Grafana (Cloud + tự lưu trữ), New Relic, PagerDuty.
- **CRM & marketing (mới)**: Ahrefs, Semrush, Klaviyo, Apollo, Attio. **Tự động hoá (mới)**: Zapier, Make, n8n.
- **Dự án/cộng tác**: Atlassian (Jira, Confluence, Compass), Trello, Todoist, Calendly, Fireflies, Granola, Typeform, Miro, Dropbox. **Phát triển**: GitLab, Netlify, Railway, Hostinger, Postman, Azure DevOps, Render, Shopify Dev.
- **Dữ liệu**: BigQuery, MongoDB (chỉ đọc), PostgreSQL Pro (restricted), Pinecone, Qdrant, PlanetScale, ClickHouse Cloud, Appwrite, PostHog, Amplitude, Mixpanel. **Tìm kiếm & web**: Firecrawl, Tavily, Jina, Apify, Bright Data, Fetch, DuckDuckGo, Brave Search, Perplexity. **Tài liệu**: OpenAI, Twilio, Bitrix24, AWS Knowledge, Google Developer Knowledge. **Khác**: WordPress.com / WordPress tự lưu trữ, Sanity, Resend, Xero, Slack (token cá nhân/bot), Discord.
- **Sửa mục cũ**: Square đổi sang `https://mcp.squareup.com/mcp` (OAuth + đăng ký tự động) nên hết «chưa hỗ trợ»; Datadog đổi sang `/v1/mcp`. Atlassian và Zapier — trước đây không thăm dò được — nay đã có.

### Ô nhập khoá / ID / địa chỉ (`inputs`)

Mục cần khoá API, ID khách hàng OAuth của chính bạn hay địa chỉ máy chủ riêng khai `inputs` trong `core/mcp/catalog.ts`. Bấm **Kết nối** → VS Code hỏi lần lượt (ô bí mật dạng mật khẩu; `Esc` = huỷ, chưa lưu gì).

- Giá trị lưu trong **SecretStorage** (mã hoá bằng kho khoá hệ điều hành), khoá `mcp.input.<mục>.<số thứ tự>`. Bản ghi kết nối trong `globalState` chỉ có phần MÔ TẢ (tên biến, loại, có bí mật không) — không có giá trị.
- Ghép vào cấu hình **lúc khởi động server**: biến môi trường (`env`), đối số (`arg`, không dùng cho bí mật vì lộ trong danh sách tiến trình), hoặc header HTTP (`header`; máy chủ từ xa xác thực bằng khoá, ví dụ Render `Bearer …`, PagerDuty `Token token=…`, `X-Goog-Api-Key`). Header được đọc lại từ SecretStorage ở MỖI yêu cầu nên đổi khoá không cần khởi động lại.
- Giao diện che giá trị bí mật «•••» kể cả khi tên biến không có chữ KEY/TOKEN (ví dụ `MDB_MCP_CONNECTION_STRING`), nhật ký che qua `registerSecret`, giá trị có xuống dòng bị từ chối.
- Ngắt kết nối xoá sạch mọi giá trị đã nhập; kết nối lại mà bỏ trống một ô tuỳ chọn thì giá trị cũ bị xoá.

### Chưa đưa vào (và lý do)

- **Cần OAuth client RIÊNG của người dùng** (8 máy chủ Google Workspace chính thức `*.googleapis.com/mcp/v1` — Developer Preview, không có đăng ký tự động; HubSpot; BigQuery từ xa): luồng đăng nhập hiện chỉ hỗ trợ đăng ký ứng dụng tự động (DCR). Dùng `workspace-mcp` ở trên thay thế.
- **Cần CIMD** (ElevenLabs; máy chủ MongoDB/MYOB từ xa): chưa hỗ trợ.
- **Thận trọng / rủi ro**: Desktop Commander (toàn quyền máy), Google Forms «A1» (0 sao, gửi telemetry), Bitrix24 CRM (chỉ có bản ghi Registry). Zalo, SePay, VietQR, payOS, MISA, Haravan, Sapo, GHN, GHTK, KiotViet: chưa có máy chủ MCP chính thức; chỉ có cổng của bên thứ ba giữ khoá của khách — không đưa.

## Chợ plugin: 1 nguồn → 11 nguồn

`core/plugins/marketplace.ts` → `MARKETPLACES`. Giao diện có bộ lọc theo nguồn; nguồn cộng đồng có nhãn «cộng đồng» và dải cảnh báo.

- **Anthropic**: chợ chính thức (316), công việc tri thức (`knowledge-work-plugins`, +37 plugin riêng), tài chính (19), kỹ năng mẫu `anthropics/skills` (Word, Excel, PowerPoint, PDF, claude-api, skill-creator, mcp-builder… 5 gói), Claude Code (12, đều đã có ở chợ chính thức).
- **Hãng**: Microsoft (13), Microsoft · Azure (7), AWS Labs. **Cộng đồng (có nhãn)**: Superpowers (8), wshobson/agents (94), marketingskills.
- Tổng **501 plugin** (trước đây 316). Cùng MỘT plugin có ở nhiều chợ chỉ hiện ở nguồn đứng trước (105/120 mục trùng tên là như vậy); cùng tên nhưng khác plugin thì giữ cả hai, id thêm hậu tố `-<nguồn>`.
- `source: "./"` (cả gốc kho là plugin) nay được nhận: có danh sách `skills` thì chỉ lấy đúng các thư mục đó (mỗi thư mục thành `skills/<tên>/`); không có thì chỉ chép phần plugin ở gốc (`skills/`, `agents/`, `commands/`, `.mcp.json`…).
- Không đổi quy tắc an toàn: chỉ tải khi bạn bấm Cài (không đóng gói lại), plugin cài về **TẮT**, máy chủ MCP của plugin phải được duyệt riêng, hooks/LSP không chạy.

## English (short)

- **MCP catalog 36 → 110 entries** (probed 2026-11-10): new Office (Google Workspace incl. Forms/Sheets/Apps Script via `workspace-mcp`, Sheets via service account, clasp, Excel, MarkItDown, Microsoft 365), Cloud & operations, CRM & marketing and Automation groups, plus Atlassian, GitLab, Trello, Todoist, Postman, Netlify, Railway, Render, BigQuery, MongoDB, Pinecone, Firecrawl, Tavily, Brave, Perplexity and more. Square (new `/mcp` URL) is no longer "unsupported"; Datadog moved to `/v1/mcp`.
- **`inputs`**: entries that need an API key / your own OAuth client ID / a server address ask for them on Connect (password-style box for secrets). Values live in SecretStorage only, are merged into the config when the server starts (env, positional/flag args, or HTTP headers re-read on every request), are masked in the UI and logs, and are removed on Disconnect.
- Not included: servers that need your own OAuth client (official Google Workspace MCP, HubSpot) or CIMD (ElevenLabs) — the sign-in flow only supports dynamic client registration for now; risky/unverified servers were left out on purpose.
- **Plugin market 1 → 11 sources, 501 plugins**: official, knowledge-work, financial-services, `anthropics/skills`, Microsoft, Azure, AWS Labs, plus clearly labelled community sources (Superpowers, wshobson/agents, marketingskills). Source filter in the UI; the same plugin listed by several marketplaces appears once; `source: "./"` (repo root as plugin) is now understood. Plugins still install OFF, MCP servers still need separate approval, hooks/LSP still do not run.
