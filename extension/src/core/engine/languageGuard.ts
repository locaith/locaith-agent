/**
 * (0.7.4) Chống trượt sang tiếng Trung/Nhật/Hàn — lớp bảo vệ thứ hai sau lời dặn trong system prompt (`languageRule`).
 *
 * Vì sao cần: các mô hình gốc Trung (DeepSeek… — nền của Locaith-v5) đôi khi trả lời bằng tiếng Trung dù người dùng viết tiếng Việt, hay gặp nhất ở tin cực ngắn
 * («tiếp tục») sau khi lượt trước bị ngắt (anh chụp màn hình 08/11/2026). Lời dặn giảm được nhưng không đảm bảo; lớp này đảm bảo:
 * câu trả lời CUỐI (không gọi công cụ) mà phần lớn là chữ Trung/Nhật/Hàn trong khi người dùng KHÔNG viết/nhắc tới các thứ tiếng đó thì bị bỏ khỏi màn hình
 * và lịch sử, rồi hỏi lại ĐÚNG MỘT LẦN kèm dòng nhắc ở cuối payload. Chỉ chạm tới câu trả lời không có công cụ: lệnh công cụ đã hiện trên giao diện thì không rút lại được.
 *
 * Toàn bộ hàm thuần → kiểm thử được bằng số.
 */
import type { ChatMessage, ContentBlock } from '../types';

type Lang = 'vi' | 'en';

const CJK_CHARS = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
const HAS_CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
/** Người dùng nhắc tới các thứ tiếng đó (hỏi/dịch/viết) → câu trả lời có chữ Trung/Nhật/Hàn là CÓ CHỦ Ý. */
const ASKS_CJK = /chinese|mandarin|cantonese|japanese|korean|hanzi|kanji|hangul|tiếng\s*(?:trung|hoa|nhật|hàn)|trung\s*quốc|nhật\s*bản|hàn\s*quốc|chữ\s*hán/i;
const VI_DIACRITICS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

/** Bỏ khối mã (```…```, kể cả khối chưa đóng) và mã nội dòng: chữ Trung nằm trong chuỗi/chú thích của mã là hợp lệ. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Phần lớn chữ trong câu trả lời là chữ Trung/Nhật/Hàn? (≥ 6 ký tự và ≥ 30% số chữ cái, không tính mã.) */
export function isCjkDrift(reply: string): boolean {
  const body = stripCode(reply);
  const cjk = (body.match(CJK_CHARS) ?? []).length;
  if (cjk < 6) return false;
  const letters = (body.match(/\p{L}/gu) ?? []).length;
  return letters > 0 && cjk / letters >= 0.3;
}

/** Người dùng (qua các tin gần đây) có viết chữ Trung/Nhật/Hàn hoặc nhắc tới các thứ tiếng đó? Có → không can thiệp. */
export function userAllowsCjk(userTexts: readonly string[]): boolean {
  return userTexts.some((t) => HAS_CJK.test(t) || ASKS_CJK.test(t));
}

/** Ngôn ngữ nên dùng để trả lời: có dấu tiếng Việt trong tin cuối → 'vi'; còn lại theo `fallback` (ngôn ngữ giao diện). */
export function expectedReplyLanguage(lastUserText: string, fallback: Lang): Lang {
  return VI_DIACRITICS.test(lastUserText) ? 'vi' : fallback;
}

/** Chữ của tối đa `n` tin người dùng gần nhất (bỏ khối volatile của harness; bỏ tin chỉ có kết quả công cụ). Mới nhất ở ĐẦU. */
export function recentUserTexts(messages: readonly ChatMessage[], n = 6): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = m.content
      .filter((b: ContentBlock) => b.type === 'text' && !b.volatile)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/** Dòng nhắc gắn vào CUỐI payload của lần hỏi lại (một khối volatile, không vào lịch sử). */
export function languageRetryNote(lang: Lang): string {
  return lang === 'vi'
    ? '[Câu trả lời trước viết sai ngôn ngữ nên đã bị bỏ. Hãy trả lời lại, cùng nội dung, CHỈ bằng tiếng Việt có dấu đầy đủ — không chen chữ Trung, Nhật, Hàn.]'
    : '[Your previous answer was written in the wrong language and was discarded. Answer again with the same content, ONLY in English — no Chinese, Japanese or Korean text.]';
}

/** Gộp các dòng nhắc ở đuôi payload thành MỘT khối (engine giữ bất biến «một khối volatile» mỗi lần gọi). */
export function joinTailNotes(...notes: Array<string | null | undefined>): string | null {
  const parts = notes.filter((x): x is string => !!x);
  return parts.length ? parts.join('\n') : null;
}

/**
 * Quyết định: câu trả lời cuối `reply` có phải trượt ngôn ngữ và cần hỏi lại không? Trả ngôn ngữ cần ép, hoặc `null` (để nguyên).
 * `messages` = lịch sử phiên TRƯỚC khi thêm câu trả lời này.
 */
export function languageDrift(reply: string, messages: readonly ChatMessage[], fallback: Lang): Lang | null {
  if (!isCjkDrift(reply)) return null;
  const recent = recentUserTexts(messages);
  if (userAllowsCjk(recent)) return null;
  return expectedReplyLanguage(recent[0] ?? '', fallback);
}
