/**
 * Chuỗi hiển thị do engine/host sinh ra (không phải chuỗi của webview). Hai ngôn ngữ: vi (mặc định) và en.
 */

export type Lang = 'vi' | 'en';

const vi = {
  thinking: 'Đang suy nghĩ…',
  writing: 'Đang soạn nội dung…',
  writingTo: 'Đang viết {target}…',
  retrying: 'Máy chủ đang bận, thử lại sau {sec} giây (lần {n}/{max})…',
  queueing: 'Đang có nhiều lượt sử dụng, vui lòng chờ xử lý — vị trí {pos} trong hàng…',
  compacting: 'Đang nén các tin nhắn cũ để giải phóng ngữ cảnh…',
  compacted: 'Đã nén {n} tin nhắn cũ để giải phóng ngữ cảnh.',
  compactedPruned: 'Đã lược bớt các kết quả công cụ cũ để giải phóng ngữ cảnh.',
  maxTurns: 'Đã đạt số vòng lặp tối đa ({n}). Trợ lý sẽ tóm tắt tiến độ; bạn có thể nhắn "tiếp tục" để chạy tiếp.',
  maxTokensContinue: 'Câu trả lời bị cắt do giới hạn độ dài, đang yêu cầu viết tiếp…',
  refusal: 'Model từ chối thực hiện yêu cầu này (bộ lọc an toàn của nhà cung cấp).',
  contentFilter: 'Nội dung bị bộ lọc của nhà cung cấp chặn.',
  authError: 'Khóa API của {provider} không hợp lệ hoặc đã hết hạn. Mở Cài đặt để nhập lại.',
  noKey: 'Chưa có API key cho {provider}. Mở Cài đặt để thêm khóa.',
  consentRequired: 'Cần đồng ý thông báo dữ liệu của Locaith trước khi dùng {provider}. Thẻ thông báo đã hiện ở cuối cuộc trò chuyện — đồng ý rồi bấm «Thử lại».',
  accountInvalid: 'Phiên đăng nhập Locaith không còn hiệu lực — đang kiểm tra lại tài khoản. Nếu được yêu cầu, hãy đăng nhập lại rồi bấm «Thử lại».',
  rateLimit: 'Đã bị giới hạn tốc độ ({provider}). Hãy thử lại sau ít phút.',
  overloaded: 'Máy chủ {provider} đang quá tải. Hãy thử lại sau.',
  networkError: 'Không kết nối được tới {provider}: {detail}',
  contextTooLong: 'Cuộc trò chuyện đã vượt giới hạn ngữ cảnh của model, ngay cả sau khi nén.',
  providerError: 'Lỗi từ {provider}: {detail}',
  aborted: 'Đã dừng theo yêu cầu.',
  unknownTool: 'Công cụ "{name}" không tồn tại hoặc chưa được mở khóa. Dùng load_skill/search_skills để tìm.',
  toolCancelled: 'Người dùng đã dừng trước khi công cụ này chạy xong.',
  // Kết quả "bù" cho lệnh gọi mồ côi (lượt trước bị Dừng/lỗi giữa vòng công cụ). Nói rõ là ĐÃ HUỶ để model không chạy lại.
  toolInterrupted: 'Người dùng đã dừng trước khi thao tác này chạy xong — không có kết quả. Đừng chạy lại: hãy xem việc này là đã huỷ và tiếp tục phần còn lại.',
  toolDenied: 'Người dùng đã từ chối thao tác này.',
  toolDeniedWithFeedback: 'Người dùng đã từ chối thao tác này và nhắn: "{feedback}"',
  planMode: 'Đang ở chế độ lập kế hoạch: chỉ được đọc và nghiên cứu, chưa được sửa tệp hay chạy lệnh.',
  titleDefault: 'Cuộc trò chuyện mới',
  budget: '[vòng {n}/{max} · còn {left} vòng]',
  budgetLow: '[vòng {n}/{max} · còn {left} vòng — CHỐT VIỆC, KHÔNG MỞ VIỆC MỚI]',
  // Nhãn đếm của tin nhắc hoàn thành (engine ghép vào đầu tin nhắc): để model biết đây là lần thứ mấy và phải đổi cách làm.
  gateLabel: '[nhắc lần {n}]',
  // Lần cổng can thiệp THỨ BA: không chèn nhắc nữa (nhắc vô hạn chỉ đốt thêm lượt gọi) mà dừng và nói thẳng với người dùng.
  // {n} = số lần ĐÃ nhắc thật (không tính lần chốt này).
  gateFinal: 'Đã nhắc {n} lần nhưng vẫn còn việc chưa xong: {list}. Dừng ở đây để bạn quyết định — nhắn "tiếp tục" để trợ lý làm nốt các việc này, hoặc đổi yêu cầu.',
  gateFinalVerify: 'Trợ lý đã sửa tệp nhưng chưa chạy lệnh kiểm chứng nào (build / test) dù đã được nhắc. Hãy tự kiểm tra kết quả, hoặc nhắn "kiểm chứng" để trợ lý chạy.',
  todoReminder:
    'Bạn vẫn còn tác vụ chưa hoàn thành trong danh sách (todo_write). Hãy hoàn tất chúng hoặc cập nhật trạng thái cho đúng thực tế trước khi kết thúc.',
  gateTodos:
    'Bạn còn {n} việc chưa xong: {list}. Đừng dừng để hỏi khi câu trả lời nằm ngay trong workspace — đọc tệp hoặc chạy lệnh để tự trả lời, rồi làm tiếp việc kế tiếp ngay trong lượt này và cập nhật todo_write cho đúng thực tế. Nếu thật sự bị chặn (thiếu quyền, thiếu khoá, thiếu dữ liệu), nói rõ đúng việc nào và thiếu gì.',
  gateVerify:
    'Bạn đã sửa tệp nhưng chưa chạy gì để kiểm chứng. Hãy chạy phép kiểm tra thật (test / typecheck / build / chạy thử sản phẩm), đọc kết quả, lỗi thì sửa rồi chạy lại. Chỉ báo hoàn thành khi có kết quả thật để dẫn ra; nếu không chạy được, nói rõ vì sao.',
  continuePrompt: 'Hãy tiếp tục từ đúng chỗ bị dừng, không lặp lại phần đã viết.',
  emptyReplyNudge: 'Hãy trả lời người dùng bằng văn bản dựa trên kết quả công cụ ở trên.',
  steerHeader:
    '[Người dùng vừa gửi thêm {n} tin nhắn trong lúc bạn đang làm việc — mỗi tin là MỘT VIỆC MỚI, xem bên dưới. Làm xong việc đang dở trước, rồi làm LẦN LƯỢT từng việc mới theo đúng thứ tự và không bỏ việc nào: cập nhật danh sách tác vụ (todo_write) cho việc đang làm, hoàn thành xong mới sang việc kế tiếp.]',
  steerItem: 'Việc mới',
  queuedImageTask: '(ảnh)',
  maxTurnsWrapUp:
    'Đã hết số vòng lặp cho phép. KHÔNG gọi thêm công cụ. Hãy tóm tắt ngắn gọn: đã làm được gì, còn lại việc gì, và bước tiếp theo đề xuất.',
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  budgetBlock:
    '[hết ngân sách vòng] Còn {left} vòng — công cụ khám phá ({name}) không được chạy nữa. Chỉ ghi/sửa tệp, chạy một phép kiểm tra, rồi chốt bằng ba phần: đã xong gì · còn lại gì · chạy tiếp bằng lệnh nào.',
  budgetGrace: '[sắp hết ngân sách] Đây là lần đọc cuối được phép (còn {left} vòng, lượt này chưa ghi/chạy gì). Dùng kết quả này để chốt việc có nghĩa, không khám phá thêm.',
  loopNote: '[phá vòng lặp] {name} đã trả cùng một kết quả {n} lần liên tiếp. Đổi chiến lược: đọc mã/nguồn trước, thu hẹp phạm vi, hoặc hỏi người dùng một câu cụ thể. Không thử biến thể nữa.',
  loopBlock:
    '[phá vòng lặp] Không chạy: {name} đã cho cùng một kết quả {n} lần liên tiếp và lệnh này gần như y hệt lần trước. Đổi hẳn cách làm (công cụ khác, đọc mã, thu hẹp phạm vi), hoặc dừng và nêu rõ vướng mắc với người dùng.',
  jsonGuide: 'Không tự sửa được an toàn. Nội dung dài, nhiều dấu nháy hay xuống dòng → đừng tự ghép chuỗi JSON: gọi write_file/edit_file với nội dung thô, chia nhỏ nếu cần',
  jsonGuideStrong:
    'Đây là lần thứ {n} liên tiếp đối số JSON hỏng. BẮT BUỘC đổi cách: dùng write_file với nội dung thô (không nhúng JSON lồng nhau, không tự thoát dấu nháy), mỗi lần một tệp và ngắn hơn; nếu vẫn kẹt thì nói rõ với người dùng thay vì thử lại',
  // Cổng hoàn thành: lần nhắc 1 kèm trạng thái THẬT; lần 2 bắt làm KHÁC; lần 3 tự đóng và báo.
  gateTodosAgain:
    'Bạn vừa được nhắc mà danh sách vẫn y nguyên: {list}. Lần này KHÔNG lặp lại câu cũ — làm ĐÚNG MỘT trong ba: (1) gọi todo_write đưa trạng thái về đúng thực tế (việc đã làm → completed; việc không làm được → blocked kèm note lý do); (2) nói rõ việc nào không đóng được và thiếu gì; (3) hỏi người dùng đúng một câu cụ thể để gỡ.',
  gateFinalAnswer:
    'Câu trả lời cuối đang trỏ vào chỗ khác ("ở trên", "như đã nói") hoặc quá ngắn so với lượt làm việc dài. Người dùng không thấy nhật ký — hãy viết lại ĐẦY ĐỦ, tự đứng được: kết quả (bảng/danh sách/kết luận), bằng chứng đã kiểm, việc còn lại và lệnh chạy tiếp nếu có.',
  gateFinalClosed:
    'Đã nhắc {n} lần nhưng vẫn còn việc chưa xong: {list} — đã đánh dấu «bị chặn» để không nhắc nữa{done}. Dừng ở đây để bạn quyết định — nhắn "tiếp tục" để trợ lý làm nốt, hoặc đổi yêu cầu.',
  gateFinalClosedDone: '; {k} việc có vết làm xong đã được đánh dấu hoàn thành: {doneList}',
  todoBlockedNoEvidence: 'chưa có vết ghi tệp hay chạy lệnh khớp tên việc; trợ lý đã được nhắc 2 lần mà không cập nhật',
  todoStatusBlocked: 'bị chặn',
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
};

const en: typeof vi = {
  thinking: 'Thinking…',
  writing: 'Drafting content…',
  writingTo: 'Writing {target}…',
  retrying: 'Server is busy, retrying in {sec}s (attempt {n}/{max})…',
  queueing: 'Many people are using Locaith right now — please wait · position {pos} in line…',
  compacting: 'Compacting older messages to free up context…',
  compacted: 'Compacted {n} older messages to free up context.',
  compactedPruned: 'Trimmed old tool results to free up context.',
  maxTurns: 'Reached the maximum number of loop turns ({n}). The assistant will summarize progress; reply "continue" to keep going.',
  maxTokensContinue: 'The reply hit the length limit, asking the model to continue…',
  refusal: 'The model declined this request (provider safety filter).',
  contentFilter: 'The content was blocked by the provider filter.',
  authError: 'The {provider} API key is invalid or expired. Open Settings to re-enter it.',
  noKey: 'No API key for {provider}. Open Settings to add one.',
  consentRequired: 'You need to accept the Locaith data notice before using {provider}. The notice card is shown at the end of the conversation — accept, then press “Retry”.',
  accountInvalid: 'Your Locaith session is no longer valid — re-checking your account. If asked, sign in again and press “Retry”.',
  rateLimit: 'Rate limited ({provider}). Please retry in a few minutes.',
  overloaded: '{provider} is overloaded. Please retry later.',
  networkError: 'Could not reach {provider}: {detail}',
  contextTooLong: 'The conversation exceeds the model context limit even after compaction.',
  providerError: 'Error from {provider}: {detail}',
  aborted: 'Stopped as requested.',
  unknownTool: 'Tool "{name}" does not exist or is not unlocked. Use load_skill/search_skills to find it.',
  toolCancelled: 'The user stopped before this tool finished.',
  toolInterrupted: 'The user stopped before this action finished — there is no result. Do not run it again: treat it as cancelled and continue with the rest.',
  toolDenied: 'The user denied this action.',
  toolDeniedWithFeedback: 'The user denied this action and said: "{feedback}"',
  planMode: 'Plan mode: read and research only — no file edits or commands yet.',
  titleDefault: 'New conversation',
  budget: '[turn {n}/{max} · {left} turns left]',
  budgetLow: '[turn {n}/{max} · {left} turns left — WRAP UP, DO NOT START NEW WORK]',
  gateLabel: '[reminder {n}]',
  gateFinal: 'Reminded {n} time(s) and work is still unfinished: {list}. Stopping here so you can decide — reply "continue" to have the assistant finish these, or change the request.',
  gateFinalVerify: 'The assistant changed files but never ran a verifying command (build / test), even after being reminded. Check the result yourself, or reply "verify" to have it run one.',
  todoReminder:
    'You still have unfinished tasks in your todo list (todo_write). Finish them, or update their status to match reality, before ending.',
  gateTodos:
    'You still have {n} unfinished task(s): {list}. Do not stop to ask when the answer is already in the workspace — read the file or run the command and answer it yourself, then do the next task in this same turn and keep todo_write accurate. If you are genuinely blocked (missing permission, credentials or data), say exactly which task and what is missing.',
  gateVerify:
    'You changed files but ran nothing that verifies the change. Run the real check (tests / typecheck / build / the product itself), read the result, fix what fails and run it again. Only report completion when you have a real result to quote; if no check can be run, say precisely why.',
  continuePrompt: 'Continue exactly where you stopped; do not repeat what you already wrote.',
  emptyReplyNudge: 'Answer the user in text based on the tool results above.',
  steerHeader:
    '[The user sent {n} more message(s) while you were working — each one is a NEW TASK, listed below. Finish what you are doing first, then work through the new tasks ONE AT A TIME in the order given and do not drop any: keep the task list (todo_write) in sync — mark the current one in_progress and completed before starting the next.]',
  steerItem: 'New task',
  queuedImageTask: '(image)',
  maxTurnsWrapUp:
    'The loop budget is exhausted. Do NOT call more tools. Briefly summarize: what was done, what remains, and the suggested next step.',
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  budgetBlock:
    '[turn budget exhausted] {left} turns left — exploratory tools ({name}) are no longer allowed. Only write/edit files, run one check, then wrap up in three parts: what is done · what is left · the exact command to resume.',
  budgetGrace: '[budget nearly exhausted] This is the last read allowed ({left} turns left, nothing written/run yet this turn). Use this result to wrap up meaningfully; no further exploration.',
  loopNote: '[loop breaker] {name} returned the same result {n} times in a row. Change strategy: inspect the code/source first, narrow the scope, or ask the user one precise question. Do not try another variation.',
  loopBlock:
    '[loop breaker] Not run: {name} produced the same result {n} times in a row and this call is nearly identical to the last one. Change approach entirely (another tool, read the code, narrow the scope), or stop and state the blocker to the user.',
  jsonGuide: 'Could not be repaired safely. Long content with many quotes or line breaks → do not build JSON strings by hand: call write_file/edit_file with raw content, split it if needed',
  jsonGuideStrong:
    'This is the {n}th consecutive call with broken JSON arguments. You MUST change approach: use write_file with raw content (no nested JSON, no manual quote escaping), one shorter file per call; if still stuck, tell the user instead of retrying',
  gateTodosAgain:
    'You were just reminded and the list is unchanged: {list}. Do NOT repeat yourself this time — do exactly ONE of three: (1) call todo_write so the statuses match reality (done work → completed; impossible work → blocked with a note); (2) state exactly which task cannot be closed and what is missing; (3) ask the user one precise question.',
  gateFinalAnswer:
    'Your final answer points elsewhere ("see above", "as mentioned") or is too short for such a long run. The user does not see the work log — rewrite it in full so it stands on its own: the result (table/list/conclusion), the evidence you checked, what remains and the command to resume if any.',
  gateFinalClosed:
    'Reminded {n} time(s) and work is still unfinished: {list} — marked as "blocked" so you are not nagged again{done}. Stopping here so you can decide — reply "continue" to have the assistant finish these, or change the request.',
  gateFinalClosedDone: '; {k} task(s) with evidence of completion were marked completed: {doneList}',
  todoBlockedNoEvidence: 'no file write or command run matches this task; the assistant was reminded twice without updating it',
  todoStatusBlocked: 'blocked',
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
};

export type StringKey = keyof typeof vi;

const tables: Record<Lang, typeof vi> = { vi, en };

export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  let s = tables[lang][key] ?? tables.vi[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
