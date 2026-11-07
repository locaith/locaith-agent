/**
 * "Tiếp tục" sau khi Dừng — biến một từ trần trụi thành chỉ dẫn rõ ràng.
 *
 * Vì sao cần: sau khi người dùng bấm Dừng, lịch sử kết thúc giữa một vòng công cụ. Câu "tiếp tục" không nói gì
 * thêm, nên model hay phát lại đúng những lệnh của tin trước (tạo cảm giác "chạy ở cả hai chỗ") hoặc bắt đầu lại
 * từ đầu. Ở đây ta nói rõ ba điều: làm tiếp từ chỗ dừng, dọn hết việc còn tồn, và không chạy lại lệnh đã huỷ.
 *
 * Hàm thuần → test được.
 */

/** Từ đệm hay đi kèm "tiếp tục" mà KHÔNG thêm yêu cầu nào ("tiếp tục đi", "làm tiếp nhé", "continue please"). */
const FILLER = '(?:đi|nhé|nha|nào|thôi|ạ|please|pls|now)';
const CONTINUE_RE = new RegExp(`^(?:tiếp tục|cứ tiếp tục|tiếp|chạy tiếp|làm tiếp|continue|go on|keep going|carry on|resume)(?:\\s+${FILLER})*\\s*[.!…]*\\s*$`, 'i');

/** Người dùng chỉ gõ đúng một từ "tiếp tục" (không kèm yêu cầu mới)? */
export function isBareContinue(text: string): boolean {
  return CONTINUE_RE.test(text.replace(/\s+/g, ' ').trim());
}

/**
 * Đầu chỉ dẫn do `resumeInstruction` sinh ra. Chỉ dẫn nằm trong MỘT KHỐI CHỮ RIÊNG sau chữ người dùng gõ; đây là dấu hiệu để dựng lại
 * transcript từ lịch sử (`rebuildTranscript`) bỏ khối đó đi — người dùng chỉ được thấy đúng chữ họ gõ. Giữ đồng bộ với hai câu mở đầu bên dưới
 * (test/resume.test.ts kiểm hai bên khớp nhau).
 */
export const RESUME_HEADER = /^\s*\[(?:Tiếp tục sau khi dừng|Continue after a stop)\b/;

export interface ResumeTodo {
  title: string;
  status: string;
}

/**
 * Chỉ dẫn gắn thêm khi người dùng gõ "tiếp tục". `null` = không phải câu tiếp tục, giữ nguyên tin nhắn.
 * Có việc còn tồn thì nêu đúng tên việc để model dọn nốt thay vì đoán.
 */
export function resumeInstruction(text: string, todos: readonly ResumeTodo[], lang: 'vi' | 'en'): string | null {
  if (!isBareContinue(text)) return null;
  const pending = todos.filter((x) => x.status !== 'completed').map((x) => x.title.trim()).filter(Boolean);
  const list = pending.slice(0, 8).map((t) => `- ${t.slice(0, 120)}`).join('\n');
  if (lang === 'en') {
    return (
      '[Continue after a stop — do not restart.] Pick up exactly where you stopped and finish ALL outstanding work before you report.\n' +
      'Any tool call marked as cancelled in the history was interrupted: do not run it again unless it is still needed.\n' +
      (pending.length ? `Still open (${pending.length}):\n${list}\nUpdate the task list to match reality as you go, then verify and report.` : 'Nothing is left open — finish the last step, verify it, and report the result.')
    );
  }
  return (
    '[Tiếp tục sau khi dừng — không làm lại từ đầu.] Làm tiếp đúng chỗ đã dừng và hoàn tất TẤT CẢ việc còn tồn trước khi báo xong.\n' +
    'Lệnh nào trong lịch sử bị đánh dấu đã huỷ thì đã bị gián đoạn: đừng chạy lại trừ khi vẫn còn cần.\n' +
    (pending.length ? `Còn tồn (${pending.length}):\n${list}\nVừa làm vừa cập nhật danh sách việc cho đúng thực tế, rồi kiểm chứng và báo kết quả.` : 'Không còn việc nào đang mở — làm nốt bước cuối, kiểm chứng rồi báo kết quả.')
  );
}
