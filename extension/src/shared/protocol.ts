/**
 * Giao thức giữa extension host (Node) và webview (trình duyệt), cộng với các kiểu hiển thị dùng chung.
 * File này được cả hai phía import → KHÔNG dùng `vscode`, KHÔNG dùng API riêng của Node hay DOM.
 *
 * Nguyên tắc: host là nguồn sự thật. Webview chỉ nhận `init` (ảnh chụp đầy đủ) rồi các `events`
 * tăng dần, và áp chúng bằng cùng một reducer (xem transcript.ts) — nên khi webview bị VS Code
 * huỷ rồi tạo lại, chỉ cần gửi lại `init`.
 */

import type { ModelInfo, ThinkingLevel, Usage } from '../core/types';
import type { DocKind } from './docKinds';

export type { DocKind, ModelInfo, ThinkingLevel, Usage };

// ─────────────────────────────────────────────────────────────────────────────
// Kiểu dữ liệu hiển thị
// ─────────────────────────────────────────────────────────────────────────────

/**
 * default     = hỏi trước khi sửa file / chạy lệnh
 * acceptEdits = tự nhận chỉnh sửa trong workspace, vẫn hỏi khi chạy lệnh
 * plan        = chỉ đọc + lập kế hoạch, trình kế hoạch để duyệt
 * bypass      = không hỏi gì (nguy hiểm, phải bật trong cài đặt)
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

/**
 * Một lựa chọn hướng đi mà trợ lý đưa ra ở cuối lượt (thay cho đoạn "bước tiếp theo" viết trong chat).
 * Bấm một lựa chọn = gửi `prompt` như tin nhắn của người dùng, nên chọn xong là trợ lý làm trọn việc đó.
 */
export interface SuggestionOption {
  id: string;
  /** Nhãn ngắn hiện trên nút (≤ 60 ký tự). */
  label: string;
  /** Câu gửi đi khi bấm — phải đủ rõ để một mình nó là một yêu cầu trọn vẹn. */
  prompt: string;
  /** Một dòng giải thích thêm (tuỳ chọn). */
  detail?: string;
  /** (lane:output-timeouts) 'continue' = nút «Chạy tiếp (phần N)» do harness phát khi lượt bị cắt/buộc dừng — giao diện vẽ gọn một dòng. Bản cũ bỏ qua: vẫn là nút thường. */
  kind?: 'continue';
}

export interface DiffLine {
  /** ' ' giữ nguyên, '+' thêm, '-' xoá */
  t: ' ' | '+' | '-';
  s: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffInfo {
  /** Đường dẫn tương đối theo workspace nếu có thể. */
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  isNew?: boolean;
  /** Diff quá dài nên đã cắt bớt khi gửi lên giao diện. */
  truncated?: boolean;
}

/** 'browser' = thao tác/đọc trên trang web trong bản trình duyệt (Chrome/Edge). */
export type PermissionKind = 'edit' | 'create' | 'command' | 'network' | 'plan' | 'outside_workspace' | 'browser' | 'other';

export interface PermissionRequest {
  id: string;
  callId: string;
  tool: string;
  kind: PermissionKind;
  /** Câu hỏi ngắn: "Cho phép sửa src/app.ts?" */
  title: string;
  detail?: string;
  command?: string;
  diff?: DiffInfo;
  /** Kế hoạch (Markdown) khi kind = 'plan'. */
  planMarkdown?: string;
  /** Có cho chọn "Cho phép trong phiên này" không. */
  canAllowSession: boolean;
  /** Nhãn của lựa chọn phiên, ví dụ "Luôn cho phép `npm test` trong phiên này". */
  sessionLabel?: string;
}

export type PillKind = 'thinking' | 'writing' | 'working';

export interface ArtifactRef {
  artifactId: string;
  title: string;
  /** html | svg | markdown | dashboard … */
  artifactType: string;
}

/** Ảnh do công cụ trả về (ví dụ ảnh chụp màn hình trang) để người dùng bấm xem. base64 không tiền tố data:. Chỉ nằm trong bộ nhớ khung chat, không bao giờ được lưu. */
export interface ToolImage {
  mediaType: string;
  data: string;
}

/**
 * Tiến độ SỐNG của một agent con (công cụ `agent`) hoặc cả một workflow (`workflow_run`), để giao diện hiện một dòng gọn:
 * «461,4k token · 12 lệnh · 5 phút 18 giây» kèm việc đang làm. Chỉ là số liệu hiển thị, không bao giờ đưa vào lịch sử gửi mô hình.
 */
export interface AgentProgress {
  /** Tổng token đã dùng (vào + ra, cộng ước lượng phần đang stream). */
  tokens: number;
  /** Số lệnh gọi công cụ agent con đã chạy (không tính thẻ xin phép được chuyển lên luồng chính — chúng có dòng riêng). */
  tools: number;
  /** Trong đó bao nhiêu lệnh lỗi. */
  failed?: number;
  /** Việc đang làm, một dòng ngắn đã Việt/Anh hoá ở host: «Đang đọc src/a.ts», «Đang suy nghĩ…». */
  activity?: string;
}

export interface ToolBlock {
  type: 'tool';
  /** = callId của lệnh gọi tool */
  id: string;
  name: string;
  args: Record<string, unknown>;
  state: 'running' | 'awaiting_permission' | 'done' | 'error' | 'denied' | 'cancelled';
  /** Chuỗi ngắn tool trả về để hiện cạnh nhãn: "12 kết quả", "+24 −3". */
  summary?: string;
  /** Xem trước kết quả (đã cắt). */
  output?: string;
  diff?: DiffInfo;
  /** Ảnh kèm kết quả công cụ (ảnh chụp màn hình…). */
  images?: ToolImage[];
  /** Số bước của thao tác lên trang (khớp với dấu số hiện trên trang). */
  step?: number;
  permission?: PermissionRequest;
  /** Chỉ có ở công cụ `agent` / `workflow_run`: tiến độ sống (xem AgentProgress). Thiếu → dòng công cụ thường như trước. */
  agent?: AgentProgress;
  startedAt: number;
  durationMs?: number;
}

/**
 * Số liệu của một lần nén ngữ cảnh, đính kèm vào thông báo 'notice' (tuỳ chọn) để giao diện vẽ dòng gọn
 * «Đã nén cuộc trò chuyện · tự động · giải phóng 968k token». Là TRƯỜNG TUỲ CHỌN của loại đã có (không phải loại sự kiện mới):
 * bản cũ và trang Remote cũ chỉ thấy dòng chữ thường, không hỏng.
 */
export interface CompactInfo {
  mode: 'auto' | 'manual' | 'overflow';
  /** Ước lượng token giải phóng được (trước − sau). */
  tokensFreed?: number;
  summarizedMessages?: number;
  /** Số kết quả công cụ cũ đã bị lược (xoá nội dung, đọc lại được). */
  clearedResults?: number;
  /** Bản tóm tắt (cắt hợp lý) để mở ra xem. */
  summary?: string;
}

/**
 * (lane:ctx-compaction) Thanh đo ngữ cảnh. Hai trường đầu là của bản cũ (Remote cũ vẫn đọc được); phần còn lại tuỳ chọn.
 */
export interface ContextInfo {
  usedTokens: number;
  limitTokens: number;
  /** usedTokens / limitTokens × 100, làm tròn (0–100+). */
  percent?: number;
  /** Số kết quả công cụ cũ đã lược trong phiên (đọc lại được). */
  clearedResults?: number;
  /** Số lần tóm tắt toàn bộ trong phiên. */
  compactions?: number;
}

export type ABlock =
  | { type: 'text'; id: string; text: string }
  /**
   * Văn bản suy luận thật do hãng trả (nếu có) — hiển thị trong khối thu gọn.
   * (lane:cc-timeline-ui) `startedAt`/`durationMs` TUỲ CHỌN: mốc delta đầu và khoảng tới delta cuối (từ `ts` của sự kiện `thinking`),
   * để vẽ «Đã suy nghĩ 14 giây». Phiên cũ không có → chỉ «Đã suy nghĩ».
   */
  | { type: 'thinking'; id: string; text: string; startedAt?: number; durationMs?: number }
  /** Dòng trạng thái chạy trực tiếp ("Đang đối chiếu điểm số…"): chấm cam khi đang chạy, xám khi xong. */
  | { type: 'pill'; id: string; text: string; kind: PillKind; active: boolean }
  /** "Đã thêm tác vụ: …" */
  | { type: 'tasks'; id: string; added: string[] }
  /** "Đã tải kỹ năng artifacts" */
  | { type: 'skill'; id: string; skill: string; unlocked: string[] }
  | ToolBlock
  | ({ type: 'artifact'; id: string; state: 'writing' | 'ready'; sizeChars?: number } & ArtifactRef)
  | { type: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; compact?: CompactInfo };

/** Tệp người dùng tải lên (PDF, Word, Excel, HTML, CSV, TXT) sau khi đã được đọc thành chữ. */
export interface DocInfo {
  kind: DocKind;
  /** Chữ đã trích. Đi host → webview lúc đọc xong, rồi webview → host khi gửi; host KHÔNG đưa lại vào transcript (chỉ nằm trong tin nhắn gửi cho mô hình). */
  text?: string;
  /** PDF: số trang · Excel: số trang tính · CSV: số hàng. */
  pages?: number;
  sheets?: number;
  rows?: number;
  /** Chữ dài hơn ngân sách nên chỉ giữ phần đầu; `totalChars` là độ dài đầy đủ. */
  truncated?: boolean;
  totalChars?: number;
  /** Ghi chú cho người dùng (đoán bảng mã, bỏ chữ ẩn…). */
  notes?: string[];
}

export interface AttachmentInfo {
  /** 'tab' (bản trình duyệt) = nội dung một tab đang mở; `path` là `tab:<id>`. 'doc' = tệp tải lên đã đọc thành chữ (xem `doc`). */
  kind: 'file' | 'selection' | 'image' | 'folder' | 'tab' | 'doc';
  /** Tên hiển thị trên chip. */
  label: string;
  /** Đường dẫn tương đối theo workspace (file/selection/folder), hoặc `tab:<id>` (tab). */
  path?: string;
  /** Dòng bắt đầu/kết thúc, 1-based (selection). */
  range?: [number, number];
  mediaType?: string;
  /** Chỉ webview → host (ảnh dán vào): base64 không tiền tố. Host không gửi lại trường này. */
  data?: string;
  sizeBytes?: number;
  /** Chỉ với kind 'doc'. */
  doc?: DocInfo;
  /** Ảnh thu nhỏ (JPEG base64, không tiền tố) để hiện trong tin đã gửi và xem phóng to ngay. */
  thumb?: string;
  /** Khoá nhận diện ảnh (xem imageKey) để xin bản đầy đủ từ host. */
  imgKey?: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  attachments: AttachmentInfo[];
  ts: number;
  /** Tin gửi lúc trợ lý đang làm việc và được chèn GIỮA vòng công cụ (chung tin nhắn kết quả công cụ) — khác với tin mở đầu một lượt. */
  steer?: boolean;
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  provider: string;
  model: string;
  ts: number;
  blocks: ABlock[];
  done: boolean;
  stopReason?: string;
  usage?: Usage;
  /** (0.6.3) Lúc lượt kết thúc (ms) — dòng «Đã làm việc 2 phút 13 giây». Phiên cũ không có: ước lượng từ lệnh công cụ cuối. */
  endedAt?: number;
}

/** Thông báo độc lập (không thuộc lượt trả lời nào): lỗi, đổi chế độ, đã nén ngữ cảnh… */
export interface NoticeItem {
  kind: 'notice';
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  ts: number;
  compact?: CompactInfo;
}

export type TItem = UserItem | AssistantItem | NoticeItem;

// ─────────────────────────────────────────────────────────────────────────────
// Sự kiện giao diện (host → webview, và được host lưu lại để dựng transcript)
// ─────────────────────────────────────────────────────────────────────────────

export type UiEvent =
  | { t: 'user'; id: string; text: string; attachments: AttachmentInfo[]; ts: number; steer?: boolean }
  | { t: 'assistant_start'; id: string; provider: string; model: string; ts: number }
  /**
   * Nối vào khối văn bản cuối của lượt trả lời `id` (hoặc mở khối mới nếu khối cuối không phải văn bản).
   * (lane:output-timeouts) `trimTail`: bỏ bấy nhiêu ký tự ở CUỐI khối văn bản cuối TRƯỚC khi nối `delta` — dùng khi harness lùi câu trả lời
   * bị cắt về ranh giới câu. Trường tuỳ chọn: bản cũ/Remote cũ bỏ qua và chỉ nối `delta`.
   */
  | { t: 'text'; id: string; delta: string; trimTail?: number }
  /** (lane:cc-timeline-ui) `ts` tuỳ chọn: lúc delta này được phát (engine đóng dấu) → reducer tính thời lượng suy nghĩ. */
  | { t: 'thinking'; id: string; delta: string; ts?: number }
  /** Tạo mới hoặc cập nhật dòng trạng thái: cùng pillId và dòng đó còn active → thay chữ; ngược lại mở dòng mới, các dòng active cũ chuyển xám. */
  | { t: 'pill'; id: string; pillId: string; text: string; kind: PillKind }
  /** Danh sách tác vụ hiện tại (ảnh chụp đầy đủ) + những tiêu đề vừa được thêm lần này. */
  | { t: 'tasks'; id: string; todos: TodoItem[]; added: string[] }
  | { t: 'skill'; id: string; skill: string; unlocked: string[] }
  | { t: 'tool_start'; id: string; callId: string; name: string; args: Record<string, unknown> }
  | { t: 'tool_progress'; id: string; callId: string; output: string }
  /** Ảnh chụp tiến độ MỚI NHẤT (không phải số gia) của agent con đang chạy — gộp được: chỉ giữ cái cuối cùng cho mỗi callId. */
  | ({ t: 'agent_progress'; id: string; callId: string } & AgentProgress)
  | { t: 'tool_permission'; id: string; callId: string; request: PermissionRequest }
  | {
      t: 'tool_end';
      id: string;
      callId: string;
      state: 'done' | 'error' | 'denied' | 'cancelled';
      summary?: string;
      output?: string;
      diff?: DiffInfo;
      images?: ToolImage[];
      step?: number;
      durationMs: number;
    }
  | ({ t: 'artifact'; id: string; state: 'writing' | 'ready'; sizeChars?: number } & ArtifactRef)
  | { t: 'usage'; id: string; usage: Usage; contextTokens?: number }
  | { t: 'assistant_end'; id: string; stopReason: string }
  /** Có id → gắn vào lượt trả lời đó; không có → thành NoticeItem độc lập. */
  | { t: 'notice'; id?: string; level: 'info' | 'warn' | 'error'; text: string; compact?: CompactInfo }
  | { t: 'run_state'; running: boolean }
  | { t: 'mode'; mode: PermissionMode }
  /** Cập nhật bảng tác vụ cố định phía trên ô nhập. */
  | { t: 'todos'; todos: TodoItem[] }
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
  /** Các lựa chọn hướng đi hiện dưới dạng nút (rỗng = thu hồi). Thay cho việc liệt kê "bước tiếp theo" trong chat. */
  | { t: 'options'; id?: string; options: SuggestionOption[] };

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái tổng của giao diện
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderSummary {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  hasKey: boolean;
  /** Dùng khoá từ biến môi trường (không cần nhập). */
  keyFromEnv?: boolean;
  builtin: boolean;
  keyUrl?: string;
  models: ModelInfo[];
  modelSource: 'live' | 'cache' | 'fallback';
  modelError?: string;
  /** Có thể đăng nhập bằng tài khoản (OAuth) thay cho khoá API (bản trình duyệt). */
  oauth?: { flow: OAuthSpecInput['flow']; signedIn: boolean };
  /** Khoá của nhà cung cấp này là token đăng nhập tài khoản Locaith (họ AI Local): không có ô nhập khoá, `hasKey` = đã đăng nhập. */
  account?: boolean;
  /** Chỉ với `account`: tài khoản chưa đồng ý thông báo dữ liệu → chưa gửi gì tới cổng và chưa được tự chọn. */
  needsConsent?: boolean;
}

/** Cấu hình đăng nhập OAuth của một nhà cung cấp (bản trình duyệt). */
export type OAuthSpecInput = { flow: 'openrouter' } | { flow: 'oauth2'; authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string };

export type UiFontFamily = 'be-vietnam-pro' | 'manrope' | 'inter' | 'system';
export type UiCodeFont = 'jetbrains-mono' | 'editor';
export type UiLanguage = 'vi' | 'en';

export interface UiSettings {
  language: UiLanguage;
  fontFamily: UiFontFamily;
  /** px, 12–20 */
  fontSize: number;
  /** 1.4–2.0 */
  lineHeight: number;
  codeFont: UiCodeFont;
  /** Hiện khối "Suy nghĩ" thô khi hãng trả về. */
  showThinking: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  provider: string;
  model: string;
  messageCount: number;
  /** Cuộc trò chuyện được tạo khi mở thư mục làm việc khác. */
  other?: boolean;
  workspaceName?: string;
}

/** Cuộc trò chuyện đã xoá, đang nằm trong Thùng rác (khôi phục được trong 30 ngày). */
export interface TrashSummary extends SessionSummary {
  deletedAt: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  loaded: boolean;
  source: 'builtin' | 'workspace' | 'user';
}

export interface SlashCommandInfo {
  name: string;
  description: string;
}

// ── Điều phối nhiều AI ──────────────────────────────────────────────────────────

/** off = chỉ dùng model đang chọn · failover = tự chuyển hãng khi bị giới hạn/quá tải · auto = thêm: agent con chọn model theo hạng và chia tải giữa các hãng. */
export type OrchestrationMode = 'off' | 'failover' | 'auto';

export interface OrchestrationPoolEntry {
  providerId: string;
  providerLabel: string;
  /** Đang nghỉ vì bị giới hạn tốc độ/lỗi. */
  cooling: boolean;
  tiers: Partial<Record<'top' | 'balanced' | 'fast', { model: string; label: string }>>;
}

export interface OrchestrationInfo {
  mode: OrchestrationMode;
  /** Các hãng đã nhập khoá và model Auto sẽ dùng cho từng hạng. */
  pool: OrchestrationPoolEntry[];
}

// ── Chợ: kỹ năng, plugin, MCP, agent ────────────────────────────────────────────

export interface MarketSkillItem {
  id: string;
  name: string;
  description: string;
  group: 'anthropic' | 'vendor' | 'community';
  repo: string;
  license: string;
  files: number;
  bytes: number;
}

export interface MarketPluginItem {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  skills: number;
  agents: number;
  commands: number;
  mcp: number;
  dir: string;
  error?: string;
  /** Cài từ Chợ plugin (gỡ được ngay trong giao diện). */
  fromMarket?: boolean;
}

export interface MarketMcpItem {
  name: string;
  scope: 'user' | 'workspace' | 'plugin' | 'connector';
  /** Tên dễ hiểu + lưu ý nguồn gốc (ví dụ "Memory (Anthropic) — không phải Bio-Memory của Locaith"). */
  label?: string;
  note?: string;
  catalogId?: string;
  hasInstructions?: boolean;
  origin?: string;
  transport: 'stdio' | 'http';
  status: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
  /** Server từ workspace/plugin chỉ chạy sau khi người dùng bật. */
  approved: boolean;
  summary: string;
  tools: { name: string; description: string; group?: 'read' | 'write'; policy?: 'allow' | 'ask' | 'deny' }[];
  /** Mức mặc định cho cả nhóm (khi công cụ chưa đặt riêng). */
  groupPolicy?: { read: 'allow' | 'ask' | 'deny'; write: 'allow' | 'ask' | 'deny' };
}

export interface MarketAgentItem {
  name: string;
  description: string;
  tier: string;
  tools: string;
  source: 'builtin' | 'workspace' | 'user' | 'plugin';
}

/** Một mục của kho kết nối (đã thăm dò thật — xem src/core/mcp/catalog.ts). */
export interface CatalogItem {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  transport: 'http' | 'stdio';
  auth: 'none' | 'oauth' | 'github' | 'local';
  own?: boolean;
  unsupported?: string;
  note?: string;
  needs?: 'node' | 'python';
  connected: boolean;
  status?: 'stopped' | 'starting' | 'running' | 'error';
  error?: string;
}

/**
 * Dải «Trí nhớ sinh học» trong khung chat khi Locaith-v5 đang TỰ bật nó (mặc định cho model Locaith): đang cài, hoặc chưa bật được (kèm lý do).
 * Bật xong thì trường này biến mất — không có gì để hiện.
 */
export interface MemoryView {
  state: 'installing' | 'error';
  message?: string;
}

/**
 * Extension Chrome đang XIN kết nối với VS Code (ghép đôi không mã): thẻ «Cho phép / Từ chối» hiện ngay trong khung chat. Vắng = không có yêu cầu nào đang chờ.
 */
export interface ChromePairView {
  id: string;
  /** Mã extension (32 ký tự) — giao diện chỉ hiện đuôi để người dùng nhận ra extension của mình. */
  extensionId: string;
  /** Hết hạn lúc (epoch ms, đồng hồ máy này). */
  expiresAt: number;
  /** Đã ghép với một extension rồi: bấm Cho phép sẽ thay thế. */
  rePair?: boolean;
}

export interface BioStatus {
  state: 'none' | 'installing' | 'ready' | 'error';
  enabled: boolean;
  /** Thư mục dữ liệu DUY NHẤT dùng chung cho mọi cuộc trò chuyện và mọi cửa sổ. */
  dataDir: string;
  message?: string;
  log?: string[];
}

/** Một plugin trong Chợ plugin (marketplace chính thức của Anthropic). */
export interface PluginMarketItem {
  id: string;
  name: string;
  description: string;
  category: string;
  installed: boolean;
  /** false = nguồn nằm ngoài GitHub, không cài tự động được. */
  installable: boolean;
  reason?: string;
  /** "anthropics" hoặc "chủ/repo". */
  origin: string;
}

export interface PluginMarketState {
  items: PluginMarketItem[];
  loading: boolean;
  error?: string;
  fetchedAt?: number;
  source: string;
}

/** Trạng thái cầu nối với extension Locaith trên Chrome. */
export interface ChromeStatus {
  running: boolean;
  paired: boolean;
  connected: boolean;
  port?: number;
  extensionId?: string;
  pairing?: { code: string; expiresAt: number };
  error?: string;
}

export interface McpPresetItem {
  id: string;
  name: string;
  description: string;
  /** Đã có trong cài đặt. */
  added: boolean;
}

export interface MarketState {
  /** true = chỉ có plugins/mcp/agents/presets (cập nhật nhanh); giữ nguyên danh sách kỹ năng đã có. */
  partial?: boolean;
  skills: MarketSkillItem[];
  installedSkills: string[];
  plugins: MarketPluginItem[];
  mcp: MarketMcpItem[];
  agents: MarketAgentItem[];
  presets: McpPresetItem[];
  catalog?: CatalogItem[];
  bio?: BioStatus;
  pluginMarket?: PluginMarketState;
  chrome?: ChromeStatus;
}

export interface EditorContextInfo {
  file?: string;
  language?: string;
  selection?: { startLine: number; endLine: number; chars: number };
}

/** Tab mà trợ lý đang "nhìn" (bản trình duyệt). */
export interface BrowserTabInfo {
  id: number;
  title: string;
  url: string;
  /** Hostname đã rút gọn để hiện trên chip. */
  host: string;
  /** Trợ lý đọc được nội dung tab này không (đã cấp quyền truy cập trang / activeTab). */
  readable: boolean;
  /** Đây là tab trợ lý ĐÃ GẮN VÀO (không đi theo khi người dùng đổi tab/cửa sổ). Không có = chỉ là tab đang xem. */
  pinned?: boolean;
}

/** Cài đặt riêng của bản trình duyệt (lưu trong chrome.storage, chỉnh ngay trong giao diện). */
export interface BrowserSettings {
  /** Chế độ quyền mặc định cho hội thoại mới. */
  defaultMode: PermissionMode;
  /** Cho phép chọn chế độ 'bypass' (không hỏi gì) — nguy hiểm, mặc định tắt. */
  allowBypass: boolean;
  maxTurns: number;
  /** Bật dòng trạng thái tóm tắt bằng model nhỏ. */
  summarizer: boolean;
  autoCompact: boolean;
  /** Gửi kèm tiêu đề + URL + đoạn đang chọn của tab hiện tại với mỗi tin nhắn. */
  attachTabContext: boolean;
  /** Hướng dẫn riêng của người dùng, nối vào system prompt (thay cho LOCAITH.md của bản VS Code). */
  customInstructions: string;
  /** Hiện viền sáng + nút Dừng nhỏ trên trang khi trợ lý đang đọc/điều khiển nó. */
  presence: boolean;
  /** Cho phép trợ lý đưa tab lên trước khi cần (mặc định tắt: bạn vẫn dùng tab khác bình thường trong lúc nó làm việc ngầm). */
  focusTabs: boolean;
  /** Bám tab: gắn vào tab ở tin nhắn đầu tiên của cuộc trò chuyện và giữ nguyên khi người dùng đổi tab/cửa sổ (tắt = theo tab đang xem lúc gửi tin). */
  pinTab: boolean;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  defaultMode: 'default',
  allowBypass: false,
  maxTurns: 30,
  summarizer: true,
  autoCompact: true,
  attachTabContext: true,
  customInstructions: '',
  presence: true,
  focusTabs: false,
  pinTab: true,
};

export interface BrowserViewState {
  /** Tab trợ lý đang bám (đã gắn) — hoặc tab đang xem nếu chưa gắn (null = chưa xác định được, ví dụ cửa sổ không có tab thường). */
  tab: BrowserTabInfo | null;
  /** Tab người dùng đang xem KHI KHÁC tab đã gắn (để đưa nút "Gắn vào tab này"); null khi trùng hoặc không phải trang web. */
  viewing?: BrowserTabInfo | null;
  /** Đã cấp quyền đọc/điều khiển mọi trang web (optional_host_permissions). */
  siteAccess: boolean;
  /** Tên trình duyệt để hiển thị ("Microsoft Edge" / "Google Chrome" / "Chromium"). */
  browser: string;
  settings: BrowserSettings;
}

/** API tuỳ chỉnh nạp từ giao diện (bản trình duyệt không có hộp thoại của VS Code). */
export interface CustomProviderInput {
  label: string;
  /** Mặc định 'openai-chat'. */
  kind?: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  baseUrl: string;
  /** Model ghim tay, cách nhau bởi dấu phẩy hoặc xuống dòng. */
  models?: string;
  requiresKey?: boolean;
  apiKey?: string;
  /** Đăng nhập bằng tài khoản (OAuth) thay cho khoá API. */
  oauth?: OAuthSpecInput;
  /** Đăng nhập ngay sau khi thêm (phải đi kèm một cú bấm của người dùng: cửa sổ đăng nhập/xin quyền cần cử chỉ). */
  loginNow?: boolean;
}

/** Tin nhắn đang xếp hàng, chờ được giao cho trợ lý (chỉ phần hiển thị, không có dữ liệu thô). */
export interface QueuedInfo {
  id: string;
  text: string;
  attachments: AttachmentInfo[];
  ts: number;
}

/**
 * Trạng thái tài khoản locaith.ai (bản VS Code). Chưa `signedIn` thì giao diện chỉ hiện màn đăng nhập và host từ chối mọi lệnh khác.
 * Không có trường này (bản trình duyệt) = không yêu cầu đăng nhập.
 */
export interface AccountView {
  status: 'signedOut' | 'signingIn' | 'signedIn' | 'expired';
  user?: { name: string; email: string; avatar?: string | null };
  /** Đang dùng trong thời gian ân hạn vì không xác minh được với máy chủ (mất mạng). */
  offline?: boolean;
  /** Lý do lần đăng nhập gần nhất thất bại: denied · failed · no_pending · invalid_grant · network · server … */
  error?: string;
  /** Vì sao phiên hết hiệu lực: revoked (đã thu hồi/hết hạn trên máy chủ) · grace (quá 7 ngày không xác minh được). */
  reason?: 'revoked' | 'grace';
  /** Đang đăng nhập kiểu dán mã (VS Code từ xa/web, nơi trình duyệt không tự chuyển về được). */
  manual?: boolean;
  /** Địa chỉ locaith.ai để mở «Quản lý thiết bị». */
  webUrl?: string;
}

/** Hàng chờ khi relay (Supabase Realtime) QUÁ TẢI — xem src/core/remote/queue.ts. Hiển thị ngay trong khung chat, không dùng thông báo của hệ thống VS Code. */
export interface RemoteQueueView {
  kind: 'connections' | 'rate' | 'channels';
  /** Lần thứ mấy bị từ chối liên tiếp (1, 2, 3…). */
  attempt: number;
  /** Thời điểm (epoch ms, đồng hồ máy này) sẽ tự thử lại — giao diện đếm ngược tới mốc này. */
  retryAt: number;
  /** Thời gian chờ đã định cho lần này (ms) — để vẽ thanh tiến trình; mốc bắt đầu lần chờ = retryAt − waitMs. */
  waitMs: number;
  /** Bắt đầu xếp hàng lúc (epoch ms). */
  since: number;
  /** Đang thử vào lại (từ lúc hết giờ chờ đến lúc có kết quả). */
  trying: boolean;
}

/**
 * Trạng thái Remote (điều khiển từ xa) cho khung chat. Remote BẬT SẴN cho người đã đăng nhập: đường Internet tự nối vào relay; trình duyệt đăng nhập ĐÚNG tài khoản Locaith của chủ máy
 * vào được ngay (0.6.5, `trust`), còn lại phải ghép đôi bằng liên kết/QR + «Cho phép». Quá tải thì `relay: 'queued'` kèm `queue` để đếm ngược. Chỉ bản VS Code.
 */
export interface RemoteView {
  /** Cài đặt `locaithAgent.remote.enabled` (mặc định BẬT). */
  enabled: boolean;
  /** Đã đăng nhập tài khoản Locaith (chưa đăng nhập thì Remote không chạy). */
  signedIn: boolean;
  /** Đường Internet: off = không chạy · connecting · online · offline (mất mạng, đang nối lại) · queued (relay quá tải, đang xếp hàng). */
  relay: 'off' | 'connecting' | 'online' | 'offline' | 'queued';
  queue?: RemoteQueueView;
  /** Số thiết bị đã ghép đôi / số kết nối đang mở. */
  devices: number;
  streams: number;
  /**
   * (0.6.5) Tin cậy theo tài khoản đang hoạt động: trình duyệt đăng nhập ĐÚNG tài khoản Locaith của chủ máy mở được máy ngay từ locaith.ai, không cần ghép đôi.
   * Vắng = không hoạt động (đã tắt trong cài đặt, hoặc máy chủ danh bạ chưa nâng cấp) → giao diện hướng dẫn ghép đôi như trước.
   */
  trust?: boolean;
}

/**
 * Hàng chờ của cổng Locaith khi có hơn 100 người dùng cùng lúc: hiện ngay trong khung chat (dải phía trên ô nhập), KHÔNG dùng thông báo hay thanh trạng thái của VS Code.
 * Vị trí là số thật cổng báo; đếm ngược chạy phía giao diện từ `retryAt` (xem webview/src/components/ModelQueue.tsx).
 */
export interface ModelQueueView {
  /** Vị trí trong hàng (1 = kế tiếp). */
  position: number;
  /** Số người đứng trước. */
  ahead: number;
  /** Lần hỏi thứ mấy trong lần xếp hàng này. */
  attempt: number;
  /** Mốc (epoch ms, đồng hồ máy này) sẽ tự hỏi lại — giao diện đếm ngược tới mốc này. */
  retryAt: number;
  /** Thời gian chờ đã định cho lần này (ms): vẽ thanh tiến trình, mốc bắt đầu = retryAt − waitMs. */
  waitMs: number;
  /** Bắt đầu xếp hàng lúc (epoch ms). */
  since: number;
  limit?: number;
  active?: number;
  waiting?: number;
}

/**
 * Mô hình Locaith (AI Local) trong khung chat: bản ghi ĐỒNG Ý THÔNG BÁO DỮ LIỆU theo tài khoản và thẻ thông báo.
 * Thẻ (card) hiện trong cuộc trò chuyện lần đầu người dùng định dùng mô hình Locaith (hoặc khi máy chủ đòi đồng ý lại); chưa đồng ý thì không có gì rời máy.
 */
export interface LocaithView {
  /** Phiên bản thông báo của tiện ích (LOCAITH_NOTICE_VERSION). */
  noticeVersion: number;
  /** Tài khoản đã đồng ý thông báo hiện hành và chưa rút lại ở máy này. */
  accepted: boolean;
  /** Thẻ thông báo đang mở trong khung chat. */
  card: boolean;
  /** Đang gửi «Đồng ý» lên máy chủ. */
  saving?: boolean;
  /** Lỗi hiện ngay trong thẻ (thẻ không đóng). */
  error?: string;
  /** Máy chủ đòi phiên bản thông báo mới hơn bản tiện ích này biết: cần cập nhật tiện ích mới đồng ý được. */
  outdated?: boolean;
}

export interface ViewState {
  version: string;
  sessionId: string;
  title: string;
  transcript: TItem[];
  /** Bảng tác vụ hiện tại. */
  todos: TodoItem[];
  /** Lựa chọn hướng đi đang chờ người dùng bấm (nút gọn dưới cuộc trò chuyện). */
  options?: SuggestionOption[];
  running: boolean;
  /** Host hỗ trợ xếp hàng tin nhắn khi trợ lý đang chạy (bản VS Code). Thiếu = không: giao diện chỉ có nút Dừng như cũ. */
  canQueue?: boolean;
  /** Tin nhắn đang chờ được giao cho trợ lý, theo thứ tự gửi. */
  queued?: QueuedInfo[];
  provider: string;
  model: string;
  mode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  /** Công tắc Swarm (điều phối bầy agent) độc lập với mức suy luận đã chọn. */
  swarm?: boolean;
  providers: ProviderSummary[];
  settings: UiSettings;
  sessions: SessionSummary[];
  /** Thùng rác: các cuộc trò chuyện đã xoá, còn khôi phục được. */
  trash: TrashSummary[];
  workspace: { name: string; folders: string[] } | null;
  /** Ước lượng token đang dùng so với giới hạn của model (+ số liệu giữ ngữ cảnh gọn — lane:ctx-compaction). */
  context: ContextInfo | null;
  editor: EditorContextInfo | null;
  skills: SkillSummary[];
  slashCommands: SlashCommandInfo[];
  /** Cho phép chọn chế độ 'bypass' trong giao diện. */
  allowBypass: boolean;
  /** Webview nên mở sẵn màn hình nào khi vừa nạp. */
  screen?: 'chat' | 'settings' | 'history' | 'market';
  /** Chế độ điều phối nhiều AI + bảng hạng → model của các khoá đã nhập. Chỉ bản VS Code. */
  orchestration?: OrchestrationInfo;
  /** Bề mặt đang chạy. Thiếu = 'vscode' (tương thích bản cũ). */
  platform?: 'vscode' | 'browser';
  /** Chỉ có ở bản trình duyệt. */
  browser?: BrowserViewState;
  /** Tài khoản locaith.ai (chỉ bản VS Code). */
  account?: AccountView;
  /** Remote — điều khiển từ xa (chỉ bản VS Code). */
  remote?: RemoteView;
  /** Đang đứng trong hàng chờ của cổng Locaith (chỉ bản VS Code). Vắng = không phải chờ. */
  modelQueue?: ModelQueueView;
  /** Trí nhớ sinh học đang được TỰ bật cho model Locaith-v5 (đang cài / chưa bật được). Vắng = không có gì để hiện. */
  memory?: MemoryView;
  /** Extension Chrome đang xin kết nối (ghép đôi không mã) — thẻ Cho phép / Từ chối trong khung chat (chỉ bản VS Code). */
  chromePair?: ChromePairView;
  /** Mô hình Locaith: đồng ý thông báo dữ liệu + thẻ thông báo (chỉ bản VS Code). */
  locaith?: LocaithView;
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
  /** Lời mời đánh giá trên Chrome Web Store (chỉ bản trình duyệt, chỉ hiện sau vài lần dùng). */
  rating?: { sends: number };
}

/** Loại tệp xem trước được ngay trong khung chat (0.6.3). `doc` = HTML/PDF/Word/Excel/PowerPoint: chỉ có thẻ mở, không nhúng. */
export type MediaKind = 'image' | 'video' | 'audio' | 'doc';

/** Kết quả host trả về cho MỘT đường dẫn câu trả lời nhắc tới. */
export interface MediaItem {
  /** Đúng chuỗi webview đã gửi (để ghép lại). */
  path: string;
  /** false = không có tệp, nằm ngoài vùng được xem (workspace, thư mục người dùng, thư mục tạm), hoặc đường dẫn bị từ chối. */
  ok: boolean;
  kind?: MediaKind;
  name?: string;
  /** Đường dẫn tuyệt đối đã chuẩn hoá — dùng lại cho `open_media`. */
  abs?: string;
  size?: number;
  mtime?: number;
  /** Địa chỉ nhúng được trong webview (asWebviewUri, hoặc data: cho ảnh nằm ngoài các thư mục webview được đọc). Thiếu → chỉ có thẻ mở. */
  src?: string;
}

export interface FileHit {
  /** Đường dẫn tương đối theo workspace, dùng dấu '/'. */
  path: string;
  name: string;
  dir: string;
  isDir?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tin nhắn qua postMessage
// ─────────────────────────────────────────────────────────────────────────────

export type HostMessage =
  | { type: 'init'; state: ViewState }
  /** Gộp nhiều sự kiện (host gom delta theo ~30–50ms để đỡ giật). */
  | { type: 'events'; events: UiEvent[] }
  | { type: 'patch'; patch: Partial<ViewState> }
  | { type: 'files'; reqId: number; items: FileHit[] }
  /** Kết quả `parse_document`: `doc` (đã đọc được) hoặc `error` (thông điệp tiếng Việt/Anh dùng thẳng cho người dùng). */
  | { type: 'document_parsed'; reqId: number; name: string; doc?: DocInfo; error?: string }
  /** Chèn văn bản/tệp đính kèm vào ô nhập (lệnh "Thêm vào chat"). */
  | { type: 'insert'; text?: string; attachments?: AttachmentInfo[] }
  /** Đặt lại nội dung ô nhập (sửa tin nhắn cuối, thử lại…). */
  | { type: 'draft'; text: string; attachments?: AttachmentInfo[] }
  | { type: 'focus' }
  /** Trả lời `market_open` và mọi thao tác Chợ (cài/gỡ kỹ năng, bật plugin, bật MCP…). */
  /** Trả lời `get_image`: ảnh đầy đủ lấy từ lịch sử. */
  | { type: 'image_data'; key: string; mediaType: string; data: string }
  /** Trả lời `resolve_media` (0.6.3): `items` cùng thứ tự với `paths` đã xin. CHỈ gửi cho khung chat trong VS Code, không phát lại cho Remote. */
  | { type: 'media_resolved'; key: string; items: MediaItem[] }
  | { type: 'market_state'; state: MarketState }
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'test_result'; provider: string; ok: boolean; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  // ── tài khoản locaith.ai (bản VS Code) ──
  | { type: 'account_sign_in'; manual?: boolean }
  | { type: 'account_cancel' }
  | { type: 'account_sign_out' }
  | { type: 'account_enter_code'; code?: string }
  | { type: 'account_manage' }
  // ── Remote (bản VS Code): thử vào lại relay ngay · bật/tắt · ghép đôi thiết bị mới · quản lý thiết bị ──
  | { type: 'remote_retry' }
  | { type: 'remote_set_enabled'; enabled: boolean }
  | { type: 'remote_pair' }
  | { type: 'remote_open' }
  | { type: 'remote_manage' }
  // ── mô hình Locaith (bản VS Code): accept = «Đồng ý và dùng» (ghi nhận lên máy chủ) · decline = «Dùng API riêng» · withdraw = rút lại ở máy này · review = mở lại thẻ thông báo ──
  | { type: 'locaith_consent'; action: 'accept' | 'decline' | 'withdraw' | 'review' }
  | { type: 'send'; text: string; attachments: AttachmentInfo[] }
  | { type: 'stop' }
  /** Bỏ một tin khỏi hàng đợi; `edit: true` thì trả nội dung về ô nhập để sửa. */
  | { type: 'queue_remove'; id: string; edit?: boolean }
  /** «Gửi ngay»: dừng bước đang chạy rồi giao tin chờ này ngay (không đợi ranh giới vòng lặp). */
  | { type: 'queue_send_now'; id: string }
  /** Xin ảnh đầy đủ theo khoá (ảnh trong tin đã gửi chỉ còn bản thu nhỏ ở giao diện). */
  | { type: 'get_image'; key: string }
  | { type: 'new_session' }
  | { type: 'load_session'; id: string }
  /** Xoá = chuyển vào Thùng rác (khôi phục được trong 30 ngày). */
  | { type: 'delete_session'; id: string }
  | { type: 'restore_session'; id: string }
  /** Xoá vĩnh viễn một cuộc trong Thùng rác. */
  | { type: 'purge_session'; id: string }
  | { type: 'empty_trash' }
  /** Sao lưu ra tệp: một cuộc (`id`) hoặc tất cả (kèm cả Thùng rác). Trình duyệt tải về; VS Code mở hộp thoại lưu. */
  | { type: 'export_backup'; id?: string }
  /** Khôi phục từ tệp sao lưu: `text` là nội dung tệp JSON do giao diện đọc. */
  | { type: 'import_backup'; name: string; text: string }
  | { type: 'rename_session'; id: string; title: string }
  | { type: 'set_model'; provider: string; model: string }
  | { type: 'set_mode'; mode: PermissionMode }
  | { type: 'set_thinking'; level: ThinkingLevel }
  | { type: 'set_swarm'; on: boolean }
  | { type: 'set_ui_setting'; key: keyof UiSettings; value: string | number | boolean }
  | { type: 'permission_response'; id: string; decision: 'allow' | 'allow_session' | 'deny'; feedback?: string }
  | { type: 'open_file'; path: string; line?: number }
  /** (0.6.3) Xem trước kết quả: hỏi host các đường dẫn ảnh/video/âm thanh/tài liệu mà câu trả lời nhắc tới có thật không và lấy địa chỉ hiển thị. Trả lời bằng `media_resolved`. */
  | { type: 'resolve_media'; key: string; paths: string[] }
  /** Mở một tệp đã được `resolve_media` xác nhận: trong VS Code, bằng ứng dụng mặc định, hoặc hiện trong thư mục. */
  | { type: 'open_media'; path: string; how: 'editor' | 'external' | 'reveal' }
  | { type: 'open_diff'; callId: string }
  | { type: 'open_artifact'; artifactId: string }
  | { type: 'save_artifact'; artifactId: string }
  /** Mở artifact (HTML/SVG/Markdown) trong TRÌNH DUYỆT mặc định thay vì tab xem trước của VS Code. */
  | { type: 'open_artifact_browser'; artifactId: string }
  | { type: 'search_files'; reqId: number; query: string }
  /** Đọc một tệp tải lên (PDF/Word/Excel/HTML/CSV/TXT) thành chữ; `data` là base64 không tiền tố. Trả lời bằng `document_parsed`. */
  | { type: 'parse_document'; reqId: number; name: string; data: string }
  | { type: 'refresh_models'; provider: string }
  | { type: 'save_api_key'; provider: string; key: string }
  | { type: 'clear_api_key'; provider: string }
  | { type: 'test_connection'; provider: string }
  | { type: 'set_base_url'; provider: string; baseUrl: string }
  /** Mở trình hướng dẫn thêm API tương thích OpenAI (hỏi tên, URL, khoá bên phía host). */
  | { type: 'add_custom_provider' }
  | { type: 'remove_custom_provider'; provider: string }
  | { type: 'open_vscode_settings'; query?: string }
  | { type: 'open_external'; url: string }
  | { type: 'slash'; command: string; args: string }
  | { type: 'retry' }
  | { type: 'edit_last' }
  | { type: 'compact' }
  | { type: 'export_chat' }
  // ── Chợ & điều phối (bản VS Code) ──
  | { type: 'market_open' }
  | { type: 'market_install'; id: string }
  | { type: 'market_uninstall'; id: string }
  | { type: 'plugin_toggle'; id: string; enabled: boolean }
  | { type: 'plugin_install'; source: 'folder' | 'git' }
  | { type: 'plugin_open_folder' }
  | { type: 'mcp_toggle'; name: string; enabled: boolean }
  | { type: 'mcp_restart'; name: string }
  /** Đổi mức quyền một công cụ MCP (`tool`), hoặc cả nhóm (`group`). */
  | { type: 'mcp_tool_policy'; server: string; tool?: string; group?: 'read' | 'write'; policy: 'allow' | 'ask' | 'deny' }
  | { type: 'mcp_add_preset'; id: string }
  | { type: 'connector_connect'; id: string }
  | { type: 'connector_disconnect'; id: string }
  | { type: 'connector_add_url' }
  | { type: 'connector_token'; id: string }
  | { type: 'bio_install' }
  | { type: 'chrome_pair_allow'; id: string }
  | { type: 'chrome_pair_deny'; id: string }
  /** Lời mời đánh giá trên Chrome Web Store: mở trang đánh giá, hoặc tắt hẳn. */
  | { type: 'rating_rate' }
  | { type: 'rating_dismiss' }
  | { type: 'bio_auto_retry' }
  | { type: 'bio_auto_decline' }
  /** Ẩn dải Trí nhớ sinh học: việc cài/bật vẫn chạy ngầm (KHÔNG từ chối). */
  | { type: 'bio_auto_hide' }
  | { type: 'bio_enable'; enabled: boolean }
  | { type: 'bio_open_folder' }
  | { type: 'plugin_market_refresh'; force?: boolean }
  | { type: 'plugin_market_install'; id: string }
  | { type: 'plugin_uninstall'; id: string }
  | { type: 'chrome_status' }
  | { type: 'chrome_pair_start' }
  | { type: 'chrome_unpair' }
  | { type: 'mcp_open_config' }
  | { type: 'agents_open_folder' }
  | { type: 'set_orchestration'; mode: OrchestrationMode }
  /** Hành động trên khối mã: chèn vào editor đang mở / thay vùng chọn / tạo file mới. */
  | { type: 'apply_code'; code: string; lang?: string; mode: 'insert' | 'replace' | 'new_file' }
  // ── (lane:cc-timeline-ui) ──
  // ── (lane:ctx-compaction) ──
  // ── (lane:output-timeouts) ──
  // ── (lane:loop-guards) ──
  // ── (lane:blind-verifier) ──
  // ── (lane:checkpoints-rewind) ──
  // ── (lane:perm-rules) ──
  // ── (lane:hooks) ──
  // ── (lane:commands-agents) ──
  // ── (lane:bg-tasks) ──
  // ── (lane:ide-context) ──
  // ── (lane:sessions-ux) ──
  // ── (lane:customer-bugs) ──
  // ── (lane:gateway-client) ──
  // ── (lane:mcp-parity) ──
  // ── (lane:instructions-memory) ──
  // ── (lane:tools-parity) ──
  // ── chỉ bản trình duyệt ──
  | { type: 'save_custom_provider'; provider: CustomProviderInput }
  /** Đăng nhập / đăng xuất bằng tài khoản (OAuth) cho một nhà cung cấp (bản trình duyệt). */
  /** Bật "Toàn quyền" (bản trình duyệt): cho phép chế độ bỏ qua mọi xác nhận, chuyển phiên sang chế độ đó, tuỳ chọn ghi nhớ cho cuộc trò chuyện mới và xin quyền truy cập mọi trang web. Phải đi kèm một cú bấm của người dùng. */
  | { type: 'enable_full_access'; remember: boolean; siteAccess: boolean }
  | { type: 'oauth_login'; provider: string }
  | { type: 'oauth_logout'; provider: string }
  | { type: 'set_browser_setting'; key: keyof BrowserSettings; value: string | number | boolean }
  /** Xin quyền đọc/điều khiển mọi trang web (phải đi kèm một cú bấm của người dùng). */
  | { type: 'request_site_access' }
  | { type: 'revoke_site_access' }
  /** Làm mới tab đang xem (người dùng bấm vào chip tab). */
  | { type: 'refresh_tab' }
  /** Gắn trợ lý vào một tab (không có `tabId` = tab đang xem). */
  | { type: 'pin_tab'; tabId?: number }
  /** Bỏ gắn: tin nhắn kế tiếp lại gắn vào tab đang xem. */
  | { type: 'unpin_tab' };

// ─────────────────────────────────────────────────────────────────────────────
// Hằng số dùng chung
// ─────────────────────────────────────────────────────────────────────────────

/** Số ngày giữ một cuộc trò chuyện đã xoá trong Thùng rác trước khi dọn hẳn. */
export const TRASH_DAYS = 30;
/** Tệp sao lưu lớn hơn mức này sẽ không được đọc khi khôi phục (chặn treo máy vì tệp nhầm/độc hại). */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export const DEFAULT_UI_SETTINGS: UiSettings = {
  language: 'vi',
  fontFamily: 'be-vietnam-pro',
  fontSize: 14,
  lineHeight: 1.65,
  codeFont: 'jetbrains-mono',
  showThinking: true,
};

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max', 'swarm'];
/** Mức hiện trong ô chọn: `swarm` không còn là một mức mà là công tắc riêng (`swarm`), nên ô chọn chỉ có 5 mức. */
export const PICKER_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

/** Giới hạn khi lưu/gửi kết quả tool lên giao diện (ký tự). */
export const UI_TOOL_OUTPUT_LIMIT = 6000;
