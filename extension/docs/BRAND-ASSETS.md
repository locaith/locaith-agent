# Logo thương hiệu trong Chợ (MCP · Plugin · Kỹ năng)

Các ô logo ở tab MCP, Plugin và Kỹ năng (`webview/src/components/BrandIcon.tsx`) vẽ từ kho SVG tĩnh
`webview/src/brand/logos.ts`. Không tải ảnh qua mạng, không dựng SVG từ chuỗi nhận về: chỉ dùng path đã kiểm duyệt
trong tệp này. Mục nào không có logo hợp lệ thì hiện **monogram** (1–2 chữ cái, sắc độ cố định theo tên).

> **Nhãn hiệu.** Logo là nhãn hiệu của chủ sở hữu tương ứng, chỉ được hiển thị để nhận diện dịch vụ tương thích;
> việc hiển thị không có nghĩa là có quan hệ đối tác hay được chứng thực.
>
> **Trademarks.** Logos are trademarks of their respective owners and are shown only to identify compatible services.
> Their display does not imply endorsement or affiliation.

## Nguồn và giấy phép

| Nguồn | Phiên bản | Giấy phép | Dùng cho |
| --- | --- | --- | --- |
| [Simple Icons](https://github.com/simple-icons/simple-icons) (`simple-icons` trên npm) | 16.36.0 | CC0-1.0 | 118 logo một màu (glyph + mã màu hãng) |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg`) | 1.102.0 | MIT, © LobeHub | 14 logo nhiều màu: Google, Google Cloud, Microsoft, Figma, Hugging Face, AWS, Cloudflare, Exa, Tavily, Firecrawl, Langfuse, Greptile, Together AI, Lovable |
| Locaith | — | của Locaith | Logo "Lo" (`webview/src/brand/lo.ts`) cho Bio-Memory-Locaith |

Văn bản giấy phép MIT của Lobe Icons (bắt buộc giữ khi phân phối lại):

```
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Biến đổi đã làm: chỉ trích path và màu. Không chỉnh hình dạng logo nào.

Tổng cộng 132 logo thương hiệu (118 Simple Icons + 14 Lobe Icons) và logo "Lo" của Locaith = 133 mục trong `LOGOS`.

## Đã gỡ theo yêu cầu của chủ thương hiệu

Trước 0.5.2, 11 logo được lấy từ các bản Simple Icons cũ vì Simple Icons đã bỏ chúng khỏi bản mới theo yêu cầu của chủ thương hiệu
(bản phát hành cũ vẫn là CC0 về quyền tác giả, nhưng quyền nhãn hiệu thuộc chủ sở hữu). Locaith **đã gỡ cả 11**, không dùng lại:

- từ Simple Icons 13.21.0: **Oracle, Salesforce, Adobe, Twilio, Slack, Canva**;
- từ Simple Icons 9.21.0: **Microsoft Azure, Playwright, Zoho, Sourcegraph, C#**.

Các mục dịch vụ/plugin/nguồn kỹ năng của những hãng này nay hiện **monogram** như mọi mục không có logo. Mã chốt chặn để không ai thêm lại:

- `webview/dev/gen-logos.mjs` có `REMOVED_AT_OWNER_REQUEST` và từ chối chạy nếu một khoá đó xuất hiện lại trong `BRANDS`; script cũng không còn
  nhận nguồn `si13:` / `si9:` (chỉ `si:` = Simple Icons hiện hành và `lobe:`);
- `webview/src/brand/logos.ts` có `NO_LOGO_BRANDS`: mục mà chính id/tên là hãng đó phải ra monogram, không được rơi sang logo hãng mẹ hay kho chứa
  (Playwright không mượn logo Microsoft, `csharp-lsp` không mượn logo Anthropic…);
- `test/webview/brandLogos.test.ts` kiểm danh sách này khớp giữa test, generator và dữ liệu.

### Danh sách theo nguồn

- **Simple Icons 16.36.0:** Anthropic, Model Context Protocol, NVIDIA, LangChain, Upstash, Zapier, Google BigQuery,
  Google Cloud Spanner, Looker, Google Chrome, Apple, iMessage, SAP, AMD, Intuit, QuickBooks, Spotify, JetBrains,
  TeamCity, Unity, Unreal Engine, Qt, GitHub, GitLab, GitKraken, Sentry, Vercel, Netlify, Railway, Render, Hostinger,
  Fastly, Docker, HashiCorp, Terraform, Expo, Firebase, Appwrite, Postman, Laravel, Shopify, WordPress, Buildkite,
  CodeRabbit, JFrog, SonarQube, Auth0, Mintlify, Sanity, Resend, RevenueCat, Apollo GraphQL, Quarkus, Convex, Cloudinary,
  Pydantic, Apache Airflow, Mapbox, Postiz, TypeScript, Python, Rust, Go, Swift, Kotlin, PHP, Ruby, Lua, C++, OpenJDK,
  Notion, Linear, ClickUp, Asana, Atlassian, Miro, Box, Dropbox, Coursera, Discord, Telegram, Intercom, Zoom, HubSpot,
  Supabase, Neon, Prisma, Airtable, Datadog, MongoDB, PlanetScale, PostgreSQL, MySQL, SQLite, Redis, ClickHouse,
  CockroachDB, Databricks, DuckDB, Snowflake, Qdrant, Milvus, MLflow, Grafana, New Relic, Dynatrace, PagerDuty, PostHog,
  Dash0, StackHawk, Stripe, PayPal, Square, Mercado Pago, SumUp, Webflow, Wix, ElevenLabs.
- **Lobe Icons 1.102.0:** Google, Google Cloud, Microsoft, Figma, Hugging Face, Amazon Web Services, Cloudflare, Exa,
  Tavily, Firecrawl, Langfuse, Greptile, Together AI, Lovable.

## Cố ý dùng monogram

Không tìm được SVG có giấy phép cho phép phân phối lại (không có trong Simple Icons hiện hành, không có
trong Lobe Icons): **monday.com**, **Honeycomb**, **DeepWiki (Cognition)**, nguồn kỹ năng cộng đồng **obra/superpowers**
và **wshobson/agents**, cùng các plugin của hãng nhỏ (Vanguard, Carta, Pendo, Amplitude…).

Cộng với 11 hãng đã gỡ logo theo yêu cầu của chủ thương hiệu (mục ở trên): trong kho MCP là **Slack**, **Canva**, **Playwright**;
nguồn kỹ năng **twilio-skills**; plugin Slack, Azure, Salesforce, Twilio, Adobe, Canva, Oracle, C# (`csharp-lsp`)…

Danh sách mục kho MCP cố ý dùng monogram nằm trong `test/webview/brandLogos.test.ts` (`INTENTIONAL_MONOGRAM`); thêm logo mới thì bỏ id khỏi đó.

## Sinh lại / thêm logo

1. Cài gói vào thư mục tạm **ngoài** dự án (không thêm phụ thuộc vào `package.json`):
   `npm i simple-icons@16.36.0 @lobehub/icons-static-svg@1.102.0`. Chỉ dùng bản Simple Icons **hiện hành** — không lấy logo từ bản cũ
   (đó chính là cách 11 logo đã gỡ lọt vào trước đây).
2. Thêm dòng vào bảng `BRANDS` trong `webview/dev/gen-logos.mjs` (khoá, tên, nguồn `si:<slug>` hoặc `lobe:<tệp>`, tông, tên gọi khác).
3. `node webview/dev/gen-logos.mjs <tmp-icons> webview/src/brand/logos.ts` — phần dữ liệu được sinh lại,
   phần viết tay (`brandFor`, `monogram`, màu glyph, `NO_LOGO_BRANDS`) giữ nguyên.
4. Ghi nguồn vào tệp này, chạy `npx vitest run test/webview/brandLogos.test.ts` (kiểm tra cả dung lượng < 200 KB).

Tông hiển thị: `color` (glyph màu hãng trên nền nhuộm nhẹ, màu glyph tự pha để đạt tương phản ≥ 3:1, ≥ 4.5:1 ở theme
tương phản cao), `mono` (theo màu chữ của theme — GitHub, Notion, Vercel…), `multi` (giữ nhiều màu trên nền trung tính),
`solid` (nền màu hãng — Miro, ClickHouse, DuckDB).
