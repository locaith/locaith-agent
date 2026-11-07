/**
 * (lane:output-timeouts) Cắt đúng RANH GIỚI khi câu trả lời bị chạm trần đầu ra (stopReason = max_tokens).
 *
 * Vì sao có: 7/12 lượt chạm trần trong log thật kết thúc GIỮA CÂU — người dùng nhận nửa câu, và lượt "viết tiếp" sau đó lặp lại hoặc
 * nối lệch. Lùi về ranh giới câu/mục gần nhất rồi mới nối tiếp thì cả người đọc lẫn model đều có một điểm dừng sạch.
 *
 * Luật (tất định, có test):
 *   • Kết thúc đã sạch (dấu câu cuối câu + có thể có dấu đóng ngoặc/ngoặc kép, hoặc xuống dòng) → giữ nguyên.
 *   • Đang trong khối mã (số ``` lẻ) → bỏ dòng mã dở (không có xuống dòng cuối), ĐÓNG khối bằng ```; không cắt lùi ra ngoài khối.
 *   • Dòng cuối là hàng bảng Markdown dở (bắt đầu bằng `|`, chưa kết thúc bằng `|`) → bỏ hàng đó.
 *   • Còn lại: lùi về ranh giới câu gần nhất (. ! ? … : ; theo sau là khoảng trắng/xuống dòng) hoặc ranh giới mục/đoạn (xuống dòng)
 *     — nhưng không bỏ quá `MAX_DROP_RATIO` của văn bản (để một đoạn dài không có dấu câu không bị xoá sạch).
 *   • An toàn Unicode: chỉ cắt ở KHOẢNG TRẮNG/xuống dòng (không bao giờ tách cặp surrogate, dấu kết hợp hay chuỗi emoji).
 */

import type { SuggestionOption } from '../../shared/protocol';
import type { ChatMessage, ContentBlock } from '../types';
import { t, type Lang } from './strings';

/**
 * Giới hạn phần bị bỏ khi lùi về ranh giới câu: dưới `FREE_DROP_CHARS` thì luôn được (một câu dở dù là 45% của câu trả lời ngắn);
 * trên đó chỉ khi không quá `MAX_DROP_RATIO` của văn bản VÀ không quá `MAX_DROP_CHARS` — một đoạn dài không dấu câu không bị xoá sạch.
 */
export const FREE_DROP_CHARS = 400;
export const MAX_DROP_RATIO = 0.35;
export const MAX_DROP_CHARS = 1200;

export interface TrimResult {
  text: string;
  /** Số ký tự đã bỏ ở cuối (0 = không bỏ). */
  removed: number;
  /** Đã phải đóng một khối mã dở bằng ``` (chuỗi đã nằm trong `text`). */
  closedFence: boolean;
  /** Chuỗi đã nối thêm vào cuối (hiện tại chỉ có dấu đóng khối mã), để giao diện nối đúng phần đó. */
  appended: string;
}

const SENTENCE_END = /[.!?…:;][)\]"'»”’]*$/;

function countFences(s: string): number {
  let n = 0;
  const re = /^\s{0,3}(```|~~~)/gm;
  while (re.exec(s)) n++;
  return n;
}

/** Vị trí (sau dấu phân cách) của ranh giới câu/đoạn gần cuối nhất, hoặc -1. */
function lastBoundary(s: string): number {
  // Ranh giới đoạn/mục: xuống dòng (giữ cả dòng trước đó).
  const nl = s.lastIndexOf('\n');
  // Ranh giới câu: dấu kết câu rồi khoảng trắng.
  let sentence = -1;
  const re = /[.!?…;:][)\]"'»”’]*(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) sentence = m.index + m[0].length;
  return Math.max(nl, sentence);
}

export function trimToBoundary(input: string): TrimResult {
  const text = input.replace(/[ \t]+$/, '');
  const keep = (s: string, appended = ''): TrimResult => ({
    text: s + appended,
    removed: input.length - s.length,
    closedFence: appended.length > 0,
    appended,
  });
  if (!text.trim()) return { text: input, removed: 0, closedFence: false, appended: '' };

  // Khối mã dở: bỏ dòng mã chưa kết thúc rồi đóng khối. Không bao giờ lùi ra ngoài khối (phần mã đã viết là tài sản).
  if (countFences(text) % 2 === 1) {
    const lines = text.split('\n');
    // Kết thúc bằng '\n' → phần tử cuối là '' ; không → phần tử cuối là dòng mã DỞ. Cả hai trường hợp đều bỏ phần tử cuối.
    lines.pop();
    const isFence = (s: string) => /^\s{0,3}(```|~~~)/.test(s);
    // Dòng dở vừa bỏ chính là dòng mở khối → khối đã không còn, không cần đóng.
    if (countFences(lines.join('\n')) % 2 === 0) return keep(lines.join('\n').replace(/\s+$/, ''));
    let opener = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isFence(lines[i])) {
        opener = i;
        break;
      }
    }
    // Dòng mở khối là dòng cuối (chưa có dòng mã nào) → bỏ luôn dòng mở, không cần đóng.
    if (opener === lines.length - 1) return keep(lines.slice(0, opener).join('\n').replace(/\s+$/, ''));
    const fence = opener >= 0 && /^\s{0,3}~~~/.test(lines[opener]) ? '~~~' : '```';
    return keep(lines.join('\n'), `\n${fence}`);
  }

  // Số fence chẵn mà dòng cuối chính là một fence ⇒ đó là dấu ĐÓNG của khối mã vừa xong (không có xuống dòng cuối): giữ nguyên, đừng xoá.
  if (/(?:^|\n)\s{0,3}(?:```|~~~)[ \t]*$/.test(text)) return keep(text);

  // Kết thúc sạch: dấu câu cuối câu hoặc xuống dòng (một mục/đoạn đã xong).
  if (text.endsWith('\n') || SENTENCE_END.test(text)) return keep(text);

  // Hàng bảng dở: bỏ hàng.
  const lastNl = text.lastIndexOf('\n');
  const lastLine = text.slice(lastNl + 1);
  if (/^\s*\|/.test(lastLine) && !/\|\s*$/.test(lastLine)) return keep(text.slice(0, Math.max(0, lastNl)).replace(/\s+$/, ''));

  const b = lastBoundary(text);
  if (b <= 0) return keep(text);
  const dropped = text.length - b;
  if (dropped > FREE_DROP_CHARS && (dropped > MAX_DROP_CHARS || dropped / text.length > MAX_DROP_RATIO)) return keep(text);
  return keep(text.slice(0, b).replace(/\s+$/, ''));
}

/** Dòng «[tiếp phần N]» hiện dưới phần vừa bị cắt; `total` chưa biết thì chỉ ghi số phần kế. */
export function continuationMarker(lang: Lang, nextPart: number, total?: number): string {
  return total ? t(lang, 'partMarkerOf', { n: nextPart, m: total }) : t(lang, 'partMarker', { n: nextPart });
}

/**
 * Cắt khối chữ CUỐI của tin assistant (tại chỗ, trả về kết quả cắt) — chỉ áp khi tin không có lệnh gọi công cụ.
 * Trả về null nếu tin không có khối chữ.
 */
export function trimAssistantTail(message: ChatMessage): TrimResult | null {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const b: ContentBlock = message.content[i];
    if (b.type !== 'text') continue;
    const r = trimToBoundary(b.text);
    if (r.removed > 0 || r.appended) message.content[i] = { ...b, text: r.text };
    return r;
  }
  return null;
}

/** Nút «Chạy tiếp phần N» — đi qua cơ chế `options` sẵn có (hiện ở VS Code, Remote và bản Chrome). */
export function continuePartOption(lang: Lang, nextPart: number): SuggestionOption {
  return {
    id: `continue-part-${nextPart}`,
    kind: 'continue',
    label: t(lang, 'continuePartLabel', { n: nextPart }),
    prompt: t(lang, 'continuePartPrompt', { n: nextPart }),
  };
}

/** Nút «Chạy tiếp» chung (sau khi bị buộc dừng vì hết vòng / hết thời gian / model treo). */
export function continueWorkOption(lang: Lang): SuggestionOption {
  return { id: 'continue-work', kind: 'continue', label: t(lang, 'continueWorkLabel'), prompt: t(lang, 'continueWorkPrompt') };
}
