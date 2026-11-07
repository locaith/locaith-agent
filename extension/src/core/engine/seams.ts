/**
 * Điểm cắm của engine (seams).
 *
 * Vì sao có: vòng lặp `AgentEngine.run()` là trục của cả hệ thống. Mỗi tính năng "quanh vòng lặp" — kiểm tra độc lập,
 * hook của người dùng, chốt chặn kỷ luật, thông báo tác vụ nền, chẩn đoán IDE… — nếu chèn thẳng vào thân `run()` thì
 * (a) thân hàm phình thành một khối không ai dám sửa, (b) mọi tính năng đụng nhau ở cùng vài dòng. Thay vào đó mỗi tính
 * năng là một `RunExtension` nằm trong tệp riêng, đăng ký một lần ở `extensions.ts`; engine chỉ gọi các móc dưới đây.
 *
 * Vòng đời của một extension trong MỘT lần `run()`:
 *
 *   begin(scope)  → trả về `RunHooks` (hoặc không) — trạng thái riêng của lần chạy nằm trong closure.
 *   ┌ vòng lặp ───────────────────────────────────────────────────────────────────────────────┐
 *   │ beforeModel     trước mỗi lần gọi model: có thể thêm tin synthetic vào lịch sử (được lưu)   │
 *   │ toolBefore      trước khi một công cụ chạy (sau khi đối số hợp lệ, TRƯỚC khi hỏi quyền):     │
 *   │                 có thể chặn hoặc sửa đối số                                                  │
 *   │ toolAfter       sau khi công cụ chạy xong: có thể sửa/ghi chú vào kết quả                    │
 *   │ queuedTurn      tin người dùng xếp hàng được nhận làm lượt kế tiếp của cùng lần chạy         │
 *   │ finalize        model dừng mà không gọi công cụ: chấp nhận / buộc làm tiếp / dừng hẳn        │
 *   └──────────────────────────────────────────────────────────────────────────────────────────┘
 *   end(info)     → mọi đường thoát (kể cả lỗi, Dừng, hết vòng).
 *
 * Quy ước an toàn: ngoại lệ ném ra từ một móc KHÔNG làm hỏng lần chạy — engine ghi log và coi như móc đó không làm gì.
 * Thứ tự: theo thứ tự mảng đăng ký. `finalize`: extension đầu tiên trả về khác 'accept' thắng.
 */

import type { ChatMessage, ContentBlock, LLMProvider, StopReason, ToolUseBlock } from '../types';
import type { TodoItem, UiEvent } from '../../shared/protocol';
import type { Lang } from './strings';
import type { EngineSettings, SessionState, ToolContext, ToolDef, ToolHost, ToolResult, ToolRisk } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Vết (trace) của một lần chạy — engine cập nhật, extension chỉ đọc
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceCall {
  callId: string;
  name: string;
  /** Loại rủi ro của công cụ (từ registry); 'unknown' nếu công cụ không tồn tại. */
  risk: ToolRisk | 'unknown';
  input: Record<string, unknown>;
  /** Vòng (1-based) mà lệnh gọi này được phát ra. */
  turn: number;
  ts: number;
  /** Đã chạy xong mà không lỗi. */
  ok: boolean;
  /** 200 ký tự đầu của kết quả (để chẩn đoán/vết, không dùng làm dữ liệu). */
  resultHead: string;
}

export interface RunTrace {
  /** Đã ghi/sửa tệp (công cụ risk 'write', trừ artifact) trong lần chạy này. */
  wrote: boolean;
  /** Số lệnh 'exec' đã chạy. */
  execs: number;
  /** Số vòng đã gọi model. */
  turns: number;
  /** Mọi lệnh gọi công cụ ĐÃ HOÀN TẤT, theo thứ tự. */
  calls: TraceCall[];
  /** Đường dẫn (đối số `path`) của các lệnh ghi thành công, không trùng lặp, theo thứ tự lần đầu. */
  writtenPaths(): string[];
}

export function newTrace(): RunTrace {
  const calls: TraceCall[] = [];
  return {
    wrote: false,
    execs: 0,
    turns: 0,
    calls,
    writtenPaths() {
      const out: string[] = [];
      for (const c of calls) {
        if (c.risk !== 'write' || !c.ok) continue;
        const p = c.input?.path;
        if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
      }
      return out;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phạm vi và móc
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnInfo {
  /** Vòng hiện tại, tính từ 1. */
  turn: number;
  maxTurns: number;
  /** Số vòng còn lại SAU vòng này (0 = vòng cuối). */
  turnsLeft: number;
  /** Đang ở lượt tổng kết vì chạm trần vòng lặp. */
  wrapUp: boolean;
}

/** Mọi thứ một extension cần biết về lần chạy. Chỉ đọc (trừ qua các hàm). */
export interface RunScope {
  readonly session: SessionState;
  readonly settings: EngineSettings;
  readonly lang: Lang;
  readonly host: ToolHost;
  readonly provider: LLMProvider;
  readonly signal: AbortSignal;
  /** Nội dung tin nhắn người dùng khởi động lần chạy. */
  readonly input: readonly ContentBlock[];
  readonly trace: RunTrace;
  emit(ev: UiEvent): void;
  notice(level: 'info' | 'warn' | 'error', text: string): void;
  /** Id của lượt trả lời hiện tại (đổi khi tin xếp hàng chen vào). */
  assistantId(): string;
}

export type ToolBeforeResult =
  | void
  | undefined
  /** Không chạy: trả tool_result lỗi với thông điệp này (model thấy được). */
  | { block: string; state?: 'error' | 'denied' }
  /** Chạy với đối số đã sửa (dispatcher kiểm tra lại theo schema). `note` được nối vào đầu kết quả. */
  | { input: Record<string, unknown>; note?: string };

export interface FinalizeContext {
  turn: TurnInfo;
  /** Tin trả lời cuối của model (đã chuẩn hoá). */
  message: ChatMessage;
  /** Chữ của tin đó, đã cắt khoảng trắng. */
  text: string;
  stop: StopReason;
  pendingTodos: readonly TodoItem[];
  aborted: boolean;
}

export type FinalizeDecision =
  | { action: 'accept' }
  /** Chèn `message` làm tin synthetic của người dùng và chạy tiếp (model phải làm gì đó). */
  | { action: 'continue'; message: string; reason?: string }
  /** Kết thúc lần chạy ngay, kèm thông báo tuỳ chọn. */
  | { action: 'halt'; notice?: { level: 'info' | 'warn' | 'error'; text: string } };

export interface RunHooks {
  /**
   * Trước mỗi lần gọi model. Trả về các khối chữ cần nối vào lịch sử (được LƯU, nằm trong tin người dùng cuối nếu tin
   * cuối là của người dùng — giữ xen kẽ vai trò — hoặc thành tin synthetic mới).
   */
  beforeModel?(turn: TurnInfo): string[] | void | Promise<string[] | void>;
  toolBefore?(call: ToolUseBlock, def: ToolDef, ctx: ToolContext): ToolBeforeResult | Promise<ToolBeforeResult>;
  toolAfter?(call: ToolUseBlock, def: ToolDef, ctx: ToolContext, result: ToolResult): ToolResult | void | Promise<ToolResult | void>;
  /** Tin nhắn xếp hàng của người dùng được nhận làm lượt kế tiếp: đặt lại trạng thái "theo lượt" (số lần nhắc…). */
  queuedTurn?(): void;
  finalize?(ctx: FinalizeContext): FinalizeDecision | Promise<FinalizeDecision>;
  end?(info: { stopReason: string; turns: number }): void | Promise<void>;
}

export interface RunExtension {
  readonly id: string;
  /** Gọi ở đầu mỗi `run()`. Trả về móc cho riêng lần chạy này; không trả gì = extension không tham gia lần chạy này. */
  begin(scope: RunScope): RunHooks | void | null | undefined;
}

/** Một extension đã `begin` trong lần chạy hiện tại. */
export interface ActiveExtension {
  readonly id: string;
  readonly hooks: RunHooks;
}

/** Gọi `begin` của từng extension; ngoại lệ → ghi log và bỏ qua extension đó. */
export function beginExtensions(extensions: readonly RunExtension[], scope: RunScope): ActiveExtension[] {
  const out: ActiveExtension[] = [];
  for (const ext of extensions) {
    try {
      const hooks = ext.begin(scope);
      if (hooks) out.push({ id: ext.id, hooks });
    } catch (err) {
      scope.host.log('warn', `Extension "${ext.id}" lỗi khi bắt đầu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Gọi một móc trên mọi extension đang hoạt động, bắt ngoại lệ từng cái. Trả về kết quả của các móc có trả về giá trị. */
export async function callHook<K extends keyof RunHooks>(
  active: readonly ActiveExtension[],
  hook: K,
  log: (level: 'warn', message: string) => void,
  ...args: Parameters<NonNullable<RunHooks[K]>>
): Promise<Array<{ id: string; value: Awaited<ReturnType<NonNullable<RunHooks[K]>>> }>> {
  const out: Array<{ id: string; value: Awaited<ReturnType<NonNullable<RunHooks[K]>>> }> = [];
  for (const ext of active) {
    const fn = ext.hooks[hook] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) continue;
    try {
      const value = (await fn.apply(ext.hooks, args as unknown[])) as Awaited<ReturnType<NonNullable<RunHooks[K]>>>;
      out.push({ id: ext.id, value });
    } catch (err) {
      log('warn', `Extension "${ext.id}" lỗi ở móc ${String(hook)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
