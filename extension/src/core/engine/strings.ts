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
    'Đã hết số vòng lặp cho phép. KHÔNG gọi thêm công cụ. Trả lời ĐÚNG BA PHẦN, mỗi phần một tiêu đề riêng: «Đã làm» (chỉ kể những gì có vết thật bên dưới — tệp đã sửa, lệnh đã chạy, việc đã đánh dấu xong), «Còn lại» (liệt kê từng việc chưa xong), «Chạy tiếp bằng cách nào» (bước đầu tiên khi được chạy tiếp). CẤM viết "đã hoàn thành toàn bộ" hay tương tự khi phần «Còn lại» không rỗng.\n{facts}',
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  wrapUpFacts: 'Vết thật của lượt này (do harness ghi, không phải do bạn kể): {files}; {execs}; việc chưa xong trong danh sách: {pending}.',
  factsFiles: 'đã sửa {n} tệp ({list})',
  factsNoFiles: 'chưa sửa tệp nào',
  factsExecs: 'đã chạy {n} lệnh',
  factsNoExecs: 'chưa chạy lệnh nào',
  factsNoPending: 'không có',
  partMarker: '[tiếp phần {n}]',
  partMarkerOf: '[tiếp phần {n}/{m}]',
  continuePartLabel: 'Chạy tiếp phần {n}',
  continuePartPrompt: 'Viết tiếp phần {n} từ đúng chỗ vừa dừng: không lặp lại phần trước, không mở đầu lại, không tóm tắt lại.',
  maxTokensButton: 'Câu trả lời dài hơn trần đầu ra nên đã cắt ở ranh giới câu. Bấm «Chạy tiếp phần {n}» để viết tiếp.',
  continueWorkLabel: 'Chạy tiếp',
  continueWorkPrompt: 'Tiếp tục đúng việc đang dở: làm nốt các việc còn lại theo danh sách, không làm lại phần đã xong, rồi báo kết quả kèm bằng chứng.',
  stallRetry: 'Model không gửi gì trong {sec} giây — đã ngắt lần gọi này và thử lại một lần (không phải bạn bấm Dừng).',
  stallGiveUp: 'Model vẫn không phản hồi sau {sec} giây ở lần thử lại. Đã giữ phần đã viết và dừng lượt — đây là lỗi phía máy chủ/model, không phải lỗi của bạn.',
  stopReasonMaxTurns: 'Đã dừng vì hết số vòng cho phép ({n}).',
  stopReasonStall: 'Đã dừng vì model không phản hồi.',
  stopReasonError: 'Đã dừng vì lỗi từ nhà cung cấp.',
  stopDone: 'Đã làm: {text}.',
  stopDoneNone: 'Đã làm: chưa có thay đổi nào được ghi lại (chưa sửa tệp, chưa chạy lệnh).',
  stopDoneTodos: 'xong {done}/{total} việc',
  stopLeft: 'Còn lại: {list}.',
  stopLeftNone: 'Còn lại: không còn việc nào trong danh sách.',
  stopHow: 'Chạy tiếp: bấm «Chạy tiếp» bên dưới hoặc nhắn "tiếp tục" — trợ lý làm nốt từ đúng chỗ dừng.',
  stopHowNone: 'Chạy tiếp: không cần — hãy kiểm tra kết quả; cần thêm gì thì nhắn tiếp.',
  stopContradiction: 'Lưu ý: trợ lý nói đã hoàn thành toàn bộ nhưng danh sách còn {n} việc chưa xong — hãy tin danh sách.',
  // ── (lane:loop-guards) ──
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
    'The loop budget is exhausted. Do NOT call more tools. Answer in EXACTLY THREE PARTS, each under its own heading: "Done" (only what the real trace below shows — files changed, commands run, tasks marked complete), "Remaining" (every unfinished task), "How to continue" (the first step when resumed). You MUST NOT write "everything is done" or similar while "Remaining" is not empty.\n{facts}',
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  wrapUpFacts: 'Real trace of this run (recorded by the harness, not by you): {files}; {execs}; unfinished tasks in the list: {pending}.',
  factsFiles: 'changed {n} file(s) ({list})',
  factsNoFiles: 'no files changed',
  factsExecs: 'ran {n} command(s)',
  factsNoExecs: 'no commands run',
  factsNoPending: 'none',
  partMarker: '[continued in part {n}]',
  partMarkerOf: '[continued in part {n}/{m}]',
  continuePartLabel: 'Continue with part {n}',
  continuePartPrompt: 'Continue with part {n} from exactly where you stopped: do not repeat earlier parts, do not restart the introduction, do not recap.',
  maxTokensButton: 'The reply is longer than the output limit, so it was cut at a sentence boundary. Press "Continue with part {n}" to keep writing.',
  continueWorkLabel: 'Continue',
  continueWorkPrompt: 'Continue the unfinished work: complete the remaining tasks in the list, do not redo what is already done, then report the result with evidence.',
  stallRetry: 'The model sent nothing for {sec} s — this call was cancelled and is being retried once (you did not press Stop).',
  stallGiveUp: 'The model still did not respond after {sec} s on the retry. Kept what was written and ended the turn — this is a server/model problem, not something you did.',
  stopReasonMaxTurns: 'Stopped: the loop budget ({n} turns) is exhausted.',
  stopReasonStall: 'Stopped: the model did not respond.',
  stopReasonError: 'Stopped: provider error.',
  stopDone: 'Done: {text}.',
  stopDoneNone: 'Done: no recorded changes yet (no files changed, no commands run).',
  stopDoneTodos: '{done}/{total} tasks completed',
  stopLeft: 'Remaining: {list}.',
  stopLeftNone: 'Remaining: nothing left in the task list.',
  stopHow: 'How to continue: press "Continue" below or reply "continue" — the assistant resumes exactly where it stopped.',
  stopHowNone: 'How to continue: not needed — check the result; send another message if you need more.',
  stopContradiction: 'Note: the assistant claimed everything is done, but {n} task(s) in the list are still unfinished — trust the list.',
  // ── (lane:loop-guards) ──
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
