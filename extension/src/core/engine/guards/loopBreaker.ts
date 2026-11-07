/**
 * Phá vòng lặp theo KẾT QUẢ (B07, lane:loop-guards).
 *
 * Bộ chặn có sẵn trong engine (`recentSigs`) chỉ bắt cùng công cụ + cùng ĐỐI SỐ y hệt. Log thật cho thấy 215 chuỗi ≥ 4 vòng cùng tổ hợp
 * công cụ mà đối số hơi khác (đổi một khoảng trắng, đổi cờ) nhưng kết quả thì y nguyên — thử lần thứ tư không thêm thông tin.
 *
 * Cách làm: với mỗi công cụ, giữ "chuỗi" (streak) các lần gọi liên tiếp trả cùng chữ ký kết quả = (lỗi hay không) + băm của đầu ra đã
 * chuẩn hoá (bỏ số đo thời gian, dấu thời gian, khoảng trắng). Đạt 3 → nối ghi chú đổi chiến lược vào kết quả; lần thứ 4 với đối số
 * gần giống → chặn chạy. Công cụ ghi/thao tác thành công làm "thế giới đổi" → xoá mọi chuỗi (đọc lại, chạy lại test là chính đáng).
 */

import { sha1 } from '../../tools/textUtil';

/** Số lần cùng kết quả liên tiếp để (a) nối ghi chú và (b) từ lần kế tiếp chặn nếu đối số gần giống. */
export const LOOP_STREAK = 3;
/** Ngưỡng "gần giống" của đối số (hệ số Dice trên bigram ký tự). */
export const LOOP_ARGS_SIMILARITY = 0.6;

const OUTPUT_HEAD = 6000;

/** Chuẩn hoá đầu ra để hai lần chạy "y hệt về nội dung" cho cùng băm dù khác thời gian chạy/dấu thời gian. */
export function normalizeOutput(s: string): string {
  return s
    .slice(0, OUTPUT_HEAD)
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>')
    .replace(/\b\d+(\.\d+)?\s*(ms|s|giây|sec|secs|seconds?|phút|min|mins|minutes?)\b/g, '<dur>')
    .replace(/0x[0-9a-f]{6,}/g, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resultSignature(name: string, content: string, isError: boolean): string {
  return `${name}|${isError ? 'err' : 'ok'}|${sha1(normalizeOutput(content))}`;
}

/** Chuỗi đối số đã chuẩn hoá để so "gần giống": chữ thường, bỏ khoảng trắng thừa, bỏ dấu nháy/ngoặc của JSON. */
export function argsText(args: Record<string, unknown> | undefined): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {}) ?? '';
  } catch {
    s = String(args);
  }
  return s.toLowerCase().replace(/["'{}[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** Hệ số Dice trên bigram ký tự: 1 = y hệt, 0 = không chung gì. Chuỗi quá ngắn so bằng equality. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const [k, n] of A) shared += Math.min(n, B.get(k) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

interface Streak {
  sig: string;
  count: number;
  args: string;
}

export class LoopTracker {
  private readonly streaks = new Map<string, Streak>();

  /** Ghi một kết quả; trả về độ dài chuỗi hiện tại của công cụ đó (1 = kết quả mới). */
  record(name: string, args: Record<string, unknown> | undefined, content: string, isError: boolean): number {
    const sig = resultSignature(name, content, isError);
    const text = argsText(args);
    const cur = this.streaks.get(name);
    if (cur && cur.sig === sig) {
      cur.count++;
      cur.args = text;
      return cur.count;
    }
    this.streaks.set(name, { sig, count: 1, args: text });
    return 1;
  }

  /** Độ dài chuỗi hiện tại của công cụ (0 = chưa có). */
  streakOf(name: string): number {
    return this.streaks.get(name)?.count ?? 0;
  }

  /** Lệnh kế tiếp có nên bị chặn: công cụ đã trả cùng kết quả ≥ LOOP_STREAK lần và đối số gần giống lần cuối. */
  shouldBlock(name: string, args: Record<string, unknown> | undefined): boolean {
    const cur = this.streaks.get(name);
    if (!cur || cur.count < LOOP_STREAK) return false;
    return similarity(cur.args, argsText(args)) >= LOOP_ARGS_SIMILARITY;
  }

  /** Thế giới đã đổi (ghi tệp, thao tác lên trang): mọi chuỗi vô nghĩa. */
  reset(): void {
    this.streaks.clear();
  }
}
