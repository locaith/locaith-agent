# Luật quyền allow / ask / deny và duyệt kế hoạch (lane perm-rules)

Mảnh ghi chú cho CHANGELOG. Mỗi gạch đầu dòng là một thay đổi nhìn thấy được, kèm cách dùng và cài đặt liên quan.

## Thay đổi nhìn thấy được

- **Luật quyền bền theo mẫu** — ba cài đặt mới `locaithAgent.permissions.allow` / `.ask` / `.deny` (mảng chuỗi). Cú pháp `công_cụ(đặc tả)`:
  `run_command(npm test:*)` (tiền tố lệnh), `run_command(git diff*)` (mẫu `*`), `edit_file(src/**)` / `write_file(docs/**)` (glob trong workspace),
  `read_file(.env*)` (mẫu không có `/` khớp theo tên tệp ở mọi cấp), `fetch_url(domain:github.com)` (`domain:*.github.com` cho tên miền con),
  `mcp__server__tool` hoặc `mcp__server__*` (tên công cụ trần). Ưu tiên **deny > ask > allow**, xét TRƯỚC chế độ quyền:
  deny chặn tuyệt đối (kể cả chế độ bỏ qua xác nhận), ask ép hỏi (kể cả «tự nhận chỉnh sửa» và bypass), allow bỏ câu hỏi — nhưng yêu cầu ngoài
  workspace / tệp bí mật / lệnh nguy hiểm vẫn hỏi, và chế độ lập kế hoạch vẫn chỉ cho đọc.
- **Khớp lệnh an toàn** — lệnh ghép (`a && b`, `a; b`, `a | b`, `a & b`, `||`, xuống dòng) được tách và luật allow phải khớp MỌI phần
  (`npm test && rm -rf /` không bao giờ được `run_command(npm test:*)` cho qua). Lệnh có `$(…)`, backtick, `${…}`, chuyển hướng `>`/`<`, dấu nháy
  lệch hay ký tự nháy/ngắt Unicode không bao giờ được allow theo luật (vẫn bị deny/ask bắt). Phần trong dấu nháy không bị tách; khoảng trắng và dấu
  nháy quanh token được chuẩn hoá trước khi khớp. Đường dẫn được chuẩn hoá theo đường dẫn thật (symlink, tên ngắn), chặn `..`, không phân biệt
  hoa/thường trên Windows.
- **Luật từ workspace** — `.vscode/settings.json` của dự án chỉ được thêm luật **ask** và **deny** (siết chặt). Luật **allow** của dự án chỉ có hiệu
  lực sau khi bạn chấp nhận danh sách đó MỘT lần (nút «Chấp nhận danh sách này» trong khu quản lý, hoặc `/permissions trust`); đổi danh sách là phải
  chấp nhận lại (băm nội dung lưu ở `locaithAgent.permissions.trustedWorkspaceAllow`, cấp người dùng). Workspace chưa tin cậy ⇒ bỏ qua mọi luật allow.
  Khi mở dự án có luật allow chờ xác nhận, khung chat nhắc một lần mỗi phiên.
- **Nút «Luôn cho phép …» trên thẻ xin quyền** — host đề xuất đặc tả hợp lý từ lệnh/đường dẫn (`npm run test:*`, `git diff:*`, thư mục chứa tệp
  `edit_file(src/utils/**)`, `fetch_url(domain:api.github.com)`, tên công cụ MCP). Bấm vào là mở ô sửa đặc tả + chọn phạm vi («Cài đặt của tôi» /
  «Dự án này»), rồi «Lưu luật và cho phép». Lệnh nguy hiểm (rm -rf, sudo, format, git push --force, curl | sh, gửi dữ liệu ra ngoài…), lệnh ghép,
  yêu cầu ngoài workspace / tệp bí mật KHÔNG có đề xuất. Luật quá rộng (`run_command`, `run_command(*)`) không lưu được từ thẻ. Các nút cũ
  («Cho phép», «… trong phiên này», «Từ chối», «Từ chối kèm góp ý») giữ nguyên.
- **Thấy luật nào vừa quyết định** — dòng công cụ ghi «cho phép bởi luật run_command(npm test:*)» khi được luật cho qua; thẻ xin quyền ghi
  «hỏi theo luật …» khi luật ask buộc hỏi; model nhận lý do «Bị chặn bởi luật quyền …» khi bị deny. Các dòng này cũng tới Remote (locaith.ai) và
  bản Chrome vì chỉ là trường tuỳ chọn của sự kiện/khối đã có.
- **Lệnh `/permissions`** — mở khu «Luật quyền» trong Cài đặt (ba nhóm Chặn / Luôn hỏi / Cho phép, nguồn cá nhân·dự án, nút xoá, ô thêm luật,
  ô «Thử khớp một lệnh» chạy ngay trong giao diện bằng cùng bộ so khớp với engine) và in tóm tắt bộ luật vào khung chat. Dạng chữ dùng được từ
  Remote: `/permissions allow run_command(npm test:*)`, `/permissions deny read_file(.env*)`, `/permissions remove <luật>`,
  `/permissions test npm test && rm -rf /`, `/permissions trust`.
- **Thẻ duyệt kế hoạch** — ba nút rõ ràng: «Duyệt và tự nhận chỉnh sửa», «Duyệt, hỏi từng bước», «Tiếp tục lập kế hoạch kèm góp ý» (nhập góp ý
  rồi gửi). Kế hoạch vẫn hiển thị Markdown như trước.
- **Shift+Tab trong ô nhập** xoay vòng chế độ quyền default → acceptEdits → plan (bypass không nằm trong vòng; đang bypass thì về default). Huy hiệu
  chế độ cạnh ô nhập đổi theo; di chuột lên huy hiệu thấy gợi ý phím.

## Cài đặt liên quan

| Khoá | Phạm vi | Ý nghĩa |
| --- | --- | --- |
| `locaithAgent.permissions.allow` | người dùng (dự án: cần xác nhận) | luật cho phép không hỏi |
| `locaithAgent.permissions.ask` | người dùng + dự án | luật luôn hỏi |
| `locaithAgent.permissions.deny` | người dùng + dự án | luật chặn tuyệt đối |
| `locaithAgent.permissions.trustedWorkspaceAllow` | người dùng | băm các danh sách allow của dự án đã chấp nhận (xoá để hỏi lại) |

`locaithAgent.agent.allowBypassPermissions` và rào chắn `/mode bypass` giữ nguyên.

## Kiểm thử

`test/permissionRules.test.ts` (bộ so khớp + ≥50 ca đối kháng), `test/permissionRulesEngine.test.ts` (dispatcher đầu-cuối qua FakeProvider: deny kể cả
bypass, allow bỏ hỏi, lệnh ghép, đường dẫn, ask ở acceptEdits, đề xuất, nhắc workspace), `test/permissionRulesService.test.ts` (nguồn luật theo cấp,
băm xác nhận, Workspace Trust, SECURE_KEYS), `test/permissionsFeature.test.ts` (`/permissions`, tin «Luôn cho phép», thêm/xoá/trust),
`test/permissionRulesRemote.test.ts` (cắt/lọc trường mới cho Remote, transcript), `test/webview/permRulesView.test.ts` (Shift+Tab, mô hình thẻ quyền,
thử khớp trong giao diện).

---

## English (short)

- New persistent permission rules `locaithAgent.permissions.allow/ask/deny` with `tool(spec)` syntax (`run_command(npm test:*)`, `edit_file(src/**)`,
  `read_file(.env*)`, `fetch_url(domain:github.com)`, `mcp__server__*`). Priority deny > ask > allow, evaluated before the permission mode; deny blocks
  even in bypass, ask forces a prompt even in accept-edits, allow skips the prompt except for elevated requests (outside workspace, secret files,
  dangerous commands).
- Compound commands are split and every part must match an allow rule; substitutions, redirections, unbalanced quotes and suspicious Unicode are never
  allowed by rule. Paths are canonicalised (symlinks, `..`, case on Windows).
- Workspace settings may only add ask/deny rules; workspace allow rules apply after a one-time confirmation (content hash stored per user); untrusted
  workspaces ignore all allow rules.
- Permission card gains "Always allow <suggested spec>" with an editable spec and user/workspace scope; no suggestion for dangerous or compound commands.
  Tool rows show "allowed by rule …", cards show "asked by rule …".
- `/permissions` opens the rules panel in Settings (list by action with source, remove, add, try-match box) and works as text from Remote
  (`/permissions allow|ask|deny|remove|test|trust`).
- Plan card: "Approve and auto-accept edits", "Approve, ask each step", "Keep planning with feedback". Shift+Tab cycles default → acceptEdits → plan.
