/**
 * LÕI CHẠY của Locaith CLI (không giao diện): dựng `AgentEngine` mỗi lượt đúng công thức của extension (`ChatController.createEngine`),
 * giữ phiên, quyền, hàng đợi tin, nén ngữ cảnh, lệnh gạch chéo, và cắm các mô-đun tính năng (`FeatureModule`).
 * Giao diện và chế độ in một lần chỉ nói chuyện với `CliRuntime` (contract.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentEngine, repairOrphanToolCalls, type QueuedMessage, type QueueState } from '../../core/engine/engine';
import { loadProjectInstructions } from '../../core/engine/instructions';
import { coreRunExtensions } from '../../core/engine/extensions';
import { permissionRulesExtension, resolvePathPlain } from '../../core/engine/extensions/permissionRules';
import { formatMemoryBlock, MEMORY_DIR, MEMORY_INDEX, type MemoryScope, type MemorySnapshot } from '../../core/engine/memory';
import { resumeInstruction } from '../../core/engine/resume';
import type { RunExtension } from '../../core/engine/seams';
import { t as engineT } from '../../core/engine/strings';
import { Summarizer } from '../../core/engine/summarizer';
import { estimateBlockTokens } from '../../core/engine/tokens';
import { newSession, type PermissionDecision, type SessionState, type ToolDef } from '../../core/engine/types';
import { resolveUserPathReal } from '../../core/fsutil/paths';
import { AgentRegistry } from '../../core/agents/definitions';
import { Semaphore } from '../../core/agents/semaphore';
import type { AgentServices } from '../../core/agents/runner';
import { builtinOutputStyles } from '../../core/commands/outputStyles';
import { LOCAITH_GATEWAY_URL, LOCAITH_PROVIDER_ID } from '../../core/providers/locaithGateway';
import { builtinSkills } from '../../core/skills/builtin';
import { SkillRegistry } from '../../core/skills/registry';
import { createToolRegistry } from '../../core/tools';
import type { ContentBlock } from '../../core/types';
import { SlashRegistry, type SlashCommandDef } from '../../host/slashRegistry';
import { buildUserContent } from '../../host/userContent';
import { buildRules, type Rule } from '../../shared/permissionRules';
import {
  PERMISSION_MODES,
  THINKING_LEVELS,
  type AttachmentInfo,
  type PermissionMode,
  type PermissionRequest,
  type SessionSummary,
  type SlashCommandInfo,
  type ThinkingLevel,
  type TItem,
  type UiEvent,
} from '../../shared/protocol';
import { docCharBudget } from '../../shared/docKinds';
import { buildMeter } from '../../shared/sessionMeter';
import { applyEvent, newId } from '../../shared/transcript';
import { reconcileTranscript } from '../../shared/transcriptRebuild';
import { registerStrings, t as cliT } from '../i18n';
import { NotLoggedInError, readLocaithKey } from './auth';
import { completeSlash, FileIndexer } from './complete';
import { buildEngineSettings, resolveLang, SettingsStore } from './config';
import type {
  AskAnswer,
  AskInput,
  AskRequest,
  Attachment,
  CliRuntime,
  Completion,
  FeatureContext,
  FeatureModule,
  FeatureSlashDef,
  RuntimeEvent,
  RuntimeOptions,
  RunResultInfo,
  RuntimeStatus,
  SettingsApi,
  SlashRunContext,
} from './contract';
import { defaultFeatures } from './features';
import { CliToolHost } from './host';
import { imageDimensions, MAX_IMAGE_EDGE } from './images';
import { AccountInfoCache, GitBranch } from './info';
import { CliProviders } from './providers';
import { registerBuiltinSlash } from './slash';
import { SessionRepo, type LoadedSession } from './sessions';
import { RUNTIME_STRINGS } from './strings';
import { isDirTrusted } from './trust';
import { RuntimeLogger, type LogLevel } from './util';

registerStrings('runtime', RUNTIME_STRINGS);

const MAX_QUEUED = 20;
const SAVE_DEBOUNCE_MS = 2500;
const STATUS_MIN_INTERVAL_MS = 100;
const FEATURE_ATTACH_TIMEOUT_MS = 8000;
const DISPOSE_STEP_TIMEOUT_MS = 3000;

interface QueuedTurn extends QueuedMessage {
  readFiles: Record<string, string>;
  original: AttachmentInfo[];
}

/** Ngữ cảnh một lệnh gạch chéo: hợp của SlashContext (registry extension) và SlashRunContext (contract). */
export interface FullSlashContext extends SlashRunContext {
  info(text: string): void;
  warn(text: string): void;
}

export class Runtime implements CliRuntime {
  // ── cấu hình/phụ thuộc ──
  readonly opts: RuntimeOptions;
  readonly home: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  lang: 'vi' | 'en' = 'vi';
  readonly logger: RuntimeLogger;
  readonly store: SettingsStore;
  private trusted = false;
  providers!: CliProviders;
  host!: CliToolHost;
  readonly skills = new SkillRegistry(builtinSkills());
  readonly agents = new AgentRegistry();
  readonly slashReg = new SlashRegistry();
  repo!: SessionRepo;
  readonly files: FileIndexer;
  private git!: GitBranch;
  account!: AccountInfoCache;

  // ── phiên ──
  session!: SessionState;
  transcript: TItem[] = [];
  private explicitMode = false;

  // ── lượt chạy ──
  private running = false;
  private agentBusy = false;
  private pendingTurns = 0;
  private turnLock: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private shellAbort: AbortController | null = null;
  private lastStop = 'end_turn';
  private timedOut = false;
  private lastRun: { stopReason: string; turns: number; startedAt: number; endedAt: number } = { stopReason: 'none', turns: 0, startedAt: 0, endedAt: 0 };
  private queue: QueuedTurn[] = [];
  private pendingNotes: string[] = [];
  private readonly permWaiters = new Map<string, (d: PermissionDecision) => void>();
  private readonly askWaiters = new Map<string, (v: AskAnswer) => void>();
  private readonly inflight = new Set<Promise<unknown>>();
  private idleResolvers: Array<() => void> = [];
  private modelQueue: QueueState | null = null;
  /** Token mới nhất mỗi lệnh gọi agent con báo (callId → tokens). */
  private readonly agentTokens = new Map<string, number>();
  private disposed = false;
  private disposing: Promise<void> | null = null;
  private keepDispatcher = false;
  private agentServices!: Omit<AgentServices, 'registry'>;
  private readonly limiter = new Semaphore(8);
  private readonly writeLock = new Semaphore(1);

  // ── sự kiện ──
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private early: RuntimeEvent[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── tính năng ──
  private readonly runExts: Array<{ ext: RunExtension; subAgents: boolean; last: boolean }> = [];
  private readonly toolContribs: Array<(add: (tool: unknown) => void) => void> = [];
  private readonly statusContribs: Array<(s: RuntimeStatus) => void> = [];
  private readonly promptContribs: Array<() => string | null> = [];
  private readonly disposers: Array<{ name: string; fn: () => void | Promise<void> }> = [];
  private readonly sessionChangeFns: Array<(s: SessionState) => void> = [];
  private readonly beforeSendFns: Array<NonNullable<Parameters<NonNullable<FeatureContext['beforeSend']>>[0]>> = [];
  private readonly beforeCompactFns: Array<NonNullable<Parameters<NonNullable<FeatureContext['onBeforeCompact']>>[0]>> = [];
  private alwaysAllowFn: ((rule: string, scope: 'user' | 'local') => string | null) | null = null;
  private readonly slashAborts = new Set<AbortController>();
  private readonly compactedFns: Array<NonNullable<Parameters<NonNullable<FeatureContext['onCompacted']>>[0]>> = [];
  readonly featureErrors: Array<{ name: string; error: string }> = [];
  private startupNotices: string[] = [];

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
    this.cwd = path.resolve(opts.cwd);
    this.home = opts.home ? path.resolve(opts.home) : os.homedir();
    this.env = opts.env ?? process.env;
    this.logger = new RuntimeLogger(path.join(this.home, '.locaith', 'logs', 'cli.log'), !!opts.verbose || this.env.LOCAITH_DEBUG === '1');
    this.files = new FileIndexer(this.cwd);
    const cli: Record<string, unknown> = {};
    if (opts.allowedTools?.length) {
      cli['permissions.allow'] = opts.allowedTools;
      cli['cli.allowedTools'] = opts.allowedTools;
    }
    if (opts.disallowedTools?.length) {
      cli['permissions.deny'] = opts.disallowedTools;
      cli['cli.disallowedTools'] = opts.disallowedTools;
    }
    if (opts.mcpConfig?.length) cli['cli.mcpConfig'] = opts.mcpConfig;
    this.trusted = typeof opts.trusted === 'boolean' ? opts.trusted : isDirTrusted(this.home, this.cwd);
    this.store = new SettingsStore({ home: this.home, cwd: this.cwd, env: this.env, trusted: () => this.trusted, cli });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Khởi tạo
  // ───────────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const opts = this.opts;
    this.lang = resolveLang(opts.lang, this.store, this.env);
    this.logger.log('info', `Khởi tạo runtime v${opts.version} cwd=${this.cwd} trusted=${this.trusted} interactive=${opts.interactive}`);
    this.logger.registerSecret(readLocaithKey(this.home, this.env));

    this.providers = new CliProviders({
      home: this.home,
      env: this.env,
      version: opts.version,
      settings: this.store,
      baseUrl: opts.baseUrl,
      override: opts.providerOverride,
      overrideModel: opts.model,
      fetchImpl: opts.fetchImpl,
      log: (l, m) => this.logger.log(l, m),
      lang: () => this.lang,
    });

    // Chọn nhà cung cấp/model. Cờ --model là lựa chọn rõ ràng (sai → lỗi); cài đặt `model`/`defaultModel` chỉ là mặc định (sai → rơi về mặc định).
    let target: { provider: string; model: string };
    if (opts.model?.trim() || this.providers.overridden) target = this.providers.pickInitial(opts.model);
    else {
      const saved = (this.store.get<string>('model', '') || this.store.get<string>('defaultModel', '')).trim();
      try {
        target = this.providers.pickInitial(saved || undefined);
      } catch (err) {
        if (!saved) throw err;
        this.logger.log('warn', `Mô hình đã lưu «${saved}» không dùng được (${err instanceof Error ? err.message : err}) — dùng mặc định.`);
        target = this.providers.pickInitial(undefined);
      }
    }

    this.host = new CliToolHost({
      cwd: this.cwd,
      addDirs: (opts.addDirs ?? []).map((d) => path.resolve(this.cwd, d)),
      home: this.home,
      settings: this.store,
      env: this.env,
      fetchImpl: opts.fetchImpl,
      decide: (req, signal) => this.decidePermission(req, signal),
      log: (l, m) => this.logger.log(l, m),
    });
    this.host.addReadRoot(path.join(this.home, '.locaith', 'memory'));

    this.repo = new SessionRepo(this.home, this.cwd, opts.version, (l, m) => this.logger.log(l, m));
    this.git = new GitBranch(this.cwd, () => this.scheduleStatus());
    this.account = new AccountInfoCache(this.home, {
      key: () => this.providers.token(),
      baseUrl: () => this.store.get<Record<string, string>>('baseUrls', {})[LOCAITH_PROVIDER_ID] || opts.baseUrl || LOCAITH_GATEWAY_URL,
      version: opts.version,
      fetchImpl: opts.fetchImpl,
      onChange: () => this.scheduleStatus(),
      log: (l, m) => this.logger.log(l, m),
    });

    // Chế độ quyền ban đầu.
    const allowBypass = this.bypassAllowed();
    let mode: PermissionMode = 'default';
    if (opts.permissionMode && PERMISSION_MODES.includes(opts.permissionMode)) {
      mode = opts.permissionMode;
      this.explicitMode = true;
    } else {
      const saved = this.store.get<string>('agent.permissionMode', 'default');
      if (PERMISSION_MODES.includes(saved as PermissionMode)) mode = saved as PermissionMode;
      if (mode === 'bypass' && !allowBypass) mode = 'default';
      if (this.store.isUserSet('agent.permissionMode')) this.explicitMode = true;
    }
    if (!this.trusted && !this.explicitMode && mode !== 'plan') {
      mode = 'plan';
      this.startupNotices.push(this.tr('untrustedPlan'));
    }
    const thinkingRaw = opts.thinking ?? this.store.get<string>('agent.thinkingLevel', 'medium');
    const thinking: ThinkingLevel = THINKING_LEVELS.includes(thinkingRaw as ThinkingLevel) ? (thinkingRaw as ThinkingLevel) : 'medium';

    this.session = this.freshSession(target.provider, target.model, mode, thinking);
    this.buildAgentServices();
    registerBuiltinSlash(this);

    if (opts.resume) {
      try {
        await this.loadSessionInto(opts.resume, 'resume', true);
        if (opts.model?.trim() || this.providers.overridden) {
          this.session.provider = target.provider;
          this.session.model = target.model;
        }
        if (opts.permissionMode) this.session.mode = mode;
        else if (!this.trusted && !this.explicitMode) this.session.mode = 'plan';
        if (opts.thinking) this.session.thinkingLevel = thinking;
      } catch (err) {
        if (opts.resume !== true) throw err;
        this.startupNotices.push(this.tr('noSessionToContinue'));
      }
    }

    await this.attachFeatures();
    this.git.refresh(true);
    // Thông tin tài khoản: chỉ đọc bộ đệm đã có; làm mới ở nền, không chặn khởi động.
    if (!this.providers.overridden) void this.account.refresh().catch(() => undefined);
    for (const n of this.startupNotices) this.emit({ t: 'toast', level: 'warn', text: n });
  }

  tr(key: string, vars?: Record<string, string | number>): string {
    return cliT(`runtime.${key}`, vars, this.lang);
  }

  private freshSession(provider: string, model: string, mode: PermissionMode, thinking: ThinkingLevel): SessionState {
    return newSession({ id: newId('cli'), provider, model, mode, thinkingLevel: thinking, title: engineT(this.lang, 'titleDefault') });
  }

  bypassAllowed(): boolean {
    return this.opts.permissionMode === 'bypass' || this.store.get<boolean>('agent.allowBypassPermissions', false) === true;
  }

  get interactive(): boolean {
    return this.opts.interactive;
  }

  get isTrusted(): boolean {
    return this.trusted;
  }

  get busy(): boolean {
    return this.agentBusy || this.running;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sự kiện
  // ───────────────────────────────────────────────────────────────────────────

  get settings(): SettingsApi {
    return this.store;
  }

  on(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.early.length) {
      const pending = this.early.splice(0);
      queueMicrotask(() => {
        for (const e of pending) {
          try {
            listener(e);
          } catch (err) {
            this.logger.log('warn', `Người nghe sự kiện ném lỗi: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    }
    return () => this.listeners.delete(listener);
  }

  emit(e: RuntimeEvent): void {
    if (this.listeners.size === 0) {
      // Chưa ai nghe (đang khởi tạo): giữ lại thông báo/đầu ra để giao cho người nghe đầu tiên.
      if ((e.t === 'toast' || e.t === 'output') && this.early.length < 100) this.early.push(e);
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.logger.log('warn', `Người nghe sự kiện ném lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  output(text: string, kind: 'markdown' | 'plain' | 'error' = 'markdown', title?: string): void {
    this.emit({ t: 'output', text, kind, ...(title ? { title } : {}) });
  }

  toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit({ t: 'toast', level, text });
  }

  notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.onUiEvent({ t: 'notice', level, text });
  }

  /** Mọi sự kiện UI (từ engine hoặc từ runtime) đi qua đây: cập nhật transcript + trạng thái rồi phát cho giao diện. */
  onUiEvent(ev: UiEvent): void {
    try {
      this.transcript = applyEvent(this.transcript, ev);
    } catch (err) {
      this.logger.log('warn', `Không áp được sự kiện ${ev.t} vào transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    switch (ev.t) {
      case 'agent_progress':
        this.agentTokens.set(ev.callId, ev.tokens);
        break;
      case 'todos':
      case 'tasks':
        this.session.todos = ev.todos;
        break;
      case 'mode':
        this.session.mode = ev.mode;
        break;
      case 'options':
        this.session.options = ev.options.length ? ev.options : undefined;
        break;
      case 'tool_end':
      case 'assistant_end':
      case 'user':
        this.scheduleSave();
        break;
      default:
        break;
    }
    this.emit({ t: 'ui', ev });
    this.scheduleStatus();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Trạng thái
  // ───────────────────────────────────────────────────────────────────────────

  status(): RuntimeStatus {
    const s = this.session;
    const window = this.providers.contextWindow(s.provider, s.model);
    let tokens = s.lastContextTokens || 0;
    if (!tokens) {
      for (const m of s.messages) for (const b of m.content) tokens += estimateBlockTokens(b);
    }
    const meter = buildMeter(s, this.transcript, this.providers.pricing(s.provider, s.model));
    const acct = this.account.current();
    const notices: string[] = [];
    if (!this.trusted) notices.push(this.tr('noticeUntrusted'));
    if (acct.loggedIn && acct.consent === false && s.provider === LOCAITH_PROVIDER_ID) notices.push(this.tr('noticeConsent'));
    if (this.modelQueue) notices.push(this.tr('noticeQueue', { pos: this.modelQueue.position, limit: this.modelQueue.limit ?? '?' }));
    if (this.featureErrors.length) notices.push(this.tr('noticeFeatureErrors', { n: this.featureErrors.length }));
    const st: RuntimeStatus = {
      version: this.opts.version,
      cwd: this.cwd,
      ...(this.git.current() ? { gitBranch: this.git.current() } : {}),
      provider: s.provider,
      model: s.model,
      mode: s.mode,
      thinking: s.thinkingLevel,
      ...(s.provider === LOCAITH_PROVIDER_ID || acct.loggedIn ? { account: { loggedIn: acct.loggedIn, ...(acct.email ? { email: acct.email } : {}), ...(acct.plan ? { plan: acct.plan } : {}) } } : {}),
      context: { tokens, window, percent: window > 0 ? Math.min(999, Math.round((tokens / window) * 100)) : 0 },
      usage: { input: meter.inputTokens, output: meter.outputTokens },
      ...(this.subAgentTotal() > 0 ? { subAgentTokens: this.subAgentTotal() } : {}),
      ...(meter.costUsd !== undefined ? { costUsd: meter.costUsd } : {}),
      running: this.running,
      queued: this.queue.map((q) => q.text),
      sessionId: s.id,
      title: s.title,
      todos: s.todos,
      bgTasks: { running: 0, total: 0 },
      notices,
    };
    for (const fn of this.statusContribs) {
      try {
        fn(st);
      } catch (err) {
        this.logger.log('warn', `Đóng góp trạng thái lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return st;
  }

  private subAgentTotal(): number {
    let n = 0;
    for (const v of this.agentTokens.values()) n += v;
    return n;
  }

  scheduleStatus(): void {
    if (this.disposed || this.statusTimer) return;
    const wait = Math.max(0, STATUS_MIN_INTERVAL_MS - (Date.now() - this.lastStatusAt));
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.flushStatus();
    }, wait);
    this.statusTimer.unref?.();
  }

  flushStatus(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.disposed) return;
    this.lastStatusAt = Date.now();
    try {
      this.emit({ t: 'status', status: this.status() });
    } catch (err) {
      this.logger.log('warn', `Không dựng được trạng thái: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Nhận tin người dùng
  // ───────────────────────────────────────────────────────────────────────────

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => {
      this.inflight.delete(p);
      this.notifyIdle();
    };
    p.then(done, done);
    return p;
  }

  private isIdle(): boolean {
    return !this.busy && this.inflight.size === 0 && this.queue.length === 0;
  }

  private notifyIdle(): void {
    if (!this.idleResolvers.length || !this.isIdle()) return;
    const rs = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of rs) r();
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  async submit(text: string, o: { attachments?: Attachment[] } = {}): Promise<void> {
    if (this.disposed) return;
    const trimmed = String(text ?? '').trim();
    const atts = o.attachments ?? [];
    if (!trimmed && atts.length === 0) return;

    if (trimmed.startsWith('!') && atts.length === 0) {
      const cmd = trimmed.slice(1).trim();
      if (!cmd) {
        this.toast('warn', this.tr('shellEmpty'));
        return;
      }
      await this.track(this.runShell(cmd));
      return;
    }

    if (trimmed.startsWith('/') && atts.length === 0) {
      const m = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed);
      const name = (m?.[1] ?? '').toLowerCase();
      const args = (m?.[2] ?? '').trim();
      if (!name) {
        this.output(this.helpText(), 'markdown');
        return;
      }
      if (this.slashReg.has(name)) {
        await this.runSlash(name, args);
        return;
      }
      // `/usr/bin/x`, `/tmp/a.txt`: trông như đường dẫn → là tin thường. Còn lại là gõ nhầm lệnh.
      if (!/[\\/.]/.test(name)) {
        this.output(this.tr('unknownCommand', { name }), 'error');
        return;
      }
    }

    await this.sendMessage(trimmed, atts);
  }

  private async sendMessage(text: string, atts: Attachment[]): Promise<void> {
    const infos = this.attachmentInfos(text, atts);
    if (this.busy) return this.enqueue(text, infos);
    // Cờ bận đặt ĐỒNG BỘ trong runAgentTurn: tin gửi liền sau đó thấy bận và xếp hàng thay vì chạy song song.
    void this.track(this.runAgentTurn(() => this.sendUnlocked(text, infos)));
  }

  /** Ảnh đính kèm + các `@đường-dẫn` có thật trong chữ → AttachmentInfo cho buildUserContent. */
  private attachmentInfos(text: string, atts: Attachment[]): AttachmentInfo[] {
    const out: AttachmentInfo[] = [];
    for (const a of atts) {
      if (a.kind !== 'image' || !a.data) continue;
      const dim = imageDimensions(a.data);
      if (dim && Math.max(dim.width, dim.height) > MAX_IMAGE_EDGE) {
        this.notice('warn', this.tr('imageTooLarge', { name: a.name || 'image', w: dim.width, h: dim.height, max: MAX_IMAGE_EDGE }));
        continue;
      }
      out.push({ kind: 'image', label: a.name || 'image', mediaType: a.mediaType, data: a.data });
    }
    const seen = new Set<string>();
    const re = /(^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let p = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (!p) continue;
      // Bỏ dấu câu cuối câu và hậu tố `#L10-20` (resolveLineMentions xử lý riêng).
      const hash = p.indexOf('#');
      if (hash > 0) p = p.slice(0, hash);
      p = p.replace(/[.,;:!?)\]}>]+$/, '');
      if (!p || /^(problems|terminal|git|web)$/i.test(p) || seen.has(p)) continue;
      const abs = path.resolve(this.cwd, p);
      let isDir = false;
      try {
        const st = fs.statSync(abs);
        isDir = st.isDirectory();
        if (!st.isFile() && !isDir) continue;
      } catch {
        continue; // không phải đường dẫn thật (email, @tên…) → để nguyên trong chữ
      }
      seen.add(p);
      out.push({ kind: isDir ? 'folder' : 'file', label: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p, path: p.replace(/\\/g, '/') });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Hàng đợi tin nhắn
  // ───────────────────────────────────────────────────────────────────────────

  private async enqueue(text: string, atts: AttachmentInfo[]): Promise<void> {
    if (this.queue.length >= MAX_QUEUED) {
      this.toast('warn', this.tr('queueFull', { n: MAX_QUEUED }));
      this.emit({ t: 'action', action: 'insert', payload: text });
      return;
    }
    const scratch = { readFiles: {} as Record<string, string> };
    let built: Awaited<ReturnType<typeof buildUserContent>>;
    try {
      built = await buildUserContent({
        text,
        attachments: atts,
        host: this.host,
        session: scratch,
        editor: null,
        docBudget: docCharBudget(this.providers.contextWindow(this.session.provider, this.session.model)),
      });
    } catch (err) {
      this.toast('error', err instanceof Error ? err.message : String(err));
      this.emit({ t: 'action', action: 'insert', payload: text });
      return;
    }
    for (const w of built.warnings) this.notice('warn', w);
    this.queue.push({ id: newId('q'), text, display: built.display, content: built.content, ts: Date.now(), readFiles: scratch.readFiles, original: atts });
    this.scheduleStatus();
    // Lượt vừa kết thúc trong lúc đọc tệp: không còn ai giao hàng đợi → tự giao ngay.
    if (!this.busy) {
      void this.track(
        this.runAgentTurn(async () => {
          this.lastStop = 'end_turn';
        }),
      );
    }
  }

  /** Engine lấy các tin đang chờ ở ranh giới vòng lặp (ngay sau lượt công cụ, hoặc khi model trả lời xong). */
  private takeForEngine(): QueuedMessage[] {
    if (this.queue.length === 0) return [];
    const items = this.queue.splice(0);
    for (const q of items) Object.assign(this.session.readFiles, q.readFiles);
    this.scheduleStatus();
    return items.map(({ id, text, display, content, ts }) => ({ id, text, display, content, ts }));
  }

  /** Trả các tin chưa giao về ô nhập (Dừng, lỗi) để người dùng sửa hoặc gửi lại; không tự gửi. */
  private restoreQueue(): void {
    const items = this.queue.splice(0);
    if (items.length === 0 || this.disposed) return;
    const text = items.map((q) => q.text).filter(Boolean).join('\n\n');
    this.scheduleStatus();
    this.toast('info', this.tr('queueRestored', { n: items.length }));
    this.emit({ t: 'action', action: 'insert', payload: text });
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      if (this.disposed) break;
      if (this.queue.length === 0) break;
      if (this.lastStop === 'aborted' || this.lastStop === 'error') break;
      const items = this.queue.splice(0);
      this.scheduleStatus();
      this.lastStop = 'error';
      await this.runQueued(items);
    }
    if (this.queue.length > 0) this.restoreQueue();
  }

  private async runQueued(items: QueuedTurn[]): Promise<void> {
    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      for (const q of items) {
        Object.assign(this.session.readFiles, q.readFiles);
        this.onUiEvent({ t: 'user', id: q.id, text: q.text, attachments: q.display, ts: Date.now() });
      }
      await this.execute(
        items.flatMap((q) => q.content),
        abort,
      );
    } catch (err) {
      this.lastStop = 'error';
      this.reportRunError(err);
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Một lượt chạy
  // ───────────────────────────────────────────────────────────────────────────

  /** Chạy MỘT lượt của agent rồi giao nốt hàng đợi. Không bao giờ hai lượt cùng chạy trên một phiên. */
  async runAgentTurn(fn: () => Promise<void>): Promise<void> {
    this.pendingTurns++;
    this.agentBusy = true;
    const previous = this.turnLock;
    let release!: () => void;
    this.turnLock = new Promise<void>((resolve) => (release = resolve));
    try {
      await previous;
      this.lastStop = 'error';
      this.lastRun = { stopReason: 'error', turns: 0, startedAt: Date.now(), endedAt: 0 };
      await fn();
      await this.drainQueue();
    } catch (err) {
      this.lastStop = 'error';
      this.reportRunError(err);
    } finally {
      release();
      if (--this.pendingTurns === 0) {
        this.agentBusy = false;
        if (this.queue.length > 0) this.restoreQueue();
      }
      this.notifyIdle();
    }
  }

  private reportRunError(err: unknown): void {
    this.logger.log('error', `Lỗi khi chạy agent: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (err instanceof NotLoggedInError) {
      this.notice('error', err.message);
      return;
    }
    this.notice('error', engineT(this.lang, 'providerError', { provider: this.session.provider, detail: err instanceof Error ? err.message : String(err) }));
  }

  /** Chạy một lượt với nội dung văn bản (không qua phân loại lệnh gạch chéo). `model` chỉ đổi cho riêng lượt này. */
  async runPromptTurn(text: string, o: { model?: string } = {}): Promise<void> {
    if (this.busy) {
      await this.enqueue(text, []);
      return;
    }
    await this.track(
      this.runAgentTurn(async () => {
        const prev = { provider: this.session.provider, model: this.session.model };
        if (o.model) {
          try {
            const t = this.providers.resolveSpec(o.model);
            this.session.provider = t.provider;
            this.session.model = t.model;
          } catch (err) {
            this.notice('warn', this.tr('turnModelFallback', { model: o.model, detail: err instanceof Error ? err.message : String(err) }));
          }
        }
        try {
          await this.sendUnlocked(text, []);
        } finally {
          this.session.provider = prev.provider;
          this.session.model = prev.model;
        }
      }),
    );
  }

  private async sendUnlocked(text: string, attachments: AttachmentInfo[]): Promise<void> {
    const lang = this.lang;
    // "Tiếp tục" trần trụi sau khi Dừng: làm tiếp ĐÚNG chỗ đã dừng, không phải yêu cầu mới (xem core/engine/resume.ts).
    const resumed = resumeInstruction(text, this.session.todos, lang);
    const providerId = this.session.provider;
    if (!this.providers.service.has(providerId)) {
      this.notice('error', this.tr('providerGone', { provider: providerId }));
      return;
    }
    if (!this.providers.hasKey(providerId)) {
      this.notice('error', providerId === LOCAITH_PROVIDER_ID ? new NotLoggedInError(lang).message : engineT(lang, 'noKey', { provider: this.providers.label(providerId) }));
      this.emit({ t: 'action', action: 'insert', payload: text });
      return;
    }

    this.setRunning(true);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const gate = await this.runBeforeSend(text, abort.signal);
      if (gate.blocked) {
        this.notice('warn', engineT(lang, 'hookPromptBlocked', { reason: gate.reason ?? '' }));
        this.emit({ t: 'action', action: 'insert', payload: text });
        return;
      }
      const built = await buildUserContent({
        text,
        attachments,
        host: this.host,
        session: this.session,
        editor: null,
        docBudget: docCharBudget(this.providers.contextWindow(providerId, this.session.model)),
      });
      for (const w of built.warnings) this.notice('warn', w);
      // Ghi chú từ `!lệnh` đi kèm tin kế tiếp (không chèn tin riêng để giữ vai trò xen kẽ).
      if (this.pendingNotes.length) {
        const idx = built.content.findIndex((b) => b.type === 'text');
        const notes = this.pendingNotes.splice(0).join('\n\n');
        if (idx >= 0) {
          const b = built.content[idx] as Extract<ContentBlock, { type: 'text' }>;
          built.content[idx] = { ...b, text: `${notes}\n\n${b.text}` };
        } else built.content.push({ type: 'text', text: notes });
      }
      if (resumed) built.content.push({ type: 'text', text: resumed });

      if (this.session.title === engineT('vi', 'titleDefault') || this.session.title === engineT('en', 'titleDefault')) {
        this.session.title = (text || built.display[0]?.label || '').replace(/\s+/g, ' ').slice(0, 60) || this.session.title;
      }
      this.onUiEvent({ t: 'user', id: newId('u'), text, attachments: built.display, ts: Date.now() });
      await this.execute(built.content, abort);
    } catch (err) {
      this.lastStop = 'error';
      this.reportRunError(err);
    } finally {
      this.abort = null;
      this.setRunning(false);
    }
  }

  private async execute(content: ContentBlock[], abort: AbortController): Promise<void> {
    const engine = await this.createEngine();
    this.timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sec = this.opts.timeoutSec;
    if (sec && sec > 0) {
      timer = setTimeout(() => {
        this.timedOut = true;
        abort.abort();
      }, sec * 1000);
      timer.unref?.();
    }
    try {
      const startedAt = Date.now();
      const res = await engine.run({ session: this.session, content, signal: abort.signal });
      this.lastStop = res.stopReason;
      this.lastRun = { stopReason: this.timedOut ? 'timeout' : res.stopReason, turns: res.turns, startedAt, endedAt: Date.now() };
      this.logger.log('info', `Lượt chạy kết thúc: ${res.stopReason} sau ${res.turns} vòng (${this.session.provider}:${this.session.model})`);
      if (this.timedOut) this.notice('warn', this.tr('turnTimeout', { sec: sec ?? 0 }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runBeforeSend(text: string, signal: AbortSignal): Promise<{ blocked: boolean; reason?: string }> {
    for (const fn of this.beforeSendFns) {
      try {
        const r = await fn({ text, signal });
        if (r && r.blocked) return { blocked: true, reason: r.reason };
      } catch (err) {
        this.logger.log('warn', `Móc beforeSend lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { blocked: false };
  }

  /** Kết quả lượt chạy gần nhất (cho mã thoát và câu trả lời của chế độ in một lần). */
  lastResult(): RunResultInfo {
    const last = [...this.session.messages].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text.trim()));
    const text = (last?.content ?? [])
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(String.fromCharCode(10))
      .trim();
    const r = this.lastRun;
    return { stopReason: r.stopReason as RunResultInfo['stopReason'], turns: r.turns, text, ms: Math.max(0, (r.endedAt || Date.now()) - r.startedAt) };
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.onUiEvent({ t: 'run_state', running });
    if (!running) {
      this.setModelQueue(null);
      this.git.refresh();
      void this.saveNow();
    }
    this.flushStatus();
  }

  private setModelQueue(q: QueueState | null): void {
    if (this.disposed) return;
    this.modelQueue = q;
    this.scheduleStatus();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dựng engine
  // ───────────────────────────────────────────────────────────────────────────

  private buildAgentServices(): void {
    const limit = Math.min(16, Math.max(1, Math.floor(this.store.get<number>('agents.maxConcurrent', 8))));
    this.limiter.max = limit;
    this.agentServices = {
      pool: this.providers.pool,
      agents: this.agents,
      skills: this.skills,
      mode: () => {
        const v = this.store.get<string>('orchestration.mode', 'off');
        return v === 'failover' || v === 'auto' ? v : 'off';
      },
      engineSettings: () => this.engineSettings(),
      provider: (id) => this.providers.get(id),
      contextWindow: (p, m) => this.providers.contextWindow(p, m),
      log: (l, m) => this.logger.log(l, m),
      limiter: this.limiter,
      writeLock: this.writeLock,
      extensions: () => this.extensionsFor(true),
    };
  }

  engineSettings() {
    const s = this.session;
    return buildEngineSettings(this.store, {
      lang: this.lang,
      contextWindow: this.providers.contextWindow(s.provider, s.model),
      modelMaxOutputTokens: this.providers.maxOutputTokens(s.provider, s.model),
      maxTurns: this.opts.maxTurns,
    });
  }

  /** Luật quyền hiệu lực: deny/ask từ mọi tầng hợp lệ, allow chỉ từ người dùng + (thư mục đã tin cậy) dự án/cục bộ + dòng lệnh. */
  private ruleSnapshot(): { rules: Rule[]; untrusted?: boolean } {
    const list = (key: string, scope: 'user' | 'project' | 'local' | 'cli'): string[] => {
      const v = this.store.getScoped<unknown>(key, scope);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
    };
    const parts: Array<{ action: 'allow' | 'ask' | 'deny'; source: 'user' | 'workspace'; items: string[] }> = [];
    for (const action of ['deny', 'ask', 'allow'] as const) {
      const key = `permissions.${action}`;
      parts.push({ action, source: 'user', items: [...list(key, 'user'), ...list(key, 'cli')] });
      parts.push({ action, source: 'workspace', items: [...list(key, 'project'), ...list(key, 'local')] });
    }
    return { rules: buildRules(parts), ...(this.trusted ? {} : { untrusted: true }) };
  }

  private permissionRulesExt(): RunExtension {
    return permissionRulesExtension({
      source: () => this.ruleSnapshot(),
      resolvePath: async (host, raw) => {
        try {
          const r = await resolveUserPathReal(host, raw);
          return { rel: r.rel, abs: r.abs, inWorkspace: r.zone === 'workspace' && !r.suspicious };
        } catch {
          return resolvePathPlain(raw);
        }
      },
    });
  }

  /** RunExtension cho engine chính (`forSub=false`) hoặc agent con. Thứ tự: lõi chung → luật quyền → tính năng → tính năng `last`. */
  extensionsFor(forSub: boolean): RunExtension[] {
    const feats = this.runExts.filter((r) => !forSub || r.subAgents);
    const out: RunExtension[] = forSub ? [] : coreRunExtensions();
    // Luật quyền do mô-đun tính năng đăng ký (id `permission-rules`, kèm cổng duyệt allow của dự án). Lõi chỉ tự lắp bản dự phòng khi không có mô-đun nào làm việc đó.
    if (!this.runExts.some((r) => r.ext.id === 'permission-rules')) out.push(this.permissionRulesExt());
    out.push(...feats.filter((r) => !r.last).map((r) => r.ext));
    out.push(...feats.filter((r) => r.last).map((r) => r.ext));
    return out;
  }

  buildRegistry() {
    const registry = createToolRegistry({
      skills: this.skills,
      host: this.host,
      agents: this.agentServices,
      currentProvider: () => this.session.provider,
    });
    for (const c of this.toolContribs) {
      try {
        c((tool) => {
          try {
            registry.register(tool as ToolDef);
          } catch (err) {
            this.logger.log('warn', `Công cụ do tính năng thêm bị bỏ qua: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      } catch (err) {
        this.logger.log('warn', `Đóng góp công cụ lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return registry;
  }

  /** Chỉ dẫn dự án (LOCAITH.md/AGENTS.md/CLAUDE.md) + chỉ dẫn cá nhân `~/.locaith/LOCAITH.md` (đứng sau). */
  private async loadInstructions(names: string[]): Promise<{ file: string; text: string } | null> {
    const project = await loadProjectInstructions(this.host, names);
    let personal = '';
    try {
      personal = (await fs.promises.readFile(path.join(this.home, '.locaith', 'LOCAITH.md'), 'utf8')).trim();
    } catch {
      /* không có chỉ dẫn cá nhân */
    }
    if (!personal) return project;
    if (personal.length > 20_000) personal = personal.slice(0, 20_000) + String.fromCharCode(10) + '[… đã cắt bớt]';
    if (!project) return { file: '~/.locaith/LOCAITH.md', text: personal };
    const nl = String.fromCharCode(10);
    return { file: `${project.file} + ~/.locaith/LOCAITH.md`, text: `${project.text.trim()}${nl}${nl}<!-- ~/.locaith/LOCAITH.md (chỉ dẫn cá nhân của người dùng) -->${nl}${personal}` };
  }

  private async loadMemory(): Promise<MemorySnapshot | null> {
    const read = async (dir: string, where: string): Promise<MemoryScope | null> => {
      const index = await fs.promises.readFile(path.join(dir, MEMORY_INDEX), 'utf8').catch(() => null);
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      const topics = names.filter((n) => n.endsWith('.md') && n !== MEMORY_INDEX).sort();
      if (!index && topics.length === 0) return null;
      return { index: index ?? '', topics, where };
    };
    const [project, user] = await Promise.all([
      read(path.join(this.cwd, MEMORY_DIR), `${MEMORY_DIR}/${MEMORY_INDEX}`),
      read(path.join(this.home, '.locaith', 'memory'), `~/.locaith/memory/${MEMORY_INDEX}`),
    ]);
    if (!project && !user) return null;
    return { ...(project ? { project } : {}), ...(user ? { user } : {}) };
  }

  private extraPrompt(): string | null {
    const parts: string[] = [];
    if (this.opts.appendSystemPrompt?.trim()) parts.push(this.opts.appendSystemPrompt.trim());
    for (const fn of this.promptContribs) {
      try {
        const v = fn();
        if (v && v.trim()) parts.push(v.trim());
      } catch (err) {
        this.logger.log('warn', `Đóng góp prompt lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  private defaultOutputStyle() {
    const name = this.store.get<string>('agent.outputStyle', 'default');
    if (!name || name === 'default') return null;
    const st = builtinOutputStyles().find((s) => s.name === name);
    return st && st.prompt ? { name: st.name, prompt: st.prompt } : null;
  }

  async createEngine(): Promise<AgentEngine> {
    const s = this.session;
    const provider = this.providers.get(s.provider);
    const settings = this.engineSettings();
    const summarizerOn = this.store.get<boolean>('summarizer.enabled', this.opts.interactive) !== false;
    const fast = summarizerOn ? await this.providers.fastTarget(s.provider, s.model).catch(() => null) : null;
    const summarizer = fast ? new Summarizer({ provider: fast.provider, model: fast.model, language: settings.language, log: (l, m) => this.logger.log(l, m) }) : null;
    return new AgentEngine({
      provider,
      summarizer,
      compactor: fast ?? undefined,
      registry: this.buildRegistry(),
      skills: this.skills,
      host: this.host,
      settings,
      emit: (ev) => this.onUiEvent(ev),
      takeQueued: () => this.takeForEngine(),
      outputStyle: () => this.defaultOutputStyle(),
      extraSystemPrompt: () => this.extraPrompt(),
      onCompacted: (info) => this.fireCompacted(info),
      beforeCompact: (info) => this.fireBeforeCompact(info),
      onQueue: (q) => this.setModelQueue(q),
      onConsentRequired: () => this.output(this.tr('consentRequired'), 'error'),
      onAccountInvalid: () => {
        this.account.forget();
        this.output(this.tr('accountInvalid'), 'error');
        this.scheduleStatus();
      },
      loadInstructions: (names) => this.loadInstructions(names),
      loadMemory: () => this.loadMemory(),
      extensions: this.extensionsFor(false),
      thinkTags: provider.kind === 'openai-chat' && provider.flavor === 'generic',
    });
  }

  private async fireBeforeCompact(info: Parameters<NonNullable<ConstructorParameters<typeof AgentEngine>[0]['beforeCompact']>>[0]): Promise<void> {
    for (const fn of this.beforeCompactFns) {
      try {
        await fn(info);
      } catch (err) {
        this.logger.log('warn', `Móc trước khi nén lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async fireCompacted(info: { session: SessionState; summary: string }): Promise<void> {
    for (const fn of this.compactedFns) {
      try {
        await fn(info);
      } catch (err) {
        this.logger.log('warn', `Móc sau khi nén lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Nén thủ công bằng chính engine (summarizer/compactor thật). Trả null nếu không có gì để nén. */
  async compactNow(instructions?: string): Promise<{ text: string; compact: import('../../shared/protocol').CompactInfo } | null> {
    if (this.busy) throw new Error(this.tr('busy'));
    let result: { text: string; compact: import('../../shared/protocol').CompactInfo } | null = null;
    let failure: unknown;
    // Qua khoá lượt như mọi lượt khác: tin gửi trong lúc nén được xếp hàng và giao nốt sau đó.
    await this.track(
      this.runAgentTurn(async () => {
        this.setRunning(true);
        const abort = new AbortController();
        this.abort = abort;
        try {
          const engine = await this.createEngine();
          result = await engine.compactWith(this.session, abort.signal, { instructions: instructions?.trim() || undefined });
          if (result) this.onUiEvent({ t: 'notice', level: 'info', text: result.text, compact: result.compact });
          this.lastStop = 'end_turn';
        } catch (err) {
          failure = err;
        } finally {
          this.abort = null;
          this.setRunning(false);
        }
      }),
    );
    if (failure) throw failure;
    return result;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Quyền và hỏi đáp
  // ───────────────────────────────────────────────────────────────────────────

  private decidePermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (this.disposed) return Promise.resolve({ decision: 'deny', feedback: engineT(this.lang, 'aborted') });
    if (!this.opts.interactive) {
      // Không có ai trả lời: KHÔNG treo chờ. Engine đã xét chế độ + luật; còn tới đây nghĩa là cần người dùng cho phép → từ chối kèm hướng dẫn.
      this.logger.log('info', `Từ chối (không tương tác): ${req.tool} — ${req.title}`);
      return Promise.resolve({ decision: 'deny', feedback: this.tr('permDeniedNonInteractive', { title: req.title, tool: req.tool }) });
    }
    return new Promise<PermissionDecision>((resolve) => {
      const done = (d: PermissionDecision) => {
        this.permWaiters.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      };
      const onAbort = () => {
        this.emit({ t: 'permission_cancel', id: req.id });
        done({ decision: 'deny', feedback: engineT(this.lang, 'aborted') });
      };
      this.permWaiters.set(req.id, done);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit({ t: 'permission', request: req });
      this.flushStatus();
    });
  }

  respondPermission(id: string, d: PermissionDecision & { alwaysAllow?: { rule: string; scope: 'user' | 'local' } }): void {
    const w = this.permWaiters.get(id);
    if (!w) return;
    if (d?.alwaysAllow && this.alwaysAllowFn && d.decision !== 'deny') {
      const { rule, scope } = d.alwaysAllow;
      try {
        const saved = this.alwaysAllowFn(String(rule), scope === 'local' ? 'local' : 'user');
        if (saved) this.toast('info', this.tr('alwaysAllowSaved', { rule: saved }));
        else this.toast('warn', this.tr('alwaysAllowRejected', { rule: String(rule) }));
      } catch (err) {
        this.logger.log('warn', `Lưu luật «Luôn cho phép» lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Chỉ nhận đúng ba quyết định đã định nghĩa; còn lại coi là từ chối.
    if (!d || (d.decision !== 'allow' && d.decision !== 'allow_session' && d.decision !== 'deny')) return w({ decision: 'deny' });
    w({ decision: d.decision, ...(typeof d.feedback === 'string' && d.feedback ? { feedback: d.feedback.slice(0, 2000) } : {}) });
  }

  ask(req: AskInput): Promise<AskAnswer> {
    if (!this.opts.interactive || this.disposed) return Promise.resolve(null);
    const id = newId('ask');
    return new Promise<AskAnswer>((resolve) => {
      this.askWaiters.set(id, resolve);
      this.emit({ t: 'ask', ask: { ...req, id } as AskRequest });
    });
  }

  answer(id: string, value: AskAnswer): void {
    const w = this.askWaiters.get(id);
    if (!w) return;
    this.askWaiters.delete(id);
    w(value);
  }

  interrupt(): void {
    if (this.shellAbort) this.shellAbort.abort();
    for (const c of [...this.slashAborts]) c.abort();
    this.abort?.abort();
    for (const w of [...this.permWaiters.values()]) w({ decision: 'deny', feedback: engineT(this.lang, 'aborted') });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Chế độ, model, suy luận
  // ───────────────────────────────────────────────────────────────────────────

  setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) return;
    if (mode === 'bypass' && !this.bypassAllowed()) {
      this.toast('warn', this.tr('bypassNotAllowed'));
      return;
    }
    this.explicitMode = true;
    this.session.mode = mode;
    this.onUiEvent({ t: 'mode', mode });
    this.flushStatus();
  }

  cycleMode(): PermissionMode {
    const order: PermissionMode[] = ['default', 'acceptEdits', 'plan', ...(this.bypassAllowed() ? (['bypass'] as PermissionMode[]) : [])];
    const i = order.indexOf(this.session.mode);
    const next = order[(i + 1) % order.length] ?? 'default';
    this.setMode(next);
    return this.session.mode;
  }

  async setModel(spec: string): Promise<void> {
    const t = this.providers.resolveSpec(spec);
    this.session.provider = t.provider;
    this.session.model = t.model;
    // Khối suy luận đã ký của hãng này không hợp lệ với hãng/model khác: engine sẽ bỏ khi thấy lịch sử đã đổi.
    this.session.historyEdited = true;
    try {
      this.store.set('defaultModel', `${t.provider}:${t.model}`, 'user');
    } catch (err) {
      this.logger.log('debug', `Không lưu được model mặc định: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.flushStatus();
  }

  setThinking(level: ThinkingLevel): void {
    if (!THINKING_LEVELS.includes(level)) return;
    this.session.thinkingLevel = level;
    this.flushStatus();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lệnh gạch chéo và `!shell`
  // ───────────────────────────────────────────────────────────────────────────

  slashCommands(): SlashCommandInfo[] {
    return this.slashReg.list(this.lang);
  }

  private makeSlashContext(args: string, detach: () => void, signal: AbortSignal): FullSlashContext {
    const rt = this;
    return {
      args,
      lang: this.lang,
      signal,
      output: (text, kind) => this.output(text, kind ?? 'markdown'),
      toast: (level, text) => this.toast(level, text),
      ask: (req) => {
        detach();
        return this.ask(req);
      },
      runPrompt: async (text, o) => {
        detach();
        await this.runPromptTurn(text, o);
      },
      get busy() {
        return rt.busy;
      },
      info: (text) => this.output(text, 'markdown'),
      warn: (text) => this.toast('warn', text),
    };
  }

  async runSlash(name: string, args: string): Promise<void> {
    const def = this.slashReg.get(name);
    if (!def) {
      this.output(this.tr('unknownCommand', { name }), 'error');
      return;
    }
    if (this.busy && def.needsIdle !== false) {
      this.toast('warn', this.tr('stopFirst', { name }));
      return;
    }
    let detach!: () => void;
    const detached = new Promise<void>((r) => (detach = r));
    const slashCtl = new AbortController();
    this.slashAborts.add(slashCtl);
    const work = (async () => {
      try {
        await def.run(this.makeSlashContext(args, detach, slashCtl.signal) as never);
      } catch (err) {
        this.logger.log('warn', `Lệnh /${name} lỗi: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        this.output(this.tr('commandFailed', { name, detail: err instanceof Error ? err.message : String(err) }), 'error');
      } finally {
        this.slashAborts.delete(slashCtl);
      }
    })();
    this.track(work);
    // `submit` trả về khi lệnh xong, hoặc khi nó trao quyền cho người dùng (ask) / agent (runPrompt).
    await Promise.race([work, detached]);
  }

  private async runShell(cmd: string): Promise<void> {
    const ctl = new AbortController();
    this.shellAbort = ctl;
    try {
      const res = await this.host.runCommand({ command: cmd, cwd: this.cwd, timeoutMs: 120_000, signal: ctl.signal, onData: () => undefined });
      const code = res.aborted ? 'aborted' : res.timedOut ? 'timeout' : String(res.exitCode ?? '?');
      const body = res.output.replace(/\s+$/, '');
      const failed = res.aborted || res.timedOut || (res.exitCode !== 0 && res.exitCode !== null);
      this.output(`$ ${cmd}\n${body}${body ? '\n' : ''}${failed ? `[${res.aborted ? this.tr('shellAborted') : res.timedOut ? this.tr('shellTimeout') : `exit ${code}`}]` : ''}`.replace(/\s+$/, ''), failed ? 'error' : 'plain');
      const clip = body.length > 20_000 ? `${body.slice(0, 10_000)}\n[… ${body.length - 20_000} ký tự …]\n${body.slice(-10_000)}` : body;
      this.pendingNotes.push(`<attached_shell cmd="${cmd.replace(/["<>\r\n]/g, ' ').slice(0, 200)}" exit="${code}">\n${clip}\n</attached_shell>`);
      if (this.pendingNotes.length > 5) this.pendingNotes.splice(0, this.pendingNotes.length - 5);
    } catch (err) {
      this.output(this.tr('shellFailed', { detail: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      this.shellAbort = null;
      this.git.refresh(true);
      this.files.invalidate();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Gợi ý
  // ───────────────────────────────────────────────────────────────────────────

  async complete(req: { kind: 'file' | 'slash'; query: string; limit?: number }): Promise<Completion[]> {
    try {
      if (req.kind === 'slash') return completeSlash(req.query, this.slashCommands(), req.limit ?? 20);
      return await this.files.search(req.query, req.limit ?? 20);
    } catch (err) {
      this.logger.log('warn', `Gợi ý lỗi: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  helpText(): string {
    const cmds = this.slashReg.list(this.lang);
    const w = Math.max(8, ...cmds.map((c) => c.name.length)) + 1;
    return [
      this.tr('helpTitle', { version: this.opts.version }),
      '',
      this.tr('helpCommands'),
      ...cmds.map((c) => `  /${c.name.padEnd(w)} ${c.description}`),
      '',
      this.tr('helpPrefixes'),
      '',
      this.tr('helpKeys'),
    ].join('\n');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phiên
  // ───────────────────────────────────────────────────────────────────────────

  sessions(scope: 'cwd' | 'all' = 'cwd'): Promise<SessionSummary[]> {
    return this.repo.list(scope);
  }

  scheduleSave(): void {
    if (this.disposed || this.opts.noPersist || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.opts.noPersist) return;
    try {
      // Tự hàn gắn: transcript ít lượt hơn lịch sử gửi model thì dựng lại phần thiếu (không làm giữa lượt: sự kiện còn đang tới).
      if (!this.running) {
        const rec = reconcileTranscript(this.session.messages, this.transcript);
        if (rec.rebuilt) this.transcript = rec.items;
      }
      await this.repo.save(this.session, this.transcript);
    } catch (err) {
      this.logger.log('warn', `Không lưu được phiên: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fireSessionChange(): void {
    for (const fn of this.sessionChangeFns) {
      try {
        fn(this.session);
      } catch (err) {
        this.logger.log('warn', `Người nghe đổi phiên lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Đặt phiên đang chạy = `next` (resume/fork/rewind/new): ghi phiên cũ, sửa nhà cung cấp không dùng được, phát replay + status. */
  async swapSession(next: SessionState, transcript: TItem[], reason: 'resume' | 'fork' | 'rewind' | 'new' | 'clear', opts: { silent?: boolean } = {}): Promise<void> {
    if (next !== this.session) await this.saveNow();
    repairOrphanToolCalls(next, this.lang);
    if (!this.providers.service.has(next.provider) || !this.providers.hasKey(next.provider)) {
      try {
        const t = this.providers.pickInitial(undefined);
        if (!opts.silent) this.toast('warn', this.tr('sessionProviderSwitched', { from: `${next.provider}:${next.model}`, to: `${t.provider}:${t.model}` }));
        next.provider = t.provider;
        next.model = t.model;
        next.historyEdited = true;
      } catch {
        /* không có khoá nào: giữ nguyên, lượt gửi sẽ báo rõ */
      }
    }
    this.session = next;
    this.transcript = transcript;
    this.agentTokens.clear();
    this.queue = [];
    this.pendingNotes = [];
    this.emit({ t: 'replay', items: this.transcript, reason });
    this.fireSessionChange();
    this.flushStatus();
  }

  private async loadSessionInto(idOrPrefix: string | true, reason: 'resume', silent = false): Promise<void> {
    const found = await this.repo.find(idOrPrefix);
    const loaded: LoadedSession | null = await this.repo.load(found.id);
    if (!loaded) throw new Error(this.tr('sessionOpenFailed', { id: found.id }));
    await this.swapSession(loaded.session, loaded.transcript, reason, { silent });
  }

  async resume(idOrPrefix: string): Promise<void> {
    if (this.busy) throw new Error(this.tr('busy'));
    await this.loadSessionInto(idOrPrefix, 'resume');
  }

  async newSession(reason: 'new' | 'clear' = 'new'): Promise<void> {
    if (this.busy) throw new Error(this.tr('busy'));
    const s = this.session;
    const fresh = this.freshSession(s.provider, s.model, s.mode, s.thinkingLevel);
    if (s.outputStyle) fresh.outputStyle = s.outputStyle;
    await this.swapSession(fresh, [], reason);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tính năng (FeatureModule)
  // ───────────────────────────────────────────────────────────────────────────

  private adaptSlash(def: FeatureSlashDef, source: SlashCommandDef['source']): SlashCommandDef {
    return {
      name: def.name,
      description: def.description,
      ...(def.argHint ? { argHint: def.argHint } : {}),
      ...(def.needsIdle !== undefined ? { needsIdle: def.needsIdle } : {}),
      source,
      run: (ctx) => def.run(ctx as unknown as SlashRunContext),
    };
  }

  private featureContext(name: string): FeatureContext {
    const rt = this;
    const logf = (level: LogLevel, message: string) => this.logger.log(level, `[${name}] ${message}`);
    return {
      cwd: this.cwd,
      home: this.home,
      lang: this.lang,
      version: this.opts.version,
      interactive: this.opts.interactive,
      options: {
        mcpConfig: this.opts.mcpConfig,
        addDirs: this.opts.addDirs,
        allowedTools: this.opts.allowedTools,
        disallowedTools: this.opts.disallowedTools,
        appendSystemPrompt: this.opts.appendSystemPrompt,
        permissionMode: this.opts.permissionMode,
        noPersist: this.opts.noPersist,
        verbose: this.opts.verbose,
        timeoutSec: this.opts.timeoutSec,
      },
      host: this.host,
      settings: this.store,
      skills: this.skills,
      agents: this.agents,
      addReadRoot: (dir) => this.host.addReadRoot(dir),
      session: () => rt.session,
      isTrusted: () => rt.trusted,
      isBusy: () => rt.busy,
      emit: (e) => {
        if (e.t === 'ui') this.onUiEvent(e.ev);
        else this.emit(e);
      },
      output: (text, kind) => this.output(text, kind ?? 'markdown'),
      toast: (level, text) => this.toast(level, text),
      ask: (req) => this.ask(req),
      log: logf,
      slash: (def, source) => {
        return this.slashReg.register(this.adaptSlash(def, source ?? 'builtin'));
      },
      replaceSlashSource: (source, defs) => this.slashReg.replaceSource(source, defs.map((d) => this.adaptSlash(d, source))),
      addRunExtension: (ext, o) => {
        this.runExts.push({ ext, subAgents: !!o?.subAgents, last: !!o?.last });
      },
      addToolContributor: (fn) => {
        this.toolContribs.push(fn);
      },
      addStatusContributor: (fn) => {
        this.statusContribs.push(fn);
        return { refresh: () => this.scheduleStatus() };
      },
      addPromptContributor: (fn) => {
        this.promptContribs.push(fn);
      },
      onDispose: (fn) => {
        this.disposers.push({ name, fn });
      },
      onSessionChange: (fn) => {
        this.sessionChangeFns.push(fn);
      },
      beforeSend: (fn) => {
        this.beforeSendFns.push(fn);
      },
      onBeforeCompact: (fn) => {
        this.beforeCompactFns.push(fn);
      },
      onCompacted: (fn) => {
        this.compactedFns.push(fn);
      },
      onFileWrite: (fn) => this.host.onFileWrite(fn),
      onPermissionRequest: (fn) => this.host.onPermissionRequest(fn),
      agentServices: () => rt.agentServices,
      mainRegistry: () => rt.buildRegistry(),
      registerAlwaysAllow: (fn) => {
        rt.alwaysAllowFn = fn;
      },
      transcript: () => rt.transcript,
      saveSession: () => this.saveNow(),
      replaceSession: async (next, o) => {
        if (this.busy) throw new Error(this.tr('busy'));
        const tr = o?.transcript ?? reconcileTranscript(next.messages, []).items;
        await this.swapSession(next, tr, o?.reason ?? 'resume');
      },
    };
  }

  private async attachFeatures(): Promise<void> {
    let mods: FeatureModule[];
    try {
      mods = this.opts.features ?? defaultFeatures();
    } catch (err) {
      this.featureFailed('defaultFeatures', err);
      return;
    }
    for (const mod of mods) {
      const name = mod?.name || '(không tên)';
      try {
        const ctx = this.featureContext(name);
        const ret = await Promise.race([
          Promise.resolve(mod.attach(ctx)),
          new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error(`attach quá ${FEATURE_ATTACH_TIMEOUT_MS / 1000}s`)), FEATURE_ATTACH_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
        if (typeof ret === 'function') this.disposers.push({ name, fn: ret });
      } catch (err) {
        this.featureFailed(name, err);
      }
    }
  }

  private featureFailed(name: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.featureErrors.push({ name, error: msg });
    this.logger.log('error', `Mô-đun tính năng «${name}» lỗi khi gắn: ${err instanceof Error ? (err.stack ?? msg) : msg}`);
    this.toast('warn', this.tr('featureFailed', { name, detail: msg }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Đóng
  // ───────────────────────────────────────────────────────────────────────────

  dispose(keepDispatcher = false): Promise<void> {
    this.keepDispatcher = keepDispatcher;
    this.disposing ??= this.doDispose();
    return this.disposing;
  }

  private async doDispose(): Promise<void> {
    this.disposed = true;
    this.interrupt();
    for (const w of [...this.askWaiters.values()]) w(null);
    this.askWaiters.clear();
    // Chờ lượt đang chạy nhả (đã bị huỷ) tối đa vài giây rồi ghi phiên.
    await Promise.race([this.turnLock.catch(() => undefined), new Promise<void>((r) => setTimeout(r, DISPOSE_STEP_TIMEOUT_MS).unref?.())]);
    for (const t of [this.statusTimer, this.saveTimer]) if (t) clearTimeout(t);
    this.statusTimer = this.saveTimer = null;
    await this.saveNow();
    for (const d of this.disposers.splice(0).reverse()) {
      try {
        await Promise.race([Promise.resolve(d.fn()), new Promise<void>((r) => setTimeout(r, DISPOSE_STEP_TIMEOUT_MS).unref?.())]);
      } catch (err) {
        this.logger.log('warn', `Dọn «${d.name}» lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.listeners.clear();
    const rs = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of rs) r();
    // Đóng socket keep-alive của fetch (undici) để tiến trình thoát sạch. Bỏ qua khi kiểm thử (nhiều runtime chung một tiến trình).
    if (!this.keepDispatcher && !this.opts.providerOverride && !this.opts.fetchImpl && this.env.LOCAITH_NO_DISPATCHER_CLOSE !== '1') closeDispatcher();
  }
}

/** Đóng bộ điều phối HTTP toàn cục (undici) — như `closeDispatcher` của CLI cũ. */
export function closeDispatcher(): void {
  try {
    const sym = Symbol.for('undici.globalDispatcher.1');
    const d = (globalThis as Record<symbol, unknown>)[sym] as { close?: () => Promise<void> } | undefined;
    void d?.close?.().catch(() => undefined);
  } catch {
    /* bản Node không có undici: bỏ qua */
  }
}
