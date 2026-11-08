/**
 * Mô-đun 4 — MCP. `McpManager` (core/mcp/*) giữ vòng đời server và dựng công cụ `mcp__<server>__<tool>`; ở đây là phần CLI:
 *   • nguồn cấu hình (lược đồ Claude: `{command,args,env}` stdio / `{url}` http): cài đặt `mcpServers` CẤP NGƯỜI DÙNG, `~/.locaith/mcp.json`,
 *     `--mcp-config` (đọc `cli.mcpConfig`), plugin đang bật, và `.mcp.json` / `.locaith/mcp.json` / `mcpServers` của DỰ ÁN (cần tin cậy +
 *     người dùng duyệt TỪNG server; không tương tác → không chạy). `${VAR}` / `${VAR:-mặc định}` được mở rộng từ môi trường;
 *   • khởi động NỀN, không chặn; công cụ vào registry qua `addToolContributor`; chỉ dẫn server vào system prompt qua `addPromptContributor`;
 *   • trạng thái duyệt / tắt / quyền theo công cụ lưu ở `~/.locaith/mcp-state.json`;
 *   • prompt do server cung cấp thành lệnh gạch chéo nguồn `mcp` (`/mcp__server__prompt`);
 *   • `/mcp` (danh sách, enable/disable, reload, tool/group policy).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitArgs } from '../../../core/commands/custom';
import { McpClient, sanitizeServerConfig, type McpClientHooks, type McpServerConfig } from '../../../core/mcp/client';
import { McpManager, type McpServerEntry, type McpServerStatus, type McpToolPolicy } from '../../../core/mcp/manager';
import { ToolRegistry } from '../../../core/engine/toolRegistry';
import type { FeatureContext, FeatureModule, FeatureSlashDef } from '../contract';
import { askUser, makeTr, oneLine } from './ext';
import { activePlugins, onPluginsChanged } from './plugins';
import { readJsonFile, strList } from './settingsFile';

const tr = makeTr('mcp', {
  none: ['Chưa có server MCP nào. Thêm vào `~/.locaith/mcp.json`, `.mcp.json` của dự án, hoặc `/mcp add`… (xem `/mcp help`).', 'No MCP servers yet. Add them to `~/.locaith/mcp.json`, the project’s `.mcp.json` (see `/mcp help`).'],
  head: ['**Server MCP** ({n})', '**MCP servers** ({n})'],
  st_running: ['đang chạy', 'running'],
  st_starting: ['đang khởi động', 'starting'],
  st_stopped: ['đã tắt', 'stopped'],
  st_error: ['lỗi', 'error'],
  st_pending: ['chờ duyệt', 'awaiting approval'],
  st_untrusted: ['thư mục chưa tin cậy', 'folder not trusted'],
  tools: ['{n} công cụ', '{n} tool(s)'],
  scopeUser: ['cá nhân', 'user'],
  scopeWorkspace: ['dự án', 'project'],
  scopePlugin: ['plugin', 'plugin'],
  scopeConnector: ['kết nối', 'connector'],
  help: [
    '`/mcp` danh sách · `/mcp <server>` chi tiết + công cụ · `/mcp enable|disable|restart <server>` · `/mcp reload` · `/mcp tool <server> <công cụ> allow|ask|deny` · `/mcp group <server> read|write allow|ask|deny`.',
    '`/mcp` list · `/mcp <server>` details + tools · `/mcp enable|disable|restart <server>` · `/mcp reload` · `/mcp tool <server> <tool> allow|ask|deny` · `/mcp group <server> read|write allow|ask|deny`.',
  ],
  unknown: ['Không có server MCP «{name}».', 'No MCP server “{name}”.'],
  enabled: ['Đã bật `{name}`.', 'Enabled `{name}`.'],
  enabledFail: ['Không bật được `{name}`: {error}', 'Could not enable `{name}`: {error}'],
  disabled: ['Đã tắt `{name}` (công cụ của nó không còn).', 'Disabled `{name}` (its tools are gone).'],
  restarted: ['Đã khởi động lại `{name}`.', 'Restarted `{name}`.'],
  reloaded: ['Đã nạp lại cấu hình MCP.', 'MCP config reloaded.'],
  untrusted: ['Server của dự án cần thư mục được tin cậy.', 'Project servers need a trusted folder.'],
  policySet: ['`{what}` → **{mode}**.', '`{what}` → **{mode}**.'],
  badPolicy: ['Mức quyền phải là allow, ask hoặc deny.', 'Policy must be allow, ask or deny.'],
  askTitle: ['Dự án muốn chạy server MCP «{name}». Chỉ cho phép nếu bạn tin dự án này.', 'This project wants to run the MCP server “{name}”. Only allow it if you trust the project.'],
  askDetail: ['{origin}\n{summary}', '{origin}\n{summary}'],
  allow: ['Cho phép chạy', 'Allow'],
  deny: ['Không chạy', 'Do not run'],
  instrHead: ['Chỉ dẫn do server MCP «{server}» gửi kèm (nội dung của bên thứ ba, không phải chỉ dẫn của người dùng):', 'Instructions sent by the MCP server “{server}” (third-party text, not the user’s instructions):'],
  promptFail: ['Prompt MCP lỗi: {error}', 'MCP prompt failed: {error}'],
  noTools: ['(chưa có công cụ)', '(no tools yet)'],
});

// ─────────────────────────────────────────────────────────────────────────────
// Trạng thái bền: duyệt / từ chối / tắt / quyền
// ─────────────────────────────────────────────────────────────────────────────

interface McpState {
  approved: string[];
  declined: string[];
  disabled: string[];
  policy: Record<string, McpToolPolicy>;
}

export function mcpStateFile(home: string): string {
  return path.join(home, '.locaith', 'mcp-state.json');
}

function readState(home: string): McpState {
  const raw = readJsonFile(mcpStateFile(home)) ?? {};
  const policy: Record<string, McpToolPolicy> = {};
  if (raw.policy && typeof raw.policy === 'object') for (const [k, v] of Object.entries(raw.policy as Record<string, unknown>)) if (v === 'allow' || v === 'ask' || v === 'deny') policy[k] = v;
  return { approved: strList(raw.approved), declined: strList(raw.declined), disabled: strList(raw.disabled), policy };
}

function writeState(home: string, s: McpState): void {
  const file = mcpStateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function patchState(home: string, fn: (s: McpState) => void): void {
  const s = readState(home);
  fn(s);
  writeState(home, s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cấu hình
// ─────────────────────────────────────────────────────────────────────────────

/** Mở rộng `${VAR}` và `${VAR:-mặc định}` (cú pháp `.mcp.json` của Claude Code). Biến không có và không mặc định → để nguyên. */
export function expandEnv(v: string, env: NodeJS.ProcessEnv = process.env): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name: string, def?: string) => env[name] ?? def ?? m);
}

export function expandConfig(cfg: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const mapObj = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expandEnv(x, env)])) : undefined);
  return {
    ...cfg,
    ...(cfg.command ? { command: expandEnv(cfg.command, env) } : {}),
    ...(cfg.args ? { args: cfg.args.map((a) => expandEnv(a, env)) } : {}),
    ...(cfg.env ? { env: mapObj(cfg.env) } : {}),
    ...(cfg.url ? { url: expandEnv(cfg.url, env) } : {}),
    ...(cfg.headers ? { headers: mapObj(cfg.headers) } : {}),
  };
}

/** Bảng server từ một đối tượng JSON `{mcpServers:{…}}` hoặc bảng phẳng. */
export function parseServers(raw: unknown, scope: McpServerEntry['scope'], origin: string, baseDir?: string): McpServerEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const table = (obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj) as Record<string, unknown>;
  const out: McpServerEntry[] = [];
  for (const [name, v] of Object.entries(table).slice(0, 64)) {
    const cfg = sanitizeServerConfig(v);
    if (!cfg || !/^[\w.:-]{1,60}$/.test(name)) continue;
    const full = expandConfig(cfg);
    out.push({ name, cfg: { ...full, cwd: full.cwd ?? (full.command && baseDir ? baseDir : undefined) }, scope, origin });
  }
  return out;
}

function readServersFile(file: string, scope: McpServerEntry['scope'], origin: string): McpServerEntry[] {
  return parseServers(readJsonFile(file), scope, origin, path.dirname(file));
}

/** `--mcp-config`: đường dẫn tệp hoặc chuỗi JSON. */
function readCliConfig(spec: string, cwd: string): McpServerEntry[] {
  const s = spec.trim();
  if (s.startsWith('{')) {
    try {
      return parseServers(JSON.parse(s), 'user', '--mcp-config');
    } catch {
      return [];
    }
  }
  const file = path.resolve(cwd, s);
  return readServersFile(file, 'user', `--mcp-config ${path.basename(file)}`);
}

/** Mọi server khai báo (kể cả cái người dùng đã tắt). */
export async function collectAll(ctx: FeatureContext): Promise<McpServerEntry[]> {
  const entries: McpServerEntry[] = [];
  // 1) người dùng tự khai: cài đặt cấp user + ~/.locaith/mcp.json + --mcp-config
  const userSettings = readJsonFile(ctx.settings.file('user'));
  entries.push(...parseServers((userSettings as Record<string, unknown> | null)?.mcpServers, 'user', 'settings'));
  entries.push(...readServersFile(path.join(ctx.home, '.locaith', 'mcp.json'), 'user', '~/.locaith/mcp.json'));
  for (const spec of strList(ctx.settings.get<unknown>('cli.mcpConfig', []))) entries.push(...readCliConfig(spec, ctx.cwd));
  // 2) dự án: chỉ khi thư mục đã tin cậy; từng server vẫn phải được duyệt
  if (ctx.isTrusted()) {
    for (const rel of ['.mcp.json', path.join('.locaith', 'mcp.json')]) entries.push(...readServersFile(path.join(ctx.cwd, rel), 'workspace', rel.replace(/\\/g, '/')));
    for (const scope of ['project', 'local'] as const) {
      const f = ctx.settings.file(scope);
      entries.push(...parseServers((readJsonFile(f) as Record<string, unknown> | null)?.mcpServers, 'workspace', path.relative(ctx.cwd, f).replace(/\\/g, '/'), ctx.cwd));
    }
  }
  // 3) plugin đang bật (cũng cần duyệt)
  for (const p of await activePlugins(ctx)) {
    for (const [name, cfg] of Object.entries(p.mcpServers)) entries.push({ name, cfg: expandConfig(cfg), scope: 'plugin', origin: p.name });
  }
  return entries;
}

export const isDisabled = (home: string, name: string): boolean => readState(home).disabled.includes(name);

const summaryOf = (cfg: McpServerConfig): string => cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(' ').slice(0, 300);

// ─────────────────────────────────────────────────────────────────────────────
// Dịch vụ
// ─────────────────────────────────────────────────────────────────────────────

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export class McpService {
  readonly mgr: McpManager;
  private readonly clients = new Map<string, McpClient>();
  private readonly prompts = new Map<string, McpPrompt[]>();
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private started: Promise<void> = Promise.resolve();
  private all: McpServerEntry[] = [];
  private readonly offChange: () => void;
  private statusRef: { refresh(): void } | null = null;

  constructor(private readonly ctx: FeatureContext, private readonly onPrompts: () => void) {
    this.mgr = new McpManager({
      log: (level, msg) => ctx.log(level, msg),
      version: ctx.version,
      workspaceTrusted: () => ctx.isTrusted(),
      approvals: { get: () => readState(ctx.home).approved, set: (v) => patchState(ctx.home, (s) => void (s.approved = v)) },
      toolPolicy: { get: () => readState(ctx.home).policy, set: (v) => patchState(ctx.home, (s) => void (s.policy = v)) },
      clientFactory: (name, cfg, hooks: McpClientHooks) => {
        const c = new McpClient(name, cfg, hooks);
        this.clients.set(name, c);
        return c;
      },
    });
    this.offChange = this.mgr.onChange(() => {
      this.statusRef?.refresh();
      this.schedulePrompts();
    });
  }

  setStatus(ref: { refresh(): void }): void {
    this.statusRef = ref;
  }

  /** Nạp lại cấu hình và (nền) khởi động server đã được duyệt. Trả về khi `configure` xong; gọi `ready()` để chờ cả khởi động. */
  reload(): Promise<void> {
    const p = collectAll(this.ctx)
      .then((entries) => {
        this.all = entries;
        const off = new Set(readState(this.ctx.home).disabled);
        return this.mgr.configure(entries.filter((e) => !off.has(e.name)));
      })
      .then(() => this.askApprovals())
      .catch((e) => this.ctx.log('warn', `MCP: ${e instanceof Error ? e.message : String(e)}`));
    this.started = p;
    return p;
  }

  ready(): Promise<void> {
    return this.started;
  }

  /** Hỏi người dùng duyệt từng server của dự án/plugin chưa duyệt (chỉ khi tương tác và thư mục đã tin cậy). */
  private async askApprovals(): Promise<void> {
    if (!this.ctx.interactive) return;
    const declined = new Set(readState(this.ctx.home).declined);
    for (const s of this.mgr.status()) {
      if (s.approved || s.scope === 'user' || s.scope === 'connector') continue;
      if (s.scope === 'workspace' && !this.ctx.isTrusted()) continue;
      const key = `${s.scope}:${s.name}:${s.summary}`;
      if (declined.has(key)) continue;
      const lang = this.ctx.lang;
      const ans = await askUser(this.ctx, {
        kind: 'confirm',
        title: tr(lang, 'askTitle', { name: s.name }),
        detail: tr(lang, 'askDetail', { origin: s.origin ?? '', summary: s.summary }),
        yes: tr(lang, 'allow'),
        no: tr(lang, 'deny'),
        defaultYes: false,
        danger: true,
      });
      if (ans === true) await this.mgr.enable(s.name).catch(() => undefined);
      else patchState(this.ctx.home, (st) => void st.declined.push(key));
    }
  }

  /** Danh sách hiển thị: server đang quản lý + server người dùng đã tắt (không nằm trong quản lý nên tự dựng dòng). */
  rows(): McpServerStatus[] {
    const live = this.mgr.status();
    const off = new Set(readState(this.ctx.home).disabled);
    const extra: McpServerStatus[] = this.all
      .filter((e) => off.has(e.name) && !live.some((l) => l.name === e.name))
      .map((e) => ({ name: e.name, scope: e.scope, origin: e.origin, transport: e.cfg.url ? ('http' as const) : ('stdio' as const), status: 'stopped' as const, approved: true, summary: summaryOf(e.cfg), tools: [], groupPolicy: { read: 'ask' as const, write: 'ask' as const } }));
    return [...live, ...extra];
  }

  /** Các công cụ MCP đang chạy, dưới dạng ToolDef (mgr dựng sẵn); gọi ở mỗi lần runtime dựng registry. */
  tools(): unknown[] {
    const tmp = new ToolRegistry();
    const detach = this.mgr.attach(tmp);
    detach();
    return tmp.all();
  }

  instructionsBlock(): string | null {
    const list = this.mgr.instructions();
    if (!list.length) return null;
    return list.map((i) => `${tr(this.ctx.lang, 'instrHead', { server: i.server })}\n<mcp_server name="${i.server.replace(/[^\w.-]/g, '_')}">\n${i.text}\n</mcp_server>`).join('\n\n');
  }

  // ── prompt MCP → lệnh gạch chéo ──
  private schedulePrompts(): void {
    if (this.promptTimer) return;
    this.promptTimer = setTimeout(() => {
      this.promptTimer = undefined;
      void this.refreshPrompts();
    }, 250);
  }

  async refreshPrompts(): Promise<void> {
    let changed = false;
    for (const [name, c] of this.clients) {
      if (c.status !== 'running') {
        if (this.prompts.delete(name)) changed = true;
        continue;
      }
      if (this.prompts.has(name)) continue;
      try {
        const r = (await c.request('prompts/list', {}, { timeoutMs: 15_000 })) as { prompts?: McpPrompt[] } | undefined;
        this.prompts.set(name, (r?.prompts ?? []).filter((p) => p && typeof p.name === 'string'));
      } catch {
        this.prompts.set(name, []); // server không hỗ trợ prompts
      }
      changed = true;
    }
    if (changed) this.onPrompts();
  }

  slashDefs(): FeatureSlashDef[] {
    const out: FeatureSlashDef[] = [];
    for (const [server, list] of this.prompts) {
      for (const p of list) {
        const name = `mcp__${server.replace(/[^a-zA-Z0-9_-]+/g, '_')}__${p.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}`.toLowerCase();
        const argNames = (p.arguments ?? []).map((a) => a.name);
        out.push({
          name,
          description: { vi: `[MCP · ${server}] ${p.description ?? p.name}`, en: `[MCP · ${server}] ${p.description ?? p.name}` },
          ...(argNames.length ? { argHint: argNames.map((n, i) => ((p.arguments ?? [])[i]?.required ? `<${n}>` : `[${n}]`)).join(' ') } : {}),
          needsIdle: true,
          run: async (c) => {
            const client = this.clients.get(server);
            if (!client || client.status !== 'running') return c.output(tr(c.lang, 'promptFail', { error: `${server}: ${tr(c.lang, 'st_stopped')}` }), 'error');
            const words = splitArgs(c.args);
            const args: Record<string, string> = {};
            argNames.forEach((n, i) => {
              if (words[i] !== undefined) args[n] = words[i];
            });
            try {
              const r = (await client.request('prompts/get', { name: p.name, arguments: args }, { timeoutMs: 30_000 })) as { messages?: { role?: string; content?: unknown }[] } | undefined;
              const text = (r?.messages ?? [])
                .map((m) => {
                  const ct = m.content as { type?: string; text?: string } | string | undefined;
                  return typeof ct === 'string' ? ct : ct?.type === 'text' ? ct.text ?? '' : '';
                })
                .filter(Boolean)
                .join('\n\n');
              if (!text.trim()) return c.output(tr(c.lang, 'promptFail', { error: 'empty' }), 'error');
              await c.runPrompt(text);
            } catch (e) {
              c.output(tr(c.lang, 'promptFail', { error: e instanceof Error ? e.message : String(e) }), 'error');
            }
          },
        });
      }
    }
    return out;
  }

  // ── trình bày ──
  stateWord(s: McpServerStatus, lang: 'vi' | 'en'): string {
    if (!s.approved) return tr(lang, s.scope === 'workspace' && !this.ctx.isTrusted() ? 'st_untrusted' : 'st_pending');
    return tr(lang, `st_${s.status}`);
  }

  async dispose(): Promise<void> {
    this.offChange();
    if (this.promptTimer) clearTimeout(this.promptTimer);
    await this.started.catch(() => undefined);
    await this.mgr.dispose();
  }
}

const services = new WeakMap<FeatureContext, McpService>();
export const mcpServiceOf = (ctx: FeatureContext): McpService | undefined => services.get(ctx);

export const mcpFeature: FeatureModule = {
  name: 'mcp',
  attach(ctx) {
    const svc = new McpService(ctx, () => ctx.replaceSlashSource('mcp', svc.slashDefs()));
    services.set(ctx, svc);
    ctx.addToolContributor((add) => {
      for (const t of svc.tools()) add(t);
    });
    ctx.addPromptContributor(() => svc.instructionsBlock());
    svc.setStatus(
      ctx.addStatusContributor((s) => {
        const bad = svc.mgr.status().filter((x) => x.approved && x.status === 'error');
        if (bad.length) s.notices.push(`MCP: ${bad.map((b) => b.name).join(', ')} ${tr(ctx.lang, 'st_error')}`);
      }),
    );
    onPluginsChanged(ctx, () => void svc.reload());
    void svc.reload(); // khởi động NỀN: không chặn runtime

    ctx.slash({
      name: 'mcp',
      description: {
        vi: 'Server MCP: trạng thái, bật/tắt, kết nối lại, quyền theo công cụ — /mcp help',
        en: 'MCP servers: status, enable/disable, reconnect, per-tool permissions — /mcp help',
      },
      argHint: '[<server>|enable|disable|restart|reload|tool|group]',
      needsIdle: false, // /mcp (danh sách) là chỉ đọc; thao tác đổi trạng thái an toàn khi đang bận (không đụng phiên)
      async run(c) {
        const lang = c.lang;
        const words = c.args.trim().split(/\s+/).filter(Boolean);
        const verb = (words[0] ?? '').toLowerCase();
        const find = (n: string | undefined) => svc.rows().find((s) => s.name === n);
        if (verb === 'help') return c.output(tr(lang, 'help'));
        if (verb === 'reload') {
          await svc.reload();
          return c.output(tr(lang, 'reloaded'), 'plain');
        }
        if (verb === 'enable' || verb === 'disable' || verb === 'restart') {
          const name = words[1];
          if (!find(name)) return c.output(tr(lang, 'unknown', { name: name ?? '' }), 'error');
          if (verb === 'enable') {
            patchState(ctx.home, (s) => void (s.disabled = s.disabled.filter((x) => x !== name)));
            await svc.reload();
            const st = find(name);
            if (st && !st.approved && st.scope === 'workspace' && !ctx.isTrusted()) return c.output(tr(lang, 'untrusted'), 'error');
            await svc.mgr.enable(name!);
            const after = find(name);
            return after?.status === 'error' ? c.output(tr(lang, 'enabledFail', { name: name!, error: after.error ?? '' }), 'error') : c.output(tr(lang, 'enabled', { name: name! }), 'plain');
          }
          if (verb === 'disable') {
            patchState(ctx.home, (s) => void (s.disabled.includes(name!) || s.disabled.push(name!)));
            await svc.mgr.disable(name!);
            await svc.reload();
            return c.output(tr(lang, 'disabled', { name: name! }), 'plain');
          }
          await svc.mgr.restart(name!);
          return c.output(tr(lang, 'restarted', { name: name! }), 'plain');
        }
        if (verb === 'tool' || verb === 'group') {
          const [, server, a, b] = words;
          if (!find(server)) return c.output(tr(lang, 'unknown', { name: server ?? '' }), 'error');
          const mode = (verb === 'tool' ? b : words[3])?.toLowerCase();
          if (mode !== 'allow' && mode !== 'ask' && mode !== 'deny') return c.output(tr(lang, 'badPolicy'), 'error');
          if (verb === 'tool') await svc.mgr.setToolPolicy(server, a, null, mode);
          else {
            const g = a === 'write' ? 'write' : 'read';
            await svc.mgr.setToolPolicy(server, null, g, mode);
          }
          return c.output(tr(lang, 'policySet', { what: verb === 'tool' ? `${server} › ${a}` : `${server} (${a})`, mode }), 'plain');
        }
        const list = svc.rows();
        if (verb && verb !== 'list') {
          const s = find(words[0]);
          if (!s) return c.output(tr(lang, 'unknown', { name: words[0] }), 'error');
          const tools = s.tools.length ? s.tools.map((t) => `- \`${t.name}\` [${t.group}/${t.policy}] — ${oneLine(t.description, 100)}`).join('\n') : tr(lang, 'noTools');
          return c.output(`**${s.name}** · ${svc.stateWord(s, lang)} · ${s.transport} · ${tr(lang, `scope${s.scope[0].toUpperCase()}${s.scope.slice(1)}`)}\n\`${s.summary}\`${s.error ? `\n⚠ ${s.error}` : ''}\n\n${tools}`);
        }
        if (!list.length) return c.output(tr(lang, 'none'));
        const rows = list.map((s) => `- ${s.status === 'running' && s.approved ? '✓' : '⚠'} **${s.name}** — ${svc.stateWord(s, lang)}${s.tools.length ? ` · ${tr(lang, 'tools', { n: s.tools.length })}` : ''} · ${tr(lang, `scope${s.scope[0].toUpperCase()}${s.scope.slice(1)}`)}${s.error ? ` · ${oneLine(s.error, 120)}` : ''}`);
        c.output([tr(lang, 'head', { n: list.length }), ...rows, '', tr(lang, 'help')].join('\n'));
      },
    });

    ctx.onDispose(() => svc.dispose());
  },
};
