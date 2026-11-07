/**
 * Kiểu dùng chung của engine: công cụ, ngữ cảnh chạy công cụ, host trừu tượng, trạng thái phiên.
 * Không import `vscode` — mọi thứ phụ thuộc môi trường đi qua `ToolHost`.
 */

import type { ChatMessage, ImageBlock, JsonSchema, ThinkingLevel } from '../types';
import type { DiffInfo, PermissionKind, PermissionMode, PermissionRequest, SuggestionOption, TodoItem, UiEvent } from '../../shared/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Công cụ
// ─────────────────────────────────────────────────────────────────────────────

/** read = chỉ đọc; write = sửa tệp; exec = chạy lệnh; network = ra mạng; meta = nội bộ (todo, skill…); act = thao tác lên trang web (bản trình duyệt). */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'meta' | 'act';

export interface ToolContext {
  signal: AbortSignal;
  session: SessionState;
  host: ToolHost;
  callId: string;
  /** id lượt trả lời hiện tại (để tool tự phát UiEvent như artifact, skill). */
  assistantId: string;
  emit(ev: UiEvent): void;
  /** Báo tiến độ (stdout của lệnh…) lên giao diện. */
  progress(text: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface ToolResult {
  /** Nội dung gửi lại cho model. */
  content: string;
  isError?: boolean;
  images?: ImageBlock[];
  /** Số bước của một thao tác lên trang (bản trình duyệt): hiện trên dấu ở trang lẫn trong khung chat để người dùng nhắc lại "bước 3". */
  step?: number;
  /** Chuỗi ngắn cạnh nhãn trên giao diện: "12 kết quả", "+24 −3". */
  summary?: string;
  /** Xem trước hiển thị cho người dùng (mặc định lấy từ content). */
  display?: string;
  diff?: DiffInfo;
  /** Tên các công cụ vừa được mở khoá (load_skill). */
  unlock?: string[];
}

/** Điều cần xin phép trước khi chạy một công cụ. */
export interface PermissionNeed {
  kind: PermissionKind;
  title: string;
  detail?: string;
  command?: string;
  diff?: DiffInfo;
  planMarkdown?: string;
  /** Khoá cho lựa chọn "cho phép trong phiên này"; không có = không cho chọn. */
  sessionKey?: string;
  sessionLabel?: string;
  /** Động vào ngoài workspace / đường dẫn nhạy cảm → luôn hỏi, trừ chế độ bypass. */
  elevated?: boolean;
  /** Bản trình duyệt: ở chế độ "tự nhận" được phép bỏ qua câu hỏi này (thao tác thường, trên trang không nhạy cảm). Không áp dụng khi `elevated`. */
  autoInAcceptEdits?: boolean;
}

export interface ToolDef<I = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  /** An toàn khi chạy song song với các lệnh gọi khác (chỉ đọc, không đổi trạng thái chung). */
  concurrencySafe: boolean;
  /** Không đưa cho model cho tới khi một skill mở khoá. */
  hidden?: boolean;
  /** Chỉ hiện ở một chế độ quyền nhất định (ví dụ exit_plan_mode chỉ có khi đang lập kế hoạch). */
  onlyInMode?: PermissionMode;
  /** Có hiện ở chế độ lập kế hoạch không. Mặc định: risk là read/network/meta. */
  planSafe?: boolean;
  /** Gọi lặp lại với đúng đối số cũ là bình thường (kết quả phụ thuộc trạng thái bên ngoài thay đổi theo thời gian: trang web đang cuộn/tải) → không bị chặn "lặp vô ích". */
  repeatExempt?: boolean;
  /** Đối số lớn (mã nguồn/nội dung) → xin stream từng mảnh và tóm tắt "đang viết…". */
  streamsContent?: boolean;
  /** Tên trường chứa nội dung dài (để bộ tóm tắt biết đang viết gì). */
  contentField?: string;
  /** Kiểm tra ngữ nghĩa ngoài JSON-schema. Trả chuỗi lỗi, hoặc null nếu ổn. */
  validate?(input: I, ctx: ToolContext): string | null | Promise<string | null>;
  /** Có cần xin phép không (null = không). Chỉ gọi khi chế độ quyền yêu cầu cân nhắc. */
  permission?(input: I, ctx: ToolContext): Promise<PermissionNeed | null>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Host trừu tượng (VS Code hoặc Node thuần cho test)
// ─────────────────────────────────────────────────────────────────────────────

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
  /** Dòng ngữ cảnh trước/sau (nếu yêu cầu). */
  before?: string[];
  after?: string[];
}

export interface GrepResult {
  hits: GrepHit[];
  truncated: boolean;
  filesScanned: number;
  /** Số tệp có thể chứa bí mật (.env, khoá riêng…) đã bị bỏ qua — nội dung chúng không được gửi cho model. */
  skippedSecret?: number;
  /** Tìm kiếm bị dừng vì biểu thức chính quy chạy quá lâu (nguy cơ treo máy do backtracking). */
  regexTimedOut?: boolean;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onData(chunk: string): void;
}

export interface RunCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

export interface PermissionDecision {
  decision: 'allow' | 'allow_session' | 'deny';
  feedback?: string;
}

/** Tệp không phải UTF-8 hợp lệ (Windows-1258, TCVN3, UTF-16…): đọc bằng UTF-8 sẽ thay byte lạ bằng U+FFFD, ghi lại là mất chữ vĩnh viễn. */
export class NotUtf8Error extends Error {
  constructor(readonly abs: string) {
    super(`Tệp không phải UTF-8 hợp lệ: ${abs}`);
    this.name = 'NotUtf8Error';
  }
}

export interface ToolHost {
  readonly platform: { os: 'windows' | 'mac' | 'linux'; shell: string; shellLabel: string };
  workspaceRoots(): string[];
  /** Thư mục cá nhân của người dùng (`~`), nếu biết — chỗ lưu ký ức dùng chung mọi dự án. */
  homeDir?: string;
  /** Các thư mục ngoài workspace được phép ĐỌC (thư mục skill, phần mở rộng). */
  extraReadRoots(): string[];

  stat(abs: string): Promise<FileStat | null>;
  /** Đọc văn bản; ưu tiên nội dung chưa lưu trong editor nếu có. null = không đọc được/không tồn tại. Ném NotUtf8Error nếu tệp không phải UTF-8. */
  readText(abs: string): Promise<string | null>;
  readBytes(abs: string): Promise<Uint8Array>;
  writeText(abs: string, content: string): Promise<void>;
  readDir(abs: string): Promise<DirEntry[]>;
  glob(opts: { pattern: string; cwd: string; limit: number; signal: AbortSignal }): Promise<string[]>;
  grep(opts: {
    pattern: string;
    cwd: string;
    glob?: string;
    ignoreCase: boolean;
    context: number;
    limit: number;
    signal: AbortSignal;
  }): Promise<GrepResult>;
  runCommand(opts: RunCommandOptions): Promise<RunCommandResult>;

  fetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * Tải URL do MODEL chỉ định, ghim địa chỉ IP đã kiểm tra vào kết nối (chống DNS rebinding) và không tự theo chuyển hướng.
   * Host không cài đặt thì công cụ dùng `fetch` thường.
   */
  fetchPublic?(url: URL, init: { headers?: Record<string, string>; signal?: AbortSignal }, allowPrivate: boolean): Promise<Response>;
  /** Đọc cấu hình người dùng (locaithAgent.*). */
  setting<T>(key: string, fallback: T): T;
  secret(name: string): Promise<string | undefined>;

  requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Ghi lại nội dung trước/sau của một thay đổi tệp để giao diện mở được diff đầy đủ trong editor (tuỳ chọn). */
  recordFileChange?(callId: string, change: { abs: string; rel: string; before: string | null; after: string }): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái phiên (có thể JSON hoá để lưu)
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactRecord {
  id: string;
  title: string;
  /** html | svg | markdown | … */
  type: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface SessionState {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  mode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  /** Swarm bật: ưu tiên chia việc cho nhiều agent con và mở công cụ workflow. Phiên cũ dùng thinkingLevel='swarm' được chuyển sang cờ này khi nạp. */
  swarm?: boolean;
  messages: ChatMessage[];
  todos: TodoItem[];
  /**
   * Các lựa chọn hướng đi trợ lý đưa ra ở cuối lượt (nút bấm, không phải đoạn văn trong chat).
   * Bị xoá mỗi khi có tin nhắn mới của người dùng — một lựa chọn chỉ có nghĩa với lượt vừa xong.
   */
  options?: SuggestionOption[];
  scratchpad: Record<string, string>;
  loadedSkills: string[];
  /** Các khoá "cho phép trong phiên này" đã được người dùng chọn. */
  approvals: string[];
  /** đường dẫn tuyệt đối → hash nội dung lần đọc cuối (chặn sửa mù / ghi đè khi tệp đã đổi). */
  readFiles: Record<string, string>;
  artifacts: Record<string, ArtifactRecord>;
  /** Lịch sử đã bị nén/cắt tỉa kể từ lần gọi trước (adapter Anthropic phải bỏ khối suy luận cũ). */
  historyEdited: boolean;
  /**
   * Dấu vân tay của (system prompt + danh sách công cụ) ở lần gọi thành công gần nhất. Khối suy luận của Anthropic chỉ hợp lệ
   * khi hai thứ này không đổi, nên khi nó đổi (duyệt kế hoạch, nạp kỹ năng, sang ngày mới) engine xoá suy luận cũ.
   */
  promptFingerprint?: string;
  /** (lane:commands-agents) Phong cách đầu ra do người dùng chọn bằng `/output-style` cho phiên này (vắng = theo cài đặt). */
  outputStyle?: { name: string; prompt: string };
  /** Kích thước ngữ cảnh thực của lần gọi gần nhất (token). */
  lastContextTokens: number;
  usageTotals: { input: number; output: number };
}

export function newSession(partial: Partial<SessionState> & Pick<SessionState, 'id' | 'provider' | 'model'>): SessionState {
  const now = Date.now();
  return {
    title: 'Cuộc trò chuyện mới',
    createdAt: now,
    updatedAt: now,
    mode: 'default',
    thinkingLevel: 'medium',
    messages: [],
    todos: [],
    scratchpad: {},
    loadedSkills: [],
    approvals: [],
    readFiles: {},
    artifacts: {},
    historyEdited: false,
    lastContextTokens: 0,
    usageTotals: { input: 0, output: 0 },
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cài đặt cho một lượt chạy
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineSettings {
  maxTurns: number;
  maxOutputTokens: number;
  parallelToolCalls: boolean;
  language: 'vi' | 'en';
  autoCompact: boolean;
  /** Cửa sổ ngữ cảnh của model đang dùng (token). */
  contextWindow: number;
  /**
   * Ngưỡng nén TỰ ĐỘNG, tính theo phần trăm cửa sổ ngữ cảnh (0,5–0,95; mặc định 0,8).
   * Khách báo nén ở ~100k là quá sớm với model cửa sổ lớn → nâng lên 0,9 để giữ ngữ cảnh lâu hơn.
   */
  compactAt?: number;
  /** Tên các tệp hướng dẫn dự án cần nạp, theo thứ tự ưu tiên. */
  instructionFiles: string[];
  /** Gom delta suy nghĩ/mã: số ký tự tối thiểu hoặc khoảng thời gian trước khi tóm tắt. */
  summarizeEveryChars: number;
  summarizeEveryMs: number;
  maxPillsPerReply: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  // Gần như không trần (Claude Code không đặt giới hạn): 200 vòng là quá đủ cho một việc lớn, và khi chạm trần
  // engine vẫn cho MỘT lượt tổng kết thay vì cắt ngang công việc.
  maxTurns: 200,
  maxOutputTokens: 32000,
  parallelToolCalls: true,
  language: 'vi',
  autoCompact: true,
  contextWindow: 200_000,
  instructionFiles: ['LOCAITH.md', 'AGENTS.md', 'CLAUDE.md'],
  summarizeEveryChars: 700,
  summarizeEveryMs: 1500,
  maxPillsPerReply: 14,
};
