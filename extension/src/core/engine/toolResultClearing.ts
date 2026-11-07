/**
 * (lane:ctx-compaction) Lược kết quả công cụ cũ (tool-result clearing) — bước ĐẦU của việc giữ ngữ cảnh gọn.
 *
 * Vì sao có: 43% lượt của người dùng Locaith chạy với ngữ cảnh > 150k token, phần lớn là kết quả read_file / run_command
 * cũ mà model không còn cần nguyên văn (đọc lại được bất cứ lúc nào). Claude Code xoá những kết quả đó TRƯỚC, chỉ khi vẫn
 * đầy mới tóm tắt toàn bộ. Ở đây mỗi kết quả bị lược được thay bằng MỘT dòng giữ đủ thông tin để quyết định: tên công cụ,
 * đối số chính (đường dẫn/lệnh/truy vấn), ok hay lỗi (kèm mã thoát), kích thước gốc và gợi ý gọi lại.
 *
 * Bất biến:
 *  - KHÔNG đụng khối tool_use, KHÔNG xoá/thêm tin nhắn → cặp tool_use ↔ tool_result nguyên vẹn, thứ tự nguyên vẹn.
 *  - KHÔNG đụng kết quả thuộc bước đang chờ model trả lời (tin cuối chứa tool_result), KHÔNG đụng N kết quả gần nhất.
 *  - Làm theo ĐỢT: vượt ngưỡng thì lược (cũ → mới) cho tới khi còn ≤ mục tiêu, không lược lắt nhắt mỗi vòng (tiền tố ổn định cho prompt-cache).
 *  - Idempotent: kết quả đã lược không bị lược lại; không có gì để lược → không đổi gì, không bật historyEdited.
 *  - Lỗi và mã thoát được GIỮ (kèm đầu thông điệp lỗi) — model không được quên là lệnh đó đã hỏng.
 */

import type { ChatMessage, ToolResultBlock, ToolUseBlock } from '../types';
import { sliceSafe } from '../textSafe';
import { stripThinking } from './compaction';
import { estimateBlockTokens, estimateMessagesTokens } from './tokens';
import type { Lang } from './strings';
import type { SessionState } from './types';

/** Dấu mở đầu của một kết quả đã lược (vi/en) — dùng để nhận ra và không lược lại. */
/** Gồm cả định dạng CŨ của pruneOldToolResults (phiên lưu từ bản trước) để không lược lại và không đếm lại. */
const CLEARED_RE = /^\[(?:đã lược — |cleared — |Kết quả cũ của )/u;

export const isClearedResult = (b: ToolResultBlock): boolean => CLEARED_RE.test(b.content);

export interface ClearOptions {
  contextWindow: number;
  /** Ngưỡng bắt đầu, phần trăm cửa sổ (0 = tắt). */
  clearAtPercent: number;
  /** Lược cho tới khi còn ≤ phần trăm này của cửa sổ. */
  targetPercent: number;
  /** Số kết quả gần nhất giữ nguyên văn. */
  keepRecentResults: number;
  lang: Lang;
  /** Bỏ qua ngưỡng bắt đầu (vẫn tôn trọng mục tiêu, số kết quả giữ lại và bước đang chờ). */
  force?: boolean;
  /** Token dự phòng cộng vào ước lượng (system prompt, công cụ…). Mặc định 3000 như compaction.ts. */
  reserveTokens?: number;
}

export interface ClearResult {
  /** Số kết quả vừa bị lược trong đợt này. */
  cleared: number;
  tokensBefore: number;
  tokensAfter: number;
}

const ARG_KEYS = ['path', 'command', 'pattern', 'query', 'url', 'file', 'name', 'prompt'] as const;

/** Đối số chính của lệnh gọi — thứ người đọc cần để biết "gọi lại cái gì". */
export function mainArgOf(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const k of ARG_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return `${k === 'path' || k === 'command' ? '' : `${k}=`}${oneLine(v, 120)}`;
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return oneLine(v, 120);
  return '';
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${sliceSafe(t, 0, max - 1)}…` : t;
}

const EXIT_RE = /(?:Mã thoát|Exit code|exit code)\s*[:=]?\s*(-?\d+)/u;

/** Số ký tự → "12,3k ký tự" / "12.3k chars". */
function sizeLabel(chars: number, lang: Lang): string {
  const unit = lang === 'en' ? 'chars' : 'ký tự';
  if (chars < 1000) return `${chars} ${unit}`;
  const k = chars / 1000;
  const s = (k >= 100 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString()).replace('.', lang === 'vi' ? ',' : '.');
  return `${s}k ${unit}`;
}

/** Dòng thay cho kết quả bị lược. Thuần tuý (test được), không sửa đầu vào. */
export function clearedResultText(b: ToolResultBlock, call: ToolUseBlock | undefined, lang: Lang): string {
  const name = b.name || call?.name || 'tool';
  const arg = mainArgOf(call?.input);
  const target = arg ? `${name} ${arg}` : name;
  const exit = EXIT_RE.exec(b.content)?.[1];
  const imgs = b.images?.length ?? 0;
  const en = lang === 'en';
  const parts: string[] = [en ? 'cleared' : 'đã lược', target];
  if (b.isError) {
    const head = oneLine(b.content.replace(EXIT_RE, '').trim(), 200);
    parts.push(en ? `ERROR${exit !== undefined ? ` (exit code ${exit})` : ''}` : `LỖI${exit !== undefined ? ` (mã thoát ${exit})` : ''}`);
    if (head) parts.push(`${en ? 'error head' : 'đầu lỗi'}: "${head}"`);
  } else {
    parts.push(exit !== undefined ? (en ? `ok (exit code ${exit})` : `ok (mã thoát ${exit})`) : 'ok');
  }
  parts.push(sizeLabel(b.content.length, lang));
  if (imgs) parts.push(en ? `${imgs} image(s) dropped` : `${imgs} ảnh đã bỏ`);
  const again = en ? `call ${target} again if needed` : `gọi lại ${target} nếu cần`;
  return `[${parts[0]} — ${parts.slice(1).join(' · ')} — ${again}]`;
}

interface Candidate {
  msg: ChatMessage;
  block: ToolResultBlock;
}

/** Mọi kết quả còn nguyên văn, theo thứ tự xuất hiện, bỏ bước đang chờ (tin cuối có tool_result) và N kết quả gần nhất. */
export function clearableResults(messages: readonly ChatMessage[], keepRecentResults: number): Candidate[] {
  const all: Candidate[] = [];
  const last = messages[messages.length - 1];
  const pending = last && last.role === 'user' && last.content.some((b) => b.type === 'tool_result') ? last : null;
  for (const m of messages) {
    if (m.role !== 'user' || m === pending) continue;
    for (const b of m.content) if (b.type === 'tool_result' && !isClearedResult(b)) all.push({ msg: m, block: b });
  }
  // N kết quả gần nhất (kể cả trong bước đang chờ) được giữ: đếm cả phần pending vào N.
  const pendingCount = pending ? pending.content.filter((b) => b.type === 'tool_result' && !isClearedResult(b)).length : 0;
  const keep = Math.max(0, keepRecentResults - pendingCount);
  return keep >= all.length ? [] : all.slice(0, all.length - keep);
}

function toolUseIndex(messages: readonly ChatMessage[]): Map<string, ToolUseBlock> {
  const idx = new Map<string, ToolUseBlock>();
  for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') idx.set(b.id, b);
  return idx;
}

/**
 * Lược theo đợt. Trả về số kết quả vừa lược (0 = không đổi gì). Có đổi → xoá khối suy luận đã lưu + `historyEdited = true`
 * (đúng quy ước của compaction.ts: lịch sử phía trước khối suy luận đã đổi thì chữ ký không còn hợp lệ).
 */
export function clearOldToolResults(session: SessionState, o: ClearOptions): ClearResult {
  const reserve = o.reserveTokens ?? 3000;
  const before = estimateMessagesTokens(session.messages) + reserve;
  const none = { cleared: 0, tokensBefore: before, tokensAfter: before };
  // 0 = TẮT, kể cả khi buộc (/compact, tràn ngữ cảnh): người dùng đã tắt thì không lược; bước tóm tắt vẫn chạy bình thường.
  if (o.clearAtPercent <= 0) return none;
  const start = (o.contextWindow * o.clearAtPercent) / 100;
  if (!o.force && before < start) return none;
  const target = (o.contextWindow * Math.max(0, Math.min(o.targetPercent, o.clearAtPercent || o.targetPercent))) / 100;

  const uses = toolUseIndex(session.messages);
  let running = before;
  let cleared = 0;
  for (const c of clearableResults(session.messages, o.keepRecentResults)) {
    if (running <= target) break;
    const was = estimateBlockTokens(c.block);
    c.block.content = clearedResultText(c.block, uses.get(c.block.toolUseId), o.lang);
    c.block.images = undefined;
    running -= was - estimateBlockTokens(c.block);
    cleared++;
  }
  if (cleared === 0) return none;
  // Giữa vòng công cụ (tin cuối chứa tool_result): khối suy luận có chữ ký của tin assistant đang chờ kết quả phải còn nguyên trong lịch sử đã lưu. Ở ranh giới lượt: xoá hết như cũ.
  const last = session.messages[session.messages.length - 1];
  const midToolLoop = !!last && last.role === 'user' && last.content.some((b) => b.type === 'tool_result');
  stripThinking(session, midToolLoop);
  session.historyEdited = true;
  session.lastContextTokens = 0;
  const stats = (session.contextStats ??= { clearedResults: 0, compactions: 0 });
  stats.clearedResults += cleared;
  return { cleared, tokensBefore: before, tokensAfter: estimateMessagesTokens(session.messages) + reserve };
}
