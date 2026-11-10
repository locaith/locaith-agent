/**
 * Dịch vụ plugin (host): tìm plugin ở `~/.locaith/plugins`, `<workspace>/.locaith/plugins` và các đường dẫn người dùng thêm,
 * nhớ plugin nào đang bật (globalState), cài từ thư mục hoặc Git. Plugin chưa bật thì không đóng góp gì.
 * Một plugin mới được tìm thấy mặc định ĐANG TẮT — chỉ khi người dùng bật thì kỹ năng/agent/MCP/lệnh của nó mới có hiệu lực.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverPlugins, loadPluginCommands, type PluginCommand, type PluginInfo } from '../core/plugins/loader';
import { MARKETPLACES, OFFICIAL_MARKETPLACE, fetchAllMarketplaces, installPlugin, installedByMarket, uninstallPlugin, type MergedMarketplace } from '../core/plugins/marketplace';
import type { PluginMarketState } from '../shared/protocol';
import type { McpServerEntry } from '../core/mcp/manager';
import type { ConfigService } from './config';
import type { Logger } from './logger';

const ENABLED_KEY = 'locaithAgent.plugins.enabled';

export class PluginService {
  private found: PluginInfo[] = [];
  private cmds: PluginCommand[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {}

  /** Thư mục cài plugin của người dùng. */
  get userRoot(): string {
    return path.join(os.homedir(), '.locaith', 'plugins');
  }

  roots(): string[] {
    const out: string[] = [this.userRoot];
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') out.push(path.join(f.uri.fsPath, '.locaith', 'plugins'));
    for (const p of this.config.pluginPaths()) out.push(p.replace(/^~(?=$|[\\/])/, os.homedir()));
    return out;
  }

  private enabledSet(): Set<string> {
    return new Set(this.context.globalState.get<string[]>(ENABLED_KEY, []));
  }

  async refresh(): Promise<void> {
    this.found = await discoverPlugins(this.roots());
    const enabled = this.enabledSet();
    const cmds: PluginCommand[] = [];
    for (const p of this.found) if (enabled.has(p.id)) cmds.push(...(await loadPluginCommands(p)));
    this.cmds = cmds;
  }

  list(): (PluginInfo & { enabled: boolean })[] {
    const enabled = this.enabledSet();
    return this.found.map((p) => ({ ...p, enabled: enabled.has(p.id) }));
  }

  private active(): PluginInfo[] {
    const enabled = this.enabledSet();
    return this.found.filter((p) => enabled.has(p.id) && !p.error);
  }

  skillDirs(): string[] {
    return this.active().flatMap((p) => p.skillDirs);
  }

  agentDirs(): string[] {
    return this.active().flatMap((p) => p.agentDirs);
  }

  mcpEntries(): McpServerEntry[] {
    return this.active().flatMap((p) => Object.entries(p.mcpServers).map(([name, cfg]) => ({ name, cfg, scope: 'plugin' as const, origin: p.name })));
  }

  commands(): PluginCommand[] {
    return this.cmds;
  }

  command(name: string): PluginCommand | undefined {
    const n = name.toLowerCase();
    return this.cmds.find((c) => c.name === n);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const s = this.enabledSet();
    if (enabled) s.add(id);
    else s.delete(id);
    await this.context.globalState.update(ENABLED_KEY, [...s]);
    await this.refresh();
  }

  // ── Chợ plugin: marketplace chính thức của Anthropic + các nguồn đã kiểm khác (xem MARKETPLACES) ──
  private mk: { at: number; data: MergedMarketplace } | null = null;
  private mkError: string | undefined;
  private mkLoading = false;
  /** Cho kiểm thử thay `fetch`. */
  fetchImpl: typeof fetch | undefined;

  /** Tải danh sách plugin của mọi nguồn (bộ đệm 1 giờ; `force` bỏ qua bộ đệm). `mkLoading` được bật ĐỒNG BỘ để giao diện thấy ngay trạng thái đang tải. Một nguồn lỗi chỉ làm nguồn đó vắng mặt. */
  async refreshMarketplace(force = false): Promise<void> {
    if (this.mkLoading) return;
    if (!force && this.mk && Date.now() - this.mk.at < 3_600_000) return;
    this.mkLoading = true;
    this.mkError = undefined;
    try {
      const data = await fetchAllMarketplaces(this.fetchImpl);
      const failed = data.sources.filter((s) => s.error);
      if (data.entries.length === 0) this.mkError = failed.map((s) => `${s.source.label}: ${s.error}`).join(' · ') || 'Danh sách plugin rỗng.';
      else if (failed.length > 0) this.mkError = `${this.lang === 'en' ? 'Some sources could not be loaded' : 'Một số nguồn không tải được'}: ${failed.map((s) => s.source.label).join(', ')}.`;
      if (data.entries.length > 0 || !this.mk) this.mk = { at: Date.now(), data };
    } catch (err) {
      this.mkError = err instanceof Error ? err.message : String(err);
    } finally {
      this.mkLoading = false;
    }
  }

  async marketState(): Promise<PluginMarketState> {
    const mine = await installedByMarket(this.userRoot);
    const bySource = new Map(MARKETPLACES.map((m) => [m.id, m]));
    const items = (this.mk?.data.entries ?? []).map((e) => {
      const src = bySource.get(e.market ?? OFFICIAL_MARKETPLACE.repo);
      return {
        id: e.id,
        name: e.name,
        description: e.description,
        category: e.category,
        installed: mine.has(e.id),
        installable: e.source.kind !== 'other',
        ...(e.source.kind === 'other' ? { reason: `Nguồn nằm ngoài GitHub (${new URL(e.source.url).host}) — dùng "Cài từ Git…" nếu bạn tin tưởng.` } : {}),
        // `origin` còn dùng để chọn logo hãng: plugin nằm trong kho của chính chợ thì gắn tên kho (chợ chính thức giữ «anthropics» như trước).
        origin: e.source.kind === 'repo-path' || e.source.kind === 'repo-root' ? (src && src.id !== 'claude-plugins-official' ? `${src.owner}/${src.repo}` : 'anthropics') : e.source.kind === 'github' ? `${e.source.owner}/${e.source.repo}` : new URL(e.source.url).host,
        ...(src ? { market: src.id, trust: src.trust } : {}),
      };
    });
    const sources = (this.mk?.data.sources ?? []).filter((s) => s.count > 0).map((s) => ({ id: s.source.id, label: s.source.label, trust: s.source.trust, count: s.count }));
    return { items, loading: this.mkLoading, ...(this.mkError ? { error: this.mkError } : {}), ...(this.mk ? { fetchedAt: this.mk.at } : {}), source: 'anthropics/claude-plugins-official', ...(sources.length > 0 ? { sources } : {}) };
  }

  async installFromMarket(id: string): Promise<{ ok: boolean; message: string }> {
    const e = this.mk?.data.entries.find((x) => x.id === id);
    if (!e) return { ok: false, message: this.lang === 'en' ? 'Plugin not in the list — reload the list.' : 'Không thấy plugin này trong danh sách (hãy tải lại danh sách).' };
    const src = MARKETPLACES.find((m) => m.id === (e.market ?? OFFICIAL_MARKETPLACE.repo));
    const r = await installPlugin(e, { userRoot: this.userRoot, fetchImpl: this.fetchImpl, ...(src ? { marketplace: { owner: src.owner, repo: src.repo, ref: src.ref } } : {}) });
    if (r.ok) await this.refresh();
    return { ok: r.ok, message: r.message };
  }

  async uninstallFromMarket(id: string): Promise<{ ok: boolean; message: string }> {
    const plugin = this.found.find((p) => path.basename(p.dir) === id);
    const r = await uninstallPlugin(id, this.userRoot);
    if (r.ok) {
      if (plugin) await this.setEnabled(plugin.id, false);
      else await this.refresh();
    }
    return r;
  }

  private get lang(): string {
    return this.config.language();
  }

  /** Cài từ thư mục (sao chép) hoặc từ Git (`git clone --depth 1`). Trả về thông báo cho người dùng. */
  async install(source: 'folder' | 'git', vi: boolean): Promise<{ ok: boolean; message: string }> {
    await mkdir(this.userRoot, { recursive: true });
    if (source === 'folder') {
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vi ? 'Chọn thư mục plugin' : 'Select plugin folder' });
      if (!pick?.[0]) return { ok: false, message: vi ? 'Đã huỷ.' : 'Cancelled.' };
      const src = pick[0].fsPath;
      const dest = path.join(this.userRoot, path.basename(src));
      if (await stat(dest).then(() => true, () => false)) return { ok: false, message: vi ? `Đã có plugin "${path.basename(src)}" — xoá thư mục ${dest} trước nếu muốn cài lại.` : `Plugin "${path.basename(src)}" already exists.` };
      await cp(src, dest, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
      await this.refresh();
      return { ok: true, message: vi ? `Đã chép plugin vào ${dest}. Bật nó trong danh sách để dùng.` : `Copied to ${dest}. Enable it in the list.` };
    }
    const url = await vscode.window.showInputBox({
      title: vi ? 'Cài plugin từ Git' : 'Install plugin from Git',
      prompt: vi ? 'Dán địa chỉ kho Git (https://…). Chỉ cài plugin bạn tin tưởng: plugin có thể chạy chương trình qua MCP.' : 'Paste a Git repository URL (https://…). Only install plugins you trust.',
      validateInput: (v) => (/^https:\/\/[^\s]+$/i.test(v.trim()) ? undefined : vi ? 'Cần địa chỉ https://' : 'An https:// URL is required'),
    });
    if (!url) return { ok: false, message: vi ? 'Đã huỷ.' : 'Cancelled.' };
    const name = (url.trim().replace(/\/+$/, '').split('/').pop() ?? 'plugin').replace(/\.git$/i, '').replace(/[^\w.-]+/g, '-') || 'plugin';
    const dest = path.join(this.userRoot, name);
    if (await stat(dest).then(() => true, () => false)) return { ok: false, message: vi ? `Đã có plugin "${name}".` : `Plugin "${name}" already exists.` };
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn('git', ['clone', '--depth', '1', '--', url.trim(), dest], { windowsHide: true });
      let err = '';
      p.stderr?.on('data', (d) => (err += String(d)));
      p.on('error', (e) => resolve({ code: -1, err: e.message }));
      p.on('exit', (code) => resolve({ code, err }));
    });
    if (r.code !== 0) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: (vi ? 'Không clone được: ' : 'Clone failed: ') + r.err.trim().slice(-300) };
    }
    await rm(path.join(dest, '.git'), { recursive: true, force: true }).catch(() => undefined);
    this.logger.log('info', `Đã cài plugin từ ${url} vào ${dest}`);
    await this.refresh();
    return { ok: true, message: vi ? `Đã cài plugin "${name}". Bật nó trong danh sách để dùng.` : `Installed "${name}". Enable it in the list.` };
  }
}
