/**
 * Hook của người dùng (lane:hooks): lệnh shell gắn vào vòng đời agent — cùng ý tưởng/định dạng với hooks của Claude Code.
 * Tệp này chỉ chứa kiểu; không import `vscode` hay `node:*` (bản Chrome/CLI dùng chung core).
 */

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd', 'Notification'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Tối đa số lần hook Stop được ép model làm tiếp trong một lần chạy. */
export const STOP_HOOK_MAX_CONTINUES = 8;
export const HOOK_DEFAULT_TIMEOUT_SEC = 60;
export const HOOK_MAX_TIMEOUT_SEC = 600;
/** Giới hạn dung lượng stdout / stderr giữ lại từ một hook (ký tự). */
export const HOOK_MAX_OUTPUT_CHARS = 64_000;

/** Một lệnh hook như người dùng khai báo. */
export interface HookCommandDef {
  type?: 'command';
  command: string;
  /** Giây; mặc định 60, tối đa 600. */
  timeout?: number;
  /** Tên hiện trên giao diện (mặc định lấy từ lệnh). */
  name?: string;
  /** Biến môi trường bổ sung (giá trị chữ). Đây là cách DUY NHẤT khai báo biến cho hook, ngoài danh sách `hooksPassEnv` của người dùng. */
  env?: Record<string, string>;
}

export interface HookGroup {
  /** Tên công cụ, `a|b`, `*`, hoặc regex (xem matcher.ts). Bỏ trống = mọi thứ. */
  matcher?: string;
  hooks: HookCommandDef[];
}

export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>;

/**
 * Nguồn của hook:
 *  - user: cài đặt `locaithAgent.hooks` của NGƯỜI DÙNG (luôn chạy);
 *  - project / projectLocal: `.locaith/settings.json` / `.locaith/settings.local.json` (cần workspace tin cậy + xác nhận);
 *  - claude / claudeLocal: `.claude/settings.json` / `.claude/settings.local.json` (như trên, và phải bật `hooksReadClaudeSettings`).
 */
export type HookSourceKind = 'user' | 'project' | 'projectLocal' | 'claude' | 'claudeLocal';

/** Một hook đã trải phẳng, sẵn sàng chạy. */
export interface HookEntry {
  event: HookEvent;
  source: HookSourceKind;
  /** Nhãn nguồn để hiển thị: «cài đặt người dùng», «.locaith/settings.json»… */
  sourceLabel: string;
  matcher?: string;
  command: string;
  timeoutSec: number;
  name: string;
  env: Record<string, string>;
  /** 'claude' = từ .claude/settings*.json: tên công cụ gửi qua stdin theo tên của Claude Code. */
  dialect: 'locaith' | 'claude';
}

export type HookStatus = 'ok' | 'block' | 'warn' | 'timeout' | 'error';

/** Kết quả một lần chạy một hook (để hiện trên giao diện và /hooks). Lệnh đã che bí mật. */
export interface HookRunRecord {
  event: HookEvent;
  source: HookSourceKind;
  sourceLabel: string;
  name: string;
  command: string;
  status: HookStatus;
  exitCode: number | null;
  ms: number;
  /** Lý do chặn / chi tiết lỗi (một đoạn ngắn). */
  message?: string;
  at: number;
}

/** Kết quả gộp của mọi hook khớp trong một sự kiện — luật «chặn thắng». */
export interface HookOutcome {
  blocked: boolean;
  /** Lý do chặn (đã nối nếu nhiều hook cùng chặn). */
  reason?: string;
  /** Một hook đã tán thành rõ ràng (decision 'approve' / permissionDecision 'allow'). KHÔNG bỏ qua hỏi quyền hay luật từ chối. */
  approved: boolean;
  additionalContext: string[];
  /** Đối số công cụ đã sửa (hook cuối trong thứ tự cấu hình thắng). */
  updatedInput?: Record<string, unknown>;
  /** `continue:false` — hook yêu cầu dừng hẳn. */
  stop: boolean;
  stopReason?: string;
  /** Cảnh báo không chặn (exit khác 0/2, quá hạn, không chạy được, `systemMessage`). */
  warnings: string[];
  records: HookRunRecord[];
}

export function emptyOutcome(): HookOutcome {
  return { blocked: false, approved: false, additionalContext: [], stop: false, warnings: [], records: [] };
}

// ── Tiến trình thật (do host cài đặt) ──────────────────────────────────────────

export interface HookExecSpec {
  command: string;
  cwd: string;
  /** Môi trường ĐẦY ĐỦ của tiến trình con (host không được trộn thêm process.env). */
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  maxChars: number;
  signal: AbortSignal;
}

export interface HookExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
  /** Không khởi chạy được tiến trình. */
  error?: string;
}

export interface HookExecutor {
  exec(spec: HookExecSpec): Promise<HookExecResult>;
}
