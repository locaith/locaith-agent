/**
 * Sửa nhẹ JSON đối số công cụ bị hỏng (B09, lane:loop-guards) — CHỈ khi không mơ hồ.
 *
 * Ba lỗi hay gặp ở model yếu: dấu phẩy thừa trước `}`/`]`; xuống dòng/tab thật nằm trong chuỗi (chưa thoát); thiếu `}`/`]` cuối.
 * Hai lỗi đầu luôn sửa được an toàn. Lỗi thứ ba chỉ sửa khi đầu ra KHÔNG bị cắt (`stop !== 'max_tokens'`) và chuỗi không kết thúc
 * giữa một literal — nội dung cụt mà "đóng ngoặc cho xong" rồi chạy là ghi tệp thiếu nửa sau.
 *
 * Khi vẫn hỏng: viết lại `parseError` thành hướng dẫn rõ ("nội dung dài nhiều dấu nháy → write_file với nội dung thô"), mạnh hơn ở lần
 * hỏng thứ hai liên tiếp. Hàm thuần.
 */

import type { StopReason, ToolUseBlock } from '../../types';
import { t, type Lang } from '../strings';

/** Trạng thái đếm lỗi liên tiếp trong một lần chạy (engine giữ). */
export interface JsonFailState {
  streak: number;
}

/** Đi qua chuỗi JSON, gọi `onCode(ch, i)` cho ký tự ngoài literal chuỗi và `onString(ch, i)` cho ký tự trong chuỗi (kể cả dấu nháy). */
function walk(s: string, onCode: (ch: string, i: number) => void, onString: (ch: string, i: number, escaped: boolean) => void): { inString: boolean; depth: number; stack: string[] } {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      onString(ch, i, escaped);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      onString(ch, i, false);
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
    onCode(ch, i);
  }
  return { inString, depth: stack.length, stack };
}

/** Thoát xuống dòng / tab thật nằm trong literal chuỗi. */
export function escapeRawControlChars(s: string): string {
  const out: string[] = [];
  walk(
    s,
    (ch) => out.push(ch),
    (ch) => {
      if (ch === '\n') out.push('\\n');
      else if (ch === '\r') out.push('\\r');
      else if (ch === '\t') out.push('\\t');
      else out.push(ch);
    },
  );
  return out.join('');
}

/** Bỏ dấu phẩy thừa ngay trước `}` / `]` (ngoài chuỗi). */
export function stripTrailingCommas(s: string): string {
  const commaAt: number[] = [];
  const drop = new Set<number>();
  walk(
    s,
    (ch, i) => {
      if (ch === ',') commaAt.push(i);
      else if (ch === '}' || ch === ']') {
        const last = commaAt[commaAt.length - 1];
        if (last !== undefined && /^[\s]*$/.test(s.slice(last + 1, i))) drop.add(last);
        commaAt.length = 0;
      } else if (!/\s/.test(ch)) commaAt.length = 0;
    },
    () => {
      commaAt.length = 0;
    },
  );
  if (drop.size === 0) return s;
  return s
    .split('')
    .filter((_, i) => !drop.has(i))
    .join('');
}

/** Thêm các dấu đóng còn thiếu ở cuối — chỉ khi không đang ở giữa một chuỗi và không kết thúc bằng `,` hay `:`. */
export function closeOpenBrackets(s: string): string | null {
  const trimmed = s.trimEnd();
  const st = walk(trimmed, () => {}, () => {});
  if (st.inString) return null;
  if (st.depth === 0) return trimmed;
  if (/[,:]$/.test(trimmed)) return null;
  return trimmed + st.stack.reverse().join('');
}

function parseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Thử sửa chuỗi đối số thô. `allowClose` = được phép thêm ngoặc đóng thiếu (chỉ khi đầu ra không bị cắt).
 * Trả về đối tượng đã parse, hoặc null nếu không sửa được một cách chắc chắn.
 */
export function repairJsonArgs(raw: string, opts: { allowClose: boolean }): Record<string, unknown> | null {
  const s = raw.trim();
  if (!s.startsWith('{')) return null;
  const direct = parseObject(s);
  if (direct) return direct;
  let fixed = stripTrailingCommas(escapeRawControlChars(s));
  let v = parseObject(fixed);
  if (v) return v;
  if (!opts.allowClose) return null;
  const closed = closeOpenBrackets(fixed);
  if (!closed) return null;
  fixed = stripTrailingCommas(closed);
  v = parseObject(fixed);
  return v;
}

/**
 * Áp lên các lệnh gọi của một lượt TRƯỚC khi dispatcher chạy: sửa được → xoá parseError (lệnh chạy bình thường); không → hướng dẫn rõ,
 * đếm lần hỏng liên tiếp để lần thứ hai trở đi nói mạnh hơn. Lượt không có lỗi JSON nào → đặt lại bộ đếm.
 */
export function repairToolArgs(calls: ToolUseBlock[], stop: StopReason, state: JsonFailState, lang: Lang): void {
  let failed = false;
  const truncated = stop === 'max_tokens';
  calls.forEach((c, idx) => {
    if (!c.parseError) return;
    const isLast = idx === calls.length - 1;
    // Lệnh cuối khi chạm trần đầu ra là nội dung CỤT: không bao giờ sửa rồi chạy.
    if (!(truncated && isLast) && typeof c.rawArgs === 'string') {
      const fixed = repairJsonArgs(c.rawArgs, { allowClose: !truncated });
      if (fixed) {
        c.input = fixed;
        delete c.parseError;
        delete c.rawArgs;
        return;
      }
    }
    failed = true;
  });
  if (!failed) {
    state.streak = 0;
    return;
  }
  state.streak++;
  const guide = state.streak >= 2 ? t(lang, 'jsonGuideStrong', { n: state.streak }) : t(lang, 'jsonGuide');
  for (const c of calls) if (c.parseError) c.parseError = `${c.parseError}. ${guide}`;
}
