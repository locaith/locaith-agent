/**
 * BrowserController — "bộ não" nối engine với giao diện trong khung chat của Chrome/Edge. Chạy CÙNG trang với giao diện
 * (nên không cần postMessage qua tiến trình khác): giao diện gửi `WebviewMessage` vào `onMessage`, controller phát `HostMessage` qua `deps.post`.
 *
 * Mô phỏng ChatController của bản VS Code (cùng giao thức, cùng cách gom sự kiện, cùng các lớp phòng thủ: khoá `starting` chống chạy
 * hai engine, kiểm tra quyết định cấp quyền, lệnh gạch chéo xử lý trước khi khoá…) nhưng không có workspace, trình soạn thảo hay diff.
 */

import { AgentEngine } from '../core/engine/engine';
import { t, type Lang } from '../core/engine/strings';
import { Summarizer } from '../core/engine/summarizer';
import type { ToolRegistry } from '../core/engine/toolRegistry';
import { newSession, type ArtifactRecord, type PermissionDecision, type SessionState } from '../core/engine/types';
import { DEMO_PROVIDER_ID } from '../core/providers/demo';
import type { ProviderService } from '../core/providers/service';
import type { SkillRegistry } from '../core/skills/registry';
import type { ContentBlock } from '../core/types';
import { isAllowedBaseUrl } from '../shared/baseUrl';
import { docCharBudget } from '../shared/docKinds';
import { parseUploadedDocument, type DocExtractor } from '../shared/docWrap';
import type {
  AttachmentInfo,
  BrowserTabInfo,
  BrowserViewState,
  FileHit,
  HostMessage,
  PermissionMode,
  PermissionRequest,
  SkillSummary,
  SlashCommandInfo,
  ThinkingLevel,
  TItem,
  UiEvent,
  ViewState,
  WebviewMessage,
} from '../shared/protocol';
import { PERMISSION_MODES, THINKING_LEVELS } from '../shared/protocol';
import { backupFileName, makeBackup } from '../shared/sessionBackup';
import type { BaseSessionStore } from '../shared/sessionStore';
import { newId, reduceView } from '../shared/transcript';
import type { BrowserApi, TabLite } from './api';
import type { BrowserConfig } from './config';
import { browserContextBlock, buildBrowserUserContent, withFreshContext } from './context';
import { BrowserToolHost } from './host';
import type { BrowserLogger } from './logger';
import { clip } from './page/pure';
import { OAuthError, validateSpec, type OAuthManager } from './oauth';
import type { BrowserSecrets } from './secrets';
import { hasRedactions, redactForStorage, redactTranscript, settleForExit } from './storageRedact';
import { createBrowserToolRegistry } from './tools';
import { hostOf, TabScope } from './tools/policy';
import { Presence } from './presence';

export interface ArtifactHost {
  open(rec: ArtifactRecord): Promise<void> | void;
  save(rec: ArtifactRecord): Promise<void> | void;
  /** Tải một tệp văn bản về máy (xuất hội thoại). */
  download(filename: string, mime: string, content: string): void;
}

export interface BrowserControllerDeps {
  config: BrowserConfig;
  secrets: BrowserSecrets;
  /** Đăng nhập bằng tài khoản (OAuth) cho các nhà cung cấp có cấu hình. */
  oauth: OAuthManager;
  providers: ProviderService;
  skills: SkillRegistry;
  store: BaseSessionStore;
  logger: BrowserLogger;
  api: BrowserApi;
  artifacts: ArtifactHost;
  /** Gửi tin nhắn tới giao diện. */
  post(msg: HostMessage): void;
  version: string;
  /** Phiên đang mở gần nhất (sống tới khi tắt trình duyệt) để mở lại khung chat không mất mạch. */
  lastSession?: { get(): Promise<string | undefined>; set(id: string | undefined): Promise<void> };
  /** Đọc tệp tải lên (PDF/Word/Excel/HTML/CSV/TXT) thành chữ. Bản thật nạp lười từ docparse.js (xem panel.tsx); bỏ trống = chưa hỗ trợ đọc tệp. */
  extractDocument?: DocExtractor;
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
    { name: 'retry', description: 'Chạy lại tin nhắn cuối' },
    { name: 'export', description: 'Tải cuộc trò chuyện về dạng Markdown' },
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
    { name: 'retry', description: 'Re-run the last message' },
    { name: 'export', description: 'Download the conversation as Markdown' },
    { name: 'help', description: 'Quick help' },
  ],
};

const MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  hoi: 'default',
  ask: 'default',
  acceptedits: 'acceptEdits',
  accept: 'acceptEdits',
  nhan: 'acceptEdits',
  plan: 'plan',
  'ke-hoach': 'plan',
  kehoach: 'plan',
  bypass: 'bypass',
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
};

const COMBINING = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');
function fold(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Gộp các delta liên tiếp để mỗi lần đẩy sang giao diện mang ít sự kiện hơn. */
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

/** Tab hiện trên chip (đã gắn hoặc đang xem) + tab đang xem khi khác tab đã gắn. */
interface TabsInfo {
  tab: BrowserViewState['tab'];
  viewing: BrowserViewState['viewing'] | null;
}

const RESTORE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Số bước lớn nhất đã dùng trong một cuộc trò chuyện (mở lại cuộc cũ thì đánh số nối tiếp, không trùng với số bước đã có). */
function maxStepOf(transcript: TItem[]): number {
  let max = 0;
  for (const it of transcript) {
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) if (b.type === 'tool' && b.step !== undefined && b.step > max) max = b.step;
  }
  return max;
}

export class BrowserController {
  private session: SessionState;
  private view: ViewState;
  private abort: AbortController | null = null;
  /** Đang trong giai đoạn chuẩn bị của send() (trước khi `running` bật). */
  private starting = false;
  private readonly waiters = new Map<string, (d: PermissionDecision) => void>();
  private readonly host: BrowserToolHost;
  private readonly registry: ToolRegistry;
  private readonly scope = new TabScope();
  /** Viền sáng + nút Dừng trên các trang trợ lý đang đọc/điều khiển. */
  private readonly presence: Presence;
  private pending: UiEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tabTimer: ReturnType<typeof setTimeout> | null = null;
  private offTabs: (() => void) | null = null;
  private disposed = false;
  /**
   * Tab trợ lý đã GẮN vào (bám tab): đặt ở tin nhắn đầu tiên của cuộc trò chuyện hoặc khi người dùng chọn lại; KHÔNG đổi khi người dùng đổi tab/cửa sổ để
   * sao chép, tra cứu. Cuộc trò chuyện mới / tab bị đóng thì bỏ.
   */
  private pinnedTabId: number | undefined;
  /** Giao diện đã gửi `ready` ít nhất một lần (đã dựng ô nhập, đã nghe tin nhắn từ controller). */
  private uiReady = false;
  private readonly queuedInserts: { text?: string; attachments?: AttachmentInfo[] }[] = [];
  /** Tệp tải lên của tin nhắn người dùng cuối cùng (còn nguyên chữ), để "Sửa tin nhắn cuối" đưa lại vào ô nhập. */
  private docStash: { id: string; docs: AttachmentInfo[] } | null = null;
  /** Bộ đếm cho kiểm thử tích hợp. */
  readonly stats = { ready: 0, messages: 0 };

  constructor(private readonly d: BrowserControllerDeps) {
    this.host = new BrowserToolHost({
      askPermission: (req, signal) => this.askPermission(req, signal),
      log: (l, m) => d.logger.log(l, m),
      secret: async () => undefined,
    });
    this.presence = new Presence({ api: d.api, enabled: () => d.config.browser().presence, lang: () => this.lang });
    this.registry = createBrowserToolRegistry({ skills: d.skills, api: d.api, scope: this.scope, presence: this.presence, focusTabs: () => d.config.browser().focusTabs });
    this.session = this.freshSession();
    this.view = this.baseView();
  }

  get isRunning(): boolean {
    return this.view.running;
  }

  /** Ảnh chụp trạng thái — chỉ dùng cho kiểm thử. */
  snapshot(): { view: ViewState; session: SessionState } {
    return { view: this.view, session: this.session };
  }

  private get lang(): Lang {
    return this.d.config.language();
  }

  private post(msg: HostMessage): void {
    if (!this.disposed) this.d.post(msg);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Khởi động / trạng thái
  // ─────────────────────────────────────────────────────────────────────────

  /** Gọi sau khi config đã nạp: theo dõi tab, khôi phục phiên gần nhất. */
  async start(): Promise<void> {
    this.offTabs = this.d.api.onTabsChanged(() => this.scheduleTabRefresh());
    this.d.config.onDidChange(() => void this.onConfigChanged());
    this.d.secrets.onDidChange(() => void this.onEnvironmentChanged({ providers: true }));
    await this.restoreLast();
  }

  private async restoreLast(): Promise<void> {
    try {
      const id = await this.d.lastSession?.get();
      if (!id) return;
      const p = await this.d.store.load(id);
      if (!p || Date.now() - p.session.updatedAt > RESTORE_WINDOW_MS) return;
      this.session = p.session;
      this.session.historyEdited = hasRedactions(this.session); // lịch sử đã bị lược khi lưu → bỏ khối suy luận cũ ở lượt kế
      this.session.approvals = []; // quyền "cho phép cả phiên" không sống qua lần mở khung chat (bản cũ trong kho có thể còn lưu)
      if (!this.d.providers.has(this.session.provider)) {
        // Nhà cung cấp đã bị gỡ (API tuỳ chỉnh bị xoá…): vẫn giữ nội dung hội thoại, chuyển sang model mặc định.
        const pick = this.pickDefaultProvider();
        this.session.provider = pick.provider;
        this.session.model = pick.model;
      }
      if (this.session.mode === 'bypass' && !this.d.config.allowBypass()) this.session.mode = 'default';
      Object.keys(this.session.artifacts).forEach((k) => this.seenArtifacts.add(k));
      this.view = { ...this.baseView(), transcript: p.transcript };
      this.presence.resetSteps(maxStepOf(p.transcript) + 1);
      if (p.transcript.length) {
        // Tác vụ đang chạy dở bị dừng khi khung chat đóng: nói rõ để người dùng không tưởng nó đã xong.
        this.view.transcript = [...p.transcript, { kind: 'notice', id: newId('n'), level: 'info', text: this.lang === 'vi' ? 'Đã mở lại cuộc trò chuyện gần nhất. Nếu trợ lý đang làm dở khi khung chat đóng, tác vụ đó đã dừng.' : 'Reopened your latest conversation. If the assistant was mid-task when the panel closed, it stopped.', ts: Date.now() }];
      }
    } catch (err) {
      this.d.logger.log('warn', `Không khôi phục được phiên gần nhất: ${err instanceof Error ? err.message : err}`);
    }
  }

  private readonly seenArtifacts = new Set<string>();

  private pickDefaultProvider(): { provider: string; model: string } {
    const last = this.d.config.lastModel();
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
      mode: this.d.config.defaultMode(),
      thinkingLevel: 'medium',
    });
  }

  private skillSummaries(): SkillSummary[] {
    return this.d.skills.list().map((s) => ({ name: s.name, description: s.description, loaded: this.session.loadedSkills.includes(s.name), source: s.source }));
  }

  private contextInfo(): ViewState['context'] {
    return { usedTokens: this.session.lastContextTokens, limitTokens: this.d.providers.contextWindow(this.session.provider, this.session.model) };
  }

  private browserState(tabs: TabsInfo = { tab: this.view?.browser?.tab ?? null, viewing: this.view?.browser?.viewing ?? null }, siteAccess = this.view?.browser?.siteAccess ?? false): BrowserViewState {
    return { tab: tabs.tab, viewing: tabs.viewing, siteAccess, browser: this.d.api.name, settings: this.d.config.browser() };
  }

  private baseView(): ViewState {
    return {
      version: this.d.version,
      sessionId: this.session.id,
      title: this.session.title,
      transcript: [],
      todos: this.session.todos,
      running: false,
      provider: this.session.provider,
      model: this.session.model,
      mode: this.session.mode,
      thinkingLevel: this.session.thinkingLevel,
      providers: [],
      settings: this.d.config.ui(),
      sessions: [],
      trash: [],
      workspace: null,
      context: this.contextInfo(),
      editor: null,
      skills: this.skillSummaries(),
      slashCommands: SLASH[this.lang],
      allowBypass: this.d.config.allowBypass(),
      screen: 'chat',
      platform: 'browser',
      browser: this.browserState(),
    };
  }

  /** Cuộc trò chuyện đang được XEM trong lúc trợ lý vẫn chạy ở cuộc khác (null = theo dõi cuộc đang chạy). */
  private viewing: string | null = null;
  /** Bản đã nạp của cuộc đang xem trong lúc cuộc khác chạy: khi cuộc kia xong, gửi tin sẽ NHẬN cuộc này rồi gửi vào chính nó. */
  private viewed: { session: SessionState; transcript: TItem[] } | null = null;
  /** Chống bắn cùng một cảnh báo vài lần trong vài giây. */
  private viewToastAt = 0;

  private patch(p: Partial<ViewState>): void {
    this.view = { ...this.view, ...p };
    // Đang xem một cuộc khác trong lúc trợ lý chạy: vẫn cập nhật this.view, nhưng không đẩy lên giao diện.
    if (this.viewing) return;
    this.post({ type: 'patch', patch: p });
  }

  /** Danh sách cuộc trò chuyện và Thùng rác — luôn cập nhật cùng nhau. */
  private async listings(): Promise<Pick<ViewState, 'sessions' | 'trash'>> {
    const [sessions, trash] = await Promise.all([this.d.store.list(), this.d.store.listTrash()]);
    return { sessions, trash };
  }

  private toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ type: 'toast', level, text });
  }

  /** Phiên còn trống mà nhà cung cấp đang chọn chưa có khoá → chuyển sang nhà cung cấp đầu tiên có khoá, hoặc chế độ demo. */
  private async autoPickProvider(): Promise<void> {
    if (this.session.messages.length > 0 || this.busy) return;
    if (await this.d.providers.hasKey(this.session.provider)) return;
    const descriptors = await this.d.providers.registry.descriptors();
    const pick = descriptors.find((p) => p.id !== DEMO_PROVIDER_ID && p.hasKey) ?? descriptors.find((p) => p.id === DEMO_PROVIDER_ID);
    if (!pick) return;
    this.session.provider = pick.id;
    this.session.model = pick.defaultModel;
    this.view = { ...this.view, provider: pick.id, model: pick.defaultModel };
  }

  async sendInit(screen?: ViewState['screen']): Promise<void> {
    await this.autoPickProvider();
    const [providers, lists, tabs, siteAccess] = await Promise.all([this.providerSummaries(), this.listings(), this.currentTabs(), this.d.api.hasSiteAccess()]);
    this.view = {
      ...this.view,
      providers,
      ...lists,
      settings: this.d.config.ui(),
      skills: this.skillSummaries(),
      slashCommands: SLASH[this.lang],
      allowBypass: this.d.config.allowBypass(),
      context: this.contextInfo(),
      screen: screen ?? 'chat',
      browser: this.browserState(tabs, siteAccess),
    };
    this.post({ type: 'init', state: this.view });
    void this.refreshProvidersInBackground();
  }

  private async refreshProvidersInBackground(force = false): Promise<void> {
    try {
      await this.d.providers.refresh(undefined, force);
      if (!this.disposed) this.patch({ providers: await this.providerSummaries(), context: this.contextInfo() });
    } catch (err) {
      this.d.logger.log('warn', `Làm mới danh sách model thất bại: ${err instanceof Error ? err.message : err}`);
    }
  }

  async onEnvironmentChanged(opts: { providers?: boolean; settings?: boolean; skills?: boolean } = {}): Promise<void> {
    const p: Partial<ViewState> = {};
    if (opts.settings) {
      p.settings = this.d.config.ui();
      p.allowBypass = this.d.config.allowBypass();
      p.slashCommands = SLASH[this.lang];
      p.browser = this.browserState();
    }
    if (opts.skills) p.skills = this.skillSummaries();
    if (opts.providers) p.providers = await this.providerSummaries();
    if (Object.keys(p).length) this.patch(p);
  }

  private async onConfigChanged(): Promise<void> {
    this.d.providers.reconfigure();
    void this.d.providers.refresh();
    await this.onEnvironmentChanged({ settings: true, providers: true });
  }

  // ── tab trợ lý bám / tab đang xem ──
  private async tabInfoOf(tab: TabLite, pinned: boolean): Promise<BrowserTabInfo> {
    const http = /^https?:/i.test(tab.url);
    const readable = http && ((await this.d.api.hasSiteAccess()) || (await this.d.api.canAccess(tab.id)));
    return { id: tab.id, title: clip(tab.title || hostOf(tab.url), 120), url: tab.url, host: hostOf(tab.url), readable, ...(pinned ? { pinned: true } : {}) };
  }

  /**
   * Tab hiện trên chip: tab ĐÃ GẮN (nếu bật "bám tab" và tab còn tồn tại), nếu không thì tab đang xem. `viewing` = tab đang xem khi khác tab đã gắn,
   * để chip đưa nút "Gắn vào tab này". Tab đã gắn bị đóng thì bỏ gắn.
   */
  private async currentTabs(): Promise<TabsInfo> {
    const active = await this.d.api.activeTab().catch(() => null);
    if (this.d.config.browser().pinTab && this.pinnedTabId !== undefined) {
      const pinned = await this.d.api.getTab(this.pinnedTabId).catch(() => null);
      if (pinned) {
        const viewing = active && active.id !== pinned.id && /^https?:/i.test(active.url) ? await this.tabInfoOf(active, false) : null;
        return { tab: await this.tabInfoOf(pinned, true), viewing };
      }
      this.pinnedTabId = undefined; // tab đã gắn đã bị đóng
    }
    return { tab: active ? await this.tabInfoOf(active, false) : null, viewing: null };
  }

  /**
   * Tab trợ lý làm việc cho lượt này. Bật "bám tab": tab đã gắn (còn tồn tại) — KHÔNG đi theo tab/cửa sổ người dùng đang xem; chưa gắn thì gắn vào tab đang xem NGAY BÂY GIỜ.
   * `trust`: có tin cậy origin hiện tại của tab không — tab vừa chọn / đang được xem thì có; tab đã gắn mà người dùng đang ở tab khác thì không (xem TabScope.beginRun).
   */
  private async resolveAnchor(): Promise<{ anchor: TabLite | null; trust: boolean }> {
    if (!this.d.config.browser().pinTab) return { anchor: await this.d.api.activeTab().catch(() => null), trust: true };
    if (this.pinnedTabId !== undefined) {
      const t = await this.d.api.getTab(this.pinnedTabId).catch(() => null);
      if (t) return { anchor: t, trust: t.active };
      this.pinnedTabId = undefined;
      this.toast('info', this.lang === 'vi' ? 'Tab đã gắn đã đóng — trợ lý gắn vào tab bạn đang xem.' : 'The attached tab was closed — attaching to the tab you are viewing.');
    }
    const active = await this.d.api.activeTab().catch(() => null);
    this.pinnedTabId = active?.id;
    return { anchor: active, trust: true };
  }

  /** Gắn trợ lý vào một tab (không có `tabId` = tab đang xem). Có hiệu lực từ tin nhắn kế tiếp; lượt đang chạy không đổi. */
  async pinTab(tabId?: number): Promise<void> {
    const t = tabId !== undefined ? await this.d.api.getTab(tabId).catch(() => null) : await this.d.api.activeTab().catch(() => null);
    if (!t) return;
    this.pinnedTabId = t.id;
    // Người dùng chủ động chọn tab này (đang nhìn nó / bấm menu trên nó) → đó là sự đồng ý cho origin HIỆN TẠI của tab, kể cả khi lúc gửi tin họ đã sang tab khác.
    this.scope.trust(t.id, t.url);
    this.scheduleTabRefresh();
  }

  private scheduleTabRefresh(): void {
    if (this.tabTimer || this.disposed) return;
    this.tabTimer = setTimeout(async () => {
      this.tabTimer = null;
      if (this.disposed) return;
      try {
        const [tabs, siteAccess] = await Promise.all([this.currentTabs(), this.d.api.hasSiteAccess()]);
        // Mỗi tab tải/đổi tiêu đề ở BẤT KỲ cửa sổ nào cũng kích hoạt đây: chỉ đẩy xuống giao diện khi thông tin tab thật sự đổi.
        const cur = this.view.browser;
        if (cur && cur.siteAccess === siteAccess && JSON.stringify(cur.tab) === JSON.stringify(tabs.tab) && JSON.stringify(cur.viewing ?? null) === JSON.stringify(tabs.viewing)) return;
        this.patch({ browser: this.browserState(tabs, siteAccess) });
      } catch {
        /* cửa sổ đang đóng */
      }
    }, 250);
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

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.session.todos = this.view.todos;
    try {
      // Nội dung trang người dùng đã đăng nhập không được nằm lại dạng văn bản thuần trong kho (xem storageRedact.ts); bản trong bộ nhớ giữ nguyên.
      await this.d.store.save(redactForStorage(this.session), redactTranscript(this.view.transcript));
      await this.d.lastSession?.set(this.session.messages.length ? this.session.id : undefined);
    } catch (err) {
      this.d.logger.log('warn', `Không lưu được hội thoại: ${err instanceof Error ? err.message : err}`);
    }
  }

  private onEngineEvent(ev: UiEvent): void {
    this.emit(ev);
    switch (ev.t) {
      case 'artifact':
        // Không tự mở tab mới: sẽ cướp tiêu điểm khỏi trang trợ lý đang làm việc. Người dùng bấm "Mở" trên thẻ artifact.
        if (ev.state === 'ready') this.seenArtifacts.add(ev.artifactId);
        break;
      case 'skill':
        this.patch({ skills: this.skillSummaries() });
        break;
      case 'usage':
        this.patch({ context: this.contextInfo() });
        break;
      case 'mode':
        this.patch({ mode: ev.mode });
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Xin phép
  // ─────────────────────────────────────────────────────────────────────────

  private askPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const done = (dec: PermissionDecision) => {
        this.waiters.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        resolve(dec);
      };
      const onAbort = () => done({ decision: 'deny', feedback: t(this.lang, 'aborted') });
      this.waiters.set(req.id, done);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.flushNow(); // đảm bảo thẻ xin phép đã tới giao diện
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tin nhắn từ giao diện
  // ─────────────────────────────────────────────────────────────────────────

  async onMessage(m: WebviewMessage): Promise<void> {
    this.stats.messages++;
    try {
      await this.dispatch(m);
    } catch (err) {
      this.d.logger.log('error', `Lỗi xử lý tin nhắn từ giao diện (${m?.type}): ${err instanceof Error ? err.stack ?? err.message : err}`);
    }
  }

  private async dispatch(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.stats.ready++;
        await this.sendInit(this.view.screen);
        // Giao diện đã dựng xong: giao các lần chèn vào ô nhập đã phải chờ (menu chuột phải lúc khung chat mới mở).
        this.uiReady = true;
        const queued = this.queuedInserts.splice(0);
        for (const q of queued) this.insert(q.text, q.attachments);
        return;
      }
      case 'send':
        return this.send(m.text, Array.isArray(m.attachments) ? m.attachments : []);
      case 'stop':
        return this.stop();
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
      case 'set_browser_setting':
        await this.d.config.setBrowser(m.key, m.value as never);
        // Rút lại quyền dùng chế độ "Toàn quyền" trong Cài đặt: phiên đang ở chế độ đó phải quay về chế độ hỏi ngay, không đợi lần mở lại.
        if (m.key === 'allowBypass' && m.value === false && this.session.mode === 'bypass') this.setMode('default');
        return;
      case 'enable_full_access':
        return this.enableFullAccess(!!m.remember, !!m.siteAccess);
      case 'permission_response':
        // Chỉ nhận đúng ba quyết định đã định nghĩa, còn lại bỏ qua (thẻ vẫn chờ người dùng).
        if (m.decision !== 'allow' && m.decision !== 'allow_session' && m.decision !== 'deny') return;
        this.waiters.get(m.id)?.({ decision: m.decision, feedback: typeof m.feedback === 'string' ? m.feedback.slice(0, 500) : undefined });
        return;
      case 'open_artifact': {
        const rec = this.session.artifacts[m.artifactId];
        if (rec) await this.d.artifacts.open(rec);
        return;
      }
      case 'save_artifact': {
        const rec = this.session.artifacts[m.artifactId];
        if (rec) await this.d.artifacts.save(rec);
        return;
      }
      case 'search_files':
        // Trong trình duyệt, "@" nhắc tới TAB thay vì tệp.
        this.post({ type: 'files', reqId: m.reqId, items: await this.searchTabs(String(m.query ?? '')) });
        return;
      case 'parse_document':
        return this.parseDocument(m.reqId, m.name, m.data);
      case 'refresh_models':
        await this.d.providers.refresh([m.provider], true);
        this.patch({ providers: await this.providerSummaries() });
        return;
      case 'save_api_key':
        return this.saveApiKey(m.provider, m.key);
      case 'clear_api_key':
        await this.d.oauth.logout(m.provider); // khoá lấy từ đăng nhập OAuth thì bỏ luôn dấu "đã đăng nhập"
        await this.d.secrets.delete(m.provider);
        this.d.providers.registry.catalog.invalidate(m.provider);
        this.patch({ providers: await this.providerSummaries() });
        return;
      case 'oauth_login':
        return this.oauthLogin(m.provider);
      case 'oauth_logout': {
        await this.d.oauth.logout(m.provider);
        this.d.providers.registry.catalog.invalidate(m.provider);
        this.patch({ providers: await this.providerSummaries() });
        this.toast('info', this.lang === 'vi' ? 'Đã đăng xuất.' : 'Signed out.');
        return;
      }
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
        if (url) await this.ensureApiOrigin(url);
        return;
      }
      case 'save_custom_provider':
        return this.saveCustomProvider(m.provider);
      case 'remove_custom_provider':
        await this.d.config.setCustomProviders(this.d.config.customProviders().filter((c) => c.id !== m.provider));
        await this.d.oauth.forget(m.provider);
        await this.d.secrets.delete(m.provider);
        return;
      case 'request_site_access': {
        const ok = await this.d.api.requestSiteAccess();
        this.patch({ browser: this.browserState(await this.currentTabs(), await this.d.api.hasSiteAccess()) });
        this.toast(ok ? 'info' : 'warn', ok ? (this.lang === 'vi' ? 'Đã cấp quyền truy cập trang web.' : 'Site access granted.') : this.lang === 'vi' ? 'Chưa được cấp quyền truy cập trang web.' : 'Site access was not granted.');
        return;
      }
      case 'revoke_site_access':
        await this.d.api.removeSiteAccess();
        this.patch({ browser: this.browserState(await this.currentTabs(), await this.d.api.hasSiteAccess()) });
        return;
      case 'refresh_tab':
        this.scheduleTabRefresh();
        return;
      case 'pin_tab':
        return this.pinTab(typeof m.tabId === 'number' ? m.tabId : undefined);
      case 'unpin_tab':
        this.pinnedTabId = undefined;
        this.scheduleTabRefresh();
        return;
      case 'open_external': {
        const u = String(m.url ?? '');
        if (/^https?:\/\//i.test(u)) await this.d.api.openExternal(u);
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
      // Không có nghĩa trong trình duyệt: open_file, open_diff, open_vscode_settings, apply_code, add_custom_provider
      default:
        return;
    }
  }

  private async searchTabs(query: string): Promise<FileHit[]> {
    const q = fold(query);
    const win = await this.d.api.windowId();
    const tabs = (await this.d.api.listTabs()).filter((x) => /^https?:/i.test(x.url) && (win === undefined || x.windowId === win));
    return tabs
      .filter((x) => !q || fold(x.title).includes(q) || fold(hostOf(x.url)).includes(q))
      .slice(0, 12)
      .map((x) => ({ path: `tab:${x.id}`, name: clip(x.title || hostOf(x.url), 60), dir: hostOf(x.url) }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gửi tin nhắn và chạy agent
  // ─────────────────────────────────────────────────────────────────────────

  private get busy(): boolean {
    return this.view.running || this.starting;
  }

  private busyToast(): void {
    this.toast('info', this.lang === 'vi' ? 'Trợ lý đang làm việc. Nhấn Dừng trước khi gửi tin mới.' : 'The assistant is working. Press Stop before sending a new message.');
  }

  async send(rawText: string, attachments: AttachmentInfo[]): Promise<void> {
    if (this.viewing) {
      if (this.busy) {
        // Cuộc khác ĐANG chạy: chưa gửi được. Báo một lần (không lặp mỗi lần bấm), kèm việc cần làm.
        const now = Date.now();
        if (now - this.viewToastAt > 6000) {
          this.viewToastAt = now;
          return this.toast('info', this.lang === 'vi'
            ? 'Cuộc đang chạy vẫn tiếp tục ở nền. Đợi nó xong (hoặc bấm Dừng) rồi gửi — tin sẽ vào đúng cuộc đang mở.'
            : 'The other conversation is still running in the background. Wait for it (or press Stop), then send — the message goes to the conversation you are viewing.');
        }
        return;
      }
      await this.adoptViewed(); // cuộc kia đã xong: nhận cuộc đang xem làm cuộc hiện tại rồi gửi vào CHÍNH NÓ
    }
    if (this.busy) return this.busyToast();
    const text = String(rawText ?? '').trim();
    if (!text && attachments.length === 0) return;
    // Lệnh gạch chéo xử lý TRƯỚC khi khoá: /compact, /new… tự kiểm tra "đang bận" nên sẽ tự chặn mình nếu đã đặt `starting`.
    if (text.startsWith('/') && attachments.length === 0) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      if (await this.handleSlash(cmd, rest.join(' '))) return;
    }
    if (this.busy) return this.busyToast(); // kiểm tra lại: `await` ở trên có thể để tin khác chen vào
    this.starting = true;
    try {
      await this.sendUnlocked(text, rawText, attachments);
    } finally {
      this.starting = false;
    }
  }

  /** Nhận cuộc đang xem (đã nạp sẵn) làm cuộc hiện tại — không chặn, không mất gì của cuộc kia (đã lưu). */
  private async adoptViewed(): Promise<void> {
    const p = this.viewed;
    this.viewing = null;
    this.viewed = null;
    if (!p) return;
    this.session = p.session;
    this.session.historyEdited = hasRedactions(this.session);
    this.session.approvals = []; // quyền "cho phép cả phiên" không theo hội thoại cũ sang lần mở này
    if (!this.d.providers.has(this.session.provider)) {
      const pick = this.pickDefaultProvider();
      this.session.provider = pick.provider;
      this.session.model = pick.model;
    }
    if (this.session.mode === 'bypass' && !this.d.config.allowBypass()) this.session.mode = 'default';
    this.scope.reset();
    this.pinnedTabId = undefined;
    this.presence.resetSteps(maxStepOf(p.transcript) + 1);
    this.seenArtifacts.clear();
    Object.keys(this.session.artifacts).forEach((k) => this.seenArtifacts.add(k));
    this.view = { ...this.baseView(), transcript: p.transcript, providers: this.view.providers, ...(await this.listings()), screen: 'chat', browser: this.browserState(await this.currentTabs()) };
    this.post({ type: 'init', state: this.view });
    await this.d.lastSession?.set(this.session.id);
  }

  private async sendUnlocked(text: string, rawText: string, attachments: AttachmentInfo[]): Promise<void> {
    const providerId = this.session.provider;
    if (!this.d.providers.has(providerId)) {
      this.emit({ t: 'notice', level: 'error', text: `Nhà cung cấp "${providerId}" không còn tồn tại. Hãy chọn lại model.` });
      return;
    }
    if (!(await this.d.providers.hasKey(providerId))) {
      this.emit({ t: 'notice', level: 'error', text: t(this.lang, 'noKey', { provider: this.d.providers.get(providerId).label }) });
      this.post({ type: 'draft', text: String(rawText ?? ''), attachments: attachments.filter((a) => a.kind !== 'image') });
      await this.showScreen('settings');
      return;
    }

    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { anchor, trust } = await this.resolveAnchor();
      const built = await buildBrowserUserContent({
        text,
        attachments,
        api: this.d.api,
        browserName: this.d.api.name,
        attachTabContext: this.d.config.browser().attachTabContext,
        anchor,
        docBudget: docCharBudget(this.d.providers.contextWindow(providerId, this.session.model)),
      });
      for (const w of built.warnings) this.emit({ t: 'notice', level: 'warn', text: w });
      this.scope.beginRun(built.anchor, { trust });
      this.scheduleTabRefresh(); // vừa gắn vào tab (tin nhắn đầu tiên): chip đổi sang "Đang bám …"
      // Người dùng đính kèm nội dung của một tab KHÁC tab đang xem → nội dung đó giờ nằm trong ngữ cảnh của mô hình: coi phiên là "nhiễm" (xem TabScope.tainted).
      // Chữ trong tệp tải lên cũng vậy: có thể do người khác gửi và chứa lời dụ "làm thế này trên trang kia" — mỗi thao tác trên trang phải hỏi lại.
      if (built.display.some((a) => (a.kind === 'tab' && a.path !== `tab:${built.anchor?.id}`) || a.kind === 'doc')) this.scope.taint();

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
    const extract = this.d.extractDocument;
    if (!extract) {
      this.post({ type: 'document_parsed', reqId, name: label, error: this.lang === 'vi' ? 'Bản này chưa hỗ trợ đọc tệp.' : 'This build can’t read files.' });
      return;
    }
    const maxChars = docCharBudget(this.d.providers.contextWindow(this.session.provider, this.session.model));
    const r = await parseUploadedDocument(extract, { name: label, data: String(data ?? '') }, maxChars);
    this.post({ type: 'document_parsed', reqId, name: label, ...r });
  }

  private async createEngine(): Promise<AgentEngine> {
    const s = this.session;
    const provider = this.d.providers.get(s.provider);
    const settings = { ...this.d.config.engine(), contextWindow: this.d.providers.contextWindow(s.provider, s.model) };
    const fast = this.d.config.summarizerEnabled() ? await this.d.providers.fastTarget(s.provider) : null;
    const summarizer = fast ? new Summarizer({ provider: fast.provider, model: fast.model, language: settings.language, log: (l, m) => this.d.logger.log(l, m) }) : null;
    return new AgentEngine({
      provider,
      summarizer,
      compactor: fast ?? undefined,
      registry: this.registry,
      skills: this.d.skills,
      host: this.host,
      settings,
      emit: (ev) => this.onEngineEvent(ev),
      profile: 'browser',
      // Hướng dẫn riêng của người dùng thay cho LOCAITH.md của bản VS Code.
      loadInstructions: async () => {
        const text = this.d.config.browser().customInstructions.trim();
        return text ? { file: 'Cài đặt → Hướng dẫn riêng', text } : null;
      },
      thinkTags: provider.kind === 'openai-chat' && provider.flavor === 'generic',
    });
  }

  private async execute(content: ContentBlock[], abort: AbortController): Promise<void> {
    const engine = await this.createEngine();
    const res = await engine.run({ session: this.session, content, signal: abort.signal });
    this.d.logger.log('info', `Lượt chạy kết thúc: ${res.stopReason} sau ${res.turns} vòng (${this.session.provider}:${this.session.model})`);
  }

  private setRunning(running: boolean): void {
    if (running) this.presence.begin();
    else this.presence.end();
    this.emit({ t: 'run_state', running });
    if (!running) {
      this.flushNow();
      void this.saveNow().then(async () => this.patch({ ...(await this.listings()), context: this.contextInfo() }));
    }
  }

  /** Nút Dừng ngay trên trang (lớp phủ của trợ lý). Chỉ nhận từ đúng tab đang có lớp phủ của lượt chạy này. */
  stopFromPage(tabId: number): void {
    if (!this.presence.has(tabId)) return;
    this.stop();
    this.toast('info', this.lang === 'vi' ? 'Đã dừng theo yêu cầu của bạn (nút Dừng trên trang).' : 'Stopped at your request (Stop button on the page).');
  }

  stop(): void {
    this.presence.end(); // gỡ viền sáng ngay, không chờ công cụ đang chạy dở trả về
    this.abort?.abort();
    for (const w of [...this.waiters.values()]) w({ decision: 'deny', feedback: t(this.lang, 'aborted') });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phiên
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Thay phiên hiện tại: giữ khoá `starting` suốt các bước `await` để một tin nhắn gửi chen vào không chạy trên phiên đang bị thay giữa chừng.
   * (Lời gọi không lồng nhau: lệnh gạch chéo được xử lý trước khi `send` đặt khoá.)
   */
  private async swapSession(work: () => Promise<void>): Promise<void> {
    if (this.busy) return this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
    this.starting = true;
    try {
      await work();
    } finally {
      this.starting = false;
    }
  }

  async startNewSession(): Promise<void> {
    return this.swapSession(async () => {
      await this.saveNow();
      this.session = this.freshSession();
      this.scope.reset();
      this.pinnedTabId = undefined;
      this.presence.resetSteps();
      this.seenArtifacts.clear();
      await this.d.lastSession?.set(undefined);
      this.view = { ...this.baseView(), providers: this.view.providers, ...(await this.listings()), screen: 'chat', browser: this.browserState(await this.currentTabs()) };
      this.post({ type: 'init', state: this.view });
    });
  }

  private async loadSession(id: string): Promise<void> {
    // Đang chạy: mở cuộc KHÁC = chỉ đổi thứ đang hiển thị, lượt chạy tiếp tục ở nền (không bắt dừng tác vụ).
    if (this.busy && id !== this.session.id) {
      const p = await this.d.store.load(id);
      if (!p) return this.toast('error', this.lang === 'vi' ? 'Không mở được cuộc trò chuyện này.' : 'Could not open this conversation.');
      this.viewing = id;
      this.viewed = { session: p.session, transcript: p.transcript };
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
          transcript: p.transcript,
          running: false,
          queued: [],
          canQueue: false,
          ...(await this.listings()),
          screen: 'chat',
          browser: this.browserState(await this.currentTabs()),
        },
      });
      return this.toast('info', this.lang === 'vi'
        ? 'Đang xem lại một cuộc trò chuyện khác — trợ lý vẫn chạy ở cuộc đang dở. Quay lại cuộc đó để gửi tin.'
        : 'Viewing another conversation — the assistant keeps running in the other one. Switch back to that one to send.');
    }
    // Đang chạy mà bấm lại đúng cuộc đang chạy: quay về theo dõi trực tiếp.
    if (this.busy && id === this.session.id) {
      this.viewing = null;
      return this.post({ type: 'init', state: this.view });
    }
    return this.swapSession(async () => {
      const p = await this.d.store.load(id);
      if (!p) return this.toast('error', this.lang === 'vi' ? 'Không mở được cuộc trò chuyện này.' : 'Could not open this conversation.');
      await this.saveNow();
      this.session = p.session;
      this.session.historyEdited = hasRedactions(this.session);
      this.session.approvals = []; // quyền "cho phép cả phiên" không theo hội thoại cũ sang lần mở này
      if (!this.d.providers.has(this.session.provider)) {
        const pick = this.pickDefaultProvider();
        this.session.provider = pick.provider;
        this.session.model = pick.model;
      }
      if (this.session.mode === 'bypass' && !this.d.config.allowBypass()) this.session.mode = 'default';
      this.scope.reset();
      this.pinnedTabId = undefined;
      this.presence.resetSteps(maxStepOf(p.transcript) + 1);
      this.seenArtifacts.clear();
      Object.keys(this.session.artifacts).forEach((k) => this.seenArtifacts.add(k));
      this.view = { ...this.baseView(), transcript: p.transcript, providers: this.view.providers, ...(await this.listings()), screen: 'chat', browser: this.browserState(await this.currentTabs()) };
      this.post({ type: 'init', state: this.view });
      await this.d.lastSession?.set(this.session.id);
    });
  }

  /** Xoá = chuyển vào Thùng rác (khôi phục được trong 30 ngày), không mất nội dung nào, kể cả tệp bối cảnh đã tải lên. */
  private async deleteSession(id: string): Promise<void> {
    const trashedMsg = this.lang === 'vi' ? 'Đã chuyển vào Thùng rác — khôi phục được trong 30 ngày.' : 'Moved to the Trash — you can restore it for 30 days.';
    if (id === this.session.id) {
      if (this.busy) return this.toast('info', this.lang === 'vi' ? 'Hãy dừng tác vụ đang chạy trước.' : 'Stop the running task first.');
      await this.saveNow(); // bản trong Thùng rác phải là bản mới nhất
      await this.d.store.moveToTrash(id);
      this.session = this.freshSession();
      this.scope.reset();
      this.pinnedTabId = undefined;
      this.presence.resetSteps();
      await this.d.lastSession?.set(undefined);
      this.view = { ...this.baseView(), providers: this.view.providers, ...(await this.listings()), screen: 'history', browser: this.browserState(await this.currentTabs()) };
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
    const ok = await this.d.store.restore(String(id ?? ''));
    this.patch(await this.listings());
    this.toast(ok ? 'info' : 'error', ok ? (this.lang === 'vi' ? `Đã khôi phục "${title}".` : `Restored "${title}".`) : this.lang === 'vi' ? 'Không khôi phục được (bản trong Thùng rác không còn).' : 'Could not restore (the copy in the Trash is gone).');
  }

  /**
   * Sao lưu ra tệp JSON (đầy đủ, khôi phục được): một cuộc (`id`) hoặc tất cả kèm Thùng rác. Lưu lại bản mới nhất trước khi đọc kho, để tệp gồm cả những gì vừa trao đổi.
   * Nội dung trang người dùng đã đăng nhập đã bị lược khỏi kho (xem storageRedact.ts) nên cũng không nằm trong tệp sao lưu.
   */
  private async exportBackup(id?: string): Promise<void> {
    await this.saveNow();
    const sessions = await this.d.store.exportSessions(id ? { ids: [id], includeTrash: true } : { includeTrash: true });
    if (sessions.length === 0) return this.toast('info', this.lang === 'vi' ? 'Chưa có cuộc trò chuyện nào để sao lưu.' : 'There are no conversations to back up yet.');
    const file = makeBackup(sessions, { version: this.d.version, platform: 'browser' });
    this.d.artifacts.download(backupFileName(id ? 'one' : 'all', sessions[0]?.session.title), 'application/json', JSON.stringify(file));
    this.toast('info', this.lang === 'vi' ? `Đã tạo tệp sao lưu (${sessions.length} cuộc trò chuyện) — xem thư mục Tải xuống.` : `Backup file created (${sessions.length} conversations) — check your Downloads folder.`);
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
    this.session.provider = provider;
    this.session.model = model;
    await this.d.config.setLastModel(provider, model);
    this.patch({ provider, model, context: this.contextInfo() });
  }

  async showScreen(screen: 'chat' | 'settings' | 'history'): Promise<void> {
    await this.sendInit(screen);
  }

  /**
   * Bật "Toàn quyền" (người dùng đã xác nhận trong hộp thoại): cho phép chế độ bỏ qua mọi xác nhận, chuyển phiên hiện tại sang đó, tuỳ chọn ghi nhớ làm mặc định
   * cho cuộc trò chuyện mới, và xin quyền truy cập mọi trang web (xin TRƯỚC các bước await khác để còn nằm trong cử chỉ bấm của người dùng).
   * Những chặn cứng không phụ thuộc câu hỏi vẫn còn: công cụ từ chối nhập vào ô mật khẩu/thẻ/OTP, kiểm tra địa chỉ nội bộ của fetch_url…
   */
  private async enableFullAccess(remember: boolean, siteAccess: boolean): Promise<void> {
    if (siteAccess && !(await this.d.api.hasSiteAccess())) await this.d.api.requestSiteAccess();
    await this.d.config.setBrowser('allowBypass', true);
    if (remember) await this.d.config.setBrowser('defaultMode', 'bypass');
    this.setMode('bypass');
    this.patch({ allowBypass: true, browser: this.browserState(await this.currentTabs(), await this.d.api.hasSiteAccess()) });
    this.toast('warn', this.lang === 'vi' ? 'Đã bật Toàn quyền: trợ lý sẽ không hỏi trước khi làm. Bấm "Tắt" ở thanh cảnh báo hoặc đổi chế độ để quay lại.' : 'Full access is on: the assistant will not ask before acting. Use "Turn off" in the warning bar or change the mode to go back.');
  }

  private setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) return;
    if (mode === 'bypass' && !this.d.config.allowBypass()) {
      this.toast('warn', this.lang === 'vi' ? 'Chế độ này đang tắt. Bật "Cho phép chế độ bỏ qua mọi xác nhận" trong Cài đặt nếu bạn hiểu rủi ro.' : 'This mode is disabled. Enable "Allow bypass mode" in Settings if you understand the risk.');
      return;
    }
    this.session.mode = mode;
    this.patch({ mode });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Khoá API, API tuỳ chỉnh, kết nối
  // ─────────────────────────────────────────────────────────────────────────

  private async saveApiKey(providerId: string, rawKey: string): Promise<void> {
    const key = String(rawKey ?? '').trim();
    if (!this.d.providers.has(providerId)) return;
    if (!key || /\s/.test(key)) return this.toast('error', this.lang === 'vi' ? 'API key không hợp lệ (đang trống hoặc có khoảng trắng).' : 'Invalid API key (empty or contains whitespace).');
    await this.d.secrets.set(providerId, key);
    this.d.logger.registerSecret(key);
    this.d.providers.registry.catalog.invalidate(providerId);
    await this.d.providers.refresh([providerId], true);
    this.patch({ providers: await this.providerSummaries() });
    this.toast('info', this.lang === 'vi' ? 'Đã lưu API key trong bộ nhớ của tiện ích (không mã hoá trên đĩa).' : 'API key saved in the extension storage (not encrypted on disk).');
  }

  /** Danh sách nhà cung cấp kèm trạng thái đăng nhập OAuth (nếu có). */
  private async providerSummaries(): Promise<import('../shared/protocol').ProviderSummary[]> {
    const list = await this.d.providers.summaries();
    return Promise.all(
      list.map(async (p) => {
        const s = await this.d.oauth.summary(p.id);
        if (s) return { ...p, oauth: s };
        // OpenRouter (thêm từ mẫu hoặc tự nhập địa chỉ): luôn cho phép đăng nhập một chạm, không cần cấu hình trước.
        let host = '';
        try {
          host = new URL(p.baseUrl).hostname;
        } catch {
          /* bỏ qua */
        }
        return host === 'openrouter.ai' ? { ...p, oauth: { flow: 'openrouter' as const, signedIn: false } } : p;
      }),
    );
  }

  /** Extension không có quyền gọi tới mọi máy chủ: với địa chỉ API tuỳ chỉnh phải xin quyền theo máy chủ đó (nếu không bị CORS chặn). */
  private async ensureApiOrigin(url: string): Promise<void> {
    try {
      if (!(await this.d.api.ensureOrigin(url))) {
        this.toast('warn', this.lang === 'vi' ? `Chưa cấp quyền truy cập ${hostOf(url)}: trình duyệt có thể chặn yêu cầu tới máy chủ này (CORS). Lưu lại và cấp quyền khi được hỏi.` : `Access to ${hostOf(url)} was not granted: the browser may block requests to it (CORS). Save again and allow it when asked.`);
      }
    } catch {
      /* môi trường không hỗ trợ: bỏ qua */
    }
  }

  private async oauthLogin(providerId: string): Promise<void> {
    if (!this.d.providers.has(providerId)) return;
    try {
      // OpenRouter chưa có cấu hình đăng nhập (người dùng tự thêm API trỏ tới openrouter.ai): tự gắn luồng một chạm.
      if (!(await this.d.oauth.summary(providerId))) {
        const base = (await this.d.providers.summaries()).find((p) => p.id === providerId)?.baseUrl ?? '';
        if (new URL(base).hostname === 'openrouter.ai') await this.d.oauth.register(providerId, { flow: 'openrouter' });
      }
      await this.d.oauth.login(providerId);
      this.d.providers.registry.catalog.invalidate(providerId);
      this.patch({ providers: await this.providerSummaries() });
      this.toast('info', this.lang === 'vi' ? 'Đăng nhập thành công.' : 'Signed in.');
      void this.d.providers
        .refresh([providerId], true)
        .then(async () => {
          if (!this.disposed) this.patch({ providers: await this.providerSummaries() });
        })
        .catch(() => undefined);
    } catch (err) {
      this.d.logger.log('warn', `Đăng nhập OAuth thất bại (${providerId}): ${err instanceof Error ? err.message : err}`);
      this.toast('error', err instanceof OAuthError ? err.message : this.lang === 'vi' ? 'Đăng nhập không thành công.' : 'Sign-in failed.');
      this.patch({ providers: await this.providerSummaries() });
    }
  }

  private async saveCustomProvider(input: import('../shared/protocol').CustomProviderInput): Promise<void> {
    // Kiểm tra cấu hình đăng nhập TRƯỚC khi thêm nhà cung cấp, để lỗi nhập liệu không để lại nhà cung cấp dở dang.
    if (input.oauth) {
      const bad = validateSpec(input.oauth);
      if (bad) return this.toast('error', bad);
    }
    const res = await this.d.config.addCustomProvider(input, new Set(this.d.providers.registry.ids()));
    if ('error' in res) return this.toast('error', res.error);
    this.d.providers.reconfigure();
    const key = (input.apiKey ?? '').trim();
    if (key && !/\s/.test(key)) {
      await this.d.secrets.set(res.id, key);
      this.d.logger.registerSecret(key);
    }
    if (input.oauth) await this.d.oauth.register(res.id, input.oauth);
    await this.ensureApiOrigin(input.baseUrl);
    void this.d.providers.refresh([res.id], true);
    this.patch({ providers: await this.providerSummaries() });
    this.toast('info', this.lang === 'vi' ? `Đã thêm API "${input.label}".` : `Added API "${input.label}".`);
    if (input.oauth && input.loginNow) await this.oauthLogin(res.id);
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
      case 'skills': {
        const list = this.d.skills.list().map((s) => `- **${s.name}**${this.session.loadedSkills.includes(s.name) ? ' ✓' : ''}: ${s.description}`);
        info(`${vi ? 'Kỹ năng có sẵn' : 'Available skills'}:\n${list.join('\n')}`);
        return true;
      }
      case 'help':
        info(
          vi
            ? 'Gõ **@** để đính kèm nội dung một tab, **/** để xem lệnh. Enter gửi, Shift+Enter xuống dòng, Esc dừng. Chế độ quyền, model và mức suy luận chọn ở dưới ô nhập. Trợ lý chỉ thấy tab bạn đang xem; muốn nó đọc mọi trang hoặc thao tác thay bạn, hãy bật quyền trong Cài đặt.'
            : 'Type **@** to attach a tab, **/** for commands. Enter sends, Shift+Enter adds a line, Esc stops. Pick permission mode, model and reasoning level below the input. The assistant only sees the tab you are viewing; enable site access in Settings to let it read any page or act for you.',
        );
        return true;
      case 'mode': {
        const m = MODE_ALIASES[fold(args)];
        if (!m) {
          info(vi ? 'Chế độ: `default` (hỏi trước), `acceptEdits` (tự nhận thao tác thường), `plan` (lập kế hoạch), `bypass`.' : 'Modes: `default`, `acceptEdits`, `plan`, `bypass`.');
          return true;
        }
        this.setMode(m);
        return true;
      }
      case 'thinking': {
        const l = THINK_ALIASES[fold(args)];
        if (!l) {
          info(vi ? 'Mức suy luận: `off`, `low`, `medium`, `high`, `max`.' : 'Reasoning levels: `off`, `low`, `medium`, `high`, `max`.');
          return true;
        }
        this.session.thinkingLevel = l;
        this.patch({ thinkingLevel: l });
        return true;
      }
      case 'model': {
        const q = fold(args);
        if (!q) {
          this.patch({ screen: 'chat' });
          info(vi ? 'Chọn model ở dưới ô nhập, hoặc gõ /model <tên>.' : 'Pick a model below the input, or type /model <name>.');
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
      default:
        return false;
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
      if (msgs[i].role === 'user' && !msgs[i].synthetic && msgs[i].content.some((b) => b.type === 'text' || b.type === 'image')) {
        idx = i;
        break;
      }
    }
    let ti = -1;
    for (let i = this.view.transcript.length - 1; i >= 0; i--) if (this.view.transcript[i].kind === 'user') { ti = i; break; }
    if (idx < 0 || ti < 0) return;
    const userItem = this.view.transcript[ti] as Extract<TItem, { kind: 'user' }>;
    const content = msgs[idx].content;
    // Cắt đuôi chỉ để lại một TIỀN TỐ nguyên vẹn của hội thoại cũ nên khối suy luận còn lại vẫn hợp lệ — không đặt `historyEdited`.
    this.session.messages = msgs.slice(0, idx);
    this.patch({ transcript: this.view.transcript.slice(0, ti) });
    if (editOnly) {
      // Tệp tải lên: bản hiển thị không còn phần chữ → lấy lại từ bản lưu của tin cuối (nếu còn); phiên mới khôi phục từ kho thì phải đính kèm lại.
      const stash = this.docStash?.id === userItem.id ? this.docStash.docs : [];
      this.post({ type: 'draft', text: userItem.text, attachments: [...userItem.attachments.filter((a) => a.kind !== 'image' && a.kind !== 'doc'), ...stash] });
      if (stash.length === 0 && userItem.attachments.some((a) => a.kind === 'doc')) this.toast('info', this.lang === 'vi' ? 'Tệp tải lên không được giữ lại — hãy đính kèm lại.' : 'Uploaded files aren’t kept — please attach them again.');
      return;
    }
    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { anchor, trust } = await this.resolveAnchor();
      this.scope.beginRun(anchor, { trust });
      // Tin nhắn cũ mang `<browser_context>` của tab lúc đó; chạy lại bây giờ thì phải nói đúng tab đang xem.
      const fresh = await browserContextBlock(this.d.api, this.d.api.name, this.d.config.browser().attachTabContext, anchor);
      this.emit({ t: 'user', id: newId('u'), text: userItem.text, attachments: userItem.attachments, ts: Date.now() });
      await this.execute(withFreshContext(content, fresh), abort);
    } catch (err) {
      this.emit({ t: 'notice', level: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Xuất, hỏi nhanh, huỷ
  // ─────────────────────────────────────────────────────────────────────────

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
    const safe = this.session.title.normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'cuoc-tro-chuyen';
    this.d.artifacts.download(`${safe}.md`, 'text/markdown', lines.join('\n'));
    return Promise.resolve();
  }

  /** Chèn văn bản/đính kèm vào ô nhập (menu chuột phải) rồi focus. Khung chat vừa mở mà giao diện chưa dựng xong thì giữ lại, giao khi nó báo `ready`. */
  insert(text?: string, attachments?: AttachmentInfo[]): void {
    if (!this.uiReady) {
      this.queuedInserts.push({ text, attachments });
      return;
    }
    this.post({ type: 'insert', text, attachments });
    this.post({ type: 'focus' });
  }

  /** Gửi thẳng một câu hỏi (menu chuột phải: "Giải thích đoạn đã chọn"…). */
  async ask(text: string, attachments: AttachmentInfo[] = []): Promise<void> {
    await this.send(text, attachments);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offTabs?.();
    this.stop();
    this.presence.dispose();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.tabTimer) clearTimeout(this.tabTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Trang sắp bị huỷ nên các ghi bất đồng bộ có thể không kịp hoàn tất: ghi "phiên gần nhất" TRƯỚC (một lần ghi nhanh), rồi lưu hội thoại với các công cụ đang
    // chạy / chờ duyệt đã được chốt là "đã huỷ" (lệnh dừng chỉ cập nhật chúng sau đó, quá muộn cho lần lưu này).
    if (this.session.messages.length) void this.d.lastSession?.set(this.session.id);
    this.session.todos = this.view.todos;
    void this.d.store.save(redactForStorage(this.session), redactTranscript(settleForExit(this.view.transcript))).catch((err) => this.d.logger.log('warn', `Không lưu được hội thoại khi đóng: ${err instanceof Error ? err.message : err}`));
  }
}
