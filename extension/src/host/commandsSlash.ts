/**
 * (lane:commands-agents) Lệnh gạch chéo tuỳ chỉnh + lệnh dựng sẵn mới + phong cách đầu ra + công cụ `slash_command`.
 *
 *   • Lệnh tuỳ chỉnh: `<ws>/.locaith/commands/**.md` (dự án), `~/.locaith/commands/**.md` (cá nhân) và — tương thích —
 *     `.claude/commands/**.md` ở cả hai nơi (cài đặt `commands.readClaudeDir`, mặc định bật; thư mục `.claude` của DỰ ÁN chỉ đọc
 *     khi workspace đã tin cậy). Theo dõi thay đổi tệp để làm mới menu `/`.
 *   • Lệnh dựng sẵn: /review /simplify /security-review /status /doctor /agents /output-style /mcp.
 *   • Phong cách đầu ra: `/output-style <tên>` (phiên) — cài đặt `agent.outputStyle` là mặc định cho phiên chưa chọn.
 *
 * Đăng ký ở đúng một dòng của ChatController (`registerCommandsSlash(this.slash, this)`); mọi thứ khác nằm ở đây.
 */

import { access, mkdir, readdir, writeFile, constants as fsConstants } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentDirSpec } from '../core/agents/definitions';
import { slugifyName } from '../core/skills/registry';
import { loadProjectInstructions } from '../core/engine/instructions';
import type { Lang } from '../core/engine/strings';
import type { ToolRegistry } from '../core/engine/toolRegistry';
import type { SessionState, ToolHost } from '../core/engine/types';
import { reviewPrompt, securityReviewPrompt, simplifyPrompt } from '../core/commands/builtinPrompts';
import { expandCustomCommand, loadCommandDirs, type CommandDirSpec, type CustomCommand } from '../core/commands/custom';
import { builtinOutputStyles, loadOutputStyles, type OutputStyle, type SessionOutputStyle } from '../core/commands/outputStyles';
import { createSlashCommandTool, SLASH_TOOL_NAME } from '../core/commands/slashTool';
import type { ControllerDeps } from './chatController';
import { formatDoctor, formatStatus, type DoctorCheck } from './commandsReport';
import type { SlashCommandDef, SlashContext, SlashRegistry } from './slashRegistry';

/** Những gì controller mở cho lane này (xem `ChatController.commandsLaneAccess`). */
export interface CommandsLaneAccess {
  deps: ControllerDeps;
  host: ToolHost;
  registry: ToolRegistry;
  session(): SessionState;
  /** Gửi lại danh sách lệnh cho menu `/` (webview + Remote). */
  refreshMenu(): void;
  /** Một dòng thông báo trong khung chat (loại 'notice' sẵn có → đi qua Remote nguyên vẹn). */
  notice(level: 'info' | 'warn', text: string): void;
  /** Gọi khi controller bị huỷ. */
  onDispose(fn: () => void): void;
  showScreen(screen: 'market'): Promise<void>;
}

export interface CommandsLaneState {
  commands: CustomCommand[];
  styles: OutputStyle[];
  warnings: string[];
  reload(): Promise<void>;
  /** Phong cách mặc định theo cài đặt `agent.outputStyle` (null = default). */
  defaultStyle(): SessionOutputStyle | null;
}

const STATES = new WeakMap<object, CommandsLaneState>();

/** Phong cách mặc định cho engine của controller này (dòng `outputStyle:` trong createEngine). */
export function commandsOutputStyle(ctl: object): SessionOutputStyle | null {
  return STATES.get(ctl)?.defaultStyle() ?? null;
}

export function commandsLaneState(ctl: object): CommandsLaneState | undefined {
  return STATES.get(ctl);
}

const trusted = (): boolean => vscode.workspace.isTrusted !== false;

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => (f.uri.scheme ?? 'file') === 'file').map((f) => f.uri.fsPath);
}

/** Thư mục lệnh theo thứ tự ưu tiên (trùng tên: dự án > cá nhân; cùng nguồn: `.locaith` trước `.claude`). */
export function commandDirectories(o: { roots: string[]; home: string; trusted: boolean; readClaudeDir: boolean }): CommandDirSpec[] {
  const out: CommandDirSpec[] = [];
  for (const r of o.roots) {
    out.push({ path: path.join(r, '.locaith', 'commands'), source: 'project' });
    if (o.readClaudeDir && o.trusted) out.push({ path: path.join(r, '.claude', 'commands'), source: 'project' });
  }
  if (o.home) {
    out.push({ path: path.join(o.home, '.locaith', 'commands'), source: 'user' });
    if (o.readClaudeDir) out.push({ path: path.join(o.home, '.claude', 'commands'), source: 'user' });
  }
  return out;
}

function agentDirectories(roots: string[], home: string, pluginDirs: string[]): AgentDirSpec[] {
  const out: AgentDirSpec[] = [];
  for (const r of roots) out.push({ path: path.join(r, '.locaith', 'agents'), source: 'workspace' }, { path: path.join(r, '.claude', 'agents'), source: 'workspace' });
  if (home) out.push({ path: path.join(home, '.locaith', 'agents'), source: 'user' }, { path: path.join(home, '.claude', 'agents'), source: 'user' });
  for (const p of pluginDirs) out.push({ path: p, source: 'plugin' });
  return out;
}

const L = {
  vi: {
    review: 'Rà soát thay đổi chưa commit / nhánh hiện tại (không sửa mã)',
    simplify: 'Rà thay đổi vừa làm về tái sử dụng, đơn giản hoá, hiệu năng rồi sửa',
    security: 'Rà lỗ hổng bảo mật trên các thay đổi',
    status: 'Phiên bản, tài khoản, model, chế độ quyền, MCP, ngữ cảnh',
    doctor: 'Chẩn đoán môi trường: shell, git, node, quyền ghi, kết nối',
    agents: 'Danh sách agent con — /agents new <tên> để tạo mẫu',
    style: 'Chọn phong cách trả lời — /output-style <tên>',
    mcp: 'Mở bảng MCP',
    project: 'dự án',
    user: 'cá nhân',
    plugin: 'plugin',
    builtin: 'dựng sẵn',
    workspace: 'dự án',
    cmdWarn: 'Lệnh tuỳ chỉnh lỗi',
    embedded: (n: number) => `Đã nhúng ${n} tệp`,
    refused: (n: number) => `${n} lệnh nhúng không chạy (chưa được phép hoặc workspace chưa tin cậy)`,
    styleSet: (n: string) => `Phong cách trả lời của phiên này: **${n}**.`,
    styleSaved: 'Đã lưu làm mặc định (cài đặt `agent.outputStyle`).',
    styleUnknown: (n: string) => `Không có phong cách "${n}".`,
    styleList: 'Phong cách trả lời (gõ `/output-style <tên>`; thêm `--save` để đặt làm mặc định)',
    agentsTitle: 'Agent con',
    agentsTip: '`/agents new <tên>` tạo mẫu trong `.locaith/agents`, `/agents open <tên>` mở tệp định nghĩa.',
    agentExists: (f: string) => `Đã có tệp ${f}.`,
    agentCreated: (f: string) => `Đã tạo ${f} — sửa phần mô tả và vai trò rồi lưu, danh sách tự làm mới.`,
    agentNoFile: (n: string) => `Agent "${n}" là agent dựng sẵn, không có tệp.`,
    agentUnknown: (n: string) => `Không có agent "${n}".`,
    needFolder: 'Hãy mở một thư mục dự án trước.',
    needTrust: 'Workspace chưa được tin cậy: không tạo tệp.',
    mcpTitle: 'Máy chủ MCP',
    mcpNone: 'Chưa có máy chủ MCP nào. Thêm trong bảng MCP vừa mở.',
    shellAsk: 'Lệnh tuỳ chỉnh muốn chạy',
  },
  en: {
    review: 'Review uncommitted changes / current branch (no edits)',
    simplify: 'Review recent changes for reuse, simplicity, efficiency, then fix',
    security: 'Security review of the changes',
    status: 'Version, account, model, permission mode, MCP, context',
    doctor: 'Diagnose the environment: shell, git, node, write access, connection',
    agents: 'List sub-agents — /agents new <name> creates a template',
    style: 'Choose the reply style — /output-style <name>',
    mcp: 'Open the MCP panel',
    project: 'project',
    user: 'user',
    plugin: 'plugin',
    builtin: 'built-in',
    workspace: 'project',
    cmdWarn: 'Custom command problem',
    embedded: (n: number) => `Embedded ${n} file(s)`,
    refused: (n: number) => `${n} embedded command(s) not run (not allowed or workspace not trusted)`,
    styleSet: (n: string) => `Reply style for this conversation: **${n}**.`,
    styleSaved: 'Saved as default (setting `agent.outputStyle`).',
    styleUnknown: (n: string) => `No style named "${n}".`,
    styleList: 'Reply styles (type `/output-style <name>`; add `--save` to make it the default)',
    agentsTitle: 'Sub-agents',
    agentsTip: '`/agents new <name>` creates a template in `.locaith/agents`, `/agents open <name>` opens its file.',
    agentExists: (f: string) => `${f} already exists.`,
    agentCreated: (f: string) => `Created ${f} — edit the description and role, then save; the list refreshes itself.`,
    agentNoFile: (n: string) => `"${n}" is a built-in agent with no file.`,
    agentUnknown: (n: string) => `No agent named "${n}".`,
    needFolder: 'Open a project folder first.',
    needTrust: 'Workspace is not trusted: no file created.',
    mcpTitle: 'MCP servers',
    mcpNone: 'No MCP servers yet. Add one in the MCP panel that just opened.',
    shellAsk: 'A custom command wants to run',
  },
};

export function agentTemplate(name: string, lang: Lang): string {
  return lang === 'en'
    ? `---\nname: ${name}\ndescription: One sentence: when should the main assistant hand work to this agent?\ntools: readonly\nmodel: inherit\ncolor: blue\n---\nYou are ${name}. Describe the role, what to look at first, what never to do, and the exact report format to return.\n`
    : `---\nname: ${name}\ndescription: Một câu: khi nào trợ lý chính nên giao việc cho agent này?\ntools: readonly\nmodel: inherit\ncolor: blue\n---\nBạn là ${name}. Mô tả vai trò, việc cần xem trước tiên, điều không bao giờ được làm và khuôn báo cáo cần trả về.\n`;
}

async function countFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** Đăng ký mọi thứ của lane. `ctl` là ChatController (chỉ dùng `commandsLaneAccess()`). */
export function registerCommandsSlash(reg: SlashRegistry, ctl: { commandsLaneAccess(): CommandsLaneAccess }): CommandsLaneState {
  const a = ctl.commandsLaneAccess();
  const home = a.host.homeDir ?? os.homedir();
  const setting = <T>(k: string, d: T): T => {
    try {
      return a.deps.config.get<T>(k, d) ?? d;
    } catch {
      return d;
    }
  };

  const lang = (): Lang => (a.deps.config.language?.() === 'en' ? 'en' : 'vi');
  const state: CommandsLaneState = {
    commands: [],
    styles: builtinOutputStyles(),
    warnings: [],
    async reload() {
      const roots = folders();
      const dirs = commandDirectories({ roots, home, trusted: trusted(), readClaudeDir: setting<boolean>('commands.readClaudeDir', true) !== false });
      const r = await loadCommandDirs(a.host, dirs);
      const fresh = r.warnings.filter((w) => !state.warnings.includes(w));
      state.commands = r.commands;
      state.warnings = r.warnings;
      state.styles = await loadOutputStyles(a.host, [
        ...roots.map((p) => ({ path: path.join(p, '.locaith', 'output-styles'), source: 'project' as const })),
        { path: path.join(home, '.locaith', 'output-styles'), source: 'user' as const },
      ]);
      reg.replaceSource('project', r.commands.filter((c) => c.source === 'project').map(toDef));
      reg.replaceSource('user', r.commands.filter((c) => c.source === 'user').map(toDef));
      a.refreshMenu();
      // Lỗi frontmatter: MỘT dòng cảnh báo cho mỗi lỗi mới (không lặp lại mỗi lần làm mới).
      for (const w of fresh.slice(0, 3)) {
        a.deps.logger.log('warn', `${L.vi.cmdWarn}: ${w}`);
        a.notice('warn', `${L[lang()].cmdWarn}: ${w}`);
      }
    },
    defaultStyle() {
      const want = String(setting('agent.outputStyle', 'default') || 'default').toLowerCase();
      if (want === 'default') return null;
      const st = state.styles.find((s) => s.name === want);
      return st && st.prompt ? { name: st.name, prompt: st.prompt } : null;
    },
  };
  STATES.set(ctl, state);

  const toDef = (c: CustomCommand): SlashCommandDef => ({
    name: c.name,
    description: { vi: c.description, en: c.description },
    ...(c.argumentHint ? { argHint: c.argumentHint } : {}),
    source: c.source === 'plugin' ? 'plugin' : c.source,
    run: async (ctx) => {
      try {
        await runCustom(c, ctx);
      } catch (err) {
        ctx.warn(`/${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  const runCustom = async (c: CustomCommand, ctx: SlashContext): Promise<void> => {
    const t = L[ctx.lang];
    const abort = new AbortController();
    const r = await expandCustomCommand(c, ctx.args, {
      host: a.host,
      trusted: trusted(),
      signal: abort.signal,
      confirmShell: async (command) => {
        const d = await a.host.requestPermission(
          { id: `cmd-${Date.now().toString(36)}`, callId: `slash-${c.name}`, tool: 'run_command', kind: 'command', title: `${t.shellAsk} (/${c.name})`, detail: c.file, command, canAllowSession: false },
          abort.signal,
        );
        return d.decision !== 'deny';
      },
    });
    const notes = [r.notes.embedded.length ? t.embedded(r.notes.embedded.length) : '', r.notes.refused.length ? t.refused(r.notes.refused.length) : ''].filter(Boolean);
    if (notes.length) (r.notes.refused.length ? ctx.warn : ctx.info)(notes.join(' · '));
    await ctx.runPrompt(r.prompt);
  };

  // ── Công cụ cho model ──
  try {
    if (!a.registry.get(SLASH_TOOL_NAME)) a.registry.register(createSlashCommandTool({ commands: () => state.commands, trusted }));
  } catch (err) {
    a.deps.logger.log('warn', `slash_command: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Lệnh dựng sẵn ── (lỗi của một lệnh thành MỘT dòng cảnh báo trong khung chat, không ném ra controller)
  const d = (vi: string, en: string) => ({ vi, en });
  const register = (def: SlashCommandDef) =>
    reg.register({
      ...def,
      run: async (ctx) => {
        try {
          await def.run(ctx);
        } catch (err) {
          ctx.warn(`/${def.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  register({ name: 'review', description: d(L.vi.review, L.en.review), argHint: '[branch|path]', run: (ctx) => ctx.runPrompt(reviewPrompt(ctx.args)) });
  register({ name: 'simplify', description: d(L.vi.simplify, L.en.simplify), argHint: '[path]', run: (ctx) => ctx.runPrompt(simplifyPrompt(ctx.args)) });
  register({ name: 'security-review', description: d(L.vi.security, L.en.security), argHint: '[branch|path]', run: (ctx) => ctx.runPrompt(securityReviewPrompt(ctx.args)) });
  register({ name: 'status', description: d(L.vi.status, L.en.status), needsIdle: false, run: async (ctx) => ctx.info(formatStatus(await collectStatus(a, state), ctx.lang)) });
  register({ name: 'doctor', description: d(L.vi.doctor, L.en.doctor), needsIdle: false, run: async (ctx) => ctx.info(formatDoctor(await collectDoctor(a, ctx.lang), ctx.lang)) });
  register({
    name: 'agents',
    description: d(L.vi.agents, L.en.agents),
    argHint: '[new|open <name>]',
    needsIdle: false,
    run: (ctx) => agentsCommand(a, ctx, home),
  });
  register({
    name: 'output-style',
    description: d(L.vi.style, L.en.style),
    argHint: '[name]',
    needsIdle: false,
    run: (ctx) => outputStyleCommand(a, state, ctx),
  });
  register({
    name: 'mcp',
    description: d(L.vi.mcp, L.en.mcp),
    needsIdle: false,
    run: async (ctx) => {
      const t = L[ctx.lang];
      const list = a.deps.mcp.status();
      ctx.info(list.length ? `**${t.mcpTitle}**\n${list.map((s) => `- ${s.status === 'running' ? '✓' : '⚠'} ${s.name} — ${s.status}${s.tools.length ? ` · ${s.tools.length}` : ''}${s.error ? ` · ${s.error.slice(0, 120)}` : ''}`).join('\n')}` : t.mcpNone);
      await a.showScreen('market');
    },
  });

  // ── Theo dõi tệp: lệnh, phong cách, agent ──
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (agents: boolean) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void state.reload().catch((e) => a.deps.logger.log('warn', `commands reload: ${e instanceof Error ? e.message : String(e)}`));
      if (agents) void reloadAgents(a, home);
    }, 300);
  };
  const ws = vscode.workspace as unknown as { createFileSystemWatcher?: (g: unknown) => vscode.FileSystemWatcher };
  const RP = (vscode as unknown as { RelativePattern?: new (base: unknown, pattern: string) => unknown }).RelativePattern;
  if (typeof ws.createFileSystemWatcher === 'function') {
    const patterns: unknown[] = ['**/.locaith/{commands,output-styles,agents}/**/*.md', '**/.claude/{commands,agents}/**/*.md'];
    if (RP) {
      patterns.push(new RP(vscode.Uri.file(path.join(home, '.locaith')), '{commands,output-styles,agents}/**/*.md'));
      patterns.push(new RP(vscode.Uri.file(path.join(home, '.claude')), '{commands,agents}/**/*.md'));
    }
    for (const p of patterns) {
      try {
        const w = ws.createFileSystemWatcher(p);
        const on = (u: vscode.Uri) => schedule(/[\\/]agents[\\/]/.test(u.fsPath));
        w.onDidCreate(on);
        w.onDidChange(on);
        w.onDidDelete(on);
        a.onDispose(() => w.dispose());
      } catch {
        /* môi trường không hỗ trợ theo dõi tệp: vẫn nạp lúc khởi động */
      }
    }
  }
  a.onDispose(() => {
    if (timer) clearTimeout(timer);
    STATES.delete(ctl);
  });

  // Nạp lần đầu SAU khi controller dựng xong (dòng đăng ký chạy trong constructor, trước khi có phiên/giao diện).
  setTimeout(() => void state.reload().catch((e) => a.deps.logger.log('warn', `commands: ${e instanceof Error ? e.message : String(e)}`)), 0);
  return state;
}

async function reloadAgents(a: CommandsLaneAccess, home: string): Promise<void> {
  try {
    await a.deps.agents.loadDirs(a.host, agentDirectories(folders(), home, a.deps.plugins.agentDirs()));
  } catch (e) {
    a.deps.logger.log('warn', `agents reload: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function agentsCommand(a: CommandsLaneAccess, ctx: SlashContext, home: string): Promise<void> {
  const t = L[ctx.lang];
  const [verb, ...rest] = ctx.args.split(/\s+/).filter(Boolean);
  const v = (verb ?? '').toLowerCase();
  if (v === 'new' || v === 'tao' || v === 'create') {
    const name = slugifyName(rest.join('-'));
    if (!name) return ctx.warn('`/agents new <name>`');
    const root = folders()[0];
    if (!root) return ctx.warn(t.needFolder);
    if (!trusted()) return ctx.warn(t.needTrust);
    const dir = path.join(root, '.locaith', 'agents');
    const file = path.join(dir, `${name}.md`);
    if (await a.host.stat(file)) return ctx.warn(t.agentExists(path.relative(root, file)));
    await mkdir(dir, { recursive: true });
    await writeFile(file, agentTemplate(name, ctx.lang), 'utf8');
    await reloadAgents(a, home);
    ctx.info(t.agentCreated(path.relative(root, file).replace(/\\/g, '/')));
    await openFile(file);
    return;
  }
  if (v === 'open' || v === 'mo') {
    const ag = a.deps.agents.get(rest.join(' '));
    if (!ag) return ctx.warn(t.agentUnknown(rest.join(' ')));
    if (!ag.file) return ctx.info(t.agentNoFile(ag.name));
    await openFile(ag.file);
    return;
  }
  const groups = new Map<string, string[]>();
  for (const ag of a.deps.agents.list()) {
    const label = (t as Record<string, unknown>)[ag.source] as string;
    const tools = Array.isArray(ag.tools) ? ag.tools.join(', ') : ag.tools;
    const line = `- **${ag.name}** (${ag.model ?? ag.tier}, ${tools}) — ${ag.description.slice(0, 160)}${ag.file ? ` · \`${ag.file.replace(home, '~').replace(/\\/g, '/')}\`` : ''}`;
    groups.set(label, [...(groups.get(label) ?? []), line]);
  }
  const body = [...groups.entries()].map(([k, lines]) => `*${k}*\n${lines.join('\n')}`).join('\n\n');
  ctx.info(`**${t.agentsTitle}**\n\n${body}\n\n${t.agentsTip}`);
}

async function outputStyleCommand(a: CommandsLaneAccess, state: CommandsLaneState, ctx: SlashContext): Promise<void> {
  const t = L[ctx.lang];
  const words = ctx.args.split(/\s+/).filter(Boolean);
  const save = words.includes('--save');
  const want = words.filter((w) => w !== '--save').join('-').toLowerCase();
  const session = a.session();
  const current = session.outputStyle?.name ?? state.defaultStyle()?.name ?? 'default';
  if (!want) {
    const lines = state.styles.map((s) => `- ${s.name === current ? '●' : '○'} **${s.name}** — ${s.description[ctx.lang]}${s.source !== 'builtin' ? ` (${(t as Record<string, unknown>)[s.source]})` : ''}`);
    return ctx.info(`**${t.styleList}**\n${lines.join('\n')}`);
  }
  const st = state.styles.find((s) => s.name === want);
  if (!st) return ctx.warn(t.styleUnknown(want));
  session.outputStyle = { name: st.name, prompt: st.prompt };
  let msg = t.styleSet(st.name);
  if (save) {
    try {
      await vscode.workspace.getConfiguration('locaithAgent').update('agent.outputStyle', st.name, vscode.ConfigurationTarget.Global);
      msg += ' ' + t.styleSaved;
    } catch {
      /* không lưu được cài đặt: vẫn áp cho phiên */
    }
  }
  ctx.info(msg);
}

async function openFile(file: string): Promise<void> {
  const win = vscode.window as unknown as { showTextDocument?: (u: vscode.Uri) => Promise<unknown> };
  try {
    await win.showTextDocument?.(vscode.Uri.file(file));
  } catch {
    /* không mở được editor (Remote/không đầu): đường dẫn đã có trong thông báo */
  }
}

export async function collectStatus(a: CommandsLaneAccess, state: CommandsLaneState): Promise<import('./commandsReport').StatusInfo> {
  const s = a.session();
  const view = a.deps.account?.view();
  const settings = a.deps.config.engine();
  const instr = await loadProjectInstructions(a.host, settings.instructionFiles).catch(() => null);
  const home = a.host.homeDir ?? os.homedir();
  const hooks = a.deps.config.get<unknown>('hooks', undefined);
  const roots = folders();
  let memoryFiles = await countFiles(path.join(home, '.locaith', 'memory'));
  for (const r of roots) memoryFiles += await countFiles(path.join(r, '.locaith', 'memory'));
  const pkg = (a.deps.context as unknown as { extension?: { packageJSON?: { version?: string } } }).extension?.packageJSON;
  return {
    version: pkg?.version ?? '?',
    account: a.deps.account ? { signedIn: a.deps.account.usable, who: view?.user?.email || view?.user?.name } : null,
    provider: s.provider,
    model: s.model,
    mode: s.mode,
    thinking: s.thinkingLevel,
    swarm: s.swarm === true,
    contextWindow: a.deps.providers.contextWindow(s.provider, s.model),
    lastContextTokens: s.lastContextTokens ?? 0,
    mcp: (a.deps.mcp.status() ?? []).map((m) => ({ name: m.name, status: m.status, tools: m.tools.length })),
    hooks: hooks && typeof hooks === 'object' ? Object.keys(hooks as object).length : null,
    instructions: instr?.file ?? null,
    memoryFiles,
    outputStyle: s.outputStyle?.name ?? state.defaultStyle()?.name ?? 'default',
    commands: {
      project: state.commands.filter((c) => c.source === 'project').length,
      user: state.commands.filter((c) => c.source === 'user').length,
      plugin: a.deps.plugins.commands()?.length ?? 0,
    },
    agents: a.deps.agents.list()?.length ?? 0,
    skillsLoaded: [...s.loadedSkills],
    trusted: trusted(),
  };
}

export async function collectDoctor(a: CommandsLaneAccess, lang: Lang): Promise<DoctorCheck[]> {
  const vi = lang === 'vi';
  const out: DoctorCheck[] = [];
  const home = a.host.homeDir ?? os.homedir();
  // Lệnh cố định, chạy ở thư mục cá nhân (KHÔNG ở workspace: một kho lạ có thể cài cấu hình git độc).
  const probe = async (command: string): Promise<{ ok: boolean; out: string }> => {
    const ac = new AbortController();
    try {
      const r = await a.host.runCommand({ command, cwd: home, timeoutMs: 10_000, signal: ac.signal, onData: () => undefined });
      return { ok: r.exitCode === 0 && !r.timedOut, out: r.output.trim().split('\n')[0]?.slice(0, 120) ?? '' };
    } catch (e) {
      return { ok: false, out: e instanceof Error ? e.message : String(e) };
    }
  };
  const shell = await probe('echo ok');
  out.push({ ok: shell.ok, label: 'Shell', detail: `${a.host.platform.shellLabel}${shell.ok ? '' : ` — ${shell.out}`}`, fix: vi ? 'Kiểm tra cài đặt terminal mặc định của VS Code / PowerShell có khởi động được không.' : 'Check that the default VS Code terminal shell starts.' });
  const git = await probe('git --version');
  out.push({ ok: git.ok, label: 'Git', detail: git.ok ? git.out : vi ? 'không tìm thấy' : 'not found', fix: vi ? 'Cài Git (git-scm.com) và mở lại VS Code.' : 'Install Git (git-scm.com) and restart VS Code.' });
  const node = await probe('node --version');
  out.push({ ok: node.ok, label: 'Node.js', detail: node.ok ? node.out : vi ? 'không tìm thấy (chỉ cần cho dự án JS/TS)' : 'not found (only needed for JS/TS projects)', fix: vi ? 'Cài Node.js LTS nếu dự án cần.' : 'Install Node.js LTS if the project needs it.' });
  const roots = folders();
  const tr = trusted();
  out.push({
    ok: roots.length > 0 && tr,
    label: vi ? 'Workspace' : 'Workspace',
    detail: roots.length === 0 ? (vi ? 'chưa mở thư mục' : 'no folder open') : tr ? (vi ? `đã tin cậy · ${roots.length} thư mục` : `trusted · ${roots.length} folder(s)`) : vi ? 'chưa tin cậy — chỉ đọc' : 'not trusted — read-only',
    fix: roots.length === 0 ? (vi ? 'Mở một thư mục dự án (File › Open Folder).' : 'Open a project folder (File › Open Folder).') : vi ? 'Chạy lệnh «Workspaces: Manage Workspace Trust» và chọn Trust.' : 'Run “Workspaces: Manage Workspace Trust” and choose Trust.',
  });
  if (roots[0]) {
    let writable = true;
    try {
      await access(roots[0], fsConstants.W_OK);
    } catch {
      writable = false;
    }
    out.push({ ok: writable, label: vi ? 'Quyền ghi' : 'Write access', detail: writable ? (vi ? 'ghi được vào workspace' : 'workspace is writable') : vi ? 'không ghi được vào workspace' : 'workspace is not writable', fix: vi ? 'Kiểm tra quyền thư mục hoặc thuộc tính chỉ-đọc.' : 'Check folder permissions / read-only flag.' });
  }
  if (a.deps.account) {
    const v = a.deps.account.view();
    out.push({ ok: a.deps.account.usable, label: vi ? 'Tài khoản' : 'Account', detail: a.deps.account.usable ? (v.offline ? (vi ? 'đã đăng nhập (đang ngoại tuyến)' : 'signed in (offline)') : vi ? 'đã đăng nhập' : 'signed in') : vi ? 'chưa đăng nhập' : 'signed out', fix: vi ? 'Bấm Đăng nhập trong khung chat.' : 'Click Sign in in the chat panel.' });
  }
  const s = a.session();
  try {
    const sums = await a.deps.providers.summaries();
    const p = sums.find((x) => x.id === s.provider);
    if (p) out.push({ ok: p.hasKey || !!p.keyFromEnv || p.id === 'demo', label: vi ? 'Kết nối model' : 'Model connection', detail: `${p.label}${p.modelError ? ` — ${p.modelError.slice(0, 120)}` : ''}`, fix: vi ? 'Nhập khoá API của nhà cung cấp trong Cài đặt.' : 'Enter the provider API key in Settings.' });
  } catch {
    /* bỏ qua */
  }
  const size = JSON.stringify(s.messages).length;
  out.push({ ok: size < 4_000_000, label: vi ? 'Dung lượng phiên' : 'Session size', detail: `${Math.round(size / 1024)} KB`, fix: vi ? 'Gõ /compact để nén hoặc /new để bắt đầu phiên mới.' : 'Run /compact or start a new chat with /new.' });
  const cw = a.deps.providers.contextWindow(s.provider, s.model);
  if (cw > 0 && s.lastContextTokens) {
    const pct = Math.round((s.lastContextTokens / cw) * 100);
    out.push({ ok: pct < 80, label: vi ? 'Ngữ cảnh' : 'Context', detail: `${pct}%`, fix: vi ? 'Gõ /compact để giải phóng ngữ cảnh.' : 'Run /compact to free context.' });
  }
  return out;
}
