/**
 * Điểm móc TUỲ CHỌN mà các mô-đun tính năng muốn lõi (lane cli-rt) cung cấp thêm, ngoài `FeatureContext` của contract.ts.
 * Mô-đun nào cần chỉ dùng khi lõi có (kiểm bằng `?.`), nếu không thì rơi về cách thay thế tốt nhất có thể và ghi rõ ở báo cáo.
 * Khi lõi cài đặt, chỉ việc thêm các trường này vào đối tượng FeatureContext (không cần sửa mã trong features/).
 */

import type { AgentServices } from '../../../core/agents/runner';
import type { ToolRegistry } from '../../../core/engine/toolRegistry';
import type { SessionState } from '../../../core/engine/types';
import type { PermissionRequest, TItem } from '../../../shared/protocol';
import { registerStrings, t } from '../../i18n';
import type { AskAnswer, AskRequest, FeatureContext, SlashRunContext } from '../contract';

export interface BeforeSubmitResult {
  blocked: boolean;
  reason?: string;
}

export interface FeatureContextExt extends FeatureContext {
  /**
   * Gọi TRƯỚC khi một tin người dùng được đưa cho model (kể cả lệnh tuỳ chỉnh qua `runPrompt`): hook UserPromptSubmit/SessionStart.
   * `blocked:true` → lõi KHÔNG chạy lượt, in `reason` thành lỗi và trả chữ về ô nhập. Nhiều người nghe: người đầu tiên chặn thắng.
   */
  onBeforeSubmit?(fn: (text: string, signal: AbortSignal) => Promise<BeforeSubmitResult | void>): void;
  /** Một yêu cầu xin quyền vừa hiện ra cho người dùng (hook Notification). Không chờ, không chặn. */
  onPermissionPrompt?(fn: (req: PermissionRequest) => void): void;
  /** Ngay trước khi nén ngữ cảnh (hook PreCompact). Lõi chờ hàm trả về (có hạn giờ). */
  onBeforeCompact?(fn: (trigger: 'auto' | 'manual' | 'overflow', signal: AbortSignal) => Promise<void>): void;
  /** Ghi phiên đang chạy ra đĩa ngay (sau /rewind hội thoại). */
  saveSession?(): Promise<void>;
  /** /fork: lưu phiên MỚI (đã dựng sẵn) rồi chuyển sang nó, phát replay reason 'fork'. */
  adoptSession?(session: SessionState, transcript: TItem[], reason: 'fork'): Promise<void>;
  /** Dịch vụ agent con + kho công cụ của luồng chính — để kiểm chứng độc lập (verifier) chạy agent kiểm tra. Thiếu → dựng tạm từ `RunScope`. */
  agentServices?(): Omit<AgentServices, 'registry'>;
  mainRegistry?(): ToolRegistry;
  /** Đặt chữ vào ô nhập của người dùng (sau /rewind hội thoại: trả lại tin đã quay lại). */
  setDraft?(text: string): void;
}

export const asExt = (ctx: FeatureContext): FeatureContextExt => ctx as FeatureContextExt;

/**
 * `Omit<AskRequest, 'id'>` của contract KHÔNG phân phối qua union nên chỉ còn `kind`/`title` — không truyền được `items`, `detail`…
 * `AskInit` là dạng đúng (Omit từng nhánh); `askUser`/`askSlash` ép kiểu một chỗ duy nhất.
 */
export type AskInit = AskRequest extends infer T ? (T extends { id: string } ? Omit<T, 'id'> : never) : never;

export const askUser = (ctx: Pick<FeatureContext, 'ask'>, req: AskInit): Promise<AskAnswer> => ctx.ask(req as never);
export const askSlash = (ctx: Pick<SlashRunContext, 'ask'>, req: AskInit): Promise<AskAnswer> => ctx.ask(req as never);

/**
 * Bảng chuỗi vi/en của một mô-đun: `const tr = makeTr('rewind', { title: ['Tiêu đề', 'Title'] })` rồi `tr(lang, 'title', { n: 1 })`.
 * Đăng ký vào i18n dưới `features.<ns>.<key>` (cùng chỗ với registerStrings('features', …)).
 */
export function makeTr(ns: string, table: Record<string, readonly [string, string]>): (lang: 'vi' | 'en', key: string, vars?: Record<string, string | number>) => string {
  const vi: Record<string, string> = {};
  const en: Record<string, string> = {};
  for (const [k, [v, e]] of Object.entries(table)) {
    vi[`${ns}.${k}`] = v;
    en[`${ns}.${k}`] = e;
  }
  registerStrings('features', { vi, en });
  return (lang, key, vars) => t(`features.${ns}.${key}`, vars, lang);
}

/** Cắt chữ một dòng cho danh sách. */
export function oneLine(s: string, n = 80): string {
  const x = s.replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
}
