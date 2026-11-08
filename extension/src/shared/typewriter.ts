/**
 * «Chữ gõ ra từng chữ» ở dòng đang chạy (như từ trạng thái xoay vòng «Wibbling…» của Claude Code, nhưng gõ từng chữ một).
 * HÀM THUẦN theo thời gian đã trôi — không timer, không DOM, không Node — để dùng chung cho webview (extension, Chrome) và CLI,
 * và để kiểm thử bằng số (test/typewriter.test.ts).
 *
 * Mỗi từ: GÕ từng chữ (charMs/chữ) → GIỮ nguyên (holdMs, con trỏ nháy) → XOÁ nhanh (eraseMs/chữ) → NGHỈ (gapMs) → từ kế.
 * Từ đầu tiên (chỉ số 0) luôn là nhãn gốc ở lần chạy đầu; các vòng sau xáo trộn theo `seed` (render lại không đổi),
 * KHÔNG BAO GIỜ hai lần liền cùng một từ — kể cả ở chỗ nối giữa hai vòng.
 * `once` = chỉ gõ từ đầu rồi giữ nguyên mãi (nhãn «Đang chuẩn bị» trước khi có chữ đầu tiên).
 */

export interface TypeTiming {
  /** ms cho mỗi chữ khi gõ. */
  charMs: number;
  /** ms giữ nguyên từ đã gõ xong. */
  holdMs: number;
  /** ms cho mỗi chữ khi xoá. */
  eraseMs: number;
  /** ms nghỉ (chỉ còn con trỏ) trước từ kế tiếp. */
  gapMs: number;
}

export const TYPE_TIMING: TypeTiming = { charMs: 58, holdMs: 2600, eraseMs: 24, gapMs: 220 };

export type TypePhase = 'type' | 'hold' | 'erase' | 'gap';

export interface TypeFrame {
  /** Phần đã gõ (có thể rỗng). */
  text: string;
  /** Từ đầy đủ đang được gõ/giữ/xoá (để giữ chỗ bề ngang, khỏi làm nhảy chữ bên phải). */
  verb: string;
  /** Chỉ số của từ trong mảng `verbs` truyền vào. */
  verbIndex: number;
  phase: TypePhase;
  /** ms tới lần đổi chữ kế tiếp (để hẹn giờ đúng lúc); `Infinity` khi đã dừng hẳn (`once`). */
  nextMs: number;
}

/** Số ngẫu nhiên giả (mulberry32): cùng hạt giống → cùng dãy. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items: number[], r: () => number): number[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const ROUND_STEP = 0x9e3779b1;

/** Xáo thô của vòng `round` (chưa sửa chỗ nối). */
function rawOrder(n: number, seed: number, round: number): number[] {
  return shuffled(range(0, n), rng((seed + Math.imul(round, ROUND_STEP)) >>> 0));
}

/**
 * Thứ tự các từ trong vòng `round` (mỗi từ đúng một lần). Vòng 0: từ 0 (nhãn gốc) đứng đầu, còn lại xáo theo seed.
 * Vòng ≥ 1: xáo toàn bộ, và từ đầu vòng KHÁC từ cuối vòng trước (đổi chỗ với từ thứ hai nếu trùng).
 */
export function roundOrder(n: number, seed: number, round: number): number[] {
  if (n <= 0) return [];
  if (n <= 2) return range(0, n);
  if (round === 0) return [0, ...shuffled(range(1, n), rng(seed >>> 0))];
  const order = rawOrder(n, seed, round);
  // Từ cuối của vòng trước: chỉ vị trí 0 và 1 có thể bị đổi chỗ khi sửa nối, nên từ cuối (n ≥ 3) không đổi so với bản xáo thô.
  const prevLast = round === 1 ? roundOrder(n, seed, 0)[n - 1]! : rawOrder(n, seed, round - 1)[n - 1]!;
  if (order[0] === prevLast) [order[0], order[1]] = [order[1]!, order[0]!];
  return order;
}

/** Cắt theo ký tự (không cắt giữa cặp thay thế); chuỗi nên ở dạng NFC để dấu tiếng Việt đi liền chữ. */
function glyphs(s: string): string[] {
  return Array.from(s.normalize('NFC'));
}

/**
 * Khung hình của chữ gõ tại `elapsedMs` kể từ lúc dòng đang chạy hiện ra. `verbs` rỗng → khung rỗng.
 * Cùng đầu vào → cùng kết quả; gọi bao nhiêu lần cũng được (không có trạng thái).
 */
export function typeFrame(verbs: readonly string[], elapsedMs: number, seed = 0, timing: TypeTiming = TYPE_TIMING, once = false): TypeFrame {
  const n = verbs.length;
  if (n === 0) return { text: '', verb: '', verbIndex: 0, phase: 'gap', nextMs: Infinity };
  const g = verbs.map(glyphs);
  const total = (i: number): number => g[i]!.length * timing.charMs + timing.holdMs + g[i]!.length * timing.eraseMs + timing.gapMs;

  let t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  let idx = 0;
  if (!once) {
    // Mọi vòng dài bằng nhau (mỗi từ đúng một lần), chỉ khác thứ tự → nhảy thẳng tới vòng chứa `t` rồi duyệt trong vòng đó.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += total(i);
    const round = sum > 0 ? Math.floor(t / sum) : 0;
    t -= round * sum;
    const order = roundOrder(n, seed, round);
    idx = order[n - 1]!; // sai số làm tròn số thực: coi như cuối vòng
    let found = false;
    for (const i of order) {
      const d = total(i);
      if (t < d) {
        idx = i;
        found = true;
        break;
      }
      t -= d;
    }
    if (!found) t = Math.max(0, total(idx) - 1);
  }

  const chars = g[idx]!;
  const len = chars.length;
  const verb = verbs[idx]!;
  const typeEnd = len * timing.charMs;
  if (t < typeEnd) {
    const k = Math.floor(t / timing.charMs);
    return { text: chars.slice(0, k).join(''), verb, verbIndex: idx, phase: 'type', nextMs: timing.charMs - (t - k * timing.charMs) };
  }
  const holdEnd = typeEnd + timing.holdMs;
  if (once) return { text: chars.join(''), verb, verbIndex: idx, phase: 'hold', nextMs: Infinity };
  if (t < holdEnd) return { text: chars.join(''), verb, verbIndex: idx, phase: 'hold', nextMs: holdEnd - t };
  const eraseEnd = holdEnd + len * timing.eraseMs;
  if (t < eraseEnd) {
    const e = Math.floor((t - holdEnd) / timing.eraseMs);
    return { text: chars.slice(0, len - e).join(''), verb, verbIndex: idx, phase: 'erase', nextMs: timing.eraseMs - ((t - holdEnd) - e * timing.eraseMs) };
  }
  return { text: '', verb, verbIndex: idx, phase: 'gap', nextMs: total(idx) - t };
}
