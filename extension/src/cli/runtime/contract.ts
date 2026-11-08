/**
 * HỢP ĐỒNG giữa «lõi chạy» (runtime, không giao diện) và «giao diện terminal» (tui) của Locaith CLI.
 *
 * Ba nhóm người viết mã cùng lúc nên MỌI THỨ đi qua tệp này; không bên nào được sửa tệp này nếu chưa báo điều phối viên
 * (thêm trường TUỲ CHỌN thì được, đổi nghĩa/xoá thì KHÔNG).
 *
 *   • runtime/   (lane cli-rt)       dựng engine, host công cụ, phiên, quyền, nén ngữ cảnh… → `createRuntime()`.
 *   • runtime/features/ (cli-features) hooks, checkpoints/rewind, tác vụ nền, MCP, kỹ năng, lệnh /gạch-chéo… → `FeatureModule`.
 *   • tui/       (lane cli-tui)      vẽ giao diện, nhận phím; chỉ biết `CliRuntime` (không import engine).
 *
 * Quy ước sự kiện: `UiEvent` là CÙNG kiểu mà webview VS Code nhận (shared/protocol.ts) → giao diện dùng lại bộ rút gọn
 * `reduceView` của extension nếu muốn. Runtime phát sự kiện ĐỒNG BỘ, đúng thứ tự; người nghe KHÔNG được ném lỗi.
 */

import type { PermissionDecision, SessionState, ToolHost } from '../../core/engine/types';
import type { RunExtension } from '../../core/engine/seams';
import type { PermissionMode, PermissionRequest, SessionSummary, SlashCommandInfo, ThinkingLevel, TItem, TodoItem, UiEvent } from '../../shared/protocol';
import type { LLMProvider } from '../../core/types';
import type { SkillRegistry } from '../../core/skills/registry';
import type { AgentRegistry } from '../../core/agents/definitions';

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái hiển thị ở dải dưới ô nhập
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeStatus {
  /** Phiên bản CLI. */
  version: string;
  cwd: string;
  gitBranch?: string;
  provider: string;
  model: string;
  mode: PermissionMode;
  thinking: ThinkingLevel;
  /** Tài khoản locaith.ai (nếu dùng cổng Locaith). */
  account?: { loggedIn: boolean; email?: string; plan?: string };
  /** Ngữ cảnh đã dùng (ước lượng), cửa sổ của model và phần trăm. */
  context: { tokens: number; window: number; percent: number };
  /** Tổng token của phiên (đã tính cả agent con nếu có số). */
  usage: { input: number; output: number };
  /** (cli-rt) Token đã dùng bởi các agent con (số mới nhất agent con báo, cộng dồn theo lệnh gọi) — KHÔNG nằm trong `usage`/`costUsd` (không biết tách vào/ra). */
  subAgentTokens?: number;
  /** Chi phí ước tính (USD) — chỉ khi danh mục model có giá thật. */
  costUsd?: number;
  /** Đang có một lượt chạy. */
  running: boolean;
  /** Tin đã xếp hàng chờ gửi khi agent rảnh/ở ranh giới vòng công cụ (hiện phía trên ô nhập). */
  queued: string[];
  sessionId: string;
  title: string;
  todos: TodoItem[];
  /** Số tác vụ nền đang chạy / tổng. */
  bgTasks: { running: number; total: number };
  /** Số tệp đã đổi trong lượt gần nhất (thanh «N tệp đã đổi») nếu bật checkpoints. */
  changedFiles?: number;
  /** Câu ngắn cần nhắc người dùng (ví dụ «có bản mới 0.4.1», «chưa đồng ý thông báo dữ liệu»). */
  notices: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hỏi người dùng giữa chừng (chọn / xác nhận / nhập) — dùng cho /resume, /model, /rewind, tin cậy thư mục…
// ─────────────────────────────────────────────────────────────────────────────

export interface PickItem {
  id: string;
  label: string;
  /** Dòng phụ mờ (đường dẫn, ngày, mô tả…). */
  detail?: string;
  /** Nhóm (tiêu đề phân cách), tuỳ chọn. */
  group?: string;
  /** Mục hiện tại (đánh dấu ✓). */
  current?: boolean;
}

export type AskRequest =
  | { id: string; kind: 'pick'; title: string; items: PickItem[]; hint?: string; multi?: boolean; allowCancel?: boolean; searchable?: boolean }
  | { id: string; kind: 'confirm'; title: string; detail?: string; yes?: string; no?: string; defaultYes?: boolean; danger?: boolean }
  | { id: string; kind: 'input'; title: string; detail?: string; placeholder?: string; secret?: boolean; initial?: string };

/** AskRequest không có `id` (runtime tự cấp). Omit thường làm sập union nên dùng dạng phân phối. */
export type AskInput = AskRequest extends infer R ? (R extends AskRequest ? Omit<R, 'id'> : never) : never;

/** Giá trị trả lời: pick → id (multi → mảng id); confirm → boolean; input → chuỗi; huỷ (Esc) → null. */
export type AskAnswer = string | string[] | boolean | null;

// ─────────────────────────────────────────────────────────────────────────────
// Sự kiện từ runtime tới giao diện
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeEvent =
  /** Sự kiện engine/UI gốc (assistant_start, text, thinking, tool_start/progress/end, notice, usage, run_state, tasks, options, user…). Giao diện BỎ QUA `tool_permission` (dùng `permission` bên dưới). */
  | { t: 'ui'; ev: UiEvent }
  /** Ảnh chụp trạng thái mới (phát khi có gì đổi; giao diện nên giới hạn tần suất vẽ). */
  | { t: 'status'; status: RuntimeStatus }
  /** Cần người dùng quyết định cho một lệnh gọi công cụ. Trả lời bằng `respondPermission(request.id, …)`. Lượt bị dừng → runtime tự từ chối và phát `permission_cancel`. */
  | { t: 'permission'; request: PermissionRequest }
  | { t: 'permission_cancel'; id: string }
  /** Hỏi chọn/xác nhận/nhập. Trả lời bằng `answer(ask.id, …)`. */
  | { t: 'ask'; ask: AskRequest }
  /** Kết quả của lệnh gạch chéo hoặc thông tin hệ thống (không gửi cho model): in thành một khối trong hội thoại. */
  | { t: 'output'; text: string; kind?: 'markdown' | 'plain' | 'error'; title?: string }
  /** Thông báo thoáng qua (một dòng). */
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  /** Dựng lại hội thoại (sau /resume, /fork, /rewind hội thoại, /clear): giao diện xoá vùng đã in và in lại. `items` rỗng = phiên mới trống. */
  | { t: 'replay'; items: TItem[]; reason: 'resume' | 'fork' | 'rewind' | 'new' | 'clear' }
  /** Yêu cầu giao diện làm một việc. */
  /** (cli-rt) `insert` = đưa `payload` vào ô nhập (tin đang xếp hàng bị trả về sau khi dừng lượt); `redraw` kèm `payload: 'theme:<tên>'` khi /theme đổi giao diện. */
  | { t: 'action'; action: 'exit' | 'redraw' | 'clear_screen' | 'open_editor' | 'copy' | 'insert'; payload?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Giao diện gọi vào runtime
// ─────────────────────────────────────────────────────────────────────────────

export interface Attachment {
  kind: 'image';
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** base64 không có tiền tố data: */
  data: string;
}

export interface Completion {
  /** Nhãn hiện trong danh sách. */
  label: string;
  /** Chuỗi thay thế đoạn đang gõ (ví dụ `@src/app.ts ` hoặc `/compact `). */
  insert: string;
  detail?: string;
}

export interface CliRuntime {
  /** Đăng ký người nghe; trả về hàm huỷ. */
  on(listener: (e: RuntimeEvent) => void): () => void;
  status(): RuntimeStatus;

  /**
   * Gửi một dòng người dùng gõ. Quy tắc phân loại (runtime tự làm):
   *   `/tên args` → lệnh gạch chéo (registry + lệnh tuỳ chỉnh); `!lệnh` → chạy shell trực tiếp, in kết quả;
   *   còn lại → tin nhắn cho model (đang chạy thì XẾP HÀNG như extension: engine nhận ở ranh giới vòng công cụ).
   * `@đường-dẫn` trong chữ được runtime mở rộng thành nội dung tệp/ảnh/tài liệu (như extension). Trả về khi tin đã được NHẬN, không đợi chạy xong.
   */
  submit(text: string, opts?: { attachments?: Attachment[] }): Promise<void>;
  /** Dừng lượt đang chạy (Esc / Ctrl+C). Quyền đang chờ bị từ chối. Không có gì chạy → không làm gì. */
  interrupt(): void;
  /** Chờ tới khi không còn lượt chạy nào (dùng cho chế độ in một lần `-p` và kiểm thử). */
  idle(): Promise<void>;

  respondPermission(id: string, d: PermissionDecision): void;
  answer(id: string, value: AskAnswer): void;

  setMode(mode: PermissionMode): void;
  /** Shift+Tab: default → acceptEdits → plan → (bypass nếu được phép) → default. Trả về chế độ mới. */
  cycleMode(): PermissionMode;
  setModel(id: string): Promise<void>;
  setThinking(level: ThinkingLevel): void;

  /** Danh sách lệnh gạch chéo cho menu `/` (đã gộp dựng sẵn + dự án + cá nhân + plugin + MCP). */
  slashCommands(): SlashCommandInfo[];
  complete(req: { kind: 'file' | 'slash'; query: string; limit?: number }): Promise<Completion[]>;

  sessions(scope?: 'cwd' | 'all'): Promise<SessionSummary[]>;
  resume(idOrPrefix: string): Promise<void>;
  newSession(): Promise<void>;

  /** Chuỗi văn bản của lệnh `/help` và phím tắt — giao diện có thể thay bằng bản riêng. */
  helpText(): string;

  /** Đóng sạch: dừng tác vụ nền, đóng MCP, ghi phiên. Gọi đúng một lần khi thoát. */
  dispose(): Promise<void>;

  /** (cli-rt, tuỳ chọn) Cài đặt hợp nhất user < project < local < env — để giao diện đọc `ui.theme`… */
  readonly settings?: SettingsApi;
}

// ─────────────────────────────────────────────────────────────────────────────
// Khởi tạo
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeOptions {
  /** Thư mục làm việc (gốc workspace). */
  cwd: string;
  /** Phiên bản CLI (đi vào header gửi cổng). */
  version: string;
  /** true = có giao diện tương tác trả lời quyền/hỏi đáp; false (in một lần) = quyền không tự có thì TỪ CHỐI, `ask` trả null. */
  interactive: boolean;
  model?: string;
  baseUrl?: string;
  permissionMode?: PermissionMode;
  thinking?: ThinkingLevel;
  /** Luật quyền thêm từ dòng lệnh, cú pháp `tool(spec)` như cài đặt `permissions.allow|deny`. */
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  appendSystemPrompt?: string;
  maxTurns?: number;
  /** Hạn giờ (giây) cho MỖI lượt chạy; vượt → dừng. */
  timeoutSec?: number;
  /** Tệp cấu hình MCP bổ sung (--mcp-config). */
  mcpConfig?: string[];
  /** Mở phiên: id/tiền tố, hoặc `true` = phiên gần nhất của thư mục này. */
  resume?: string | true;
  /** Không ghi phiên ra đĩa (chế độ in một lần có cờ --no-session-persistence). */
  noPersist?: boolean;
  /** Ngôn ngữ giao diện/nhắc hệ thống. */
  lang?: 'vi' | 'en';
  verbose?: boolean;
  /** Thư mục «nhà» (kiểm thử đặt tạm; mặc định os.homedir()). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** KIỂM THỬ: nhà cung cấp giả thay cho cổng thật. */
  providerOverride?: LLMProvider;
  /** Đã tin thư mục này chưa (quyết định ở giao diện/onboarding). false → cài đặt dự án (hooks, MCP, allow) KHÔNG được áp. Vắng = tra `~/.locaith/trusted.json`. */
  trusted?: boolean;
  /** (cli-rt, KIỂM THỬ) Thay hẳn danh sách mô-đun tính năng (mặc định `defaultFeatures()`). */
  features?: FeatureModule[];
  /** (cli-rt, KIỂM THỬ) fetch giả cho gọi mạng của lõi (tài khoản, /update, /doctor). */
  fetchImpl?: typeof fetch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mô-đun tính năng (lane cli-features) — cắm vào runtime mà không sửa lõi
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsApi {
  /** Đọc theo khoá chấm (`agent.compactAtPercent`, `permissions.allow`, `hooks`…), đã gộp user < project < local < env. */
  get<T>(key: string, fallback: T): T;
  /** Ghi vào tệp cài đặt của phạm vi. `project`/`local` chỉ ghi khi thư mục đã tin cậy. */
  set(key: string, value: unknown, scope: 'user' | 'project' | 'local'): void;
  /** Đường dẫn tệp cài đặt của phạm vi (để hiện cho người dùng). */
  file(scope: 'user' | 'project' | 'local'): string;
}

export interface SlashRunContext {
  /** Phần chữ sau tên lệnh (đã cắt khoảng trắng). */
  readonly args: string;
  readonly lang: 'vi' | 'en';
  /** In một khối (markdown) vào hội thoại. */
  output(text: string, kind?: 'markdown' | 'plain' | 'error'): void;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
  /** Hỏi người dùng (không tương tác → trả null). */
  ask(req: AskInput): Promise<AskAnswer>;
  /** Chạy MỘT lượt agent như thể người dùng gõ nội dung này (không lưu dòng lệnh). */
  runPrompt(text: string, opts?: { model?: string }): Promise<void>;
  readonly busy: boolean;
}

export interface FeatureSlashDef {
  /** Không có dấu `/`, chữ thường. */
  name: string;
  description: { vi: string; en: string };
  argHint?: string;
  /** true (mặc định) = chỉ chạy khi rảnh. */
  needsIdle?: boolean;
  run(ctx: SlashRunContext): Promise<void> | void;
}

export interface FeatureContext {
  readonly cwd: string;
  readonly home: string;
  readonly lang: 'vi' | 'en';
  readonly version: string;
  readonly interactive: boolean;
  /** (cli-rt) Một phần tuỳ chọn khởi tạo mà tính năng cần (--mcp-config, --add-dir, --allowedTools, --append-system-prompt…). */
  readonly options?: Readonly<Pick<RuntimeOptions, 'mcpConfig' | 'addDirs' | 'allowedTools' | 'disallowedTools' | 'appendSystemPrompt' | 'permissionMode' | 'noPersist' | 'verbose' | 'timeoutSec'>>;
  readonly host: ToolHost;
  readonly settings: SettingsApi;
  /** Sổ kỹ năng và sổ agent do lõi (cli-rt) tạo sẵn với phần dựng sẵn; tính năng gọi `loadDirs(host, dirs)` để thêm thư mục người dùng/dự án. */
  readonly skills: SkillRegistry;
  readonly agents: AgentRegistry;
  /** Cho phép ĐỌC thêm một thư mục ngoài workspace (thư mục kỹ năng/agent/lệnh…) — vào `ToolHost.extraReadRoots()`. */
  addReadRoot(dir: string): void;
  /** Phiên đang chạy — LUÔN gọi hàm (đổi khi /resume, /new). */
  session(): SessionState;
  isTrusted(): boolean;
  isBusy(): boolean;

  emit(e: RuntimeEvent): void;
  output(text: string, kind?: 'markdown' | 'plain' | 'error'): void;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
  ask(req: AskInput): Promise<AskAnswer>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;

  /** Đăng ký lệnh gạch chéo. Trả về hàm gỡ. */
  slash(def: FeatureSlashDef, source?: 'builtin' | 'project' | 'user' | 'plugin' | 'mcp'): () => void;
  /** Thay cả nhóm lệnh nạp động của một nguồn (lệnh .locaith/commands, lệnh MCP…). */
  replaceSlashSource(source: 'project' | 'user' | 'plugin' | 'mcp', defs: readonly FeatureSlashDef[]): void;
  /** Thêm RunExtension cho engine chính (và, nếu `subAgents`, cho agent con). Thứ tự đăng ký = thứ tự gọi; `verifier` nên đăng ký CUỐI (`last: true`). */
  addRunExtension(ext: RunExtension, opts?: { subAgents?: boolean; last?: boolean }): void;
  /** Khai báo thêm công cụ vào registry mỗi khi runtime dựng lại (MCP, công cụ nền…). */
  addToolContributor(fn: (add: (tool: unknown) => void) => void): void;
  /** Đóng góp vào RuntimeStatus (số tác vụ nền, số tệp đã đổi, cảnh báo…). Gọi lại `refresh()` khi dữ liệu đổi. */
  addStatusContributor(fn: (s: RuntimeStatus) => void): { refresh(): void };
  /** Đóng góp một đoạn vào system prompt (chỉ dẫn MCP, phong cách đầu ra…). */
  addPromptContributor(fn: () => string | null): void;
  /** Đăng ký việc dọn khi thoát/đổi phiên. */
  onDispose(fn: () => void | Promise<void>): void;
  onSessionChange(fn: (s: SessionState) => void): void;

  // ── (cli-rt) Điểm móc bổ sung — đều TUỲ CHỌN trong kiểu (lõi luôn cung cấp), dùng `ctx.beforeSend?.(…)` ──
  /** Trước khi tin người dùng tới model (hook UserPromptSubmit/SessionStart): trả `{blocked:true, reason}` để chặn; tin bị chặn được trả về ô nhập qua action `insert`. */
  beforeSend?(fn: (info: { text: string; signal: AbortSignal }) => { blocked?: boolean; reason?: string } | void | Promise<{ blocked?: boolean; reason?: string } | void>): void;
  /** Ngay trước khi nén ngữ cảnh thật sự bắt đầu (hook PreCompact). */
  onBeforeCompact?(fn: (info: { session: SessionState; trigger: 'auto' | 'manual' | 'overflow'; signal: AbortSignal }) => void | Promise<void>): void;
  /** Sau khi nén thành công, kèm bản tóm tắt (lưu vào bộ nhớ dài hạn…). */
  onCompacted?(fn: (info: { session: SessionState; summary: string }) => void | Promise<void>): void;
  /** Sau MỖI lần công cụ ghi tệp thành công: `before` = nội dung trước (null = tệp mới; {skipped} = không đọc được) — checkpoints/rewind. */
  onFileWrite?(fn: (abs: string, before: string | null | { skipped: 'binary' | 'unreadable' }, after: string) => void): void;
  /** Khi một yêu cầu xin quyền được trình ra (hook Notification). */
  onPermissionRequest?(fn: (req: PermissionRequest) => void): void;
  /** Transcript hiện tại (chỉ đọc). */
  transcript?(): readonly TItem[];
  /** Ghi phiên hiện tại ngay (trước /fork, /rewind…). */
  saveSession?(): Promise<void>;
  /**
   * Thay phiên đang chạy bằng `next` (fork/rewind/…): ghi phiên cũ, đặt `next`, dựng lại transcript (từ `opts.transcript` hoặc từ messages),
   * phát `replay` + `status`, gọi `onSessionChange`. Chỉ khi rảnh.
   */
  replaceSession?(next: SessionState, opts?: { reason?: 'resume' | 'fork' | 'rewind' | 'new' | 'clear'; transcript?: TItem[] }): Promise<void>;
}

export interface FeatureModule {
  readonly name: string;
  /** Gọi một lần khi runtime khởi tạo. Có thể trả về hàm dọn. */
  attach(ctx: FeatureContext): void | (() => void) | Promise<void | (() => void)>;
}
