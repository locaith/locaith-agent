import * as vscode from 'vscode';
import type { OrchestrationMode, PermissionMode, ThinkingLevel, UiSettings } from '../shared/protocol';
import { sanitizeServerConfig, type McpServerConfig } from '../core/mcp/client';
import { DEFAULT_UI_SETTINGS } from '../shared/protocol';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../core/engine/types';
import type { CustomProviderConfig } from '../core/providers';
import { isAllowedBaseUrl } from '../shared/baseUrl';

const SECTION = 'locaithAgent';

/**
 * Cài đặt quyết định "khoá API gửi đi đâu" và "tác nhân được phép làm gì". Chúng CHỈ được đọc từ cài đặt người dùng
 * (toàn cục) — không bao giờ từ `.vscode/settings.json` của workspace: nếu không, mở một kho mã lạ là đủ để đổi
 * `baseUrls` sang máy chủ của kẻ tấn công (lấy khoá API), bật `bypass` (hết hỏi quyền) hay cho đọc tệp tuỳ ý vào prompt.
 * package.json cũng đặt `scope: "machine"` cho các khoá này; đọc bằng `inspect().globalValue` là lớp phòng thủ thứ hai.
 */
const SECURE_KEYS = new Set([
  'agent.permissionMode',
  'agent.allowBypassPermissions',
  'agent.instructionFiles',
  'fetch.allowPrivateNetwork',
  'search.searxngUrl',
  'summarizer.model',
  'skills.paths',
  'baseUrls',
  'customProviders',
  'artifacts.autoOpen',
  // Điều phối nhiều hãng quyết định dữ liệu đi tới hãng nào; MCP/plugin quyết định chương trình nào được chạy → chỉ từ cài đặt người dùng.
  'orchestration.mode',
  'mcp.servers',
  'plugins.paths',
  'agents.maxConcurrent',
  // Remote: mở cổng cục bộ + ai được gọi vào + có cho đổi sang bypass không → chỉ từ cài đặt người dùng (một kho mã lạ không được tự bật điều khiển từ xa).
  'remote.enabled',
  'remote.cloud',
  'remote.local',
  'remote.webUrl',
  'remote.allowedOrigins',
  'remote.publicUrl',
  'remote.idleDays',
  'remote.allowBypass',
  // Khoá của việc «đúng tài khoản là vào được»: một kho mã lạ không được tự bật/tắt hộ chủ máy.
  'remote.trustAccount',
]);

const UI_KEYS: Record<keyof UiSettings, string> = {
  language: 'language',
  fontFamily: 'ui.fontFamily',
  fontSize: 'ui.fontSize',
  lineHeight: 'ui.lineHeight',
  codeFont: 'ui.codeFont',
  showThinking: 'ui.showThinking',
};

/** Đọc cấu hình `locaithAgent.*` thành các kiểu có kiểu rõ ràng. */
export class ConfigService {
  cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  get<T>(key: string, fallback: T): T {
    if (SECURE_KEYS.has(key)) return this.secure<T>(key, fallback);
    return this.cfg().get<T>(key, fallback);
  }

  /** Giá trị người dùng đặt ở cấp toàn cục, hoặc mặc định của extension; bỏ qua mọi giá trị từ workspace/thư mục. */
  private secure<T>(key: string, fallback: T): T {
    const info = this.cfg().inspect<T>(key);
    const v = info?.globalValue ?? info?.defaultValue;
    return v === undefined ? fallback : v;
  }

  language(): 'vi' | 'en' {
    return this.get<string>('language', 'vi') === 'en' ? 'en' : 'vi';
  }

  ui(): UiSettings {
    const c = this.cfg();
    const d = DEFAULT_UI_SETTINGS;
    return {
      language: this.language(),
      fontFamily: c.get('ui.fontFamily', d.fontFamily),
      fontSize: clamp(c.get<number>('ui.fontSize', d.fontSize), 12, 20),
      lineHeight: clamp(c.get<number>('ui.lineHeight', d.lineHeight), 1.3, 2.2),
      codeFont: c.get('ui.codeFont', d.codeFont),
      showThinking: c.get('ui.showThinking', d.showThinking),
    };
  }

  /** Ghi một cài đặt giao diện. Khoá và kiểu giá trị đến từ webview nên được kiểm tra lại ở đây. */
  async setUi<K extends keyof UiSettings>(key: K, value: UiSettings[K]): Promise<void> {
    const target = UI_KEYS[key];
    if (!target) return;
    const sample = DEFAULT_UI_SETTINGS[key];
    if (typeof value !== typeof sample) return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    await this.cfg().update(target, value, vscode.ConfigurationTarget.Global);
  }

  engine(): EngineSettings {
    const c = this.cfg();
    const d = DEFAULT_ENGINE_SETTINGS;
    return {
      ...d,
      language: this.language(),
      maxTurns: c.get<number>('agent.maxTurns', d.maxTurns),
      maxOutputTokens: c.get<number>('agent.maxOutputTokens', d.maxOutputTokens),
      parallelToolCalls: c.get<boolean>('agent.parallelToolCalls', d.parallelToolCalls),
      autoCompact: c.get<boolean>('agent.autoCompact', d.autoCompact),
      compactAt: Math.min(95, Math.max(50, c.get<number>('agent.compactAtPercent', 80))) / 100,
      instructionFiles: cleanNameList(this.get<unknown>('agent.instructionFiles', d.instructionFiles), d.instructionFiles),
    };
  }

  defaultMode(): PermissionMode {
    const m = this.get<PermissionMode>('agent.permissionMode', 'default');
    return m === 'bypass' && !this.allowBypass() ? 'default' : m;
  }

  allowBypass(): boolean {
    return this.get<boolean>('agent.allowBypassPermissions', false);
  }

  /** Bật/tắt quyền dùng chế độ "bỏ qua mọi xác nhận". Chỉ ghi vào cài đặt NGƯỜI DÙNG (toàn cục) — khoá này không bao giờ đọc từ workspace (SECURE_KEYS). */
  async setAllowBypass(v: boolean): Promise<void> {
    await this.cfg().update('agent.allowBypassPermissions', v === true, vscode.ConfigurationTarget.Global);
  }

  /** Chế độ quyền mà cuộc trò chuyện mới bắt đầu (cài đặt người dùng). */
  async setDefaultMode(m: PermissionMode): Promise<void> {
    await this.cfg().update('agent.permissionMode', m, vscode.ConfigurationTarget.Global);
  }

  // ── Remote (điều khiển từ xa) ──
  /** BẬT SẴN: người đã đăng nhập tự nối vào relay (xem RemoteService); chưa ghép đôi thiết bị nào thì không ai điều khiển được gì. */
  remoteEnabled(): boolean {
    return this.get<boolean>('remote.enabled', true);
  }

  /** Đường Internet (relay locaith.ai, mã hoá đầu-cuối): chỉ chạy khi Remote bật VÀ đã đăng nhập tài khoản Locaith. */
  remoteCloud(): boolean {
    return this.get<boolean>('remote.cloud', true);
  }

  /** Đường cục bộ (HTTP 127.0.0.1): mặc định TẮT — không mở cổng nào ở máy người dùng nếu họ không cần. */
  remoteLocal(): boolean {
    return this.get<boolean>('remote.local', false);
  }

  /** Origin (scheme://host[:port]) của một URL; chuỗi rỗng nếu không hợp lệ. */
  private static originOf(u: string): string {
    try {
      const x = new URL(u);
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.origin : '';
    } catch {
      return '';
    }
  }

  remoteWebUrl(): string {
    const v = this.get<string>('remote.webUrl', 'https://locaith.ai').trim();
    return ConfigService.originOf(v) ? v.replace(/\/+$/, '') : 'https://locaith.ai';
  }

  /** Origin được phép gọi vào = danh sách người dùng đặt + origin của emote.webUrl (để dev trang web ở localhost không phải sửa hai chỗ). */
  remoteOrigins(): string[] {
    const list = this.get<unknown>('remote.allowedOrigins', []);
    const out = new Set<string>();
    for (const v of Array.isArray(list) ? list : []) {
      const o = typeof v === 'string' ? ConfigService.originOf(v) : '';
      if (o) out.add(o);
    }
    const w = ConfigService.originOf(this.remoteWebUrl());
    if (w) out.add(w);
    return [...out];
  }

  /** Địa chỉ công khai (đã chuẩn hoá về origin) hoặc chuỗi rỗng. */
  remotePublicUrl(): string {
    return ConfigService.originOf(this.get<string>('remote.publicUrl', '').trim());
  }

  remoteIdleDays(): number {
    const n = Number(this.get<number>('remote.idleDays', 30));
    return Number.isFinite(n) ? clamp(Math.round(n), 1, 365) : 30;
  }

  remoteAllowBypass(): boolean {
    return this.get<boolean>('remote.allowBypass', false);
  }

  /**
   * (0.6.5) BẬT SẴN: trình duyệt đã đăng nhập ĐÚNG tài khoản Locaith của chủ máy xem và điều khiển được máy này mà không cần ghép đôi (khoá tài khoản của máy nằm
   * trong danh bạ máy của tài khoản). Tắt = chỉ ghép đôi bằng liên kết/QR + «Cho phép» như trước. Chỉ đọc từ cài đặt người dùng.
   */
  remoteTrustAccount(): boolean {
    return this.get<boolean>('remote.trustAccount', true);
  }

  defaultThinking(): ThinkingLevel {
    return this.get<ThinkingLevel>('agent.thinkingLevel', 'medium');
  }

  summarizerEnabled(): boolean {
    return this.get<boolean>('summarizer.enabled', true);
  }

  summarizerModel(): string {
    return this.get<string>('summarizer.model', 'auto').trim() || 'auto';
  }

  /** Chỉ giữ địa chỉ hợp lệ: khoá API sẽ được gửi tới đó nên không chấp nhận http tới máy lạ. */
  baseUrls(): Record<string, string> {
    const raw = this.get<unknown>('baseUrls', {});
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, url] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof url === 'string' && isAllowedBaseUrl(url)) out[id] = url.trim();
    }
    return out;
  }

  customProviders(): CustomProviderConfig[] {
    const raw = this.get<unknown>('customProviders', []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is CustomProviderConfig =>
        !!c && typeof c === 'object' && typeof (c as CustomProviderConfig).id === 'string' && typeof (c as CustomProviderConfig).baseUrl === 'string' && isAllowedBaseUrl((c as CustomProviderConfig).baseUrl),
    );
  }

  defaultModelSetting(): { provider: string; model: string } | null {
    const v = this.get<string>('defaultModel', '').trim();
    const i = v.indexOf(':');
    return i > 0 ? { provider: v.slice(0, i), model: v.slice(i + 1) } : null;
  }

  async setBaseUrl(providerId: string, url: string): Promise<void> {
    const next = { ...this.baseUrls() };
    if (url.trim()) next[providerId] = url.trim();
    else delete next[providerId];
    await this.cfg().update('baseUrls', next, vscode.ConfigurationTarget.Global);
  }

  async setCustomProviders(list: CustomProviderConfig[]): Promise<void> {
    await this.cfg().update('customProviders', list, vscode.ConfigurationTarget.Global);
  }

  skillPaths(): string[] {
    return cleanNameList(this.get<unknown>('skills.paths', []), []);
  }

  /** Chế độ điều phối nhiều AI (mặc định tắt: dữ liệu chỉ đi tới đúng hãng người dùng đã chọn). */
  orchestrationMode(): OrchestrationMode {
    const v = this.get<string>('orchestration.mode', 'off');
    return v === 'failover' || v === 'auto' ? v : 'off';
  }

  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    await this.cfg().update('orchestration.mode', mode, vscode.ConfigurationTarget.Global);
  }

  /** Server MCP khai báo ở cài đặt người dùng. */
  mcpServers(): Record<string, McpServerConfig> {
    const raw = this.get<unknown>('mcp.servers', {});
    const out: Record<string, McpServerConfig> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [name, v] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
      const cfg = sanitizeServerConfig(v);
      if (cfg && /^[\w.-]{1,40}$/.test(name)) out[name] = cfg;
    }
    return out;
  }

  async setMcpServers(map: Record<string, McpServerConfig>): Promise<void> {
    await this.cfg().update('mcp.servers', map, vscode.ConfigurationTarget.Global);
  }

  pluginPaths(): string[] {
    return cleanNameList(this.get<unknown>('plugins.paths', []), []);
  }

  /** Số agent con chạy đồng thời tối đa trong một cuộc trò chuyện (1–16). */
  agentsMaxConcurrent(): number {
    return clamp(Math.floor(this.get<number>('agents.maxConcurrent', 8)), 1, 16);
  }

  /**
   * Khi nào tự mở khung xem trước artifact: `never` (luôn chờ người dùng bấm), `static` (mặc định — tự mở SVG/Markdown,
   * còn HTML có script phải do người dùng bấm mở), `always`.
   */
  artifactsAutoOpen(): 'never' | 'static' | 'always' | 'browser' {
    const v = this.get<string>('artifacts.autoOpen', 'static');
    return v === 'never' || v === 'always' || v === 'browser' ? v : 'static';
  }

  debug(): boolean {
    return this.get<boolean>('debug.logRequests', false);
  }

  /** Cờ riêng cho adapter Claude (tắt khi đi qua proxy không hỗ trợ). */
  eagerInput(): boolean {
    return this.get<boolean>('anthropic.eagerInputStreaming', true);
  }

  onDidChange(cb: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) cb(e);
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/** Danh sách chuỗi ngắn, không rỗng, tối đa 20 mục; sai kiểu thì dùng mặc định. */
function cleanNameList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 300)
    .slice(0, 20);
}

export { isAllowedBaseUrl };
