/**
 * Điều phối các thao tác của màn hình "Chợ": kỹ năng đóng gói sẵn, plugin, kết nối MCP (kho dịch vụ + Bio-Memory-Locaith), agent.
 * Giao diện chỉ gửi ý định (`market_install`, `connector_connect`…); mọi việc chạm vào đĩa/tiến trình/đăng nhập diễn ra ở đây.
 */

import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentRegistry } from '../core/agents/definitions';
import { BIO_SERVER_NAME, CATALOG } from '../core/mcp/catalog';
import { MCP_PRESETS, presetConfig } from '../core/mcp/presets';
import type { McpManager } from '../core/mcp/manager';
import type { SkillMarket } from '../core/market/market';
import type { CatalogItem, MarketState } from '../shared/protocol';
import { installedByMarket } from '../core/plugins/marketplace';
import type { BioMemoryService } from './bioMemory';
import type { ConfigService } from './config';
import type { ChromeService } from './chrome';
import type { ConnectorService, ConnectResult } from './connectors';
import type { PluginService } from './plugins';

export interface MarketServiceDeps {
  config: ConfigService;
  market: SkillMarket;
  plugins: PluginService;
  mcp: McpManager;
  agents: AgentRegistry;
  connectors: ConnectorService;
  bio: BioMemoryService;
  chrome: ChromeService;
  /** Nạp lại kỹ năng / agent / MCP sau khi có thay đổi trên đĩa hoặc cấu hình. */
  reload(what: { skills?: boolean; agents?: boolean; mcp?: boolean; plugins?: boolean }): Promise<void>;
}

export class MarketService {
  constructor(private readonly d: MarketServiceDeps) {}

  private get vi(): boolean {
    return this.d.config.language() === 'vi';
  }

  async state(): Promise<MarketState> {
    const [skills, installed] = await Promise.all([this.d.market.index(), this.d.market.installedIds()]);
    const live = new Map(this.d.mcp.status().map((s) => [s.name, s]));
    const connected = this.d.connectors.connectedIds();
    const catalog: CatalogItem[] = CATALOG.filter((e) => e.id !== BIO_SERVER_NAME).map((e) => {
      const s = live.get(e.id);
      return {
        id: e.id,
        name: e.name,
        vendor: e.vendor,
        category: e.category,
        description: e.description,
        transport: e.transport,
        auth: e.auth,
        ...(e.own ? { own: true } : {}),
        ...(e.unsupported ? { unsupported: e.unsupported } : {}),
        ...(e.note ? { note: e.note } : {}),
        ...(e.needs ? { needs: e.needs } : {}),
        connected: connected.has(e.id),
        ...(connected.has(e.id) && s ? { status: s.status, ...(s.error ? { error: s.error } : {}) } : {}),
      };
    });
    const mine = await installedByMarket(this.d.plugins.userRoot);
    return {
      skills,
      installedSkills: [...installed],
      plugins: this.d.plugins.list().map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        enabled: p.enabled,
        skills: p.skillDirs.length,
        agents: p.agentDirs.length,
        commands: 0,
        mcp: Object.keys(p.mcpServers).length,
        dir: p.dir,
        error: p.error,
        fromMarket: mine.has(path.basename(p.dir)),
      })),
      mcp: this.d.mcp.status(),
      agents: this.d.agents.list().map((a) => ({
        name: a.name,
        description: a.description,
        tier: a.model ?? a.tier,
        tools: Array.isArray(a.tools) ? a.tools.join(', ') : a.tools,
        source: a.source,
      })),
      presets: [],
      catalog,
      bio: this.d.bio.status(),
      pluginMarket: await this.d.plugins.marketState(),
      chrome: this.d.chrome.status(),
    };
  }

  async installSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.market.install(String(id ?? ''));
    if (r.ok) await this.d.reload({ skills: true });
    return r;
  }

  async uninstallSkill(id: string): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.market.uninstall(String(id ?? ''));
    if (r.ok) await this.d.reload({ skills: true });
    return r;
  }

  async togglePlugin(id: string, enabled: boolean): Promise<void> {
    await this.d.plugins.setEnabled(String(id ?? ''), enabled === true);
    await this.d.reload({ skills: true, agents: true, mcp: true });
  }

  async installPlugin(source: 'folder' | 'git'): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.plugins.install(source === 'git' ? 'git' : 'folder', this.vi);
    if (r.ok) await this.d.reload({ plugins: true });
    return r;
  }

  async openPluginFolder(): Promise<void> {
    const dir = this.d.plugins.userRoot;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  }

  async openAgentsFolder(): Promise<void> {
    const dir = path.join(os.homedir(), '.locaith', 'agents');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  }

  async toggleMcp(name: string, enabled: boolean): Promise<void> {
    if (enabled) await this.d.mcp.enable(name);
    else await this.d.mcp.disable(name);
  }

  async restartMcp(name: string): Promise<void> {
    await this.d.mcp.restart(name);
  }

  /** Đổi mức quyền một công cụ MCP (`tool` = null nghĩa là đặt cho cả nhóm). */
  async setMcpToolPolicy(server: string, tool: string | null, group: 'read' | 'write' | null, policy: 'allow' | 'ask' | 'deny'): Promise<void> {
    await this.d.mcp.setToolPolicy(server, tool, group, policy);
  }

  // ── Chrome ──
  async chromePair(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.d.chrome.pair();
      return { ok: true, message: this.vi ? 'Đã tạo mã ghép đôi (hiệu lực 5 phút). Gõ mã vào extension Locaith trên Chrome.' : 'Pairing code created (valid for 5 minutes). Enter it in the Locaith extension on Chrome.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async chromeUnpair(): Promise<{ ok: boolean; message: string }> {
    await this.d.chrome.unpair();
    return { ok: true, message: this.vi ? 'Đã huỷ ghép đôi: Chrome không còn điều khiển được từ VS Code.' : 'Unpaired: Chrome can no longer be controlled from VS Code.' };
  }

  // ── Chợ plugin ──
  /** Bắt đầu tải danh sách (trả về ngay khi xong); `loading` đã được bật đồng bộ nên gọi `state()` ngay sau đó sẽ thấy "đang tải". */
  refreshPluginMarket(force = false): Promise<void> {
    return this.d.plugins.refreshMarketplace(force);
  }

  async installPluginFromMarket(id: string): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.plugins.installFromMarket(String(id ?? ''));
    if (r.ok) await this.d.reload({ plugins: true });
    return r;
  }

  async uninstallMarketPlugin(id: string): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.plugins.uninstallFromMarket(String(id ?? ''));
    if (r.ok) await this.d.reload({ plugins: true });
    return r;
  }

  // ── kết nối dịch vụ ──
  async connect(id: string): Promise<ConnectResult> {
    const r = await this.d.connectors.connect(String(id ?? ''));
    if (r.ok) await this.d.reload({ mcp: true });
    return r;
  }

  async connectToken(id: string): Promise<ConnectResult> {
    const r = await this.d.connectors.connectToken(String(id ?? ''));
    if (r.ok) await this.d.reload({ mcp: true });
    return r;
  }

  /** Hỏi địa chỉ (và tên) rồi thêm một server MCP từ xa; tự dò OAuth. */
  async addUrl(): Promise<ConnectResult | null> {
    const url = await vscode.window.showInputBox({
      title: this.vi ? 'Thêm server MCP từ địa chỉ' : 'Add an MCP server by URL',
      prompt: this.vi ? 'Dán địa chỉ MCP từ xa (https://…/mcp). Nếu cần đăng nhập, trình duyệt sẽ mở ra.' : 'Paste a remote MCP URL (https://…/mcp). If it needs sign-in, your browser opens.',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : this.vi ? 'Cần địa chỉ bắt đầu bằng https://' : 'An https:// address is required'),
    });
    if (!url) return null;
    const name = await vscode.window.showInputBox({ title: this.vi ? 'Tên hiển thị' : 'Display name', prompt: this.vi ? 'Đặt một tên gợi nhớ (để trống = dùng tên miền).' : 'A short name (leave empty to use the host name).', ignoreFocusOut: true });
    if (name === undefined) return null;
    const r = await this.d.connectors.addUrl(url, name.trim() || undefined);
    if (r.ok) await this.d.reload({ mcp: true });
    return r;
  }

  async disconnect(id: string): Promise<ConnectResult> {
    const r = await this.d.connectors.disconnect(String(id ?? ''));
    if (r.ok) await this.d.reload({ mcp: true });
    return r;
  }

  // ── Bio-Memory-Locaith ──
  async bioInstall(): Promise<{ ok: boolean; message: string }> {
    const r = await this.d.bio.install();
    if (r.ok) {
      // Nạp lại MCP (khởi động server Bio) có thể chậm: không để nó giữ dải «đang cài» quá 60 giây — đã cài xong thì coi là thành công.
      await Promise.race([this.d.reload({ mcp: true }), new Promise<void>((res) => setTimeout(res, 60_000))]);
      return { ok: true, message: this.vi ? 'Đã cài và bật Bio-Memory-Locaith. Từ giờ mọi cuộc trò chuyện dùng chung một bộ nhớ.' : 'Bio-Memory-Locaith is installed and on. Every conversation now shares one memory.' };
    }
    return { ok: false, message: r.message };
  }

  /** Model Locaith-v5 dùng Trí nhớ sinh học MẶC ĐỊNH: còn cần tự bật không (chưa bật và người dùng chưa từ chối)? */
  bioAutoNeeded(): boolean {
    return !this.d.bio.enabled() && !this.d.bio.autoDeclined();
  }

  /** Đã cài rồi chỉ cần bật; chưa cài thì cài (môi trường Python riêng) rồi bật. */
  async bioEnsure(): Promise<{ ok: boolean; message: string }> {
    if (this.d.bio.installed()) {
      await this.bioEnable(true);
      return { ok: true, message: '' };
    }
    return this.bioInstall();
  }

  /** Dừng lần cài đang chạy (hết hạn chờ). */
  bioCancelInstall(): void {
    this.d.bio.cancelInstall();
  }

  bioAutoDeclined(): boolean {
    return this.d.bio.autoDeclined();
  }

  async bioAutoDecline(): Promise<void> {
    await this.d.bio.setAutoDeclined(true);
  }

  async bioEnable(on: boolean): Promise<void> {
    await this.d.bio.setEnabled(on === true);
    await this.d.reload({ mcp: true });
  }

  async bioOpenFolder(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.d.bio.dataDir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.d.bio.dataDir));
  }

  /** Giữ để tương thích: thêm một mẫu MCP cũ vào cài đặt người dùng. */
  async addPreset(id: string): Promise<{ ok: boolean; message: string }> {
    const p = MCP_PRESETS.find((x) => x.id === id);
    if (!p) return { ok: false, message: this.vi ? 'Không có mẫu MCP này.' : 'Unknown MCP preset.' };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cfg = presetConfig(p, folder);
    if (!cfg) return { ok: false, message: this.vi ? 'Mẫu này cần một thư mục workspace đang mở.' : 'This preset needs an open workspace folder.' };
    const cur = this.d.config.mcpServers();
    if (p.name in cur) return { ok: false, message: this.vi ? `"${p.name}" đã có trong cài đặt.` : `"${p.name}" is already configured.` };
    await this.d.config.setMcpServers({ ...cur, [p.name]: cfg });
    await this.d.reload({ mcp: true });
    return { ok: true, message: this.vi ? `Đã thêm MCP "${p.name}".` : `Added MCP "${p.name}".` };
  }

  /** Mở cấu hình MCP: `.mcp.json` của workspace nếu có, nếu không thì cài đặt người dùng. */
  async openMcpConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      const file = path.join(folder, '.mcp.json');
      const exists = await readFile(file).then(() => true, () => false);
      if (exists) {
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        return;
      }
    }
    await vscode.commands.executeCommand('workbench.action.openSettings', 'locaithAgent.mcp.servers');
  }
}
