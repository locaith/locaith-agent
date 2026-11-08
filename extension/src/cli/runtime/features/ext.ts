/**
 * Điểm móc TUỲ CHỌN mà các mô-đun tính năng dùng thêm ngoài `FeatureContext` của contract.ts. Mô-đun nào cần chỉ dùng khi lõi có (kiểm bằng `?.`),
 * thiếu thì rơi về cách thay thế tốt nhất có thể (ghi rõ ở báo cáo).
 *
 * Hai nhóm, cố ý KHÔNG dùng `extends` mà dùng giao (&) để khớp được với contract.ts của lane cli-rt dù hai bên khai báo trùng tên:
 *   • `RtHooks`  — đã có trong contract.ts của lane cli-rt (beforeSend, onBeforeCompact, onFileWrite, onPermissionRequest, transcript, saveSession, replaceSession);
 *   • `FeaturesWant` — lane cli-features ĐỀ XUẤT thêm (registerAlwaysAllow, agentServices, mainRegistry).
 */

import type { AgentServices } from '../../../core/agents/runner';
import type { ToolRegistry } from '../../../core/engine/toolRegistry';
import type { SessionState } from '../../../core/engine/types';
import type { PermissionRequest, TItem } from '../../../shared/protocol';
import { registerStrings, t } from '../../i18n';
import type { AskAnswer, AskRequest, FeatureContext, RuntimeEvent, SlashRunContext } from '../contract';

export interface BeforeSendResult {
  blocked?: boolean;
  reason?: string;
}

export type FileWriteBefore = string | null | { skipped: 'binary' | 'unreadable' };

export interface RtHooks {
  /** Trước khi tin người dùng tới model (UserPromptSubmit/SessionStart). `blocked:true` → lõi không chạy lượt và trả chữ về ô nhập. */
  beforeSend?(fn: (info: { text: string; signal: AbortSignal }) => BeforeSendResult | void | Promise<BeforeSendResult | void>): void;
  /** Ngay trước khi nén ngữ cảnh thật sự bắt đầu (PreCompact). */
  onBeforeCompact?(fn: (info: { session: SessionState; trigger: 'auto' | 'manual' | 'overflow'; signal: AbortSignal }) => void | Promise<void>): void;
  /** Sau MỖI lần công cụ ghi tệp thành công (checkpoints). */
  onFileWrite?(fn: (abs: string, before: FileWriteBefore, after: string) => void): void;
  /** Khi một yêu cầu xin quyền được trình ra (Notification). */
  onPermissionRequest?(fn: (req: PermissionRequest) => void): void;
  transcript?(): readonly TItem[];
  saveSession?(): Promise<void>;
  /** Thay phiên đang chạy (cùng đối tượng đã sửa tại chỗ — rewind — hoặc phiên mới — fork), phát replay + status + onSessionChange. Chỉ khi rảnh. */
  replaceSession?(next: SessionState, opts?: { reason?: 'resume' | 'fork' | 'rewind' | 'new' | 'clear'; transcript?: TItem[] }): Promise<void>;
}

export interface FeaturesWant {
  /** Dịch vụ agent con của lõi — cho kiểm chứng độc lập chạy agent kiểm tra với đủ nhà cung cấp. Thiếu → dựng tạm từ `RunScope` (chỉ nhà cung cấp của phiên). */
  agentServices?(): Omit<AgentServices, 'registry'>;
  /** Kho công cụ của luồng chính (nguồn cho bộ công cụ chỉ-đọc của agent kiểm tra). Thiếu → dựng kho nền từ host. */
  mainRegistry?(): ToolRegistry;
  /**
   * «Luôn cho phép…» trên thẻ xin quyền (`PermissionRequest.suggest`): lõi giữ hàm này và gọi khi người dùng chọn lưu luật; trả về luật đã lưu
   * (hoặc null nếu quá rộng/không hợp lệ). `scope`: 'user' (mọi dự án) hoặc 'local' (`.locaith/settings.local.json`).
   */
  registerAlwaysAllow?(fn: (rule: string, scope: 'user' | 'local') => string | null): void;
}

export type FeatureContextExt = FeatureContext & RtHooks & FeaturesWant;

export const asExt = (ctx: FeatureContext): FeatureContextExt => ctx as FeatureContextExt;

/** Đưa chữ vào ô nhập (action 'insert' của lõi cli-rt; bản contract cũ chưa có tên này nên ép kiểu). */
export const insertIntoInput = (ctx: Pick<FeatureContext, 'emit'>, text: string): void => ctx.emit({ t: 'action', action: 'insert', payload: text } as unknown as RuntimeEvent);

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

/** `scope` là của agent con (phiên con có id riêng) chứ không phải luồng chính. So theo id để không phụ thuộc lõi trả đúng MỘT đối tượng phiên. */
export const isSubAgentScope = (ctx: Pick<FeatureContext, 'session'>, scope: { session: { id: string } }): boolean => scope.session.id !== ctx.session().id;
