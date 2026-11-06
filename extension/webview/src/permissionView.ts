/**
 * Hiển thị lệnh trong thẻ xin quyền sao cho người duyệt không bị đánh lừa bởi cách trình bày.
 *
 * Lệnh do model sinh ra có thể giấu phần nguy hiểm ở đuôi: hàng chục dòng trống, khoảng trắng đẩy chữ ra khỏi khung nhìn,
 * ký tự vô hình hoặc ký tự đổi chiều chữ (U+202E, kiểu "Trojan Source") làm văn bản hiển thị khác với văn bản được chạy.
 */

/** Các dải mã ký tự điều khiển, vô hình và đổi chiều chữ (trừ tab và xuống dòng). Viết bằng số để tệp nguồn không chứa ký tự ẩn. */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f], // điều khiển C0/C1
  [0xad, 0xad], // dấu gạch nối mềm
  [0x61c, 0x61c], // dấu chiều chữ Ả Rập
  [0x180e, 0x180e],
  [0x200b, 0x200f], // khoảng trắng độ rộng 0, dấu chiều chữ
  [0x2028, 0x2029], // ngắt dòng/đoạn Unicode
  [0x202a, 0x202e], // nhúng/ghi đè chiều chữ (U+202E)
  [0x2060, 0x206f], // dấu nối từ, ký tự định dạng vô hình, cô lập chiều chữ
  [0x115f, 0x1160], // ký tự đệm Hangul (trông như khoảng trắng)
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f], // bộ chọn biến thể
  [0xfeff, 0xfeff], // BOM / khoảng trắng độ rộng 0
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f], // "ký tự thẻ" Unicode: nhét chữ vô hình vào văn bản thường (ASCII smuggling)
  [0xe0100, 0xe01ef], // bộ chọn biến thể bổ sung
];

function isHidden(code: number): boolean {
  for (const [lo, hi] of HIDDEN_RANGES) if (code >= lo && code <= hi) return true;
  return false;
}

export const LONG_COMMAND_CHARS = 300;
export const LONG_COMMAND_LINES = 5;

export interface CommandView {
  /** Văn bản để hiển thị: ký tự ẩn được thay bằng ⟦U+XXXX⟧. */
  text: string;
  /** Số ký tự ẩn đã được phơi ra. */
  hidden: number;
  chars: number;
  lines: number;
  /** Đủ dài/nhiều dòng để phần cuối có thể nằm ngoài khung nhìn. */
  long: boolean;
}

export function describeCommand(command: string): CommandView {
  let hidden = 0;
  let text = '';
  for (const ch of command) {
    const code = ch.codePointAt(0) ?? 0;
    if (isHidden(code)) {
      hidden++;
      text += `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`;
    } else text += ch;
  }
  const lines = command.split(/\r?\n/).length;
  return { text, hidden, chars: command.length, lines, long: command.length > LONG_COMMAND_CHARS || lines > LONG_COMMAND_LINES };
}
