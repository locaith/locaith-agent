import * as vscode from 'vscode';
import { AgentEngine, type QueuedMessage, type QueueState, type RunResult } from '../core/engine/engine';
import { coreRunExtensions } from '../core/engine/extensions';
import { hostRunExtensions } from './hostExtensions';
import { SlashRegistry, type SlashContext } from './slashRegistry';
import { attachPermissionsFeature, type PermissionsFeature } from './permissionsFeature'; // (lane:perm-rules)
import { loadProjectInstructions } from '../core/engine/instructions';
import { resumeInstruction } from '../core/engine/resume';
import { MEMORY_DIR, MEMORY_INDEX, type MemoryScope, type MemorySnapshot } from '../core/engine/memory';
import { t, type Lang } from '../core/engine/strings';
import { Summarizer } from '../core/engine/summarizer';
import { newSession, type ArtifactRecord, type PermissionDecision, type SessionState } from '../core/engine/types';
import { isInside, normalizeForCompare, resolveUserPath } from '../core/fsutil/paths';
import { MEDIA_DATA_URI_MAX, MEDIA_MAX_PATHS, imageMime, mediaCandidates, mediaKindOf, viaLink, type MediaZones } from '../core/fsutil/mediaPaths';
import * as fs from 'node:fs';
import { DEMO_PROVIDER_ID } from '../core/providers';
import { LOCAITH_NOTICE_VERSION, LOCAITH_PROVIDER_ID } from '../core/providers/locaithGateway';
import type { SkillRegistry } from '../core/skills/registry';
import { createToolRegistry } from '../core/tools';
import type { ToolRegistry } from '../core/engine/toolRegistry';
import type { ContentBlock, LLMProvider } from '../core/types';
import type { AgentRegistry } from '../core/agents/definitions';
import { Semaphore } from '../core/agents/semaphore';
import type { SkillMarket } from '../core/market/market';
import type { McpManager } from '../core/mcp/manager';
import { FailoverProvider, type SwitchInfo } from '../core/orchestration/failover';
import { AUTO_PROVIDER_ID, type ModelPool, type Target } from '../core/orchestration/pool';
import { classifyTier } from '../core/orchestration/tiers';
import { expandCommand } from '../core/plugins/loader';
import { BIO_SERVER_NAME } from '../core/mcp/catalog';

/** Tự bật Bio-Memory: quá hạn này thì dừng cài và báo lỗi (không để dải «đang cài» đứng mãi). */
const BIO_INSTALL_WATCHDOG_MS = 10 * 60_000;
/** Sau một lần thất bại, không tự cài lại mỗi tin nhắn mà chờ khoảng này (Thử lại thủ công thì không bị chặn). */
const BIO_RETRY_COOLDOWN_MS = 5 * 60_000;
import { imageKey, reconcileTranscript } from '../shared/transcriptRebuild';
import * as os from 'node:os';
import * as path from 'node:path';
import { docCharBudget } from '../shared/docKinds';
import { extractDocument } from '../shared/docExtract';
import { parseUploadedDocument } from '../shared/docWrap';
import { backupFileName, makeBackup } from '../shared/sessionBackup';
import { fold, isBypassSlash, MODE_ALIASES } from '../shared/slashMode';
import type {
  AttachmentInfo,
  HostMessage,
  LocaithView,
  MediaItem,
  PermissionMode,
  PermissionRequest,
  OrchestrationInfo,
  SkillSummary,
  SlashCommandInfo,
  ThinkingLevel,
  TItem,
  UiEvent,
  ViewState,
  WebviewMessage,
} from '../shared/protocol';
import { PERMISSION_MODES, THINKING_LEVELS } from '../shared/protocol';
import { newId, reduceView } from '../shared/transcript';
import type { ArtifactPanels } from './artifactPanel';
import { isAllowedBaseUrl, type ConfigService } from './config';
import type { DiffPreview } from './diffPreview';
import type { EditorContextTracker } from './editorContext';
import type { FileIndex } from './fileIndex';
import type { Logger } from './logger';
import type { ProviderService } from './providerService';
import { SecretsService } from './secrets';
import type { SessionStore } from './sessionStore';
import { buildUserContent } from './userContent';
import type { AccountGate } from './account';
import type { AcceptResult, LocaithGate } from './locaith';
import type { RemoteGate } from './remote';
import type { ChromeService } from './chrome';
import type { MarketService } from './marketService';
import type { PluginService } from './plugins';
import { VsCodeToolHost } from './vscodeHost';

export interface ControllerDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  config: ConfigService;
  secrets: SecretsService;
  providers: ProviderService;
  skills: SkillRegistry;
  skillDirs: () => string[];
  store: SessionStore;
  artifacts: ArtifactPanels & { openInBrowser?(rec: ArtifactRecord): Promise<void> };
  diffs: DiffPreview;
  editor: EditorContextTracker;
  files: FileIndex;
  /** Kho model (chỉ các khoá đã nhập) dùng cho Locaith Auto, failover và agent con. */
  pool: ModelPool;
  agents: AgentRegistry;
  mcp: McpManager;
  market: SkillMarket;
  marketService: MarketService;
  plugins: PluginService;
  chrome: ChromeService;
  /**
   * Tài khoản locaith.ai: chưa đăng nhập thì controller từ chối mọi thao tác ngoài đăng nhập. Vắng (kiểm thử đơn vị) = không yêu cầu đăng nhập.
   */
  account?: AccountGate;
  /**
   * Remote (điều khiển từ xa): trạng thái hiện NGAY TRONG khung chat (bật sẵn; relay quá tải thì xếp hàng có đếm ngược). Vắng (kiểm thử đơn vị) = không có phần Remote.
   */
  remote?: RemoteGate;
  /**
   * Mô hình Locaith (AI Local): bản ghi đồng ý thông báo dữ liệu theo tài khoản. Vắng (kiểm thử đơn vị, bản không có nhà cung cấp Locaith) = không có thẻ đồng ý và không chặn gì.
   */
  locaith?: LocaithGate;
  /** Gọi khi một controller thay đổi trạng thái "đang chạy" (cập nhật thanh trạng thái). */
  onRunStateChanged(): void;
}

const SLASH: Record<Lang, SlashCommandInfo[]> = {
  vi: [
    { name: 'new', description: 'Bắt đầu cuộc trò chuyện mới' },
    { name: 'clear', description: 'Xoá và bắt đầu lại (giống /new)' },
    { name: 'compact', description: 'Nén tin nhắn cũ để giải phóng ngữ cảnh' },
    { name: 'model', description: 'Đổi model — /model <tên>' },
    { name: 'mode', description: 'Đổi chế độ quyền — /mode plan' },
    { name: 'thinking', description: 'Đổi mức suy luận — /thinking high' },
    { name: 'skills', description: 'Xem các kỹ năng có sẵn' },
    { name: 'remote', description: 'Mở Remote trên locaith.ai — điều khiển chat này từ trình duyệt/điện thoại' },
    { name: 'retry', description: 'Chạy lại tin nhắn cuối' },
    { name: 'export', description: 'Xuất cuộc trò chuyện ra Markdown' },
    { name: 'init', description: 'Tạo tệp LOCAITH.md hướng dẫn dự án' },
    { name: 'help', description: 'Xem hướng dẫn nhanh' },
  ],
  en: [
    { name: 'new', description: 'Start a new conversation' },
    { name: 'clear', description: 'Clear and start over (same as /new)' },
    { name: 'compact', description: 'Compact old messages to free up context' },
    { name: 'model', description: 'Change model — /model <name>' },
    { name: 'mode', description: 'Change permission mode — /mode plan' },
    { name: 'thinking', description: 'Change reasoning level — /thinking high' },
    { name: 'skills', description: 'List available skills' },
    { name: 'remote', description: 'Open Remote on locaith.ai — control this chat from a browser/phone' },
    { name: 'retry', description: 'Re-run the last message' },
    { name: 'export', description: 'Export the conversation to Markdown' },
    { name: 'init', description: 'Create LOCAITH.md project instructions' },
    { name: 'help', description: 'Quick help' },
  ],
};

const THINK_ALIASES: Record<string, ThinkingLevel> = {
  off: 'off',
  tat: 'off',
  low: 'low',
  thap: 'low',
  medium: 'medium',
  vua: 'medium',
  high: 'high',
  cao: 'high',
  max: 'max',
  toida: 'max',
  swarm: 'swarm',
  bay: 'swarm',
};

const FENCE_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', sh: 'shellscript', bash: 'shellscript',
  zsh: 'shellscript', ps1: 'powershell', powershell: 'powershell', yml: 'yaml', md: 'markdown', cs: 'csharp', rs: 'rust', rb: 'ruby',
  html: 'html', css: 'css', json: 'json', sql: 'sql', go: 'go', java: 'java', php: 'php', xml: 'xml', diff: 'diff', dockerfile: 'dockerfile',
};

/** Gộp các delta liên tiếp để mỗi lần postMessage mang ít sự kiện hơn. */
export function coalesceEvents(events: UiEvent[]): UiEvent[] {
  const out: UiEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && (e.t === 'text' || e.t === 'thinking') && last.t === e.t && last.id === e.id) {
      out[out.length - 1] = { ...last, delta: (last as typeof e).delta + e.delta };
    } else if (last && e.t === 'tool_progress' && last.t === 'tool_progress' && last.callId === e.callId) {
      out[out.length - 1] = { ...last, output: last.output + e.output };
    } else out.push(e);
  }
  return out;
}

/** Số tin tối đa được xếp hàng khi trợ lý đang chạy. */
const MAX_QUEUED = 20;

/** Tin từ webview vẫn được xử lý khi CHƯA đăng nhập tài khoản Locaith: nạp giao diện, đăng nhập/đăng xuất, đổi ngôn ngữ/giao diện, mở liên kết/cài đặt. */
const SIGNED_OUT_OK = new Set<string>(['ready', 'account_sign_in', 'account_cancel', 'account_sign_out', 'account_enter_code', 'account_manage', 'set_ui_setting', 'open_external', 'open_vscode_settings']);

/** Bên nghe lén mọi tin host → webview (ví dụ máy chủ Remote): nhận đúng những gì khung chat nhận, chỉ đọc. */
export type ViewMirror = (msg: HostMessage) => void;

/** Một tin đang chờ giao: nội dung đã dựng sẵn để gửi model, kèm bản gốc để trả lại ô nhập nếu bị huỷ. */
interface QueuedTurn extends QueuedMessage {
  readFiles: Record<string, string>;
  original: AttachmentInfo[];
}

export class ChatController implements vscode.Disposable {
  private session: SessionState;
  private view: ViewState;
  private webview: vscode.Webview | undefined;
  private readonly mirrors = new Set<ViewMirror>();
  private visible: () => boolean = () => false;
  private abort: AbortController | null = null;
  /** Đang trong giai đoạn chuẩn bị của send() (trước khi `running` bật). */
  private starting = false;
  /** Một lượt chạy của agent (gửi / thử lại / lệnh plugin / giao hàng đợi) đang diễn ra: tin mới được xếp hàng thay vì bị từ chối. */
  private agentBusy = false;
  /** Tin gửi lúc trợ lý đang chạy, chờ được giao (engine lấy ở ranh giới vòng lặp, hoặc chạy ngay sau khi lượt kết thúc). */
  private queue: QueuedTurn[] = [];
  /** Hàng đợi tuần tự của các LƯỢT CHẠY: mỗi lượt chờ lượt trước nhả xong mới ghi vào lịch sử (xem runAgentTurn). Lời hứa này không bao giờ bị từ chối. */
  private turnLock: Promise<void> = Promise.resolve();
  /** Số lượt đang chạy hoặc đang chờ khoá (để hạ cờ `starting`/`agentBusy` đúng lúc, không sớm). */
  private pendingTurns = 0;
  /** Kết cục của lần chạy gần nhất ('error' = chưa có lần nào kết thúc bình thường): quyết định giao hay trả lại hàng đợi. */
  private lastStop: RunResult['stopReason'] = 'error';
  private readonly waiters = new Map<string, (d: PermissionDecision) => void>();
  private readonly host: VsCodeToolHost;
  private readonly registry: ToolRegistry;
  /** Sổ đăng ký lệnh gạch chéo của các tính năng (xem slashRegistry.ts); lệnh dựng sẵn vẫn ở `handleSlash`. */
  private readonly slash = new SlashRegistry();
  /** (lane:perm-rules) Luật quyền allow/ask/deny: lệnh /permissions, tin «Luôn cho phép», trường `permissions` của ViewState. */
  private readonly perms: PermissionsFeature;
  private readonly detachMcp: () => void;
  private readonly accountSub?: vscode.Disposable;
  private readonly remoteSub?: vscode.Disposable;
  private readonly chromeUnsub?: () => void;
  private readonly locaithSub?: { dispose(): void };
  /** Thẻ thông báo dữ liệu của mô hình Locaith đang mở trong khung chat. */
  private consentCard = false;
  private consentSaving = false;
  private consentError: string | undefined;
  /** Lúc bắt đầu đứng trong hàng chờ của cổng Locaith (0 = không xếp hàng). */
  private modelQueueSince = 0;
  /** Phiên trống đang ở chế độ demo vì được TỰ chọn (chưa có khoá/tài khoản) — được phép rời demo khi có chỗ tốt hơn; demo do người dùng chọn thì giữ nguyên. */
  private autoPickedDemo = false;
  /** Lần trước tài khoản dùng được chưa (để chỉ làm việc đăng-nhập-xong khi vừa chuyển từ chưa sang rồi). */
  private accountWasUsable: boolean;
  /** Màn hình Chợ đang mở: cập nhật trạng thái MCP theo thời gian thực. */
  private marketOpen = false;
  private pending: UiEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenArtifacts = new Set<string>();
  private disposed = false;
  /** Tệp tải lên của tin nhắn người dùng cuối cùng (còn nguyên chữ), để "Sửa tin nhắn cuối" đưa lại vào ô nhập. */
  private docStash: { id: string; docs: AttachmentInfo[] } | null = null;
  /** Bộ đếm cho kiểm thử tích hợp: webview đã gửi eady chưa (chứng tỏ CSP, font, script nạp được). */
  readonly stats = { ready: 0, messages: 0 };

  constructor(
    private readonly d: ControllerDeps,
    readonly surface: 'sidebar' | 'tab',
  ) {
    this.host = new VsCodeToolHost({
      config: d.config,
      secrets: d.secrets,
      logger: d.logger,
      diffs: d.diffs,
      extraRoots: () => [...d.skillDirs(), ...(this.host.homeDir ? [path.join(this.host.homeDir, '.locaith', 'memory')] : [])],
      askPermission: (req, signal) => this.askPermission(req, signal),
    });
    this.registry = createToolRegistry({
      skills: d.skills,
      host: this.host,
      agents: {
        pool: d.pool,
        agents: d.agents,
        skills: d.skills,
        mode: () => d.config.orchestrationMode(),
        engineSettings: () => d.config.engine(),
        provider: (id) => d.providers.get(id),
        contextWindow: (p, m) => d.providers.contextWindow(p, m),
        log: (level, msg) => d.logger.log(level, msg),
        limiter: new Semaphore(d.config.agentsMaxConcurrent()),
        writeLock: new Semaphore(1),
        onSwitch: (i) => this.announceSwitch(i, false),
      },
      market: { search: (q, n, skip) => d.market.search(q, n, skip) },
      chrome: d.chrome,
      currentProvider: () => this.session.provider,
    });
    this.detachMcp = d.mcp.attach(this.registry);
    // ── Lệnh gạch chéo của từng tính năng: MỖI LANE MỘT DÒNG RIÊNG (bỏ dấu // ở dòng của mình + thêm import). Xem slashRegistry.ts. ──
    // registerCompactSlash(this.slash, this); // (lane:ctx-compaction)  /compact <hướng dẫn>
    // registerVerifySlash(this.slash, this); // (lane:blind-verifier)  /verify
    // registerRewindSlash(this.slash, this); // (lane:checkpoints-rewind)  /rewind
    // (lane:perm-rules) /permissions + tin «Luôn cho phép» / thêm-xoá luật + trường `permissions` của ViewState.
    this.perms = attachPermissionsFeature(this.slash, {
      config: d.config,
      lang: () => this.lang,
      patch: (p) => this.patch(p),
      notice: (level, text) => this.emit({ t: 'notice', level, text }),
      resolvePermission: (id, decision) => {
        const w = this.waiters.get(id);
        if (!w) return false;
        w(decision);
        return true;
      },
      showScreen: (screen) => this.showScreen(screen),
    });
    // registerHooksSlash(this.slash, this); // (lane:hooks)  /hooks
    // registerCommandsSlash(this.slash, this); // (lane:commands-agents)  lệnh tuỳ chỉnh + /review /simplify /status /doctor /agents /output-style /mcp
    // registerTasksSlash(this.slash, this); // (lane:bg-tasks)  /tasks
    // registerIdeSlash(this.slash, this); // (lane:ide-context)  /problems
    // registerSessionsSlash(this.slash, this); // (lane:sessions-ux)  /fork /cost /context
    // registerMcpSlash(this.slash, this); // (lane:mcp-parity)  /mcp__<server>__<prompt>
    // registerMemorySlash(this.slash, this); // (lane:instructions-memory)  /memory /remember
    this.session = this.freshSession();
    this.view = this.baseView();
    // Tài khoản đổi (đăng nhập xong, bị thu hồi, đăng xuất ở cửa sổ khác…) → cập nhật ngay giao diện.
    this.accountWasUsable = d.account?.usable ?? true;
    this.accountSub = d.account?.onChange(() => {
      if (this.disposed || !d.account) return;
      this.patch({ account: d.account.view() });
      void this.afterAccountChange();
    });
    // Đồng ý thông báo dữ liệu đổi (đồng ý, rút lại, máy chủ đòi lại, cửa sổ khác đã đồng ý…) → cập nhật thẻ và cờ «cần đồng ý» của nhà cung cấp.
    this.locaithSub = d.locaith?.onChange(() => {
      if (this.disposed) return;
      void this.d.providers.summaries().then((providers) => {
        if (!this.disposed) this.patch({ providers, locaith: this.locaithView() });
      });
    });
    // Remote đổi (vào/ra relay, hàng chờ khi quá tải, thiết bị ghép đôi, bật/tắt) → cập nhật khung chat.
    this.remoteSub = d.remote?.onChange(() => {
      if (!this.disposed && d.remote) this.patch({ remote: d.remote.view() });
    });
    // Chrome xin kết nối (ghép đôi không mã) / đã quyết định / hết hạn → cập nhật thẻ «Cho phép / Từ chối» trong khung chat.
    this.chromeUnsub = d.chrome?.onChange?.(() => this.syncChromePair());
  }

  /** Dải trạng thái đang hiện (Trí nhớ sinh học đang cài, Chrome xin kết nối) phải sống qua «cuộc trò chuyện mới» / mở cuộc khác: chúng không thuộc về một cuộc trò chuyện. */
  private carryStrips(): Pick<ViewState, 'memory' | 'chromePair'> {
    return { ...(this.view.memory ? { memory: this.view.memory } : {}), ...(this.view.chromePair ? { chromePair: this.view.chromePair } : {}) };
  }

  /** Thẻ «Chrome xin kết nối»: hiện khi có yêu cầu đang chờ, biến mất khi đã quyết định hoặc hết hạn. */
  private syncChromePair(silent = false): void {
    if (this.disposed) return;
    const req = this.d.chrome?.pairRequest?.();
    const cur = this.view.chromePair;
    if (!req && !cur) return;
    if (req && cur && cur.id === req.id) return;
    const chromePair = req ? { id: req.id, extensionId: req.extensionId, expiresAt: req.expiresAt, ...(this.d.chrome.status().paired ? { rePair: true } : {}) } : undefined;
    if (silent) this.view = { ...this.view, chromePair }; // trước `init`: giao diện nhận cả trạng thái một lần, không cần bản vá riêng
    else this.patch({ chromePair });
  }

  /** Cổng tài khoản: false = chưa đăng nhập (đã báo người dùng). */
  private requireAccount(): boolean {
    const acc = this.d.account;
    if (!acc || acc.usable) return true;
    this.toast('warn', this.lang === 'vi' ? 'Hãy đăng nhập tài khoản Locaith để dùng trợ lý.' : 'Sign in with your Locaith account to use the assistant.');
    return false;
  }

  get isRunning(): boolean {
    return this.view.running;
  }

  /** Locaith Auto vừa chọn model: báo trong cuộc trò chuyện đang chạy của đúng phiên đó. */
  announcePick(sessionKey: string | undefined, text: string): void {
    if (this.disposed || !this.view.running || (sessionKey && sessionKey !== this.session.id)) return;
    this.emit({ t: 'notice', level: 'info', text });
  }

  /** Một hãng bị giới hạn/quá tải nên đã tự chuyển sang hãng khác. */
  announceSwitch(info: SwitchInfo, fromAuto: boolean): void {
    if (this.disposed || !this.view.running || (fromAuto && this.session.provider !== AUTO_PROVIDER_ID)) return;
    const why: Record<string, string> = { rate_limit: 'bị giới hạn tốc độ', overloaded: 'đang quá tải', server: 'lỗi máy chủ', network: 'mất kết nối', timeout: 'phản hồi quá chậm', auth: 'từ chối khoá API', not_found: 'không còn model này' };
    const vi = this.lang === 'vi';
    this.emit({
      t: 'notice',
      level: 'warn',
      text: vi
        ? `${info.from.providerLabel} ${why[info.kind] ?? 'gặp lỗi'} → tạm chuyển sang ${info.to.providerLabel} · ${info.to.modelLabel}.`
        : `${info.from.providerLabel} failed (${info.kind}) → switching to ${info.to.providerLabel} · ${info.to.modelLabel}.`,
    });
  }

  private slashList(): SlashCommandInfo[] {
    const all = [...SLASH[this.lang], ...this.slash.list(this.lang), ...this.d.plugins.commands().map((c) => ({ name: c.name, description: c.description }))];
    // Trùng tên: giữ cái đứng trước (dựng sẵn > đăng ký > plugin).
    const seen = new Set<string>();
    return all.filter((c) => {
      const k = c.name.replace(/^\//, '').toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Ngữ cảnh một lệnh đăng ký ở slashRegistry được phép dùng. */
  private slashContext(args: string): SlashContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      args: args.trim(),
      lang: this.lang,
      info: (text) => this.emit({ t: 'notice', level: 'info', text }),
      warn: (text) => this.emit({ t: 'notice', level: 'warn', text }),
      runPrompt: (text) => this.runAgentTurn(() => this.sendUnlocked(text, text, [])),
      get busy() {
        return self.busy;
      },
    };
  }

  private async orchestrationInfo(): Promise<OrchestrationInfo> {
    return { mode: this.d.config.orchestrationMode(), pool: await this.d.pool.describe() };
  }

  private async sendMarket(partial = false): Promise<void> {
    this.marketOpen = true;
    const state = await this.d.marketService.state();
    this.post({ type: 'market_state', state: partial ? { ...state, skills: [], installedSkills: [], partial: true } : state });
  }

  /** MCP đổi trạng thái (khởi động xong, lỗi, dừng): làm mới danh sách nếu Chợ đang mở. */
  async refreshMarketIfOpen(): Promise<void> {
    if (this.marketOpen && !this.disposed && this.webview) await this.sendMarket(true);
  }

  /** Ảnh chụp trạng thái — chỉ dùng cho kiểm thử tích hợp. */
  snapshot(): { view: ViewState; session: SessionState } {
    return { view: this.view, session: this.session };
  }

  private get lang(): Lang {
    return this.d.config.language();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gắn/tháo webview
  // ─────────────────────────────────────────────────────────────────────────

  attach(webview: vscode.Webview, isVisible: () => boolean): vscode.Disposable {
    this.webview = webview;
    this.visible = isVisible;
    return webview.onDidReceiveMessage((m: WebviewMessage) => {
      this.onMessage(m).catch((err) => this.d.logger.log('error', `Lỗi xử lý tin nhắn từ webview (${m?.type}): ${err instanceof Error ? err.stack ?? err.message : err}`));
    });
  }

  detach(webview: vscode.Webview): void {
    if (this.webview === webview) {
      this.webview = undefined;
      this.visible = () => false;
    }
  }

  focus(): void {
    this.post({ type: 'focus' });
  }

  private post(msg: HostMessage): void {
    void this.webview?.postMessage(msg);
    for (const m of this.mirrors) {
      try {
        m(msg);
      } catch (err) {
        this.d.logger.log('warn', `Mirror lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Đăng ký một bên nghe lén (Remote). Trả về thứ để huỷ đăng ký. */
  addMirror(m: ViewMirror): vscode.Disposable {
    this.mirrors.add(m);
    return { dispose: () => void this.mirrors.delete(m) };
  }

  /** Trạng thái hiển thị hiện tại (chỉ đọc — không sửa object trả về). */
  viewState(): ViewState {
    return this.view;
  }

  /** Đẩy ngay các sự kiện đang chờ gom (33 ms) — gọi trước khi chụp snapshot cho máy khách mới để snapshot và luồng không chồng nhau. */
  flushPending(): void {
    this.flushNow();
  }

  /**
   * Nhận một tin đã được kiểm hợp lệ từ máy khách từ xa và xử lý như tin từ webview. ia = tên thiết bị: các thao tác đáng chú ý hiện
   * một thông báo ngắn trong khung chat để người đang ngồi ở VS Code biết có điều khiển từ xa (thông báo không lưu vào lịch sử).
   */
  handleRemote(m: WebviewMessage, via?: string): Promise<void> {
    // Điều khiển từ xa cũng phải qua cổng tài khoản: phiên hết hiệu lực thì lệnh từ trình duyệt bị từ chối (trả về lỗi, không chỉ báo trong VS Code).
    if (this.d.account && !this.d.account.usable) return Promise.reject(new Error('account_required'));
    // Lệnh gạch chéo đi qua `send` (vd. «/mode bypass») KHÔNG được vòng qua chốt `remote.allowBypass`: lệnh `set_mode` đã bị `parseCommand` chặn, nhưng `/mode bypass` trong nội dung tin nhắn
    // đi thẳng tới `setMode`, nơi chỉ kiểm cài đặt cục bộ. Cùng chốt với `set_mode`: chỉ qua khi `remote.allowBypass` BẬT.
    if (m.type === 'send' && isBypassSlash(m.text) && !this.d.config.remoteAllowBypass()) {
      this.notifyLocal('warn', this.lang === 'vi' ? 'Một thiết bị từ xa vừa thử đổi sang chế độ «Bỏ qua mọi xác nhận» — bị chặn (cài đặt locaithAgent.remote.allowBypass đang tắt).' : 'A remote device just tried to switch to “Bypass all prompts” — blocked (locaithAgent.remote.allowBypass is off).');
      return Promise.reject(new Error('bypass_not_allowed'));
    }
    if (via && (m.type === 'send' || m.type === 'permission_response' || m.type === 'stop' || m.type === 'set_mode' || m.type === 'new_session' || m.type === 'load_session')) {
      const what: Record<string, [string, string]> = {
        send: ['gửi tin nhắn', 'sent a message'],
        permission_response: ['trả lời yêu cầu quyền', 'answered a permission request'],
        stop: ['bấm Dừng', 'pressed Stop'],
        set_mode: ['đổi chế độ quyền', 'changed the permission mode'],
        new_session: ['mở cuộc trò chuyện mới', 'started a new conversation'],
        load_session: ['mở một cuộc trò chuyện cũ', 'opened an earlier conversation'],
      };
      const w = what[m.type]!;
      // Chỉ báo cho khung chat trong VS Code (không phát lại cho máy khách từ xa — họ vừa tự bấm nên không cần thông báo).
      void this.webview?.postMessage({ type: 'toast', level: 'info', text: this.lang === 'vi' ? `Từ xa · ${via}: ${w[0]}` : `Remote · ${via}: ${w[1]}` } satisfies HostMessage);
    }
    return this.onMessage(m);
  }

  /** Thông báo chỉ-cho-chủ-máy đang chờ khung chat hiện ra: khung chat ẩn thì webview không nhận tin (và mở lại là nạp lại từ đầu), nên giữ lại thay vì để mất. Tối đa 3 tin, tin cũ bỏ trước. */
  private readonly pendingLocal: { level: 'info' | 'warn' | 'error'; text: string }[] = [];

  /**
   * Một thông báo ngắn CHỈ trong khung chat ở VS Code (không phát lại cho trình duyệt từ xa, không lưu lịch sử) — dùng để báo chủ máy biết có trình duyệt mới vào.
   * Khung chat đang ẩn/chưa mở → giữ lại và hiện ngay sau khi nó nạp xong (xem sendInit). KHÔNG dùng thông báo hay thanh trạng thái của hệ thống VS Code.
   */
  notifyLocal(level: 'info' | 'warn' | 'error', text: string): void {
    if (this.webview && this.visible()) {
      void this.webview.postMessage({ type: 'toast', level, text } satisfies HostMessage);
      return;
    }
    this.pendingLocal.push({ level, text });
    while (this.pendingLocal.length > 3) this.pendingLocal.shift();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trạng thái
  // ─────────────────────────────────────────────────────────────────────────

  private pickDefaultProvider(): { provider: string; model: string } {
    const configured = this.d.config.defaultModelSetting();
    if (configured && this.d.providers.has(configured.provider)) return configured;
    const last = this.d.context.globalState.get<{ provider: string; model: string }>('locaithAgent.lastModel');
    if (last && this.d.providers.has(last.provider)) return last;
    return { provider: 'anthropic', model: this.d.providers.defaultModel('anthropic') };
  }

  private freshSession(): SessionState {
    const pick = this.pickDefaultProvider();
    return newSession({
      id: newId('s'),
      provider: pick.provider,
      model: pick.model,
      title: t(this.lang, 'titleDefault'),
      mode: vscode.workspace.isTrusted ? this.d.config.defaultMode() : 'plan',
      thinkingLevel: this.d.config.defaultThinking(),
    });
  }

  private skillSummaries(): SkillSummary[] {
    return this.d.skills.list(this.session.provider).map((s) => ({ name: s.name, description: s.description, loaded: this.session.loadedSkills.includes(s.name), source: s.source }));
  }

  private workspaceInfo(): ViewState['workspace'] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;
    return { name: vscode.workspace.name ?? folders[0].name, folders: folders.map((f) => f.uri.fsPath) };
  }

  private contextInfo(): ViewState['context'] {
    return { usedTokens: this.session.lastContextTokens, limitTokens: this.d.providers.contextWindow(this.session.provider, this.session.model) };
  }

  private baseView(): ViewState {
    return {
      version: String(this.d.context.extension.packageJSON.version ?? '0.0.0'),
      sessionId: this.session.id,
      title: this.session.title,
      transcript: [],
      todos: this.session.todos,
      ...(this.session.options?.length ? { options: this.session.options } : {}),
      running: false,
      provider: this.session.provider,
      model: this.session.model,
      mode: this.session.mode,
      thinkingLevel: this.session.thinkingLevel,
      swarm: this.session.swarm === true || this.session.thinkingLevel === 'swarm',
      providers: [],
      settings: this.d.config.ui(),
      sessions: [],
      trash: [],
      workspace: this.workspaceInfo(),
      context: this.contextInfo(),
      editor: this.d.editor.current(),
      skills: this.skillSummaries(),
      slashCommands: this.slashList(),
      allowBypass: this.d.config.allowBypass(),
      permissions: this.perms.view(), // (lane:perm-rules)
      screen: 'chat',
      orchestration: { mode: this.d.config.orchestrationMode(), pool: [] },
      canQueue: true,
      queued: [],
      ...(this.d.account ? { account: this.d.account.view() } : {}),
      ...(this.d.remote ? { remote: this.d.remote.view() } : {}),
      ...(this.d.locaith ? { locaith: this.locaithView() } : {}),
    };
  }

  /**
   * Id của cuộc trò chuyện đang được XEM trong lúc trợ lý vẫn chạy ở một cuộc khác (null = giao diện theo dõi cuộc đang chạy).
   * Mở cuộc khác để đọc không được làm dừng lượt chạy: sự kiện vẫn ghi vào `this.view` của cuộc đang chạy, chỉ không đẩy lên giao diện.
   */
  private viewing: string | null = null;
  /** Chống bắn cùng một cảnh báo vài lần trong vài giây. */
  private viewToastAt = 0;

  private patch(p: Partial<ViewState>): void {
    this.view = { ...this.view, ...p };
    // Đang XEM một cuộc trò chuyện khác trong lúc trợ lý chạy: this.view vẫn cập nhật (để quay lại là thấy đủ),
    // nhưng không đẩy lên giao diện — người dùng đang đọc hội thoại khác.
    if (this.viewing) return;
    this.post({ type: 'patch', patch: p });
  }

  /** Danh sách cuộc trò chuyện và Thùng rác — luôn cập nhật cùng nhau. */
  private async listings(): Promise<Pick<ViewState, 'sessions' | 'trash'>> {
    const [sessions, trash] = await Promise.all([this.d.store.listAll(), this.d.store.listTrash()]);
    return { sessions, trash };
  }

  private toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ type: 'toast', level, text });
  }

  /**
   * Phiên còn trống mà nhà cung cấp đang chọn chưa có khoá → chuyển sang nhà cung cấp đầu tiên đã có khoá,
   * hoặc chế độ demo nếu chưa có khoá nào (để lần đầu mở extension vẫn thử được ngay).
   */
  private async autoPickProvider(): Promise<void> {
    if (this.session.messages.length > 0 || this.busy) return;
    const cur = this.session.provider;
    const curOk = await this.d.providers.hasKey(cur);
    // Demo do người dùng TỰ chọn thì giữ; demo do ta tự chọn lúc chưa có gì thì được thay khi có chỗ tốt hơn (vừa đăng nhập, vừa nhập khoá).
    if (curOk && !(cur === DEMO_PROVIDER_ID && this.autoPickedDemo)) return;
    const descriptors = await this.d.providers.registry.descriptors();
    // Thứ tự: khoá API người dùng đã tự nhập → tài khoản Locaith đã đăng nhập (mô hình Locaith-v5, không cần khoá) → demo.
    const own = descriptors.find((p) => p.id !== DEMO_PROVIDER_ID && p.hasKey && !p.account);
    const locaith = descriptors.find((p) => p.account && p.hasKey);
    const pick = own ?? locaith ?? descriptors.find((p) => p.id === DEMO_PROVIDER_ID);
    if (!pick || pick.id === cur) return;
    this.autoPickedDemo = pick.id === DEMO_PROVIDER_ID;
    this.session.provider = pick.id;
    this.session.model = pick.defaultModel;
    this.view = { ...this.view, provider: pick.id, model: pick.defaultModel };
  }

  /** Tài khoản vừa dùng được (đăng nhập xong / nạp lại phiên): chọn mô hình Locaith cho người chưa có khoá nào, và hỏi máy chủ xem tài khoản đã đồng ý ở máy khác chưa. */
  private async afterAccountChange(): Promise<void> {
    const acc = this.d.account;
    const usable = !!acc?.usable;
    const was = this.accountWasUsable;
    this.accountWasUsable = usable;
    if (!usable || was) return;
    await this.autoPickProvider();
    if (this.d.locaith) await this.d.locaith.refresh().catch(() => undefined);
    if (this.disposed) return;
    this.patch({ provider: this.view.provider, model: this.view.model, locaith: this.locaithView(), skills: this.skillSummaries(), context: this.contextInfo() });
    void this.d.providers
      .refresh([LOCAITH_PROVIDER_ID], true)
      .then(async () => {
        if (!this.disposed) this.patch({ providers: await this.d.providers.summaries(), context: this.contextInfo() });
      })
      .catch(() => undefined);
  }

  async sendInit(screen?: ViewState['screen']): Promise<void> {
    await this.refreshView(screen ?? 'chat');
    this.syncChromePair(true);
    this.post({ type: 'init', state: this.view });
    for (const n of this.pendingLocal.splice(0)) void this.webview?.postMessage({ type: 'toast', level: n.level, text: n.text } satisfies HostMessage);
    // Làm mới danh sách model ở nền (bộ đệm 1 giờ nên rất rẻ), rồi cập nhật giao diện.
    void this.refreshProvidersInBackground();
    this.maybeAutoSetupBio();
  }

  /** Tính lại phần trạng thái nạp bất đồng bộ (nhà cung cấp, lịch sử, cài đặt…) mà KHÔNG gửi gì cho khung chat — Remote dùng để có snapshot đủ. */
  async refreshView(screen?: ViewState['screen']): Promise<void> {
    await this.autoPickProvider();
    const [providers, lists, orchestration] = await Promise.all([this.d.providers.summaries(), this.listings(), this.orchestrationInfo()]);
    this.view = {
      ...this.view,
      providers,
      ...lists,
      orchestration,
      settings: this.d.config.ui(),
      editor: this.d.editor.current(),
      skills: this.skillSummaries(),
      slashCommands: this.slashList(),
      allowBypass: this.d.config.allowBypass(),
      workspace: this.workspaceInfo(),
      context: this.contextInfo(),
      ...(this.d.account ? { account: this.d.account.view() } : {}),
      ...(this.d.remote ? { remote: this.d.remote.view() } : {}),
      ...(this.d.locaith ? { locaith: this.locaithView() } : {}),
      ...(screen !== undefined ? { screen } : {}),
    };
  }

  private async refreshProvidersInBackground(force = false): Promise<void> {
    try {
      await this.d.providers.refresh(undefined, force);
      if (!this.disposed) this.patch({ providers: await this.d.providers.summaries(), context: this.contextInfo() });
    } catch (err) {
      this.d.logger.log('warn', `Làm mới danh sách model thất bại: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Gọi khi cấu hình, khoá hoặc danh sách kỹ năng thay đổi. */
  async onEnvironmentChanged(opts: { providers?: boolean; settings?: boolean; skills?: boolean } = {}): Promise<void> {
    const p: Partial<ViewState> = {};
    if (opts.settings) {
      p.settings = this.d.config.ui();
      p.allowBypass = this.d.config.allowBypass();
      p.slashCommands = this.slashList();
    }
    if (opts.skills) {
      p.skills = this.skillSummaries();
      p.slashCommands = this.slashList();
    }
    if (opts.settings || opts.providers) p.orchestration = await this.orchestrationInfo();
    if (opts.providers) p.providers = await this.d.providers.summaries();
    if (Object.keys(p).length) this.patch(p);
  }

  onEditorChanged(info: ViewState['editor']): void {
    this.view = { ...this.view, editor: info };
    this.post({ type: 'patch', patch: { editor: info } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phát sự kiện giao diện
  // ─────────────────────────────────────────────────────────────────────────

  private emit(ev: UiEvent): void {
    this.view = reduceView(this.view, ev);
    this.pending.push(ev);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 33);
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const events = coalesceEvents(this.pending);
    this.pending = [];
    this.scheduleSave();
    if (this.viewing) return; // đã reduceView vào this.view; giao diện đang xem cuộc khác
    this.post({ type: 'events', events });
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 1500);
  }

  /** Giao diện xin ảnh đầy đủ (tin đã gửi chỉ còn bản thu nhỏ): tìm trong lịch sử theo khoá. */
  private sendImage(key: string): void {
    if (!key) return;
    const vi = this.lang === 'vi';
    for (const m of this.session.messages) {
      for (const b of m.content) {
        if (b.type === 'image' && imageKey(b.data) === key) return this.post({ type: 'image_data', key, mediaType: b.mediaType, data: b.data });
        if (b.type === 'tool_result') for (const im of b.images ?? []) if (imageKey(im.data) === key) return this.post({ type: 'image_data', key, mediaType: im.mediaType, data: im.data });
      }
    }
    this.toast('info', vi ? 'Ảnh gốc không còn trong lịch sử (đã nén ngữ cảnh) nên chỉ xem được bản thu nhỏ.' : 'The original image is no longer in the history (context was compacted); showing the thumbnail.');
  }

  /**
   * Ký ức bền nạp lại ở mỗi lượt: chỉ mục `.locaith/memory/MEMORY.md` của dự án và `~/.locaith/memory/MEMORY.md`
   * của người dùng. Đọc lại từ đĩa (không lấy từ lịch sử hội thoại) nên nén bao nhiêu lần cũng còn nguyên,
   * và áp dụng cho mọi nhà cung cấp — không cần kỹ năng, không cần `recall`.
   */
  private async loadMemory(): Promise<MemorySnapshot | null> {
    const read = async (dir: string, where: string): Promise<MemoryScope | null> => {
      const index = await fs.promises.readFile(path.join(dir, MEMORY_INDEX), 'utf8').catch(() => null);
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      const topics = names.filter((n) => n.endsWith('.md') && n !== MEMORY_INDEX).sort();
      if (!index && topics.length === 0) return null;
      return { index: index ?? '', topics, where };
    };
    const root = this.host.workspaceRoots()[0];
    const home = this.host.homeDir;
    const [project, user] = await Promise.all([
      root ? read(path.join(root, MEMORY_DIR), `${MEMORY_DIR}/${MEMORY_INDEX}`) : Promise.resolve(null),
      home ? read(path.join(home, '.locaith', 'memory'), `~/.locaith/memory/${MEMORY_INDEX}`) : Promise.resolve(null),
    ]);
    if (!project && !user) return null;
    return { ...(project ? { project } : {}), ...(user ? { user } : {}) };
  }

  /** Bio-Memory-Locaith đang chạy: lưu bản tóm tắt vào bộ nhớ dài hạn TRƯỚC khi chi tiết cũ biến mất khỏi ngữ cảnh (nén ngữ cảnh không làm mất ký ức). */
  private async saveCompactionToMemory(session: SessionState, summary: string): Promise<void> {
    if (!this.d.mcp.status().some((s) => s.name === BIO_SERVER_NAME && s.status === 'running')) return;
    const text = `[Tóm tắt hội thoại "${session.title}" — ${new Date().toISOString().slice(0, 10)}]\n${summary}`.slice(0, 8000);
    await this.d.mcp.callByName(BIO_SERVER_NAME, 'store_memory', { text, task_id: session.id, observation_type: 'compaction_summary' });
    this.d.logger.log('info', 'Đã lưu bản tóm tắt vào Bio-Memory-Locaith trước khi nén ngữ cảnh.');
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.session.todos = this.view.todos;
    try {
      // Tự hàn gắn: transcript ít lượt hơn lịch sử gửi model (messages) thì dựng lại phần thiếu TRƯỚC khi ghi đè — và giữ bản gốc.
      // Không làm khi đang chạy: giữa lượt, sự kiện còn đang được gửi lên giao diện; lần lưu cuối lượt sẽ hàn gắn.
      if (!this.view.running) {
        const rec = reconcileTranscript(this.session.messages, this.view.transcript);
        if (rec.rebuilt) {
          await this.d.store.backupRaw(this.session.id);
          this.view = { ...this.view, transcript: rec.items };
          this.post({ type: 'patch', patch: { transcript: rec.items } });
          this.d.logger.log('info', `Đã dựng lại ${rec.added} lượt trò chuyện bị thiếu trong transcript của ${this.session.id}.`);
        }
      }
      await this.d.store.save(this.session, this.view.transcript);
    } catch (err) {
      this.d.logger.log('warn', `Không lưu được hội thoại: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * HTML do model viết có chạy script. Nội dung model đọc từ web/tệp lạ có thể ép nó dựng một artifact độc hại, nên mặc định
   * chỉ tự mở loại tĩnh (SVG, Markdown); HTML phải do người dùng bấm "Mở". Nhà cung cấp demo (kịch bản của chính extension) được miễn.
   */
  private shouldAutoOpenArtifact(type: string): boolean {
    const policy = this.d.config.artifactsAutoOpen();
    if (policy === 'never') return false;
    if (policy === 'always' || type !== 'html') return true;
    return this.session.provider === 'demo';
  }

  /** Sự kiện từ engine: chuyển tiếp lên giao diện và xử lý các tác dụng phụ ở lớp host. */
  private onEngineEvent(ev: UiEvent): void {
    this.emit(ev);
    switch (ev.t) {
      case 'artifact': {
        const rec = this.session.artifacts[ev.artifactId];
        if (!rec || ev.state !== 'ready') break;
        // Chính sách "browser": mở bằng Chrome/Edge (khách báo tab bên cạnh của VS Code khó dùng cho HTML).
        const inBrowser = this.d.config.artifactsAutoOpen() === 'browser';
        if (this.seenArtifacts.has(rec.id)) {
          this.d.artifacts.refresh(rec);
          if (inBrowser) void this.d.artifacts.openInBrowser?.(rec); // bản mới của artifact: mở lại để thấy cập nhật
        } else {
          this.seenArtifacts.add(rec.id);
          if (inBrowser) void this.d.artifacts.openInBrowser?.(rec);
          else if (this.shouldAutoOpenArtifact(rec.type)) this.d.artifacts.open(rec, { preserveFocus: true }); // tự mở khung xem trước bên cạnh
        }
        break;
      }
      case 'skill':
        this.patch({ skills: this.skillSummaries() });
        break;
      case 'usage':
        this.patch({ context: this.contextInfo() });
        break;
      case 'mode':
        this.patch({ mode: ev.mode });
        break;
      case 'options':
        // Lựa chọn hướng đi: hiện thành nút dưới cuộc trò chuyện (nguồn sự thật là phiên).
        this.session.options = ev.options.length ? ev.options : undefined;
        this.patch({ options: ev.options });
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Xin phép
  // ─────────────────────────────────────────────────────────────────────────

  private askPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const done = (d: PermissionDecision) => {
        this.waiters.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      };
      const onAbort = () => done({ decision: 'deny', feedback: t(this.lang, 'aborted') });
      this.waiters.set(req.id, done);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.flushNow(); // đảm bảo thẻ xin phép đã tới giao diện
      if (!this.visible()) {
        void vscode.window
          .showInformationMessage(`${this.lang === 'vi' ? 'Trợ lý đang chờ bạn cho phép' : 'The assistant is waiting for your approval'}: ${req.title}`, this.lang === 'vi' ? 'Mở trợ lý' : 'Open assistant')
          .then((c) => c && vscode.commands.executeCommand('locaithAgent.open'));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tin nhắn từ webview
  // ─────────────────────────────────────────────────────────────────────────

  private async onMessage(m: WebviewMessage): Promise<void> {
    this.stats.messages++;
    const acc = this.d.account;
    if (acc && !acc.usable && !SIGNED_OUT_OK.has(m.type)) {
      this.requireAccount();
      return;
    }
    if (this.perms.handle(m)) return; // (lane:perm-rules)
    switch (m.type) {
      case 'ready':
        this.stats.ready++;
        return this.sendInit(this.view.screen);
      case 'account_sign_in':
        return acc?.signIn({ manual: m.manual === true });
      case 'account_cancel':
        acc?.cancel();
        return;
      case 'account_sign_out':
        return acc?.signOut();
      case 'account_enter_code':
        return acc?.enterCode(typeof m.code === 'string' ? m.code : undefined);
      case 'account_manage':
        return acc?.manage();
      case 'remote_retry':
        this.d.remote?.retryNow();
        return;
      case 'remote_set_enabled':
        return this.d.remote?.setEnabled(m.enabled === true);
      case 'remote_pair':
        return this.d.remote?.pair();
      case 'remote_open':
        void this.d.remote?.openWeb();
        return;
      case 'remote_manage':
        return this.d.remote?.manage();
      case 'locaith_consent':
        return this.onLocaithConsent(m.action);
      case 'send': {
        if (this.viewing) {
          if (this.busy) {
            // Cuộc khác ĐANG chạy: chưa gửi được. Báo một lần (không lặp mỗi lần bấm).
            const now = Date.now();
            if (now - this.viewToastAt > 6000) {
              this.viewToastAt = now;
              this.toast('info', this.lang === 'vi'
                ? 'Cuộc đang chạy vẫn tiếp tục ở nền. Đợi nó xong (hoặc bấm Dừng) rồi gửi — tin sẽ vào đúng cuộc đang mở.'
                : 'The other conversation is still running in the background. Wait for it (or press Stop), then send — the message goes to the conversation you are viewing.');
            }
            return;
          }
          // Cuộc kia đã xong: nhận cuộc đang mở làm cuộc hiện tại rồi gửi vào CHÍNH NÓ.
          const openId = this.viewing;
          this.viewing = null;
          void this.loadSession(openId).then(() => this.send(m.text, Array.isArray(m.attachments) ? m.attachments : []));
          return;
        }
        return this.send(m.text, Array.isArray(m.attachments) ? m.attachments : []);
      }
      case 'stop':
        return this.stop();
      case 'queue_remove':
        return this.removeQueued(String(m.id ?? ''), m.edit === true);
      case 'queue_send_now':
        return this.sendQueuedNow(String(m.id ?? ''));
      case 'get_image':
        return this.sendImage(String(m.key ?? ''));
      case 'new_session':
        return this.startNewSession();
      case 'load_session':
        return this.loadSession(m.id);
      case 'delete_session':
        return this.deleteSession(m.id);
      case 'restore_session':
        return this.restoreSession(String(m.id ?? ''));
      case 'purge_session':
        await this.d.store.purge(String(m.id ?? ''));
        this.patch(await this.listings());
        return;
      case 'empty_trash':
        await this.d.store.emptyTrash();
        this.patch(await this.listings());
        return;
      case 'export_backup':
        return this.exportBackup(typeof m.id === 'string' && m.id ? m.id : undefined);
      case 'import_backup':
        return this.importBackup(String(m.name ?? ''), String(m.text ?? ''));
      case 'rename_session': {
        const title = String(m.title ?? '').trim().slice(0, 120);
        if (!title) return;
        if (m.id === this.session.id) {
          this.session.title = title;
          this.patch({ title });
          await this.saveNow();
        } else await this.d.store.rename(m.id, title);
        this.patch(await this.listings());
        return;
      }
      case 'set_model':
        return this.setModel(m.provider, m.model);
      case 'set_mode':
        return this.setMode(m.mode);
      case 'enable_full_access':
        return this.enableFullAccess(m.remember === true);
      case 'set_swarm':
        this.session.swarm = m.on === true;
        this.patch({ swarm: this.session.swarm });
        return;
      case 'set_thinking':
        if (THINKING_LEVELS.includes(m.level)) {
          this.session.thinkingLevel = m.level;
          this.patch({ thinkingLevel: m.level });
        }
        return;
      case 'set_ui_setting':
        await this.d.config.setUi(m.key, m.value as never);
        return;
      case 'permission_response':
        // Tin nhắn đến từ webview: chỉ nhận đúng ba quyết định đã định nghĩa, còn lại bỏ qua (thẻ vẫn chờ người dùng).
        if (m.decision !== 'allow' && m.decision !== 'allow_session' && m.decision !== 'deny') return;
        this.waiters.get(m.id)?.({ decision: m.decision, feedback: typeof m.feedback === 'string' ? m.feedback.slice(0, 500) : undefined });
        return;
      case 'open_file':
        return this.openFile(m.path, m.line);
      case 'resolve_media':
        return this.resolveMedia(String(m.key ?? ''), Array.isArray(m.paths) ? m.paths : []);
      case 'open_media':
        return this.openMedia(String(m.path ?? ''), m.how);
      case 'open_diff':
        if (!(await this.d.diffs.open(m.callId))) this.toast('warn', this.lang === 'vi' ? 'Không còn dữ liệu diff cho thao tác này.' : 'Diff data is no longer available.');
        return;
      case 'open_artifact': {
        const rec = this.session.artifacts[m.artifactId];
        if (rec) this.d.artifacts.open(rec);
        return;
      }
      case 'save_artifact': {
        const rec = this.session.artifacts[m.artifactId];
        if (rec) await this.d.artifacts.save(rec);
        return;
      }
      case 'open_artifact_browser': {
        const rec = this.session.artifacts[m.artifactId];
        if (rec) await this.d.artifacts.openInBrowser?.(rec);
        return;
      }
      case 'search_files':
        this.post({ type: 'files', reqId: m.reqId, items: await this.d.files.search(String(m.query ?? '')) });
        return;
      case 'parse_document':
        return this.parseDocument(m.reqId, m.name, m.data);
      case 'refresh_models':
        await this.d.providers.refresh([m.provider], true);
        this.patch({ providers: await this.d.providers.summaries() });
        return;
      case 'save_api_key':
        return this.saveApiKey(m.provider, m.key);
      case 'clear_api_key':
        if (m.provider === LOCAITH_PROVIDER_ID) return; // khoá của họ mô hình Locaith là token đăng nhập, không phải khoá API lưu trong kho bí mật
        await this.d.secrets.delete(SecretsService.provider(m.provider));
        this.d.providers.registry.catalog.invalidate(m.provider);
        this.patch({ providers: await this.d.providers.summaries() });
        return;
      case 'test_connection':
        return this.testConnection(m.provider);
      case 'set_base_url': {
        const url = String(m.baseUrl ?? '').trim();
        // Khoá API sẽ được gửi tới địa chỉ này → chỉ nhận https (hoặc http tới máy cục bộ/mạng nội bộ).
        if (url && !isAllowedBaseUrl(url)) {
          this.toast('error', this.lang === 'vi' ? 'URL không hợp lệ: cần https (http chỉ cho localhost / mạng nội bộ), không kèm tên đăng nhập.' : 'Invalid URL: use https (http only for localhost / private network), without credentials.');
          return;
        }
        await this.d.config.setBaseUrl(m.provider, url);
        return;
      }
      case 'add_custom_provider':
        await vscode.commands.executeCommand('locaithAgent.addCustomProvider');
        return;
      case 'remove_custom_provider': {
        await this.d.config.setCustomProviders(this.d.config.customProviders().filter((c) => c.id !== m.provider));
        await this.d.secrets.delete(SecretsService.provider(m.provider));
        return;
      }
      case 'open_vscode_settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', m.query ? String(m.query) : 'locaithAgent');
        return;
      case 'open_external': {
        const u = String(m.url ?? '');
        if (/^https?:\/\//i.test(u)) await vscode.env.openExternal(vscode.Uri.parse(u));
        return;
      }
      case 'slash':
        return void (await this.handleSlash(m.command, m.args));
      case 'retry':
        return this.retryLast(false);
      case 'edit_last':
        return this.retryLast(true);
      case 'compact':
        return this.compact();
      case 'export_chat':
        return this.exportChat();
      case 'market_open':
        return this.sendMarket();
      case 'market_install':
      case 'market_uninstall': {
        const r = m.type === 'market_install' ? await this.d.marketService.installSkill(m.id) : await this.d.marketService.uninstallSkill(m.id);
        this.toast(r.ok ? 'info' : 'error', r.message);
        return this.sendMarket();
      }
      case 'plugin_toggle':
        await this.d.marketService.togglePlugin(m.id, m.enabled);
        return this.sendMarket();
      case 'plugin_install': {
        const r = await this.d.marketService.installPlugin(m.source);
        this.toast(r.ok ? 'info' : 'warn', r.message);
        return this.sendMarket();
      }
      case 'plugin_open_folder':
        return this.d.marketService.openPluginFolder();
      case 'mcp_toggle':
        await this.d.marketService.toggleMcp(m.name, m.enabled);
        return this.sendMarket();
      case 'mcp_restart':
        await this.d.marketService.restartMcp(m.name);
        return this.sendMarket();
      case 'mcp_tool_policy':
        await this.d.marketService.setMcpToolPolicy(m.server, m.tool ?? null, m.group ?? null, m.policy);
        return this.sendMarket();
      case 'mcp_add_preset': {
        const r = await this.d.marketService.addPreset(m.id);
        this.toast(r.ok ? 'info' : 'warn', r.message);
        return this.sendMarket();
      }
      case 'mcp_open_config':
        return this.d.marketService.openMcpConfig();
      case 'connector_connect':
      case 'connector_token':
      case 'connector_disconnect': {
        const ms = this.d.marketService;
        const r = m.type === 'connector_connect' ? await ms.connect(m.id) : m.type === 'connector_token' ? await ms.connectToken(m.id) : await ms.disconnect(m.id);
        this.toast(r.ok ? 'info' : 'warn', r.message);
        return this.sendMarket(true);
      }
      case 'connector_add_url': {
        const r = await this.d.marketService.addUrl();
        if (r) this.toast(r.ok ? 'info' : 'warn', r.message);
        return this.sendMarket(true);
      }
      case 'bio_install': {
        void this.sendMarket(true);
        const r = await this.d.marketService.bioInstall();
        this.toast(r.ok ? 'info' : 'error', r.message);
        return this.sendMarket(true);
      }
      case 'bio_enable':
        await this.d.marketService.bioEnable(m.enabled === true);
        return this.sendMarket(true);
      case 'chrome_pair_allow': {
        const ok = await this.d.chrome.approvePair(String(m.id ?? ''));
        this.syncChromePair();
        const vi = this.lang === 'vi';
        this.toast(ok ? 'info' : 'warn', ok ? (vi ? 'Đã cho phép Chrome kết nối. Mỗi trang vẫn cần bạn duyệt ngay trong Chrome.' : 'Chrome is connected. Each page still needs your approval inside Chrome.') : (vi ? 'Yêu cầu kết nối đã hết hạn — bật lại công tắc VS Code trong Chrome.' : 'The connection request expired — turn the VS Code switch on again in Chrome.'));
        return;
      }
      case 'chrome_pair_deny':
        this.d.chrome.denyPair(String(m.id ?? ''));
        this.syncChromePair();
        return;
      case 'bio_auto_retry':
        // Thử lại ngay (bỏ qua thời gian chờ sau lần lỗi). Cài mất vài phút: KHÔNG chờ trong bộ xử lý tin nhắn (nó chặn mọi thứ phía sau); cài ngầm, không hiện dải.
        if (!this.bioAutoBusy) void this.autoSetupBio();
        return;
      case 'bio_auto_decline':
        // Giữ để tương thích bản giao diện cũ; giao diện mới không còn nút này.
        await this.d.marketService.bioAutoDecline();
        this.patch({ memory: undefined });
        return;
      case 'bio_auto_hide':
        // Giữ để tương thích: từ 0.6.2 việc tự bật đã ngầm hoàn toàn, chỉ cần dọn dải nếu còn.
        this.patch({ memory: undefined });
        return;
      case 'bio_open_folder':
        return this.d.marketService.bioOpenFolder();
      case 'chrome_status':
        return this.sendMarket(true);
      case 'chrome_pair_start': {
        const r = await this.d.marketService.chromePair();
        if (!r.ok) this.toast('error', r.message);
        return this.sendMarket(true);
      }
      case 'chrome_unpair': {
        const r = await this.d.marketService.chromeUnpair();
        this.toast('info', r.message);
        return this.sendMarket(true);
      }
      case 'plugin_market_refresh': {
        const loading = this.d.marketService.refreshPluginMarket(m.force === true); // bật "đang tải" đồng bộ
        await this.sendMarket(true);
        await loading;
        return this.sendMarket(true);
      }
      case 'plugin_market_install':
      case 'plugin_uninstall': {
        const r = m.type === 'plugin_market_install' ? await this.d.marketService.installPluginFromMarket(m.id) : await this.d.marketService.uninstallMarketPlugin(m.id);
        this.toast(r.ok ? 'info' : 'warn', r.message);
        return this.sendMarket(true);
      }
      case 'agents_open_folder':
        return this.d.marketService.openAgentsFolder();
      case 'set_orchestration':
        if (m.mode === 'off' || m.mode === 'failover' || m.mode === 'auto') {
          await this.d.config.setOrchestrationMode(m.mode);
          this.patch({ orchestration: await this.orchestrationInfo() });
        }
        return;
      case 'apply_code':
        return this.applyCode(m.code, m.lang, m.mode);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gửi tin nhắn và chạy agent
  // ─────────────────────────────────────────────────────────────────────────

  /** Đang chạy HOẶC đang chuẩn bị chạy (giữa lúc kiểm tra và lúc bật cờ running còn nhiều `await`). */
  private get busy(): boolean {
    return this.view.running || this.starting;
  }

  private busyToast(): void {
    this.toast('info', this.lang === 'vi' ? 'Trợ lý đang làm việc. Nhấn Dừng trước khi gửi tin mới.' : 'The assistant is working. Press Stop before sending a new message.');
  }

  /** Tin gửi lúc trợ lý đang bận: tin thường được xếp hàng (khi đang chạy agent); lệnh gạch chéo và các thao tác khác (nén…) vẫn cần trợ lý rảnh. */
  private queueOrToast(text: string, attachments: AttachmentInfo[]): Promise<void> | void {
    const first = text.startsWith('/') && attachments.length === 0 ? text.slice(1).split(/\s+/)[0].toLowerCase() : '';
    const isCommand = !!first && this.slashList().some((c) => c.name.replace(/^\//, '').toLowerCase() === first);
    if (this.agentBusy && !isCommand) return this.enqueue(text, attachments);
    this.busyToast();
  }

  private async send(rawText: string, attachments: AttachmentInfo[]): Promise<void> {
    if (!this.requireAccount()) return;
    this.maybeAutoSetupBio();
    const text = String(rawText ?? '').trim();
    if (!text && attachments.length === 0) return;
    if (this.busy) return this.queueOrToast(text, attachments);
    // Lệnh gạch chéo xử lý TRƯỚC khi khoá: /compact, /new… tự kiểm tra "đang bận" nên sẽ tự chặn mình nếu đã đặt `starting`.
    if (text.startsWith('/') && attachments.length === 0) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      if (await this.handleSlash(cmd, rest.join(' '))) return;
    }

    // Cờ `starting` đặt ĐỒNG BỘ ngay sau lần kiểm tra: hai tin gửi liên tiếp rất nhanh không thể cùng lọt qua khi
    // `running` mới được bật sau vài `await` (kiểm tra khoá, đọc tệp đính kèm) — trước đây chúng chạy hai engine trên một phiên.
    if (this.busy) return this.queueOrToast(text, attachments); // kiểm tra lại: `await` ở trên có thể để tin khác chen vào
    await this.runAgentTurn(() => this.sendUnlocked(text, rawText, attachments));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hàng đợi tin nhắn: gửi thêm khi trợ lý đang làm việc
  // ─────────────────────────────────────────────────────────────────────────

  private syncQueueView(): void {
    this.patch({ queued: this.queue.map((q) => ({ id: q.id, text: q.text, attachments: q.display, ts: q.ts })) });
  }

  private async enqueue(text: string, attachments: AttachmentInfo[]): Promise<void> {
    const vi = this.lang === 'vi';
    // Ô nhập đã bị xoá ngay khi gửi: nếu không xếp hàng được thì trả nội dung về để không mất chữ.
    const giveBack = () => this.insert(text || undefined, attachments);
    if (this.queue.length >= MAX_QUEUED) {
      this.toast('warn', vi ? `Hàng đợi đã đầy (${MAX_QUEUED} tin). Hãy chờ trợ lý nhận bớt hoặc xoá bớt tin chờ.` : `The queue is full (${MAX_QUEUED} messages). Wait for the assistant to pick some up, or remove a few.`);
      return giveBack();
    }
    // Tệp đính kèm được đọc vào bản nháp: `readFiles` của phiên chỉ được cập nhật khi tin thật sự được giao (model chưa thấy nội dung thì chưa được tính là "đã đọc").
    const scratch = { readFiles: {} as Record<string, string> };
    let built: Awaited<ReturnType<typeof buildUserContent>>;
    try {
      built = await buildUserContent({
        text,
        attachments,
        host: this.host,
        session: scratch,
        editor: this.d.editor.current(),
        editorSelectionText: this.d.editor.selection()?.text,
        docBudget: docCharBudget(this.d.providers.contextWindow(this.session.provider, this.session.model)),
      });
    } catch (err) {
      this.toast('error', err instanceof Error ? err.message : String(err));
      return giveBack();
    }
    for (const w of built.warnings) this.emit({ t: 'notice', level: 'warn', text: w });
    this.queue.push({ id: newId('q'), text, display: built.display, content: built.content, ts: Date.now(), readFiles: scratch.readFiles, original: attachments });
    this.syncQueueView();
    // Lượt vừa kết thúc trong lúc đọc tệp đính kèm (không còn ai giao hàng đợi): tự giao ngay.
    if (!this.busy) {
      await this.runAgentTurn(async () => {
        this.lastStop = 'end_turn';
      });
    }
  }

  /** Engine lấy các tin đang chờ ở ranh giới vòng lặp (ngay sau lượt công cụ, hoặc khi model trả lời xong). */
  private takeForEngine(): QueuedMessage[] {
    if (this.queue.length === 0) return [];
    const items = this.queue.splice(0);
    for (const q of items) Object.assign(this.session.readFiles, q.readFiles);
    this.syncQueueView();
    return items.map(({ id, text, display, content, ts }) => ({ id, text, display, content, ts }));
  }

  /** Giao nốt hàng đợi sau khi một lượt kết thúc. Dừng hoặc lỗi → trả tin về ô nhập thay vì tự gửi. */
  private async drainQueue(): Promise<void> {
    for (;;) {
      if (this.disposed) break;
      // «Gửi ngay»: tin được chọn chạy TRƯỚC, kể cả khi lượt trước vừa bị ngắt để nhường chỗ cho nó; phần còn lại của hàng đợi giao theo luồng thường.
      if (this.sendNowItem) {
        const item = this.sendNowItem;
        this.sendNowItem = null;
        this.lastStop = 'error';
        await this.runQueued([item]);
        continue;
      }
      if (this.queue.length === 0) break;
      if (this.lastStop === 'aborted' || this.lastStop === 'error') break;
      const items = this.queue.splice(0);
      this.syncQueueView();
      this.lastStop = 'error';
      await this.runQueued(items);
    }
    if (this.queue.length > 0) this.restoreQueue();
  }

  /** Tin đã được chọn «Gửi ngay», chờ lượt đang chạy dừng hẳn rồi chạy (xem drainQueue). */
  private sendNowItem: QueuedTurn | null = null;

  /**
   * «Gửi ngay» cho một tin đang xếp hàng: dừng bước đang chạy (model đang trả lời, công cụ đang chạy hay đang chờ duyệt quyền — công cụ dở được ghi là đã huỷ nên
   * lịch sử vẫn hợp lệ) và giao tin này làm lượt kế tiếp NGAY, thay vì đợi tới ranh giới vòng lặp kế tiếp. Các tin còn lại vẫn nằm trong hàng đợi và được giao sau.
   */
  private sendQueuedNow(id: string): void {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return; // đã được giao rồi
    const [item] = this.queue.splice(i, 1);
    this.sendNowItem = item;
    this.syncQueueView();
    this.stop();
  }

  /** Chạy các tin còn lại trong hàng đợi như MỘT lượt mới (mỗi tin vẫn hiện thành một bong bóng riêng). */
  private async runQueued(items: QueuedTurn[]): Promise<void> {
    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      for (const q of items) {
        Object.assign(this.session.readFiles, q.readFiles);
        this.emit({ t: 'user', id: q.id, text: q.text, attachments: q.display, ts: Date.now() });
      }
      await this.execute(items.flatMap((q) => q.content), abort);
    } catch (err) {
      this.lastStop = 'error';
      this.d.logger.log('error', `Lỗi khi chạy tin đang chờ: ${err instanceof Error ? err.stack ?? err.message : err}`);
      this.emit({ t: 'notice', level: 'error', text: t(this.lang, 'providerError', { provider: this.session.provider, detail: err instanceof Error ? err.message : String(err) }) });
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  /** Trả các tin chưa giao về ô nhập (Dừng, lỗi nhà cung cấp, đóng khung chat) để người dùng sửa hoặc gửi lại; không tự gửi. */
  private restoreQueue(): void {
    const items = this.queue.splice(0);
    if (items.length === 0 || this.disposed) return;
    this.syncQueueView();
    const text = items.map((q) => q.text).filter(Boolean).join('\n\n');
    this.insert(text || undefined, items.flatMap((q) => q.original));
    this.toast('info', this.lang === 'vi' ? `Đã trả ${items.length} tin đang chờ về ô nhập — sửa hoặc gửi lại khi sẵn sàng.` : `Moved ${items.length} queued message(s) back to the input box.`);
  }

  private removeQueued(id: string, edit: boolean): void {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return; // đã được giao rồi
    const [q] = this.queue.splice(i, 1);
    this.syncQueueView();
    if (edit) this.insert(q.text || undefined, q.original);
  }

  /** Chạy một lượt của agent rồi giao nốt hàng đợi. `starting` giữ suốt thời gian đó để tin mới không chen ngang hàng đợi. */
  private async runAgentTurn(fn: () => Promise<void>): Promise<void> {
    this.pendingTurns++;
    this.starting = true;
    this.agentBusy = true;
    // Khoá: KHÔNG BAO GIỜ hai lượt chạy cùng lúc trên một phiên. Trước đây "Dừng" rồi gõ "tiếp tục" có thể để
    // lượt cũ còn đang nhả (engine đang kết thúc) và lượt mới cùng ghi vào một lịch sử → hai chỗ cùng "chạy".
    // Mỗi lượt nối vào lượt TRƯỚC nó và chỉ chạy khi lượt trước đã nhả hẳn. `release` luôn được gọi (kể cả khi `fn` ném lỗi) và lời hứa
    // của khoá không bao giờ bị từ chối — nếu không, một lượt hỏng sẽ "đầu độc" chuỗi và mọi lượt sau không bao giờ chạy.
    const previous = this.turnLock;
    let release!: () => void;
    this.turnLock = new Promise<void>((resolve) => (release = resolve));
    try {
      await previous;
      this.lastStop = 'error';
      await fn();
      await this.drainQueue();
    } finally {
      release();
      // Cờ bận chỉ hạ khi KHÔNG còn lượt nào đang chạy hoặc chờ khoá (lượt trước xong không được làm lượt sau tưởng mình rảnh).
      if (--this.pendingTurns === 0) {
        this.starting = false;
        this.agentBusy = false;
        if (this.queue.length > 0) this.restoreQueue();
      }
    }
  }

  private async sendUnlocked(text: string, rawText: string, attachments: AttachmentInfo[]): Promise<void> {
    // "Tiếp tục" trần trụi sau khi Dừng: ý người dùng là làm tiếp ĐÚNG chỗ đã dừng và dọn hết việc còn tồn,
    // không phải một yêu cầu mới. Gắn chỉ dẫn rõ để model không mở lại việc cũ từ đầu (trước đây nó phát lại
    // đúng các lệnh của tin trước → "chạy ở cả hai chỗ").
    const resumed = resumeInstruction(text, this.session.todos, this.lang);
    const providerId = this.session.provider;
    if (!this.d.providers.has(providerId)) {
      this.emit({ t: 'notice', level: 'error', text: `Nhà cung cấp "${providerId}" không còn tồn tại. Hãy chọn lại model.` });
      return;
    }
    if (providerId === AUTO_PROVIDER_ID && (await this.d.pool.providers()).length === 0) {
      this.emit({ t: 'notice', level: 'error', text: this.lang === 'vi' ? 'Locaith Auto cần ít nhất một nhà cung cấp đã có khoá API để điều phối. Hãy nhập khoá ở Cài đặt rồi thử lại.' : 'Locaith Auto needs at least one provider with an API key to orchestrate. Add a key in Settings and try again.' });
      this.post({ type: 'draft', text: String(rawText ?? ''), attachments: attachments.filter((a) => a.kind !== 'image') });
      await this.showScreen('settings');
      return;
    }
    // Mô hình Locaith: CHƯA đồng ý thông báo dữ liệu thì không gửi gì; mở thẻ thông báo ngay trong cuộc trò chuyện và trả lại nội dung vừa gõ.
    if (providerId === LOCAITH_PROVIDER_ID && this.d.locaith && !(await this.ensureLocaithConsent())) {
      this.post({ type: 'draft', text: String(rawText ?? ''), attachments: attachments.filter((a) => a.kind !== 'image') });
      return;
    }
    if (!(await this.d.providers.hasKey(providerId))) {
      this.emit({ t: 'notice', level: 'error', text: t(this.lang, 'noKey', { provider: this.d.providers.get(providerId).label }) });
      // Trả lại nội dung vừa gõ vào ô nhập để người dùng không mất công viết lại sau khi thêm khoá.
      this.post({ type: 'draft', text: String(rawText ?? ''), attachments: attachments.filter((a) => a.kind !== 'image') });
      await this.showScreen('settings');
      return;
    }

    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      if (!vscode.workspace.isTrusted && this.session.mode !== 'plan') {
        this.session.mode = 'plan';
        this.emit({ t: 'mode', mode: 'plan' });
        this.emit({ t: 'notice', level: 'warn', text: this.lang === 'vi' ? 'Workspace chưa được tin cậy: trợ lý chỉ được đọc, không sửa tệp hay chạy lệnh.' : 'Workspace is not trusted: the assistant is read-only.' });
      }
      const built = await buildUserContent({
        text,
        attachments,
        host: this.host,
        session: this.session,
        editor: this.d.editor.current(),
        editorSelectionText: this.d.editor.selection()?.text,
        docBudget: docCharBudget(this.d.providers.contextWindow(providerId, this.session.model)),
      });
      for (const w of built.warnings) this.emit({ t: 'notice', level: 'warn', text: w });
      // Chỉ dẫn "tiếp tục" là MỘT KHỐI CHỮ RIÊNG đứng sau chữ người dùng gõ (không trộn vào chữ của họ): bản hiển thị, tiêu đề cuộc trò chuyện,
      // "Sửa tin cuối" đều dùng `text` gốc, và transcript dựng lại từ lịch sử bỏ khối này đi (xem RESUME_HEADER).
      if (resumed) built.content.push({ type: 'text', text: resumed });

      this.session.model = await this.d.providers.resolveModel(providerId, this.session.model);
      if (this.session.title === t('vi', 'titleDefault') || this.session.title === t('en', 'titleDefault')) {
        this.session.title = (text || built.display[0]?.label || '').replace(/\s+/g, ' ').slice(0, 60) || this.session.title;
        this.patch({ title: this.session.title, model: this.session.model });
      }
      const userId = newId('u');
      // Bản hiển thị bỏ phần chữ của tệp tải lên (đã nằm trong tin nhắn gửi mô hình); giữ lại bản đầy đủ của tin cuối để "Sửa tin nhắn cuối" đưa tệp về ô nhập.
      const docs = attachments.filter((a) => a.kind === 'doc');
      this.docStash = docs.length ? { id: userId, docs } : null;
      this.emit({ t: 'user', id: userId, text, attachments: built.display, ts: Date.now() });
      await this.execute(built.content, abort);
    } catch (err) {
      this.d.logger.log('error', `Lỗi khi chạy agent: ${err instanceof Error ? err.stack ?? err.message : err}`);
      this.emit({ t: 'notice', level: 'error', text: t(this.lang, 'providerError', { provider: providerId, detail: err instanceof Error ? err.message : String(err) }) });
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  /** Giao diện nhờ đọc một tệp tải lên thành chữ. Luôn trả lời bằng `document_parsed` (đọc được, hoặc thông điệp lỗi cho người dùng). */
  private async parseDocument(reqId: number, name: string, data: string): Promise<void> {
    const label = String(name ?? '').slice(0, 260);
    const maxChars = docCharBudget(this.d.providers.contextWindow(this.session.provider, this.session.model));
    const r = await parseUploadedDocument(extractDocument, { name: label, data: String(data ?? '') }, maxChars);
    this.post({ type: 'document_parsed', reqId, name: label, ...r });
  }

  private async createEngine(): Promise<AgentEngine> {
    const s = this.session;
    const provider = this.d.providers.get(s.provider);
    const settings = { ...this.d.config.engine(), contextWindow: this.d.providers.contextWindow(s.provider, s.model) };
    const fast = this.d.config.summarizerEnabled() ? await this.d.providers.fastTarget(s.provider) : null;
    const summarizer = fast
      ? new Summarizer({ provider: fast.provider, model: fast.model, language: settings.language, log: (l, m) => this.d.logger.log(l, m) })
      : null;
    return new AgentEngine({
      provider: await this.withFailover(provider),
      summarizer,
      compactor: fast ?? undefined,
      registry: this.registry,
      skills: this.d.skills,
      host: this.host,
      settings,
      emit: (ev) => this.onEngineEvent(ev),
      takeQueued: () => this.takeForEngine(),
      mcpInstructions: () => this.d.mcp.instructions(),
      onCompacted: (info) => this.saveCompactionToMemory(info.session, info.summary),
      onQueue: (q) => this.setModelQueue(q),
      onConsentRequired: () => this.onConsentRequired(),
      onAccountInvalid: () => void this.d.account?.recheck?.(),
      loadInstructions: (names) => loadProjectInstructions(this.host, names),
      loadMemory: () => this.loadMemory(),
      // Các tính năng gắn quanh vòng lặp (xem core/engine/seams.ts): dùng chung mọi bề mặt + riêng VS Code.
      extensions: [...coreRunExtensions(), ...hostRunExtensions({ deps: this.d, host: this.host, registry: this.registry, session: () => this.session })],
      // Model phát <think> thẳng vào chữ (Ollama/LM Studio/OpenRouter…): tách thẻ và nhắc suy nghĩ qua prompt.
      thinkTags: provider.kind === 'openai-chat' && provider.flavor === 'generic',
    });
  }

  /** Chế độ failover/auto: model đang chọn đứng đầu, các hãng khác (cùng hạng) làm dự phòng khi bị giới hạn tốc độ/quá tải. */
  private async withFailover(base: LLMProvider): Promise<LLMProvider> {
    const s = this.session;
    if (this.d.config.orchestrationMode() === 'off' || s.provider === AUTO_PROVIDER_ID || s.provider === 'demo') return base;
    const own: Target = {
      providerId: s.provider,
      providerLabel: base.label,
      model: s.model,
      modelLabel: s.model,
      tier: classifyTier({ id: s.model, label: s.model }),
      contextWindow: this.d.providers.contextWindow(s.provider, s.model),
      provider: base,
    };
    const others = await this.d.pool.rank(own.tier, { prefer: { providerId: s.provider }, exclude: [s.provider] });
    if (others.length === 0) return base;
    return new FailoverProvider([own, ...others], this.d.pool, { onSwitch: (i) => this.announceSwitch(i, false), log: (l, m) => this.d.logger.log(l, m) });
  }

  private async execute(content: ContentBlock[], abort: AbortController): Promise<void> {
    const engine = await this.createEngine();
    const res = await engine.run({ session: this.session, content, signal: abort.signal });
    this.lastStop = res.stopReason;
    this.d.logger.log('info', `Lượt chạy kết thúc: ${res.stopReason} sau ${res.turns} vòng (${this.session.provider}:${this.session.model})`);
  }

  private setRunning(running: boolean): void {
    this.emit({ t: 'run_state', running });
    if (!running) {
      this.setModelQueue(null);
      this.flushNow();
      void this.saveNow().then(async () => {
        const extra = { ...(await this.listings()), context: this.contextInfo() };
        this.patch(extra);
        // Đang xem cuộc khác: patch() bị chặn, nhưng danh sách phiên vẫn phải cập nhật để thấy "vừa xong".
        if (this.viewing) this.post({ type: 'patch', patch: extra });
      });
    }
    this.d.onRunStateChanged();
  }

  stop(): void {
    this.abort?.abort();
    for (const w of [...this.waiters.values()]) w({ decision: 'deny', feedback: t(this.lang, 'aborted') });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phiên
  // ─────────────────────────────────────────────────────────────────────────

  async startNewSession(): Promise<void> {
    if (this.busy) {
      this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
      return;
    }
    await this.saveNow();
    this.session = this.freshSession();
    this.seenArtifacts.clear();
    this.view = { ...this.baseView(), providers: this.view.providers, ...this.carryStrips(), ...(await this.listings()), screen: 'chat' };
    this.post({ type: 'init', state: this.view });
  }

  private async loadSession(id: string): Promise<void> {
    // Đang chạy: mở cuộc KHÁC = chỉ đổi thứ đang hiển thị, phiên đang chạy tiếp tục ở nền (không bắt dừng tác vụ).
    if (this.busy && id !== this.session.id) {
      const p = await this.d.store.load(id);
      if (!p) {
        this.toast('error', this.lang === 'vi' ? 'Không mở được cuộc trò chuyện này.' : 'Could not open this conversation.');
        return;
      }
      const rec = reconcileTranscript(p.session.messages, p.transcript);
      this.viewing = id;
      this.post({
        type: 'init',
        state: {
          ...this.baseView(),
          sessionId: p.session.id,
          title: p.session.title,
          provider: p.session.provider,
          model: p.session.model,
          mode: p.session.mode,
          todos: p.session.todos,
          transcript: rec.items,
          running: false,
          queued: [],
          canQueue: false,
          ...(await this.listings()),
          screen: 'chat',
        },
      });
      this.toast('info', this.lang === 'vi'
        ? 'Đang xem lại một cuộc trò chuyện khác — trợ lý vẫn chạy ở cuộc đang dở. Quay lại cuộc đó để gửi tin.'
        : 'Viewing another conversation — the assistant keeps running in the other one. Switch back to that one to send messages.');
      return;
    }
    // Đang chạy mà bấm lại đúng cuộc đang chạy: quay về theo dõi trực tiếp.
    if (this.busy && id === this.session.id) {
      this.viewing = null;
      this.post({ type: 'init', state: this.view });
      return;
    }
    const p = await this.d.store.load(id);
    if (!p) {
      this.toast('error', this.lang === 'vi' ? 'Không mở được cuộc trò chuyện này.' : 'Could not open this conversation.');
      return;
    }
    await this.saveNow();
    this.session = p.session;
    // `historyEdited` do bước nâng cấp phiên quyết định (đọc từ kho lưu trữ): phiên của bản cũ có system prompt
    // và bộ công cụ khác nên khối suy luận đã ký phải bị bỏ. KHÔNG đặt lại false ở đây — làm vậy là gửi lại
    // suy luận cũ dưới một tiền tố mới và phiên cũ chạy bằng "luật" của bản cũ.
    if (!this.d.providers.has(this.session.provider)) {
      const pick = this.pickDefaultProvider();
      this.session.provider = pick.provider;
      this.session.model = pick.model;
    }
    if (!vscode.workspace.isTrusted) this.session.mode = 'plan';
    if (this.session.mode === 'bypass' && !this.d.config.allowBypass()) this.session.mode = 'default';
    this.seenArtifacts.clear();
    Object.keys(this.session.artifacts).forEach((k) => this.seenArtifacts.add(k));
    // Phiên cũ có thể thiếu transcript (chỉ còn vài lượt cuối): dựng lại từ messages, giữ bản gốc, rồi ghi bản đã hàn gắn.
    const rec = reconcileTranscript(p.session.messages, p.transcript);
    if (rec.rebuilt) await this.d.store.backupRaw(p.session.id);
    this.view = { ...this.baseView(), transcript: rec.items, providers: this.view.providers, ...this.carryStrips(), ...(await this.listings()), screen: 'chat' };
    this.post({ type: 'init', state: this.view });
    if (p.migrated) {
      const n = rec.rebuilt ? '' : this.lang === 'vi' ? ' Cuộc trò chuyện này đã được nâng cấp theo bản mới — dùng tiếp bình thường.' : ' This conversation was upgraded to the current version — just continue it.';
      this.toast('info', this.lang === 'vi' ? `Đã áp dụng thay đổi của bản ${String(this.d.context.extension.packageJSON.version ?? '')} cho cuộc trò chuyện cũ.${n}` : `Applied version ${String(this.d.context.extension.packageJSON.version ?? '')} changes to this earlier conversation.${n}`);
      void this.saveNow();
    }
    if (rec.rebuilt) {
      this.toast('info', this.lang === 'vi' ? `Đã dựng lại ${rec.added} lượt trò chuyện bị thiếu từ lịch sử. Bản gốc được giữ cạnh tệp (.healbak.json).` : `Rebuilt ${rec.added} missing conversation turn(s) from the history. The original file is kept next to it (.healbak.json).`);
      void this.saveNow();
    }
  }

  /** Xoá = chuyển vào Thùng rác (khôi phục được trong 30 ngày), không mất nội dung nào, kể cả tệp bối cảnh đã tải lên. */
  private async deleteSession(id: string): Promise<void> {
    const trashedMsg = this.lang === 'vi' ? 'Đã chuyển vào Thùng rác — khôi phục được trong 30 ngày.' : 'Moved to the Trash — you can restore it for 30 days.';
    if (id === this.session.id) {
      if (this.busy) return this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
      await this.saveNow(); // bản trong Thùng rác phải là bản mới nhất
      await this.d.store.moveToTrash(id);
      this.session = this.freshSession();
      this.view = { ...this.baseView(), providers: this.view.providers, ...this.carryStrips(), ...(await this.listings()), screen: 'history' };
      this.post({ type: 'init', state: this.view });
      this.toast('info', trashedMsg);
      return;
    }
    await this.d.store.moveToTrash(id);
    this.patch(await this.listings());
    this.toast('info', trashedMsg);
  }

  private async restoreSession(id: string): Promise<void> {
    const title = this.view.trash.find((s) => s.id === id)?.title ?? '';
    const ok = await this.d.store.restore(id);
    this.patch(await this.listings());
    this.toast(ok ? 'info' : 'error', ok ? (this.lang === 'vi' ? `Đã khôi phục "${title}".` : `Restored "${title}".`) : this.lang === 'vi' ? 'Không khôi phục được (bản trong Thùng rác không còn).' : 'Could not restore (the copy in the Trash is gone).');
  }

  /**
   * Sao lưu ra tệp JSON (đầy đủ, khôi phục được): một cuộc (`id`) hoặc tất cả kèm Thùng rác. Mặc định gợi ý lưu ở thư mục cá nhân, KHÔNG phải trong workspace
   * (lịch sử trò chuyện và tệp bối cảnh có thể chứa thông tin riêng — đừng để lỡ commit lên git).
   */
  private async exportBackup(id?: string): Promise<void> {
    await this.saveNow();
    const sessions = await this.d.store.exportSessions(id ? { ids: [id], includeTrash: true } : { includeTrash: true });
    if (sessions.length === 0) return this.toast('info', this.lang === 'vi' ? 'Chưa có cuộc trò chuyện nào để sao lưu.' : 'There are no conversations to back up yet.');
    const name = backupFileName(id ? 'one' : 'all', sessions[0]?.session.title);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
      filters: { JSON: ['json'] },
      title: this.lang === 'vi' ? 'Lưu bản sao lưu cuộc trò chuyện' : 'Save conversation backup',
    });
    if (!target) return;
    const file = makeBackup(sessions, { version: String(this.d.context.extension.packageJSON.version ?? '0.0.0'), platform: 'vscode' });
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(file)));
    this.toast('info', this.lang === 'vi' ? `Đã lưu bản sao lưu (${sessions.length} cuộc trò chuyện): ${target.fsPath}` : `Backup saved (${sessions.length} conversations): ${target.fsPath}`);
  }

  /** Khôi phục từ tệp sao lưu: không ghi đè cuộc nào đang có (xem BaseSessionStore.importSessions). */
  private async importBackup(name: string, text: string): Promise<void> {
    const r = await this.d.store.importBackupText(text);
    if (!r.ok) return this.toast('error', this.lang === 'vi' ? `Không khôi phục được "${name}": ${r.error}` : `Could not restore "${name}": ${r.error}`);
    this.patch(await this.listings());
    const s = r.summary;
    const parts = [
      this.lang === 'vi' ? `Đã khôi phục ${s.imported} cuộc trò chuyện` : `Restored ${s.imported} conversation(s)`,
      s.copies ? (this.lang === 'vi' ? `${s.copies} thêm thành bản sao (đã có bản khác cùng mã)` : `${s.copies} added as copies (a different version already existed)`) : '',
      s.trashed ? (this.lang === 'vi' ? `${s.trashed} vào Thùng rác` : `${s.trashed} to the Trash`) : '',
      s.unchanged ? (this.lang === 'vi' ? `${s.unchanged} đã có sẵn` : `${s.unchanged} already present`) : '',
      r.skipped ? (this.lang === 'vi' ? `${r.skipped} không dùng được` : `${r.skipped} unusable`) : '',
    ].filter(Boolean);
    this.toast(s.imported + s.copies + s.trashed > 0 ? 'info' : 'warn', parts.join(' · ') + '.');
  }

  async setModel(provider: string, model: string): Promise<void> {
    if (!this.d.providers.has(provider) || !model) return;
    const leavingLocaith = this.session.provider === LOCAITH_PROVIDER_ID && provider !== LOCAITH_PROVIDER_ID;
    this.session.provider = provider;
    this.session.model = model;
    this.autoPickedDemo = false;
    if (leavingLocaith && this.consentCard) {
      this.consentCard = false;
      this.consentError = undefined;
    }
    await this.d.context.globalState.update('locaithAgent.lastModel', { provider, model });
    // Kỹ năng riêng của họ mô hình Locaith chỉ hiện khi đang dùng họ đó → làm mới danh sách cùng lúc.
    this.patch({ provider, model, context: this.contextInfo(), skills: this.skillSummaries(), ...(this.d.locaith ? { locaith: this.locaithView() } : {}) });
    this.d.onRunStateChanged();
    this.maybeAutoSetupBio();
    // Chọn mô hình Locaith: hỏi trước máy chủ xem tài khoản đã đồng ý ở máy khác chưa để khỏi hiện thẻ không cần thiết.
    if (provider === LOCAITH_PROVIDER_ID && this.d.locaith && !this.d.locaith.accepted()) {
      void this.d.locaith.refresh().then(() => {
        if (!this.disposed) this.patch({ locaith: this.locaithView() });
      });
    }
  }

  /** Mở thẳng một màn hình (lịch sử, cài đặt) — dùng cho lệnh và nút trên thanh tiêu đề. */
  async showScreen(screen: 'chat' | 'settings' | 'history' | 'market'): Promise<void> {
    await this.sendInit(screen);
    if (screen === 'market') await this.sendMarket();
  }

  get currentModel(): { provider: string; model: string } {
    return { provider: this.session.provider, model: this.session.model };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trí nhớ sinh học MẶC ĐỊNH cho model Locaith-v5
  // ─────────────────────────────────────────────────────────────────────────
  private bioAutoBusy = false;
  /** Lần thất bại gần nhất: không tự cài lại mỗi tin nhắn (mỗi lần gửi đều gọi maybeAutoSetupBio) mà chờ BIO_RETRY_COOLDOWN_MS. */
  private bioFailedAt = 0;

  /**
   * Model Locaith-v5 dùng Trí nhớ sinh học (Bio-Memory-Locaith) MẶC ĐỊNH: khi chọn/dùng model Locaith mà chưa có, tự cài vào môi trường Python RIÊNG (không đụng Python hệ thống)
   * và bật — HOÀN TOÀN NGẦM từ 0.6.2: không dải trạng thái, không thông báo trong khung chat (dải «đang cài» cũ có thể đứng rất lâu và làm người dùng tưởng extension bị treo).
   * Nhờ đó khi ngữ cảnh 1M gần đầy, bản tóm tắt được lưu vào Bio-Memory trước khi nén (saveCompactionToMemory) và cuộc sau vẫn nhớ. Không cài được (thiếu Python, mất mạng…):
   * chỉ ghi nhật ký, trạng thái + lý do xem ở Chợ → MCP (cài tay ở đó), Locaith-v5 nhớ bằng tệp trong dự án như kỹ năng ghi-nho-memory chỉ dẫn; không tự thử lại trong 5 phút.
   */
  private maybeAutoSetupBio(): void {
    if (this.disposed || this.bioAutoBusy || this.session.provider !== LOCAITH_PROVIDER_ID) return;
    // Kiểm thử tích hợp: không tự cài/bật thứ gì trong thư mục người dùng (~/.locaith/bio-memory) — trừ khi một bước kiểm thử chủ động bật ND_TEST_BIO_AUTO.
    if (process.env.ND_AGENT_TEST === '1' && process.env.ND_TEST_BIO_AUTO !== '1') return;
    if (!this.d.marketService.bioAutoNeeded()) return;
    if (this.bioFailedAt && Date.now() - this.bioFailedAt < BIO_RETRY_COOLDOWN_MS) return;
    void this.autoSetupBio();
  }

  private async autoSetupBio(): Promise<void> {
    if (this.bioAutoBusy) return;
    this.bioAutoBusy = true;
    const vi = this.lang === 'vi';
    // Cài NGẦM: không hiện dải nào trong khung chat (dọn dải của trạng thái cũ nếu còn).
    if (this.view.memory) this.patch({ memory: undefined });
    // Chống treo: quá hạn thì dừng việc cài (cờ "đang cài" không giữ mãi, lần sau còn thử lại được).
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        this.d.marketService.bioEnsure(),
        new Promise<{ ok: false; message: string }>((resolve) => {
          watchdog = setTimeout(() => {
            this.d.marketService.bioCancelInstall();
            resolve({ ok: false, message: vi ? 'Cài quá lâu (hơn 10 phút) nên đã dừng. Kiểm tra mạng rồi thử lại, hoặc cài ở Chợ → MCP.' : 'The install took too long (over 10 minutes) and was stopped. Check your network and retry, or install from Market → MCP.' });
          }, BIO_INSTALL_WATCHDOG_MS);
        }),
      ]);
      if (this.disposed) return;
      if (r.ok) {
        this.bioFailedAt = 0;
        this.d.logger.log('info', 'Đã tự bật Trí nhớ sinh học (Bio-Memory-Locaith) cho Locaith-v5 — cài ngầm, không hiện thông báo.');
      } else {
        this.bioFailedAt = Date.now();
        this.d.logger.log('warn', `Bio-Memory tự bật thất bại (ngầm, không báo trong khung chat; xem Chợ → MCP): ${String(r.message ?? '').slice(0, 300)}`);
      }
    } catch (err) {
      this.bioFailedAt = Date.now();
      this.d.logger.log('warn', `Bio-Memory tự bật lỗi: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.bioAutoBusy = false;
    }
  }

  /**
   * "Bỏ qua mọi xác nhận" có sẵn trong danh sách chế độ ngay từ đầu; chọn nó lần đầu mở MỘT hộp xác nhận ngay trong khung chat (không phải vào Cài đặt).
   * Xác nhận xong: cho phép chế độ (cài đặt người dùng), chuyển cuộc này sang đó và — nếu người dùng tick — để các cuộc mới cũng bắt đầu ở đó.
   */
  private async enableFullAccess(remember: boolean): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.toast('warn', this.lang === 'vi' ? 'Workspace chưa được tin cậy: chỉ dùng được chế độ lập kế hoạch.' : 'Workspace not trusted: only plan mode is available.');
      return;
    }
    try {
      await this.d.config.setAllowBypass(true);
      if (remember) await this.d.config.setDefaultMode('bypass');
    } catch (err) {
      this.d.logger.log('warn', `Không ghi được cài đặt chế độ bỏ qua: ${err instanceof Error ? err.message : String(err)}`);
      this.toast('error', this.lang === 'vi' ? 'Không bật được chế độ này (không ghi được cài đặt).' : 'Could not turn this mode on (settings could not be written).');
      return;
    }
    this.patch({ allowBypass: true });
    this.setMode('bypass');
    if (this.session.mode === 'bypass') {
      this.toast('info', this.lang === 'vi' ? 'Đã bật "Bỏ qua mọi xác nhận": trợ lý sẽ không hỏi trước khi sửa tệp hay chạy lệnh.' : 'Turned on "Bypass all prompts": the assistant will not ask before editing files or running commands.');
    }
  }

  private setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) return;
    if (mode === 'bypass' && !this.d.config.allowBypass()) {
      this.toast('warn', this.lang === 'vi' ? 'Chế độ này đang tắt. Bật "locaithAgent.agent.allowBypassPermissions" trong cài đặt nếu bạn hiểu rủi ro.' : 'This mode is disabled. Enable "locaithAgent.agent.allowBypassPermissions" if you understand the risk.');
      return;
    }
    if (!vscode.workspace.isTrusted && mode !== 'plan') {
      this.toast('warn', this.lang === 'vi' ? 'Workspace chưa được tin cậy: chỉ dùng được chế độ lập kế hoạch.' : 'Workspace not trusted: only plan mode is available.');
      return;
    }
    this.session.mode = mode;
    this.patch({ mode });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mô hình Locaith: hàng chờ khi đông người dùng, đồng ý thông báo dữ liệu
  // ─────────────────────────────────────────────────────────────────────────

  private locaithView(): LocaithView | undefined {
    const c = this.d.locaith;
    if (!c) return undefined;
    return {
      noticeVersion: LOCAITH_NOTICE_VERSION,
      accepted: c.accepted(),
      card: this.consentCard,
      ...(this.consentSaving ? { saving: true } : {}),
      ...(this.consentError ? { error: this.consentError } : {}),
      ...(c.outdated() ? { outdated: true } : {}),
    };
  }

  /** Cổng báo đang xếp hàng (có `q`) hoặc đã được nhận / dừng (`null`): cập nhật dải đếm ngược ngay trong khung chat. */
  private setModelQueue(q: QueueState | null): void {
    if (this.disposed) return;
    if (!q) {
      this.modelQueueSince = 0;
      if (this.view.modelQueue) this.patch({ modelQueue: undefined });
      return;
    }
    if (!this.modelQueueSince) this.modelQueueSince = Date.now();
    this.patch({ modelQueue: { ...q, since: this.modelQueueSince } });
  }

  /** true = tài khoản đã đồng ý (kể cả đã đồng ý ở máy khác). false = đã mở thẻ thông báo trong khung chat. */
  private async ensureLocaithConsent(): Promise<boolean> {
    const c = this.d.locaith;
    if (!c || c.accepted()) return true;
    await c.refresh();
    if (c.accepted()) {
      this.patch({ locaith: this.locaithView() });
      return true;
    }
    this.openConsentCard();
    return false;
  }

  private openConsentCard(): void {
    this.consentCard = true;
    this.consentError = undefined;
    this.patch({ locaith: this.locaithView() });
  }

  /** Cổng từ chối vì chưa có bản ghi đồng ý hợp lệ (tài khoản mới, hoặc thông báo đã đổi phiên bản): bỏ bản đệm và hỏi lại ngay trong khung chat. */
  private onConsentRequired(): void {
    this.d.locaith?.invalidate();
    this.openConsentCard();
  }

  private consentErrorText(r: Exclude<AcceptResult, { ok: true }>): string {
    const vi = this.lang === 'vi';
    switch (r.error) {
      case 'signed_out':
      case 'unauthorized':
        return vi ? 'Phiên đăng nhập Locaith không còn hiệu lực — hãy đăng nhập lại rồi thử lại.' : 'Your Locaith session is no longer valid — sign in again and retry.';
      case 'network':
        return vi ? 'Không kết nối được máy chủ Locaith để ghi nhận đồng ý. Kiểm tra mạng rồi bấm lại.' : 'Could not reach the Locaith server to record your consent. Check your network and try again.';
      case 'rejected':
        return vi
          ? `Máy chủ Locaith không nhận bản ghi đồng ý${r.message ? ` (${r.message})` : ''}. Hãy cập nhật tiện ích lên bản mới nhất rồi thử lại.`
          : `The Locaith server did not accept the consent record${r.message ? ` (${r.message})` : ''}. Update the extension to the latest version and retry.`;
      default:
        return vi ? 'Máy chủ Locaith đang gặp lỗi khi ghi nhận đồng ý. Thử lại sau ít phút.' : 'The Locaith server had an error while recording your consent. Try again in a few minutes.';
    }
  }

  /** Rời mô hình Locaith: sang nhà cung cấp có khoá API của chính người dùng, không có thì sang demo (và mở Cài đặt để nhập khoá nếu `openSettings`). */
  private async leaveLocaith(openSettings: boolean): Promise<void> {
    const descriptors = await this.d.providers.registry.descriptors();
    const own = descriptors.find((p) => p.id !== DEMO_PROVIDER_ID && p.hasKey && !p.account);
    if (own) {
      await this.setModel(own.id, own.defaultModel);
      return;
    }
    const demo = descriptors.find((p) => p.id === DEMO_PROVIDER_ID);
    if (demo && this.session.provider === LOCAITH_PROVIDER_ID) {
      await this.setModel(demo.id, demo.defaultModel);
      this.autoPickedDemo = true;
    }
    if (openSettings) {
      this.toast('info', this.lang === 'vi' ? 'Hãy nhập API key của hãng bạn muốn dùng (Claude, ChatGPT, Gemini, DeepSeek, Grok…) ở mục Nhà cung cấp.' : 'Add the API key of the provider you want (Claude, ChatGPT, Gemini, DeepSeek, Grok…) under Providers.');
      await this.showScreen('settings');
    }
  }

  private async onLocaithConsent(action: 'accept' | 'decline' | 'withdraw' | 'review'): Promise<void> {
    const c = this.d.locaith;
    if (!c) return;
    const vi = this.lang === 'vi';
    switch (action) {
      case 'review':
        this.consentCard = true;
        this.consentError = undefined;
        this.patch({ locaith: this.locaithView(), screen: 'chat' });
        return;
      case 'accept': {
        if (this.consentSaving) return;
        this.consentSaving = true;
        this.consentError = undefined;
        this.patch({ locaith: this.locaithView() });
        let r: AcceptResult;
        try {
          r = await c.accept();
        } finally {
          this.consentSaving = false;
        }
        if (r.ok) {
          this.consentCard = false;
          this.consentError = undefined;
          this.patch({ locaith: this.locaithView(), providers: await this.d.providers.summaries() });
          this.toast('info', vi ? 'Đã ghi nhận đồng ý. Bấm Gửi để tiếp tục.' : 'Consent recorded. Press Send to continue.');
        } else {
          this.consentError = this.consentErrorText(r);
          this.patch({ locaith: this.locaithView() });
        }
        return;
      }
      case 'decline':
        this.consentCard = false;
        this.consentError = undefined;
        this.patch({ locaith: this.locaithView() });
        await this.leaveLocaith(true);
        return;
      case 'withdraw':
        await c.withdraw();
        this.consentCard = false;
        this.consentError = undefined;
        this.patch({ locaith: this.locaithView(), providers: await this.d.providers.summaries() });
        if (this.session.provider === LOCAITH_PROVIDER_ID) await this.leaveLocaith(false);
        this.toast('info', vi ? 'Đã rút lại đồng ý trên máy này — mô hình Locaith sẽ hỏi lại khi bạn dùng. Bản ghi cũ vẫn lưu ở máy chủ làm bằng chứng.' : 'Consent withdrawn on this machine — the Locaith model will ask again when you use it. The earlier record stays on the server as an audit trail.');
        return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Khoá API & kết nối
  // ─────────────────────────────────────────────────────────────────────────

  private async saveApiKey(providerId: string, rawKey: string): Promise<void> {
    const key = String(rawKey ?? '').trim();
    if (!this.d.providers.has(providerId) || providerId === LOCAITH_PROVIDER_ID) return;
    if (!key || /\s/.test(key)) {
      this.toast('error', this.lang === 'vi' ? 'API key không hợp lệ (đang trống hoặc có khoảng trắng).' : 'Invalid API key (empty or contains whitespace).');
      return;
    }
    await this.d.secrets.set(SecretsService.provider(providerId), key);
    this.d.providers.registry.catalog.invalidate(providerId);
    await this.d.providers.refresh([providerId], true);
    this.patch({ providers: await this.d.providers.summaries() });
    this.toast('info', this.lang === 'vi' ? 'Đã lưu API key an toàn trong kho bí mật của VS Code.' : 'API key saved to VS Code secret storage.');
  }

  private async testConnection(providerId: string): Promise<void> {
    if (!this.d.providers.has(providerId)) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      await this.d.providers.get(providerId).ping(ctl.signal);
      this.post({ type: 'test_result', provider: providerId, ok: true, message: this.lang === 'vi' ? 'Kết nối thành công.' : 'Connection OK.' });
    } catch (err) {
      this.post({ type: 'test_result', provider: providerId, ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lệnh gạch chéo
  // ─────────────────────────────────────────────────────────────────────────

  /** Trả true nếu đã xử lý (là lệnh hợp lệ). */
  private async handleSlash(cmdRaw: string, args: string): Promise<boolean> {
    const cmd = cmdRaw.toLowerCase();
    const vi = this.lang === 'vi';
    const info = (text: string) => this.emit({ t: 'notice', level: 'info', text });
    switch (cmd) {
      case 'new':
      case 'clear':
        await this.startNewSession();
        return true;
      case 'compact':
        await this.compact();
        return true;
      case 'retry':
        await this.retryLast(false);
        return true;
      case 'export':
        await this.exportChat();
        return true;
      case 'init':
        await vscode.commands.executeCommand('locaithAgent.initProjectFile');
        return true;
      case 'remote':
        // Không chờ lệnh xong mới trả lời khung chat: trang mở ở nền, rồi báo ĐÚNG cách đã mở (vào bằng tài khoản hay phải ghép đôi) khi biết kết quả.
        void this.d.remote?.openWeb().then((how) => {
          if (how === 'account')
            info(
              vi
                ? 'Đã mở Remote trên locaith.ai — trang tự vào máy này nhờ cùng tài khoản Locaith, **không cần mã hay ghép đôi**. Trên điện thoại: mở locaith.ai, đăng nhập cùng tài khoản rồi chọn máy này trong «Máy của bạn».'
                : 'Opened Remote on locaith.ai — the page signs in to this machine through the same Locaith account, **no code and no pairing**. On a phone: open locaith.ai, sign in with the same account, then pick this machine under “Your machines”.',
            );
          else if (how === 'pairing' || how === 'local')
            info(vi ? 'Đang mở Remote trên locaith.ai… Khi trang hiện «Chờ cho phép», bấm **Cho phép** ở hộp thoại VS Code.' : 'Opening Remote on locaith.ai… When the page says “Waiting for permission”, click **Allow** in the VS Code dialog.');
        });
        return true;
      case 'skills': {
        const list = this.d.skills.list(this.session.provider).map((s) => `- **${s.name}**${this.session.loadedSkills.includes(s.name) ? ' ✓' : ''}: ${s.description}`);
        info(`${vi ? 'Kỹ năng có sẵn' : 'Available skills'}:\n${list.join('\n')}`);
        return true;
      }
      case 'help':
        info(
          vi
            ? 'Gõ **@** để đính kèm tệp/thư mục, **/** để xem lệnh. Enter gửi, Shift+Enter xuống dòng, Esc dừng. Chế độ quyền, model và mức suy luận chọn ở dưới ô nhập.'
            : 'Type **@** to attach files/folders, **/** for commands. Enter sends, Shift+Enter adds a line, Esc stops. Pick permission mode, model and reasoning level below the input.',
        );
        return true;
      case 'mode': {
        const m = MODE_ALIASES[fold(args)];
        if (!m) {
          info(vi ? 'Chế độ: `default` (hỏi trước), `acceptEdits` (tự nhận chỉnh sửa), `plan` (lập kế hoạch), `bypass`.' : 'Modes: `default`, `acceptEdits`, `plan`, `bypass`.');
          return true;
        }
        this.setMode(m);
        return true;
      }
      case 'thinking': {
        const l = THINK_ALIASES[fold(args)];
        if (!l) {
          info(vi ? 'Mức suy luận: `off`, `low`, `medium`, `high`, `max`, `swarm` (bầy agent — rất tốn token).' : 'Reasoning levels: `off`, `low`, `medium`, `high`, `max`, `swarm` (agent swarm — uses many tokens).');
          return true;
        }
        this.session.thinkingLevel = l;
        this.patch({ thinkingLevel: l });
        return true;
      }
      case 'model': {
        const q = fold(args);
        if (!q) {
          await vscode.commands.executeCommand('locaithAgent.selectModel');
          return true;
        }
        const matches: { provider: string; model: string; label: string }[] = [];
        for (const p of await this.d.providers.summaries()) {
          for (const mod of p.models) {
            if (fold(mod.id).includes(q) || fold(mod.label).includes(q) || fold(`${p.id}:${mod.id}`).includes(q)) matches.push({ provider: p.id, model: mod.id, label: `${p.label} · ${mod.label}` });
          }
        }
        const exact = matches.filter((x) => fold(x.model) === q);
        const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
        if (pick) await this.setModel(pick.provider, pick.model);
        else if (matches.length === 0) info(vi ? `Không có model nào khớp "${args}".` : `No model matches "${args}".`);
        else info(`${vi ? 'Có nhiều model khớp, hãy gõ rõ hơn' : 'Several models match, be more specific'}:\n${matches.slice(0, 8).map((x) => `- ${x.label} (\`${x.provider}:${x.model}\`)`).join('\n')}`);
        return true;
      }
      default: {
        const reg = this.slash.get(cmd);
        if (reg) {
          if (reg.needsIdle !== false && this.busy) {
            this.busyToast();
            return true;
          }
          await reg.run(this.slashContext(args));
          return true;
        }
        const pc = this.d.plugins.command(cmd);
        if (!pc) return false;
        if (this.busy) {
          this.busyToast();
          return true;
        }
        const text = expandCommand(pc.template, args);
        await this.runAgentTurn(() => this.sendUnlocked(text, text, []));
        return true;
      }
    }
  }

  private async compact(): Promise<void> {
    if (this.busy) return this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
    if (this.session.messages.length < 4) {
      this.emit({ t: 'notice', level: 'info', text: this.lang === 'vi' ? 'Cuộc trò chuyện còn ngắn, chưa cần nén.' : 'The conversation is short; nothing to compact.' });
      return;
    }
    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const engine = await this.createEngine();
      const msg = await engine.compactNow(this.session, abort.signal);
      this.emit({ t: 'notice', level: 'info', text: msg ?? (this.lang === 'vi' ? 'Không có gì để nén.' : 'Nothing to compact.') });
    } catch (err) {
      this.emit({ t: 'notice', level: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  /** Quay lại trước tin nhắn người dùng cuối cùng; chạy lại hoặc đưa vào ô nhập để sửa. */
  private async retryLast(editOnly: boolean): Promise<void> {
    if (this.busy) return this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
    const msgs = this.session.messages;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      // Tin `steer` (người dùng chen vào giữa vòng công cụ) nằm chung tin nhắn kết quả công cụ → không phải điểm bắt đầu của một lượt.
      if (msgs[i].role === 'user' && !msgs[i].synthetic && msgs[i].content.some((b) => b.type === 'text' || b.type === 'image') && !msgs[i].content.some((b) => b.type === 'tool_result')) {
        idx = i;
        break;
      }
    }
    let ti = -1;
    for (let i = this.view.transcript.length - 1; i >= 0; i--) {
      const it = this.view.transcript[i];
      if (it.kind === 'user' && !it.steer) {
        ti = i;
        break;
      }
    }
    if (idx < 0 || ti < 0) return;
    const userItem = this.view.transcript[ti] as Extract<TItem, { kind: 'user' }>;
    const content = msgs[idx].content;
    // Cắt đuôi chỉ để lại một TIỀN TỐ nguyên vẹn của hội thoại cũ nên khối suy luận còn lại vẫn hợp lệ — không đặt
    // `historyEdited` (cờ đó chỉ bỏ suy luận ở một lần gọi rồi tự xoá, lượt sau lại phát lại bản cũ và API trả 400).
    this.session.messages = msgs.slice(0, idx);
    this.patch({ transcript: this.view.transcript.slice(0, ti) });
    if (editOnly) {
      // Tệp tải lên: bản hiển thị không còn phần chữ → lấy lại từ bản lưu của tin cuối (nếu còn); phiên mới khôi phục từ kho thì phải đính kèm lại.
      const stash = this.docStash?.id === userItem.id ? this.docStash.docs : [];
      this.post({ type: 'draft', text: userItem.text, attachments: [...userItem.attachments.filter((a) => a.kind !== 'image' && a.kind !== 'doc'), ...stash] });
      if (stash.length === 0 && userItem.attachments.some((a) => a.kind === 'doc')) this.toast('info', this.lang === 'vi' ? 'Tệp tải lên không được giữ lại — hãy đính kèm lại.' : 'Uploaded files aren’t kept — please attach them again.');
      return;
    }
    await this.runAgentTurn(async () => {
      this.setRunning(true);
      const abort = new AbortController();
      this.abort = abort;
      try {
        this.emit({ t: 'user', id: newId('u'), text: userItem.text, attachments: userItem.attachments, ts: Date.now() });
        await this.execute(content, abort);
      } catch (err) {
        this.lastStop = 'error';
        this.emit({ t: 'notice', level: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        this.abort = null;
        this.setRunning(false);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hành động trên editor
  // ─────────────────────────────────────────────────────────────────────────

  private async openFile(rel: string, line?: number): Promise<void> {
    const r = resolveUserPath(this.host, String(rel ?? ''));
    if (r.zone === 'outside') return this.toast('warn', this.lang === 'vi' ? 'Chỉ mở được tệp trong workspace.' : 'Only workspace files can be opened.');
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(r.abs));
      const ln = Math.max(0, (line ?? 1) - 1);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(ln, 0, ln, 0), preview: true });
    } catch {
      this.toast('error', this.lang === 'vi' ? `Không mở được ${rel}` : `Could not open ${rel}`);
    }
  }

  // ── (0.6.3) Xem trước kết quả: ảnh, GIF, video, âm thanh, tài liệu mà câu trả lời nhắc tới ──

  /** Đường dẫn (đã chuẩn hoá để so) mà `resolve_media` đã xác nhận là tệp có thật trong vùng xem — `open_media` chỉ mở những tệp này. */
  private readonly mediaAllowed = new Set<string>();

  private mediaZones(): MediaZones {
    return { workspaceRoots: this.host.workspaceRoots(), home: os.homedir(), tmp: os.tmpdir() };
  }

  private async resolveMedia(key: string, raw: unknown[]): Promise<void> {
    const wv = this.webview;
    if (!wv || !key || key.length > 80) return;
    const paths = raw.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MEDIA_MAX_PATHS);
    const zones = this.mediaZones();
    // Thư mục webview đọc được (đặt lúc tạo khung chat — xem chatWebviewOptions): tệp trong đó nhúng thẳng bằng asWebviewUri.
    const roots = (wv.options.localResourceRoots ?? []).filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    const items = await Promise.all(paths.map((p) => this.resolveOneMedia(p, zones, roots, wv)));
    // Gửi THẲNG tới khung chat trong VS Code, không qua this.post: địa chỉ webview và đường dẫn trên máy này không dành cho thiết bị Remote.
    void wv.postMessage({ type: 'media_resolved', key, items } satisfies HostMessage);
  }

  private async resolveOneMedia(p: string, zones: MediaZones, roots: readonly string[], wv: vscode.Webview): Promise<MediaItem> {
    for (const abs of mediaCandidates(p, zones)) {
      let st: fs.Stats;
      try {
        // lstat: không đi theo symlink (một liên kết trong workspace có thể trỏ ra ổ mạng).
        st = await fs.promises.lstat(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      // …và không thư mục nào ở giữa (từ gốc vùng xem tới tệp) là symlink / junction.
      if (await viaLink(abs, zones)) continue;
      const kind = mediaKindOf(abs);
      if (!kind) continue;
      let src: string | undefined;
      if (kind !== 'doc') {
        if (roots.some((r) => isInside(r, abs))) src = wv.asWebviewUri(vscode.Uri.file(abs)).toString();
        else if (kind === 'image' && st.size <= MEDIA_DATA_URI_MAX) {
          try {
            src = `data:${imageMime(abs)};base64,${(await fs.promises.readFile(abs)).toString('base64')}`;
          } catch {
            /* không đọc được → chỉ có thẻ mở */
          }
        }
      }
      if (this.mediaAllowed.size > 2000) this.mediaAllowed.clear();
      this.mediaAllowed.add(normalizeForCompare(abs));
      return { path: p, ok: true, kind, name: path.basename(abs), abs, size: st.size, mtime: Math.round(st.mtimeMs), src };
    }
    return { path: p, ok: false };
  }

  private async openMedia(p: string, how: unknown): Promise<void> {
    if (!p || !this.mediaAllowed.has(normalizeForCompare(p))) return;
    const uri = vscode.Uri.file(path.normalize(p));
    const vi = this.lang === 'vi';
    try {
      if (how === 'reveal') await vscode.commands.executeCommand('revealFileInOS', uri);
      else if (how === 'external') {
        if (!(await vscode.env.openExternal(uri))) throw new Error('openExternal');
      } else await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch {
      this.toast('error', vi ? `Không mở được ${path.basename(p)}` : `Could not open ${path.basename(p)}`);
    }
  }

  private async applyCode(code: string, lang: string | undefined, mode: 'insert' | 'replace' | 'new_file'): Promise<void> {
    const text = String(code ?? '');
    if (mode === 'new_file') {
      const doc = await vscode.workspace.openTextDocument({ content: text, language: FENCE_LANG[(lang ?? '').toLowerCase()] ?? (lang || 'plaintext') });
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    const ed = vscode.window.activeTextEditor;
    if (!ed) return this.toast('warn', this.lang === 'vi' ? 'Chưa có editor nào đang mở.' : 'No active editor.');
    await ed.edit((b) => (mode === 'replace' ? b.replace(ed.selection, text) : b.insert(ed.selection.active, text)));
  }

  /** Thêm vùng chọn/tệp vào ô nhập (lệnh từ editor, explorer). */
  insert(text?: string, attachments?: AttachmentInfo[]): void {
    this.post({ type: 'insert', text, attachments });
    this.post({ type: 'focus' });
  }

  /** Gửi thẳng một câu hỏi (lệnh "Giải thích đoạn mã đã chọn"…). */
  async ask(text: string, attachments: AttachmentInfo[]): Promise<void> {
    if (!this.requireAccount()) {
      this.focus();
      return;
    }
    await this.send(text, attachments);
  }

  exportChat(): Promise<void> {
    const lines: string[] = [`# ${this.session.title}`, '', `_${this.session.provider}:${this.session.model} — ${new Date(this.session.createdAt).toLocaleString('vi-VN')}_`, ''];
    for (const it of this.view.transcript) {
      if (it.kind === 'user') lines.push(`## Bạn`, '', it.text, '');
      else if (it.kind === 'assistant') {
        lines.push(`## Trợ lý (${it.model})`, '');
        for (const b of it.blocks) {
          if (b.type === 'text') lines.push(b.text, '');
          else if (b.type === 'tool') lines.push(`> Công cụ \`${b.name}\`${b.summary ? ` — ${b.summary}` : ''}`, '');
          else if (b.type === 'tasks') lines.push(...b.added.map((a) => `- [ ] ${a}`), '');
          else if (b.type === 'skill') lines.push(`> Đã tải kỹ năng \`${b.skill}\``, '');
          else if (b.type === 'artifact') lines.push(`> Artifact: ${b.title} (${b.artifactType})`, '');
        }
      } else lines.push(`> ${it.text}`, '');
    }
    return Promise.resolve(vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' }).then((d) => void vscode.window.showTextDocument(d, { preview: false })));
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.perms.dispose(); // (lane:perm-rules)
    this.detachMcp();
    this.accountSub?.dispose();
    this.remoteSub?.dispose();
    this.chromeUnsub?.();
    this.locaithSub?.dispose();
    this.stop();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    void this.saveNow();
  }
}


