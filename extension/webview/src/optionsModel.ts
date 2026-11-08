import type { SuggestionOption } from '../../src/shared/protocol';

/**
 * (0.7.2) Chip «Tất cả» của bảng lựa chọn cuối hội thoại. Chip do GIAO DIỆN tự sinh từ các lựa chọn có sẵn — không thêm trường
 * hay thông điệp vào giao thức, nên Remote / Chrome tự có mà không phải đổi gì.
 */

/** Mỗi prompt chép vào tin «Tất cả» tối đa bấy nhiêu ký tự (cắt ở ranh giới từ, thêm …). */
export const ALL_PROMPT_EACH_MAX = 420;
/** Tổng độ dài tin «Tất cả». */
export const ALL_PROMPT_TOTAL_MAX = 3200;

/** Chỉ áp cho kiểu «hướng đi»: ≥ 2 lựa chọn và không lựa chọn nào là `continue` («Chạy tiếp» là một nút duy nhất theo ngữ cảnh). */
export function shouldOfferAll(options: readonly SuggestionOption[] | undefined): boolean {
  if (!options || options.length < 2) return false;
  return options.every((o) => o.kind !== 'continue');
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/** Một tin nhắn duy nhất yêu cầu làm mọi hướng theo thứ tự hợp lý rồi báo kết quả từng hướng. */
export function buildAllPrompt(options: readonly SuggestionOption[], lang: 'vi' | 'en'): string {
  const head =
    lang === 'vi'
      ? 'Làm tất cả các hướng sau, theo thứ tự hợp lý, rồi báo kết quả từng hướng:'
      : 'Do all of the following directions, in a sensible order, then report the result of each one:';
  const n = options.length;
  // Chia đều ngân sách cho từng hướng để hướng cuối không bị cắt mất.
  const each = Math.max(80, Math.min(ALL_PROMPT_EACH_MAX, Math.floor((ALL_PROMPT_TOTAL_MAX - head.length) / Math.max(1, n)) - 40));
  const items = options.map((o, i) => {
    const label = clip(o.label, 80);
    const prompt = clip(o.prompt, each);
    return `${i + 1}) ${label}${prompt && prompt !== label ? ` — ${prompt}` : ''}`;
  });
  return `${head} ${items.join(' ')}`;
}
