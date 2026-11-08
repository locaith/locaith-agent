/**
 * Bộ dựng `FakeFeatureContext` cho kiểm thử các mô-đun tính năng của CLI: cài đặt thật trên thư mục tạm (user/project/local),
 * `NodeToolHost` thật, ghi lại mọi emit/output/toast/ask và thu các RunExtension/lệnh gạch chéo/contributor để test gọi lại.
 * KHÔNG bao giờ đụng `~/.locaith` thật: `home` luôn là thư mục tạm.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeToolHost } from '../../../src/core/host/nodeHost';
import { AgentRegistry } from '../../../src/core/agents/definitions';
import { SkillRegistry } from '../../../src/core/skills/registry';
import { newTrace, beginExtensions, type ActiveExtension, type RunExtension, type RunScope } from '../../../src/core/engine/seams';
import { newSession, type SessionState, type ToolDef } from '../../../src/core/engine/types';
import type { LLMProvider } from '../../../src/core/types';
import type { PermissionRequest, TItem, UiEvent } from '../../../src/shared/protocol';
import type { AskAnswer, AskRequest, FeatureModule, FeatureSlashDef, RuntimeEvent, RuntimeStatus, SettingsApi, SlashRunContext } from '../../../src/cli/runtime/contract';
import type { AskInit, FeatureContextExt, FileWriteBefore } from '../../../src/cli/runtime/features/ext';
import { getPath, readJsonFile, setPathInFile, type Scope } from '../../../src/cli/runtime/features/settingsFile';

export interface FakeOpts {
  cwd?: string;
  home?: string;
  trusted?: boolean;
  interactive?: boolean;
  lang?: 'vi' | 'en';
  /** Cài đặt ban đầu theo phạm vi (ghi thật ra tệp). */
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
  local?: Record<string, unknown>;
}

export interface RegisteredExt {
  ext: RunExtension;
  opts?: { subAgents?: boolean; last?: boolean };
}

export function mkTmp(prefix = 'locaith-feat-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows có thể còn giữ tay cầm một lúc */
  }
}

export function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** Host giống `CliToolHost` của lõi cli-rt: báo người nghe `onFileWrite` sau mỗi lần ghi thành công. */
class FakeHost extends NodeToolHost {
  constructor(private readonly owner: { writeFns: Array<(abs: string, before: FileWriteBefore, after: string) => void> }, opts: ConstructorParameters<typeof NodeToolHost>[0]) {
    super(opts);
  }
  override async writeText(abs: string, content: string): Promise<void> {
    if (this.owner.writeFns.length === 0) return super.writeText(abs, content);
    let before: FileWriteBefore;
    try {
      before = await this.readText(abs);
    } catch {
      before = { skipped: 'binary' };
    }
    await super.writeText(abs, content);
    for (const fn of [...this.owner.writeFns]) fn(abs, before, content);
  }
}

export class FakeFeatureContext implements FeatureContextExt {
  readonly cwd: string;
  readonly home: string;
  readonly lang: 'vi' | 'en';
  readonly version = '0.0.0-test';
  interactive: boolean;
  trusted: boolean;
  busy = false;
  readonly host: NodeToolHost;
  readonly skills = new SkillRegistry([]);
  readonly agents = new AgentRegistry();
  readonly readRoots: string[] = [];
  readonly settings: SettingsApi;
  private sess: SessionState;

  // ghi lại
  readonly events: RuntimeEvent[] = [];
  readonly outputs: { text: string; kind?: string }[] = [];
  readonly toasts: { level: string; text: string }[] = [];
  readonly asks: AskRequest[] = [];
  readonly logs: { level: string; message: string }[] = [];
  readonly prompts: { text: string; model?: string }[] = [];
  readonly extensions: RegisteredExt[] = [];
  readonly toolContributors: Array<(add: (tool: unknown) => void) => void> = [];
  readonly promptContributors: Array<() => string | null> = [];
  readonly statusContributors: Array<(s: RuntimeStatus) => void> = [];
  readonly statusRefreshes: number[] = [0];
  readonly disposers: Array<() => void | Promise<void>> = [];
  readonly sessionListeners: Array<(s: SessionState) => void> = [];
  readonly slashDefs = new Map<string, { def: FeatureSlashDef; source: string }>();
  readonly slashSources = new Map<string, FeatureSlashDef[]>();
  readonly beforeSendFns: Array<(info: { text: string; signal: AbortSignal }) => { blocked?: boolean; reason?: string } | void | Promise<{ blocked?: boolean; reason?: string } | void>> = [];
  readonly permissionRequestFns: Array<(req: PermissionRequest) => void> = [];
  readonly beforeCompactFns: Array<(info: { session: SessionState; trigger: 'auto' | 'manual' | 'overflow'; signal: AbortSignal }) => void | Promise<void>> = [];
  readonly writeFns: Array<(abs: string, before: FileWriteBefore, after: string) => void> = [];
  transcriptItems: TItem[] = [];
  /** Mỗi lần lõi được yêu cầu thay phiên (rewind/fork). */
  readonly replaced: { next: SessionState; opts?: { reason?: string; transcript?: TItem[] } }[] = [];
  saved = 0;
  alwaysAllow: ((rule: string, scope: 'user' | 'local') => string | null) | undefined;

  /** Trả lời `ask`: hàng đợi giá trị, hoặc hàm. Hết hàng đợi → null (huỷ). */
  askAnswers: AskAnswer[] = [];
  askFn?: (req: AskRequest) => AskAnswer | Promise<AskAnswer>;

  constructor(o: FakeOpts = {}) {
    this.cwd = o.cwd ?? mkTmp('locaith-cwd-');
    this.home = o.home ?? mkTmp('locaith-home-');
    this.lang = o.lang ?? 'vi';
    this.interactive = o.interactive ?? true;
    this.trusted = o.trusted ?? true;
    this.sess = newSession({ id: 's_test1', provider: 'fake', model: 'fake-model' });
    this.host = new FakeHost(this, { roots: [this.cwd], extraReadRoots: this.readRoots, shellPreference: process.platform === 'win32' ? 'cmd' : 'sh', onLog: (level, message) => this.logs.push({ level, message }) });
    (this.host as { homeDir: string }).homeDir = this.home;
    const file = (scope: Scope): string => (scope === 'user' ? path.join(this.home, '.locaith', 'settings.json') : path.join(this.cwd, '.locaith', scope === 'project' ? 'settings.json' : 'settings.local.json'));
    for (const [scope, val] of [['user', o.user], ['project', o.project], ['local', o.local]] as const) {
      if (val) writeFile(file(scope), JSON.stringify(val, null, 2));
    }
    this.settings = {
      get: <T,>(key: string, fallback: T): T => {
        let found: unknown;
        for (const s of ['user', 'project', 'local'] as const) {
          if (s !== 'user' && !this.trusted) continue;
          const v = getPath(readJsonFile(file(s)), key);
          if (v !== undefined) found = v;
        }
        return (found === undefined ? fallback : (found as T));
      },
      set: (key, value, scope) => {
        if (scope !== 'user' && !this.trusted) return;
        setPathInFile(file(scope), key, value);
      },
      file,
    };
  }

  // ── FeatureContext ──
  addReadRoot(dir: string): void {
    if (!this.readRoots.includes(dir)) this.readRoots.push(dir);
  }
  session(): SessionState {
    return this.sess;
  }
  setSession(s: SessionState): void {
    this.sess = s;
    for (const fn of this.sessionListeners) fn(s);
  }
  isTrusted(): boolean {
    return this.trusted;
  }
  isBusy(): boolean {
    return this.busy;
  }
  emit(e: RuntimeEvent): void {
    this.events.push(e);
  }
  output(text: string, kind?: 'markdown' | 'plain' | 'error'): void {
    this.outputs.push({ text, kind });
  }
  toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.toasts.push({ level, text });
  }
  async ask(req: Omit<AskRequest, 'id'> | AskInit): Promise<AskAnswer> {
    const full = { ...req, id: `ask${this.asks.length + 1}` } as AskRequest;
    this.asks.push(full);
    if (!this.interactive) return null;
    if (this.askFn) return this.askFn(full);
    return this.askAnswers.length ? this.askAnswers.shift()! : null;
  }
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.logs.push({ level, message });
  }
  slash(def: FeatureSlashDef, source: 'builtin' | 'project' | 'user' | 'plugin' | 'mcp' = 'builtin'): () => void {
    this.slashDefs.set(def.name, { def, source });
    return () => {
      if (this.slashDefs.get(def.name)?.def === def) this.slashDefs.delete(def.name);
    };
  }
  replaceSlashSource(source: 'project' | 'user' | 'plugin' | 'mcp', defs: readonly FeatureSlashDef[]): void {
    this.slashSources.set(source, [...defs]);
  }
  addRunExtension(ext: RunExtension, opts?: { subAgents?: boolean; last?: boolean }): void {
    this.extensions.push({ ext, opts });
  }
  addToolContributor(fn: (add: (tool: unknown) => void) => void): void {
    this.toolContributors.push(fn);
  }
  addStatusContributor(fn: (s: RuntimeStatus) => void): { refresh(): void } {
    this.statusContributors.push(fn);
    return { refresh: () => void this.statusRefreshes[0]++ };
  }
  addPromptContributor(fn: () => string | null): void {
    this.promptContributors.push(fn);
  }
  onDispose(fn: () => void | Promise<void>): void {
    this.disposers.push(fn);
  }
  onSessionChange(fn: (s: SessionState) => void): void {
    this.sessionListeners.push(fn);
  }
  // ── tuỳ chọn (ext.ts) ──
  beforeSend(fn: (info: { text: string; signal: AbortSignal }) => { blocked?: boolean; reason?: string } | void | Promise<{ blocked?: boolean; reason?: string } | void>): void {
    this.beforeSendFns.push(fn);
  }
  onPermissionRequest(fn: (req: PermissionRequest) => void): void {
    this.permissionRequestFns.push(fn);
  }
  onBeforeCompact(fn: (info: { session: SessionState; trigger: 'auto' | 'manual' | 'overflow'; signal: AbortSignal }) => void | Promise<void>): void {
    this.beforeCompactFns.push(fn);
  }
  onFileWrite(fn: (abs: string, before: FileWriteBefore, after: string) => void): void {
    this.writeFns.push(fn);
  }
  transcript(): readonly TItem[] {
    return this.transcriptItems;
  }
  async replaceSession(next: SessionState, opts?: { reason?: 'resume' | 'fork' | 'rewind' | 'new' | 'clear'; transcript?: TItem[] }): Promise<void> {
    this.replaced.push({ next, opts });
    this.sess = next;
    if (opts?.transcript) this.transcriptItems = opts.transcript;
    this.events.push({ t: 'replay', items: opts?.transcript ?? [], reason: opts?.reason ?? 'resume' });
    for (const fn of this.sessionListeners) fn(next);
  }
  registerAlwaysAllow(fn: (rule: string, scope: 'user' | 'local') => string | null): void {
    this.alwaysAllow = fn;
  }
  async saveSession(): Promise<void> {
    this.saved++;
  }

  // ── tiện ích cho test ──
  /** Gắn một mô-đun và trả về hàm dọn của nó. */
  async attach(mod: FeatureModule): Promise<void> {
    const off = await mod.attach(this);
    if (typeof off === 'function') this.disposers.push(off);
  }

  slashNamed(name: string): FeatureSlashDef {
    const hit = this.slashDefs.get(name) ?? [...this.slashSources.values()].flat().find((d) => d.name === name);
    if (!hit) throw new Error(`Không có lệnh /${name} (có: ${[...this.slashDefs.keys()].join(', ')})`);
    return 'def' in hit ? hit.def : hit;
  }

  /** Chạy một lệnh gạch chéo; trả về chữ đã in của lần chạy đó. */
  async runSlash(name: string, args = ''): Promise<string> {
    const def = this.slashNamed(name);
    const before = this.outputs.length;
    const ctx: SlashRunContext = {
      args,
      lang: this.lang,
      output: (text, kind) => this.output(text, kind),
      toast: (level, text) => this.toast(level, text),
      ask: (req) => this.ask(req),
      runPrompt: async (text, opts) => {
        this.prompts.push({ text, model: opts?.model });
      },
      busy: this.busy,
    };
    await def.run(ctx);
    return this.outputs.slice(before).map((o) => o.text).join('\n');
  }

  /** Dựng RunScope giả cho một lần chạy engine. */
  scope(over: Partial<RunScope> = {}): RunScope & { notices: { level: string; text: string }[]; ui: UiEvent[]; ac: AbortController } {
    const notices: { level: string; text: string }[] = [];
    const ui: UiEvent[] = [];
    const ac = new AbortController();
    const s = {
      session: this.sess,
      settings: { language: this.lang, maxTurns: 10 } as never,
      lang: this.lang,
      host: this.host,
      provider: { id: 'fake', label: 'fake' } as unknown as LLMProvider,
      signal: ac.signal,
      input: [{ type: 'text', text: 'hãy làm việc' }] as RunScope['input'],
      trace: newTrace(),
      emit: (ev: UiEvent) => void ui.push(ev),
      notice: (level: string, text: string) => void notices.push({ level, text }),
      assistantId: () => 'a1',
      notices,
      ui,
      ac,
      ...over,
    };
    return s as never;
  }

  /** Chạy `begin` của các RunExtension đã đăng ký (theo thứ tự, `last` cuối cùng) và trả các móc đang hoạt động. */
  begin(scope: RunScope, only?: (r: RegisteredExt) => boolean): ActiveExtension[] {
    const list = this.extensions.filter((e) => !e.opts?.last).concat(this.extensions.filter((e) => e.opts?.last));
    return beginExtensions(list.filter((r) => (only ? only(r) : true)).map((r) => r.ext), scope);
  }

  /** Mọi công cụ do các contributor thêm vào ở thời điểm gọi. */
  contributedTools(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const fn of this.toolContributors) fn((t) => out.push(t as ToolDef));
    return out;
  }

  promptText(): string {
    return this.promptContributors.map((f) => f()).filter(Boolean).join('\n');
  }

  status(): RuntimeStatus {
    const s = {
      version: this.version, cwd: this.cwd, provider: 'fake', model: 'fake-model', mode: 'default', thinking: 'medium',
      context: { tokens: 0, window: 1000, percent: 0 }, usage: { input: 0, output: 0 }, running: false, queued: [], sessionId: this.sess.id, title: '',
      todos: [], bgTasks: { running: 0, total: 0 }, notices: [],
    } as RuntimeStatus;
    for (const fn of this.statusContributors) fn(s);
    return s;
  }

  async dispose(): Promise<void> {
    for (const fn of [...this.disposers].reverse()) await fn();
    this.disposers.length = 0;
  }

  cleanup(): void {
    rmTmp(this.cwd);
    rmTmp(this.home);
  }
}

/** Phát hiện một lệnh gọi công cụ (ToolUseBlock) giả cho RunExtension. */
export function toolCall(name: string, input: Record<string, unknown>, id = `c_${Math.random().toString(36).slice(2, 8)}`): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return { type: 'tool_use', id, name, input };
}

export function fakeToolDef(name: string, risk: ToolDef['risk'] = 'exec'): ToolDef {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, risk, concurrencySafe: false, async execute() { return { content: 'ok' }; } } as unknown as ToolDef;
}
