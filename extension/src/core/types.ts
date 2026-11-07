/**
 * Hợp đồng dùng chung cho lõi agent — KHÔNG import `vscode`, KHÔNG dùng DOM.
 *
 * Mọi nhà cung cấp (Claude, ChatGPT, Gemini, DeepSeek, Grok, API tương thích OpenAI…)
 * được chuẩn hoá về cùng một dạng tin nhắn + một luồng sự kiện, để vòng lặp agent
 * (src/core/engine) không biết gì về từng hãng.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Cơ bản
// ─────────────────────────────────────────────────────────────────────────────

/** Cách nói chuyện với API của nhà cung cấp. */
export type ProviderKind = 'anthropic' | 'openai-responses' | 'openai-chat' | 'gemini';

/** Biến thể riêng của từng hãng (khác biệt nhỏ trong cùng một `kind`). */
export type ProviderFlavor = 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'gemini' | 'generic';

/** Mức suy luận chung; mỗi adapter tự dịch sang tham số của hãng mình. */
/** Mức suy luận gửi cho nhà cung cấp. */
export type ApiThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
/** Mức người dùng chọn: thêm `swarm` = suy luận tối đa + điều phối bầy agent (engine đổi về `max` khi gọi nhà cung cấp). */
export type ThinkingLevel = ApiThinkingLevel | 'swarm';

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'content_filter'
  | 'pause_turn'
  | 'error'
  | 'aborted';

export type JsonSchema = { [key: string]: unknown };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Token đọc từ prompt cache (nếu API báo). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Token dành cho suy luận (đã nằm trong outputTokens ở hầu hết hãng). */
  reasoningTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tin nhắn chuẩn hoá
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mọi khối do model sinh ra có thể mang theo dữ liệu gốc của hãng (chữ ký suy luận,
 * item mã hoá của OpenAI, thoughtSignature của Gemini…). Adapter CHỈ phát lại `raw`
 * khi `provider` trùng id của chính nó; khác hãng thì bỏ qua và dựng lại từ trường chuẩn.
 */
export interface BlockOrigin {
  /** id nhà cung cấp đã sinh ra khối này (ví dụ 'anthropic', 'openai', 'deepseek'). */
  provider?: string;
  raw?: unknown;
}

export interface TextBlock extends BlockOrigin {
  type: 'text';
  text: string;
  /**
   * Khối do harness gắn vào payload của MỘT lần gọi (ví dụ dòng ngân sách vòng lặp `[vòng N/M …]`) — không bao giờ được lưu vào lịch sử.
   * Đổi ở mỗi lần gọi, nên adapter không được đặt điểm prompt-cache SAU nó và không được coi nó là lời của người dùng.
   */
  volatile?: boolean;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string;
  /** base64, không có tiền tố data: */
  data: string;
}

export interface ThinkingBlock extends BlockOrigin {
  type: 'thinking';
  /** Phần suy luận (hoặc bản tóm tắt suy luận) hiển thị được; có thể rỗng. */
  text: string;
  /** Chữ ký của Anthropic (bắt buộc khi phát lại). */
  signature?: string;
  /** Anthropic `redacted_thinking`. */
  redactedData?: string;
}

export interface ToolUseBlock extends BlockOrigin {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Có giá trị khi JSON đối số hỏng/cụt; engine trả lỗi cho model thay vì chạy tool. */
  parseError?: string;
  /** Chuỗi đối số thô (để báo lại cho model khi parseError). */
  rawArgs?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  name: string;
  content: string;
  isError?: boolean;
  images?: ImageBlock[];
}

export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  /** Kết quả tool nằm trong tin nhắn role 'user' (kiểu Anthropic); adapter tự tách cho hãng khác. */
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Chỉ assistant: ai sinh ra. */
  provider?: string;
  model?: string;
  /** Tin nhắn do harness chèn (nhắc nhở, ngữ cảnh…) chứ không phải người dùng gõ. */
  synthetic?: boolean;
  ts?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yêu cầu / sự kiện luồng
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Đối số lớn (mã nguồn, nội dung file): xin API stream từng mảnh thay vì đợi xong mới trả. */
  eagerInput?: boolean;
}

export interface ThinkingOptions {
  level: ApiThinkingLevel;
  /** Xin bản tóm tắt suy luận đọc được nếu API hỗ trợ. */
  summaries: boolean;
}

export interface StreamRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  thinking: ThinkingOptions;
  signal: AbortSignal;
  /** Mặc định true. */
  parallelToolCalls?: boolean;
  /**
   * Lịch sử đã bị harness sửa (nén/cắt tỉa) từ lần gọi trước: adapter phải bỏ các khối suy luận
   * cũ mà API sẽ từ chối (Anthropic "preserved thinking").
   */
  historyEdited?: boolean;
  /** Khoá ổn định theo phiên để định tuyến prompt-cache (nếu hãng hỗ trợ). */
  sessionKey?: string;
  /**
   * `none`: vẫn gửi đủ định nghĩa công cụ (lịch sử có tool_use/tool_result nên Anthropic bắt buộc phải có `tools`)
   * nhưng cấm model gọi công cụ — dùng ở lượt tổng kết cuối khi hết `maxTurns`.
   */
  toolChoice?: 'auto' | 'none';
}

export interface CompleteRequest {
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Dùng cấu hình suy luận rẻ/nhanh nhất có thể (tắt hoặc tối thiểu). */
  fast?: boolean;
}

/**
 * Đang đứng trong HÀNG CHỜ của cổng Locaith (nhiều người dùng cùng lúc hơn mức cho phép). KHÔNG phải lỗi và không tính vào số lần thử lại:
 * nhà cung cấp tự chờ `waitMs` rồi gửi lại đúng yêu cầu đó kèm mã vé, cho tới khi được nhận. `retryAt` là mốc (epoch ms, đồng hồ máy này)
 * để giao diện đếm ngược từng giây.
 */
export interface QueueEvent {
  type: 'queue';
  /** Vị trí trong hàng (1 = kế tiếp). */
  position: number;
  /** Số người đứng trước. */
  ahead: number;
  /** Lần hỏi thứ mấy trong lần xếp hàng này (1, 2, 3…). */
  attempt: number;
  waitMs: number;
  retryAt: number;
  limit?: number;
  active?: number;
  waiting?: number;
}

export type ProviderEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  /** Hãng stream đối số từng mảnh → nhiều sự kiện; hãng trả nguyên cụm → đúng một sự kiện chứa toàn bộ JSON. */
  | { type: 'tool_args_delta'; id: string; name: string; delta: string }
  | { type: 'tool_end'; id: string; name: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | QueueEvent
  /** Cổng đã nhận yêu cầu sau khi xếp hàng (HTTP 200 đã về, chưa chắc đã có chữ): giao diện bỏ dải hàng chờ ngay, không đợi token đầu tiên. */
  | { type: 'queue_end' }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'done';
      message: ChatMessage;
      stopReason: StopReason;
      usage: Usage;
      /**
       * Adapter đã phải bỏ các khối suy luận cũ khỏi lịch sử để yêu cầu này được chấp nhận (API báo chúng không còn hợp lệ).
       * Khối suy luận MỚI trong `message` được sinh ra khi không có chúng → engine phải xoá chúng khỏi lịch sử đã lưu,
       * nếu không lượt sau sẽ phát lại cả hai và lệch nhau.
       */
      droppedReplayedThinking?: boolean;
    };

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'bad_request'
  | 'context_length'
  | 'content_filter'
  | 'not_found'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'server'
  /** Cổng Locaith báo đang đầy người dùng: xếp hàng chờ (xem `QueueInfo`), không phải lỗi. */
  | 'queued'
  /** Cổng Locaith yêu cầu tài khoản đồng ý thông báo dữ liệu trước khi dùng mô hình Locaith. */
  | 'consent_required'
  | 'unknown';

/** Hàng chờ do cổng Locaith báo trong phản hồi HTTP 429 `locaith_queue`. */
export interface QueueInfo {
  /** Vị trí trong hàng (1 = kế tiếp). */
  position: number;
  /** Số người đứng trước. */
  ahead: number;
  /** Máy chủ bảo chờ bao lâu rồi hỏi lại (ms). */
  retryAfterMs: number;
  /** Mã vé; chỉ là bản dội — máy chủ giữ chỗ theo tài khoản. */
  ticket?: string;
  limit?: number;
  active?: number;
  waiting?: number;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerId: string;
  /** Nội dung lỗi gốc (đã lược bỏ khoá) để hiển thị trong nhật ký. */
  readonly details?: string;
  /** Chỉ có khi `kind === 'queued'`. */
  readonly queue?: QueueInfo;
  /**
   * `message` là câu tiếng Việt DO MÁY CHỦ soạn sẵn cho người dùng (cổng Locaith: hết hạn mức ngày, quá nhiều lượt, đang bảo trì…): hiện NGUYÊN VĂN,
   * không thay bằng câu chung kiểu "chạm giới hạn tốc độ… chờ N phút".
   */
  readonly verbatim?: boolean;
  /** Lỗi xác thực của TÀI KHOẢN Locaith (token đăng nhập bị thu hồi/hết hạn) chứ không phải khoá API: engine nhờ host kiểm tra lại tài khoản thay vì bảo nhập khoá. */
  readonly accountAuth?: boolean;
  /** Số lần thử lại tối đa riêng cho lỗi này (nhỏ hơn mức chung nếu có), ví dụ cổng đang bảo trì chỉ thử lại đúng một lần. */
  readonly retryLimit?: number;

  constructor(
    message: string,
    opts: {
      kind: ProviderErrorKind;
      providerId: string;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: string;
      queue?: QueueInfo;
      verbatim?: boolean;
      accountAuth?: boolean;
      retryLimit?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.kind === 'rate_limit' || opts.kind === 'overloaded' || opts.kind === 'server' || opts.kind === 'network' || opts.kind === 'queued');
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
    this.queue = opts.queue;
    this.verbatim = opts.verbatim;
    this.accountAuth = opts.accountAuth;
    this.retryLimit = opts.retryLimit;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model & nhà cung cấp
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  /** Nhãn hiển thị cho người dùng. */
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Model có suy luận (thinking) hay không, nếu biết. */
  reasoning?: boolean;
  vision?: boolean;
  /** top = mạnh nhất, balanced = cân bằng, fast = rẻ/nhanh. */
  tier?: 'top' | 'balanced' | 'fast';
  /** Unix ms; dùng để xếp mới nhất lên đầu. */
  createdAt?: number;
  note?: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** live = vừa hỏi hãng; cache = còn trong bộ nhớ đệm; fallback = danh sách dự phòng. */
  source: 'live' | 'cache' | 'fallback';
  error?: string;
  fetchedAt?: number;
}

export interface ProviderCapabilities {
  /**
   * native-visible: trả văn bản suy luận đọc được; summary: chỉ trả bản tóm tắt;
   * hidden: có suy luận nhưng không lộ; none: không có.
   */
  reasoning: 'native-visible' | 'summary' | 'hidden' | 'none';
  parallelTools: boolean;
  vision: boolean;
  /** incremental: đối số tool stream từng mảnh; whole: trả nguyên cụm một lần. */
  toolArgStreaming: 'incremental' | 'whole';
  /**
   * Khối suy luận chỉ hợp lệ khi system + công cụ + lịch sử phía trước nó không đổi (Anthropic "preserved thinking").
   * Engine xoá suy luận cũ khi system hoặc danh sách công cụ đổi giữa chừng, thay vì chờ API trả 400.
   */
  thinkingBoundToPrefix?: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly flavor: ProviderFlavor;
  readonly capabilities: ProviderCapabilities;

  /** Luồng sự kiện đã chuẩn hoá; kết thúc bằng đúng một sự kiện `done` (hoặc ném ProviderError). */
  stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void>;

  /** Gọi một lần, trả văn bản — dùng cho bộ tóm tắt nền và nén ngữ cảnh. */
  complete(req: CompleteRequest): Promise<string>;

  /** Hỏi danh sách model trực tiếp từ hãng (không cache — xem ModelCatalog). */
  fetchModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /** Gọi rẻ để kiểm tra khoá/URL ("Kiểm tra kết nối"). Ném ProviderError nếu hỏng. */
  ping(signal?: AbortSignal): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ProviderRuntimeConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  flavor: ProviderFlavor;
  baseUrl: string;
  /** Lấy khoá lúc gọi (đọc từ SecretStorage/biến môi trường) — không lưu khoá trong object. */
  getApiKey(): Promise<string | undefined>;
  /** Cho phép test thay fetch bằng máy chủ giả. */
  fetchImpl?: typeof fetch;
  log?: (level: LogLevel, message: string) => void;
  extraHeaders?: Record<string, string>;
  /**
   * Tiêu đề thêm tính theo TỪNG lời gọi (cổng Locaith: mã phiên, mã vé hàng chờ). Gộp đè lên `extraHeaders`.
   * `ticket` có khi đang xếp hàng và đây là lần hỏi lại.
   */
  requestHeaders?: (ctx: { sessionKey?: string; ticket?: string }) => Record<string, string>;
  /**
   * Chốt chặn TRƯỚC lời gọi trò chuyện (không áp cho danh sách model/ping): trả lỗi thì không có byte nào rời máy
   * (ví dụ chưa đồng ý thông báo dữ liệu của Locaith).
   */
  guard?: () => ProviderError | undefined;
  /** 'account' = khoá là token đăng nhập tài khoản Locaith (không phải khoá API người dùng nhập): đổi thông điệp khi thiếu khoá. */
  credential?: 'account';
  /** Tuỳ chọn riêng từng adapter (ví dụ { eagerInputStreaming: false } khi qua proxy). */
  options?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiện ích nhỏ dùng chung
// ─────────────────────────────────────────────────────────────────────────────

export function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUsesOf(message: ChatMessage): ToolUseBlock[] {
  return message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

export function userText(text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }], ts: Date.now(), ...extra };
}
