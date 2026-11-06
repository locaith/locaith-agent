/**
 * Chuỗi JavaScript là dãy đơn vị mã UTF-16: cắt giữa một cặp thay thế (emoji, chữ ngoài BMP) để lại một nửa "mồ côi".
 * `JSON.stringify` ghi nó thành `"\ud83d"` và các nhà cung cấp từ chối cả yêu cầu ("no low surrogate"); kết quả công cụ
 * bị hỏng như vậy còn nằm mãi trong lịch sử. Mọi chỗ cắt chuỗi đưa vào lịch sử/yêu cầu phải đi qua đây.
 */

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `s.slice(from, to)` nhưng không bao giờ cắt đôi một cặp thay thế (lùi/tiến một đơn vị mã khi biên rơi giữa cặp). */
export function sliceSafe(s: string, from: number, to?: number): string {
  let a = from < 0 ? Math.max(0, s.length + from) : Math.min(from, s.length);
  let b = to === undefined ? s.length : to < 0 ? Math.max(0, s.length + to) : Math.min(to, s.length);
  if (a > 0 && a < s.length && isLow(s.charCodeAt(a)) && isHigh(s.charCodeAt(a - 1))) a++;
  if (b > 0 && b < s.length && isHigh(s.charCodeAt(b - 1)) && isLow(s.charCodeAt(b))) b--;
  return a >= b ? '' : s.slice(a, b);
}

/** Thay mọi đơn vị thay thế mồ côi bằng U+FFFD. */
export function wellFormed(s: string): string {
  const native = s as unknown as { isWellFormed?: () => boolean; toWellFormed?: () => string };
  if (typeof native.isWellFormed === 'function') return native.isWellFormed() ? s : (native.toWellFormed?.() ?? s);
  let out: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let bad = false;
    if (isHigh(c)) {
      if (i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
        i++;
        continue;
      }
      bad = true;
    } else if (isLow(c)) bad = true;
    if (bad) {
      out ??= s.slice(0, i);
      out += String.fromCharCode(0xfffd);
    } else if (out !== null) out += s[i];
  }
  return out ?? s;
}

/** Áp `wellFormed` cho mọi chuỗi trong một cấu trúc JSON (thân yêu cầu gửi nhà cung cấp). Không sửa đối tượng gốc. */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => wellFormedDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = wellFormedDeep(v);
    return out as T;
  }
  return value;
}
