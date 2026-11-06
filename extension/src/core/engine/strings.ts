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
  toolDenied: 'Người dùng đã từ chối thao tác này.',
  toolDeniedWithFeedback: 'Người dùng đã từ chối thao tác này và nhắn: "{feedback}"',
  planMode: 'Đang ở chế độ lập kế hoạch: chỉ được đọc và nghiên cứu, chưa được sửa tệp hay chạy lệnh.',
  titleDefault: 'Cuộc trò chuyện mới',
  todoReminder:
    'Bạn vẫn còn tác vụ chưa hoàn thành trong danh sách (todo_write). Hãy hoàn tất chúng hoặc cập nhật trạng thái cho đúng thực tế trước khi kết thúc.',
  continuePrompt: 'Hãy tiếp tục từ đúng chỗ bị dừng, không lặp lại phần đã viết.',
  emptyReplyNudge: 'Hãy trả lời người dùng bằng văn bản dựa trên kết quả công cụ ở trên.',
  steerHeader:
    '[Người dùng vừa gửi thêm {n} tin nhắn trong lúc bạn đang làm việc — mỗi tin là MỘT VIỆC MỚI, xem bên dưới. Làm xong việc đang dở trước, rồi làm LẦN LƯỢT từng việc mới theo đúng thứ tự và không bỏ việc nào: cập nhật danh sách tác vụ (todo_write) cho việc đang làm, hoàn thành xong mới sang việc kế tiếp.]',
  steerItem: 'Việc mới',
  queuedImageTask: '(ảnh)',
  maxTurnsWrapUp:
    'Đã hết số vòng lặp cho phép. KHÔNG gọi thêm công cụ. Hãy tóm tắt ngắn gọn: đã làm được gì, còn lại việc gì, và bước tiếp theo đề xuất.',
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
  toolDenied: 'The user denied this action.',
  toolDeniedWithFeedback: 'The user denied this action and said: "{feedback}"',
  planMode: 'Plan mode: read and research only — no file edits or commands yet.',
  titleDefault: 'New conversation',
  todoReminder:
    'You still have unfinished tasks in your todo list (todo_write). Finish them, or update their status to match reality, before ending.',
  continuePrompt: 'Continue exactly where you stopped; do not repeat what you already wrote.',
  emptyReplyNudge: 'Answer the user in text based on the tool results above.',
  steerHeader:
    '[The user sent {n} more message(s) while you were working — each one is a NEW TASK, listed below. Finish what you are doing first, then work through the new tasks ONE AT A TIME in the order given and do not drop any: keep the task list (todo_write) in sync — mark the current one in_progress and completed before starting the next.]',
  steerItem: 'New task',
  queuedImageTask: '(image)',
  maxTurnsWrapUp:
    'The loop budget is exhausted. Do NOT call more tools. Briefly summarize: what was done, what remains, and the suggested next step.',
};

export type StringKey = keyof typeof vi;

const tables: Record<Lang, typeof vi> = { vi, en };

export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  let s = tables[lang][key] ?? tables.vi[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
