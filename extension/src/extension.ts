import { createHash } from 'node:crypto';
import { openExternalOnce } from './core/host/openOnce'; // (lane:customer-bugs)
import { readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRegistry, type AgentDirSpec } from './core/agents/definitions';
import { NodeToolHost } from './core/host/nodeHost';
import { sanitizeServerConfig } from './core/mcp/client';
import { McpManager, type McpServerEntry } from './core/mcp/manager';
import { SkillMarket } from './core/market/market';
import { AccountService } from './host/account';
import { BioMemoryService } from './host/bioMemory';
import { ChromeService } from './host/chrome';
import { ConnectorService } from './host/connectors';
import { LocaithBridge, LocaithConsent } from './host/locaith';
import { gatewayDiagnosticHeaders } from './core/providers/gatewayDiagnostics'; // (lane:gateway-client)
import { LOCAITH_GATEWAY_URL, LOCAITH_PROVIDER_ID, LocaithGatewayClient } from './core/providers/locaithGateway';
import { AUTO_MODELS, AutoProvider, type AutoHooks } from './core/orchestration/autoProvider';
import { ModelPool } from './core/orchestration/pool';
import { builtinSkills } from './core/skills/builtin';
import { SkillRegistry } from './core/skills/registry';
import { ArtifactPanels } from './host/artifactPanel';
import { ChatController, type ControllerDeps } from './host/chatController';
import { ChatPanelManager, ChatViewProvider } from './host/chatView';
import { registerCommands, skillDirectories } from './host/commands';
import { ConfigService } from './host/config';
import { DiffPreview } from './host/diffPreview';
import { EditorContextTracker } from './host/editorContext';
import { FileIndex } from './host/fileIndex';
import { Logger } from './host/logger';
import { MarketService } from './host/marketService';
import { PluginService } from './host/plugins';
import { ProviderService } from './host/providerService';
import { RemoteBridge, RemoteService } from './host/remote';
import { SecretsService } from './host/secrets';
import { SessionStore } from './host/sessionStore';
import { autoCleanImages } from './host/cleanup'; // (lane:v072-fixes)
import { DEFAULT_STORAGE_IMAGE_LIMITS, LITE_STORAGE_IMAGE_LIMITS } from './shared/transcript'; // (lane:v072-fixes)

let shutdown: (() => void) | undefined;

/** API phơi ra cho kiểm thử tích hợp (chỉ khi đặt biến môi trường ND_AGENT_TEST=1). */
export interface TestApi {
  sidebar: ChatController;
  providers: ProviderService;
  store: SessionStore;
  skills: SkillRegistry;
  agents: AgentRegistry;
  mcp: McpManager;
  connectors: ConnectorService;
  bio: BioMemoryService;
  marketService: MarketService;
  plugins: PluginService;
  chrome: ChromeService;
  /** Thư mục lưu trữ của extension (kiểm thử đọc tệp phiên trực tiếp). */
  storageDir: string;
  remote: RemoteService;
  /** Tài khoản locaith.ai (đăng nhập bắt buộc để dùng extension). */
  account: AccountService;
  /** Bản ghi đồng ý thông báo dữ liệu của mô hình Locaith (AI Local). */
  locaith: LocaithConsent;
  /** Kiểm thử Remote qua relay: ghi lại các hộp thoại xác nhận ghép đôi, quyết định trả lời thay người dùng, và các địa chỉ `/remote` định mở trong trình duyệt (không mở thật). */
  remoteTest: { approvals: { label: string; sas: string }[]; answer: boolean; opened: string[] };
}

const TIER_VI = { top: 'mạnh nhất', balanced: 'cân bằng', fast: 'nhanh' } as const;

export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const logger = new Logger();
  const config = new ConfigService();
  const secrets = new SecretsService(context.secrets, logger);
  const version = String(context.extension.packageJSON.version ?? '0');
  // Họ mô hình Locaith (AI Local) dùng TOKEN TÀI KHOẢN làm khoá: tài khoản + bản ghi đồng ý được dựng sau ProviderService nên gắn trễ qua cầu nối.
  const locaithBridge = new LocaithBridge();
  const providers = new ProviderService(config, secrets, logger, locaithBridge.hooks(version));
  const skills = new SkillRegistry(builtinSkills());
  const agents = new AgentRegistry();
  const diffs = new DiffPreview();
  const artifacts = new ArtifactPanels(context.extensionUri, logger, context);
  const editor = new EditorContextTracker();
  const files = new FileIndex();

  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const workspaceKey = wsPath ? createHash('sha1').update(wsPath.toLowerCase()).digest('hex').slice(0, 16) : 'no-workspace';
  const store = new SessionStore(context.globalStorageUri, workspaceKey, undefined, vscode.workspace.workspaceFolders?.[0]?.name, version);

  const controllers = new Set<ChatController>();
  const all = () => [...controllers];
  // (0.7.2) Chế độ nhẹ: transcript chỉ giữ bản xem trước nhỏ của ảnh (xem shared/transcript.ts).
  const applyStoreLimits = () => store.setImageLimits(config.liteMode() ? LITE_STORAGE_IMAGE_LIMITS : DEFAULT_STORAGE_IMAGE_LIMITS);
  applyStoreLimits();
  const vi = () => config.language() === 'vi';

  // ── Điều phối nhiều AI: kho model (chỉ các khoá đã nhập) + nhà cung cấp ảo "Locaith Auto" ─────────────────────
  const pool = new ModelPool(providers, { maxPerProvider: 4 });
  const autoHooks: AutoHooks = {
    onPick: (t, tier, sessionKey) => all().forEach((c) => c.announcePick(sessionKey, `Locaith Auto → ${t.providerLabel} · ${t.modelLabel} (${vi() ? TIER_VI[tier] : tier})`)),
    onSwitch: (s) => all().forEach((c) => c.announceSwitch(s, true)),
    log: (level, msg) => logger.log(level, msg),
  };
  providers.registry.addExtraProvider(new AutoProvider(pool, autoHooks), AUTO_MODELS);

  // ── Kỹ năng, agent, plugin, MCP: quét thư mục workspace/người dùng, theo dõi thay đổi ───────────────────────
  const plugins = new PluginService(context, config, logger);
  const loader = new NodeToolHost({ roots: [] });

  // Kết nối dịch vụ (OAuth / GitHub / token) và Bio-Memory-Locaith (một kho dùng chung cho mọi phiên, mọi cửa sổ).
  const GH_SCOPES = ['repo', 'read:org', 'read:user', 'user:email'];
  const connectors = new ConnectorService({
    memento: context.globalState,
    secrets: { get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) },
    openExternal: async (url) => {
      // Chỉ khi chạy kiểm thử (ND_AGENT_TEST=1 + tệp đích do harness đặt): ghi URL ra tệp để harness tự mở bằng trình duyệt nó điều khiển.
      const sink = process.env.ND_AGENT_TEST === '1' ? process.env.ND_TEST_OAUTH_URL_FILE : undefined;
      if (sink) {
        await writeFile(sink, url, 'utf8');
        return;
      }
      await openExternalOnce(url, (x) => vscode.env.openExternal(vscode.Uri.parse(x))); // (lane:customer-bugs)
    },
    githubToken: async (create) => {
      try {
        const s = await vscode.authentication.getSession('github', GH_SCOPES, create ? { createIfNone: true } : { silent: true });
        if (s) logger.registerSecret(s.accessToken);
        return s?.accessToken;
      } catch {
        return undefined;
      }
    },
    prompt: (o) => Promise.resolve(vscode.window.showInputBox({ title: o.title, prompt: o.prompt, password: o.password, value: o.value, ignoreFocusOut: true })),
    workspaceFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    homedir: os.homedir(),
    log: (level, msg) => logger.log(level, msg),
  });
  // Cầu nối tới Chrome: mở MẶC ĐỊNH ở 127.0.0.1 để Chrome xin kết nối không cần mã (người dùng bấm Cho phép ngay trong khung chat); tắt bằng cài đặt locaithAgent.chrome.bridge.
  const chromeSvc = new ChromeService({ get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) }, (level, msg) => logger.log(level, msg), {
    autoStart: () => vscode.workspace.getConfiguration('locaithAgent').get<boolean>('chrome.bridge', true),
  });
  void chromeSvc.init();
  const bio = new BioMemoryService({
    root: path.join(os.homedir(), '.locaith', 'bio-memory'),
    memento: context.globalState,
    log: (level, msg) => logger.log(level, msg),
    onChange: () => all().forEach((c) => void c.refreshMarketIfOpen()),
  });

  const agentDirectories = (): AgentDirSpec[] => {
    const out: AgentDirSpec[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      out.push({ path: path.join(f.uri.fsPath, '.locaith', 'agents'), source: 'workspace' }, { path: path.join(f.uri.fsPath, '.claude', 'agents'), source: 'workspace' });
    }
    const home = os.homedir();
    out.push({ path: path.join(home, '.locaith', 'agents'), source: 'user' }, { path: path.join(home, '.claude', 'agents'), source: 'user' });
    for (const p of plugins.agentDirs()) out.push({ path: p, source: 'plugin' });
    return out;
  };

  const mcp = new McpManager({
    log: (level, msg) => logger.log(level, msg),
    version,
    workspaceTrusted: () => vscode.workspace.isTrusted,
    approvals: {
      get: () => context.globalState.get<string[]>('locaithAgent.mcp.approved', []),
      set: async (v) => {
        await context.globalState.update('locaithAgent.mcp.approved', v);
      },
    },
    toolPolicy: {
      get: () => context.globalState.get<Record<string, 'allow' | 'ask' | 'deny'>>('locaithAgent.mcp.policy', {}),
      set: async (v) => {
        await context.globalState.update('locaithAgent.mcp.policy', v);
      },
    },
  });

  const readMcpFile = async (file: string, origin: string): Promise<McpServerEntry[]> => {
    let raw: any;
    try {
      raw = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch {
      return [];
    }
    const table = raw?.mcpServers ?? raw;
    const out: McpServerEntry[] = [];
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      for (const [name, v] of Object.entries(table).slice(0, 64)) {
        const cfg = sanitizeServerConfig(v);
        if (cfg && /^[\w.-]{1,40}$/.test(name)) out.push({ name, cfg: { ...cfg, cwd: cfg.cwd ?? (cfg.command ? path.dirname(file) : undefined) }, scope: 'workspace', origin });
      }
    }
    return out;
  };

  const reloadSkills = async () => {
    const res = await skills.loadDirs(loader, skillDirectories(config, plugins.skillDirs()));
    for (const e of res.errors) logger.log('warn', `Kỹ năng lỗi: ${e}`);
    logger.log('info', `Đã nạp ${skills.list().length} kỹ năng (${res.loaded} từ thư mục người dùng/workspace/plugin).`);
    await Promise.all(all().map((c) => c.onEnvironmentChanged({ skills: true })));
  };
  const reloadAgents = async () => {
    const res = await agents.loadDirs(loader, agentDirectories());
    for (const e of res.errors) logger.log('warn', `Agent lỗi: ${e}`);
    logger.log('info', `Đã nạp ${agents.list().length} agent (${res.loaded} từ thư mục người dùng/workspace/plugin).`);
  };
  const reloadMcp = async () => {
    const entries: McpServerEntry[] = Object.entries(config.mcpServers()).map(([name, cfg]) => ({ name, cfg, scope: 'user' as const, origin: 'settings' }));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      for (const rel of ['.mcp.json', path.join('.locaith', 'mcp.json')]) entries.push(...(await readMcpFile(path.join(f.uri.fsPath, rel), rel.replace(/\\/g, '/'))));
    }
    entries.push(...plugins.mcpEntries());
    entries.push(...(await connectors.entries()));
    const bioEntry = bio.entry();
    if (bioEntry) entries.push(bioEntry);
    await mcp.configure(entries);
  };
  const reloadAll = async () => {
    await plugins.refresh();
    await reloadSkills();
    await reloadAgents();
    await reloadMcp();
  };

  await plugins.refresh();
  await reloadSkills();
  await reloadAgents();
  void reloadMcp().catch((e) => logger.log('warn', `MCP: ${e instanceof Error ? e.message : String(e)}`));

  const market = new SkillMarket(path.join(context.extensionPath, 'market'), path.join(os.homedir(), '.locaith', 'skills'));
  const marketService = new MarketService({
    config,
    market,
    plugins,
    mcp,
    agents,
    connectors,
    bio,
    chrome: chromeSvc,
    reload: async (what) => {
      if (what.plugins) await plugins.refresh();
      if (what.plugins || what.skills) await reloadSkills();
      if (what.plugins || what.agents) await reloadAgents();
      if (what.plugins || what.mcp) await reloadMcp();
    },
  });

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadAll().catch((e) => logger.log('warn', `Nạp lại: ${e instanceof Error ? e.message : String(e)}`)), 500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.locaith,.claude}/{skills,agents}/**');
  const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.mcp.json,.locaith/mcp.json}');
  for (const w of [watcher, mcpWatcher]) {
    w.onDidChange(scheduleReload);
    w.onDidCreate(scheduleReload);
    w.onDidDelete(scheduleReload);
  }

  // ── Thanh trạng thái ───────────────────────────────────────────────────────────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'locaithAgent.selectModel';
  const updateStatus = () => {
    const running = all().some((c) => c.isRunning);
    const cur = sidebar.currentModel;
    const label = providers.models(cur.provider).find((m) => m.id === cur.model)?.label ?? cur.model;
    status.text = running ? `$(loading~spin) ${label}` : `$(sparkle) ${label}`;
    status.tooltip = running ? 'Locaith AI — đang làm việc…' : `Locaith AI — ${cur.provider}:${cur.model}\nBấm để đổi model`;
    status.show();
  };

  // Tài khoản locaith.ai: BẮT BUỘC đăng nhập mới dùng được extension (ChatController từ chối mọi thao tác khác khi chưa đăng nhập).
  const account = new AccountService({
    config,
    secrets: { get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) },
    version,
    log: (level, msg) => logger.log(level, msg),
    registerSecret: (v) => logger.registerSecret(v),
  });

  // Bản ghi đồng ý thông báo dữ liệu của mô hình Locaith (theo tài khoản; máy chủ giữ bản chính). Địa chỉ cổng đổi được qua `locaithAgent.baseUrls` (khoá `locaith`).
  const locaithConsent = new LocaithConsent({
    memento: context.globalState,
    account: { get usable() { return account.usable; }, token: () => account.token(), userId: () => account.userId() },
    client: new LocaithGatewayClient({ baseUrl: () => config.baseUrls()[LOCAITH_PROVIDER_ID] ?? LOCAITH_GATEWAY_URL, timeoutMs: 6_000, headers: () => gatewayDiagnosticHeaders({ family: 'vscode', version, deviceId: account.deviceId() }) }), // (lane:gateway-client)
    clientLabel: `vscode/${version}`.replace(/[^A-Za-z0-9 ._/-]/g, '_').slice(0, 40),
    log: (level, msg) => logger.log(level, msg),
  });
  locaithBridge.attach({ get usable() { return account.usable; }, token: () => account.token(), userId: () => account.userId(), deviceId: () => account.deviceId(), refreshToken: (stale) => account.refreshToken(stale), expireToken: (t) => account.expireToken(t) }, locaithConsent); // (lane:gateway-client)

  // Remote hiện trong khung chat: ChatController dựng TRƯỚC RemoteService nên nhận cầu nối, gắn RemoteService vào ngay sau khi dựng.
  const remoteBridge = new RemoteBridge();
  context.subscriptions.push(remoteBridge);
  const deps: ControllerDeps = {
    context,
    logger,
    config,
    secrets,
    account,
    locaith: locaithConsent,
    remote: remoteBridge,
    providers,
    skills,
    skillDirs: () => skillDirectories(config, plugins.skillDirs()).map((d) => d.path),
    store,
    artifacts,
    diffs,
    editor,
    files,
    pool,
    agents,
    mcp,
    market,
    marketService,
    plugins,
    chrome: chromeSvc,
    openSessionIds: () => all().flatMap((c) => c.openSessionIds()),
    onRunStateChanged: () => updateStatus(),
  };

  const sidebar = new ChatController(deps, 'sidebar');
  controllers.add(sidebar);

  const remoteTest = process.env.ND_AGENT_TEST === '1' ? { approvals: [] as { label: string; sas: string }[], answer: true, opened: [] as string[] } : undefined;
  // Điều khiển từ xa (tab Remote trên locaith.ai): mặc định tắt, không mở gì cho tới khi người dùng bật/ghép đôi VÀ đã đăng nhập Locaith.
  const remote = new RemoteService({
    controller: sidebar,
    config,
    secrets: { get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), delete: (n) => secrets.delete(n) },
    account,
    version,
    workspaceKey,
    log: (level, msg) => logger.log(level, msg),
    approve: remoteTest
      ? async (r) => {
          remoteTest.approvals.push(r);
          return remoteTest.answer;
        }
      : undefined,
    openUrl: remoteTest ? async (url) => void remoteTest.opened.push(url) : undefined,
    // Bản kiểm thử không được bật hộp thông báo thật (sẽ treo chờ người bấm): chỉ bản chạy thật mới báo.
    state: remoteTest ? undefined : context.globalState,
  });
  remoteBridge.attach(remote);
  // Nạp phiên đăng nhập đã lưu rồi xác minh ở nền (mất mạng vẫn vào được trong thời gian ân hạn); xong thì bật Remote nếu đang bật.
  void account
    .init()
    .catch((e) => logger.log('warn', `Tài khoản: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => void remote.apply());
  const panels = new ChatPanelManager(
    context.extensionUri,
    () => {
      const c = new ChatController(deps, 'tab');
      controllers.add(c);
      return c;
    },
    () => config.language(),
    () => {
      for (const c of [...controllers]) if (c.surface === 'tab' && !panels.controllers().includes(c)) controllers.delete(c);
      updateStatus();
    },
  );

  const viewProvider = new ChatViewProvider(context.extensionUri, sidebar, () => config.language());

  const refreshEverywhere = async () => {
    await Promise.all(all().map((c) => c.onEnvironmentChanged({ providers: true })));
    updateStatus();
  };

  // ── Phản ứng khi cấu hình / khoá / editor thay đổi ─────────────────────────────
  const subs: vscode.Disposable[] = [
    logger,
    diffs,
    artifacts,
    editor,
    files,
    watcher,
    mcpWatcher,
    status,
    panels,
    { dispose: () => void mcp.dispose() },
    { dispose: () => chromeSvc.dispose() },
    remote,
    account,
    { dispose: () => all().forEach((c) => c.dispose()) },
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, { webviewOptions: { retainContextWhenHidden: false } }),
    editor.onDidChange((info) => all().forEach((c) => c.onEditorChanged(info))),
    secrets.onDidChange((name) => {
      if (name.startsWith('account.')) void account.reload(); // cửa sổ VS Code khác vừa đăng nhập/đăng xuất
      else void refreshEverywhere();
    }),
    config.onDidChange(async (e) => {
      if (e.affectsConfiguration('locaithAgent.ui.liteMode')) applyStoreLimits();
      if (e.affectsConfiguration('locaithAgent.baseUrls') || e.affectsConfiguration('locaithAgent.customProviders') || e.affectsConfiguration('locaithAgent.anthropic')) {
        providers.reconfigure();
        void providers.refresh();
      }
      if (e.affectsConfiguration('locaithAgent.skills') || e.affectsConfiguration('locaithAgent.plugins')) await reloadAll();
      else if (e.affectsConfiguration('locaithAgent.mcp')) await reloadMcp();
      await Promise.all(all().map((c) => c.onEnvironmentChanged({ settings: true, providers: true })));
      updateStatus();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void reloadMcp();
      void Promise.all(all().map((c) => c.onEnvironmentChanged({ settings: true })));
    }),
    { dispose: mcp.onChange(() => all().forEach((c) => void c.refreshMarketIfOpen())) },
    { dispose: connectors.onChange(() => void reloadMcp().catch((e) => logger.log('warn', `MCP: ${e instanceof Error ? e.message : String(e)}`))) },
    ...registerCommands({
      context,
      logger,
      config,
      secrets,
      providers,
      editor,
      sidebar,
      panels,
      allControllers: all,
      reloadSkills: reloadAll,
      afterProvidersChanged: refreshEverywhere,
    }),
  ];
  context.subscriptions.push(...subs);
  shutdown = () => all().forEach((c) => c.stop());

  // (0.7.2) Tự dọn ảnh cũ ở nền (chỉ khi người dùng bật `history.autoCleanImagesDays`; luôn giữ chữ; không đụng cuộc đang mở). Chờ khởi động xong rồi mới chạy.
  const autoDays = config.autoCleanImagesDays();
  if (autoDays > 0 && process.env.ND_AGENT_TEST !== '1') {
    const t = setTimeout(() => {
      autoCleanImages(store, autoDays, all().flatMap((c) => c.openSessionIds()))
        .then((r) => {
          if (r.images > 0) logger.log('info', `Tự dọn ảnh cũ hơn ${autoDays} ngày: xoá ${r.images} ảnh, giải phóng ${Math.round(r.bytes / 1024)} KB (chữ được giữ).`);
        })
        .catch((e) => logger.log('warn', `Tự dọn ảnh: ${e instanceof Error ? e.message : String(e)}`));
    }, 30_000);
    t.unref?.();
    context.subscriptions.push({ dispose: () => clearTimeout(t) });
  }

  updateStatus();
  logger.log('info', `Locaith AI ${version} đã kích hoạt (VS Code ${vscode.version}).`);

  return process.env.ND_AGENT_TEST === '1' ? { sidebar, providers, store, skills, agents, mcp, connectors, bio, marketService, plugins, chrome: chromeSvc, storageDir: context.globalStorageUri.fsPath, remote, account, locaith: locaithConsent, remoteTest: remoteTest! } : undefined;
}

export function deactivate(): void {
  shutdown?.();
}
