/**
 * Harness giả lập môi trường webview của VS Code để xem/chụp giao diện mà không cần mở VS Code:
 *  - định nghĩa biến --vscode-* cho theme tối/sáng/tương phản cao và các lớp body như VS Code,
 *  - stub `acquireVsCodeApi`,
 *  - host giả lập: phát lại kịch bản (?scenario=…), trả lời tin nhắn từ giao diện.
 * Tham số URL: theme=dark|light|hc|hclight · scenario=… · speed=0 (tức thì) · stop=<marker> · w=<px> · lang=vi|en
 *              expand=1 (trải toàn bộ dòng thời gian để chụp cả cuộc trò chuyện) · font=manrope|inter|system
 */
import type { ABlock, HostMessage, MediaItem, ToolBlock, UiEvent, ViewState, WebviewMessage } from '../../src/shared/protocol';
import { mediaKindOf } from '../../src/shared/mediaKinds';
import { reduceView } from '../../src/shared/transcript';
import {
  PROVIDERS,
  baseState,
  ccTimelineState,
  cutContinueState, // (lane:output-timeouts)
  errorState,
  locaithState,
  longConversation,
  onboardingState,
  parallelAgentsState,
  permissionState,
  quickReply,
  researchScenario,
  settingsState,
  type Step,
  SESSIONS,
} from './scenarios';
import { promoReply } from './promo';

const params = new URLSearchParams(location.search);
const themeParam = params.get('theme') ?? 'dark';
const scenario = params.get('scenario') ?? 'welcome';
const speed = Number(params.get('speed') ?? '1');
const stopMarker = params.get('stop');
const widthParam = params.get('w');
const langParam = params.get('lang');
const fontParam = params.get('font');
const promoKind = params.get('promo') ?? '3d';

declare global {
  interface Window {
    __ND_READY__?: boolean;
    __ND_LOG__?: unknown[];
    acquireVsCodeApi?: () => unknown;
  }
}
window.__ND_LOG__ = [];

// ── theme ───────────────────────────────────────────────────────────────────

const THEMES: Record<string, { cls: string[]; vars: Record<string, string> }> = {
  dark: {
    cls: ['vscode-dark'],
    vars: {
      foreground: '#cccccc',
      descriptionForeground: '#9d9d9d',
      'editor-background': '#1f1f1f',
      'editor-foreground': '#cccccc',
      'sideBar-background': '#181818',
      'panel-border': '#2b2b2b',
      'input-background': '#313131',
      'input-foreground': '#cccccc',
      'input-border': '#3c3c3c',
      'input-placeholderForeground': '#989898',
      focusBorder: '#0078d4',
      'textLink-foreground': '#4daafc',
      'textCodeBlock-background': '#2b2b2b',
      'textPreformat-foreground': '#d0d0d0',
      'textPreformat-background': '#3c3c3c',
      'editorWidget-background': '#202020',
      'editorWidget-border': '#454545',
      'widget-shadow': 'rgba(0,0,0,0.36)',
      errorForeground: '#f85149',
      'editorWarning-foreground': '#cca700',
    },
  },
  light: {
    cls: ['vscode-light'],
    vars: {
      foreground: '#3b3b3b',
      descriptionForeground: '#717171',
      'editor-background': '#ffffff',
      'editor-foreground': '#3b3b3b',
      'sideBar-background': '#f8f8f8',
      'panel-border': '#e5e5e5',
      'input-background': '#ffffff',
      'input-foreground': '#3b3b3b',
      'input-border': '#cecece',
      'input-placeholderForeground': '#767676',
      focusBorder: '#005fb8',
      'textLink-foreground': '#005fb8',
      'textCodeBlock-background': '#f0f0f0',
      'textPreformat-foreground': '#3b3b3b',
      'textPreformat-background': '#e8e8e8',
      'editorWidget-background': '#f8f8f8',
      'editorWidget-border': '#c8c8c8',
      'widget-shadow': 'rgba(0,0,0,0.16)',
      errorForeground: '#cf222e',
      'editorWarning-foreground': '#9a6700',
    },
  },
  hc: {
    cls: ['vscode-dark', 'vscode-high-contrast'],
    vars: {
      foreground: '#ffffff',
      descriptionForeground: '#ffffffb3',
      'editor-background': '#000000',
      'editor-foreground': '#ffffff',
      'sideBar-background': '#000000',
      'panel-border': '#6fc3df',
      contrastBorder: '#6fc3df',
      contrastActiveBorder: '#f38518',
      'input-background': '#000000',
      'input-foreground': '#ffffff',
      'input-border': '#6fc3df',
      'input-placeholderForeground': '#ffffffb3',
      focusBorder: '#f38518',
      'textLink-foreground': '#21a6ff',
      'textCodeBlock-background': '#0a0a0a',
      'textPreformat-foreground': '#ffffff',
      'textPreformat-background': '#0a0a0a',
      'editorWidget-background': '#0c141f',
      'editorWidget-border': '#6fc3df',
      'widget-shadow': 'transparent',
      errorForeground: '#f48771',
      'editorWarning-foreground': '#ffd700',
    },
  },
  hclight: {
    cls: ['vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light'],
    vars: {
      foreground: '#292929',
      descriptionForeground: '#292929',
      'editor-background': '#ffffff',
      'editor-foreground': '#292929',
      'sideBar-background': '#ffffff',
      'panel-border': '#0f4a85',
      contrastBorder: '#0f4a85',
      contrastActiveBorder: '#006bbd',
      'input-background': '#ffffff',
      'input-foreground': '#292929',
      'input-border': '#0f4a85',
      'input-placeholderForeground': '#292929',
      focusBorder: '#006bbd',
      'textLink-foreground': '#0f4a85',
      'textCodeBlock-background': '#ffffff',
      'textPreformat-foreground': '#292929',
      'textPreformat-background': '#ffffff',
      'editorWidget-background': '#ffffff',
      'editorWidget-border': '#0f4a85',
      'widget-shadow': 'transparent',
      errorForeground: '#b5200d',
      'editorWarning-foreground': '#895503',
    },
  },
};

function installTheme() {
  const th = THEMES[themeParam] ?? THEMES.dark;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(`--vscode-${k}`, v);
  root.style.setProperty('--vscode-font-family', '"Segoe UI", system-ui, -apple-system, sans-serif');
  root.style.setProperty('--vscode-font-size', '13px');
  root.style.setProperty('--vscode-font-weight', 'normal');
  root.style.setProperty('--vscode-editor-font-family', 'Consolas, "Courier New", monospace');
  root.style.setProperty('--monaco-monospace-font', 'Consolas, "Courier New", monospace');
  document.body.className = th.cls.join(' ');
  // Giống bản VS Code: nền html là nền của sidebar, body trong suốt.
  root.style.background = 'var(--vscode-sideBar-background)';
  if (widthParam) {
    document.body.style.width = `${widthParam}px`;
    document.body.style.margin = '0 auto';
  }
  if (params.get('expand') === '1') {
    const style = document.createElement('style');
    style.textContent = `html,body,#root,.app,.app-main,.pane,.chat,.timeline{height:auto !important;overflow:visible !important}`;
    document.head.appendChild(style);
  }
}
installTheme();

// ── stub acquireVsCodeApi ───────────────────────────────────────────────────

let persisted: unknown = undefined;
window.acquireVsCodeApi = () => ({
  postMessage: (m: WebviewMessage) => host.handle(m),
  getState: () => persisted,
  setState: (s: unknown) => {
    persisted = s;
  },
});

// ── host giả lập ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FILES = [
  'package.json',
  'README.md',
  'tsconfig.json',
  'src/extension.ts',
  'src/core/engine/engine.ts',
  'src/core/engine/streamInterceptor.ts',
  'src/core/providers/anthropic.ts',
  'src/core/providers/openaiResponses.ts',
  'src/core/providers/gemini.ts',
  'src/utils/formatMoney.ts',
  'src/ads/phanBoNganSach.ts',
  'webview/src/App.tsx',
  'webview/src/components/composer/Composer.tsx',
  'webview/src/styles/components.css',
  'tài-liệu/hướng-dẫn-sử-dụng.md',
  'tài-liệu/báo-giá-website-2026.md',
  'data/báo-cáo-tháng-10.csv',
  'docs/Kiến Trúc Hệ Thống Agent.md',
  'scripts/gen-fonts-css.mjs',
];

function fileHits(query: string) {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const q = norm(query);
  return FILES.filter((f) => norm(f).includes(q))
    .slice(0, 12)
    .map((path) => ({ path, name: path.split('/').pop() ?? path, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }));
}

class MockHost {
  view: ViewState;
  private runToken = 0;
  private replyCount = 0;

  constructor(initial: ViewState) {
    this.view = initial;
  }

  post(msg: HostMessage) {
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: msg })), 0);
  }

  apply(events: UiEvent[]) {
    this.view = events.reduce((v, e) => reduceView(v, e), this.view);
    this.post({ type: 'events', events });
  }

  patch(patch: Partial<ViewState>) {
    this.view = { ...this.view, ...patch };
    this.post({ type: 'patch', patch });
  }

  toast(text: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.post({ type: 'toast', level, text });
  }

  /** Phát lại các bước; trả về true nếu chạy hết, false nếu bị huỷ hoặc dừng ở marker. */
  async play(steps: Step[], opts: { honorStop: boolean }): Promise<boolean> {
    const token = ++this.runToken;
    let prev = 0;
    for (const step of steps) {
      if (token !== this.runToken) return false;
      const wait = Math.max(0, step.at - prev) * speed;
      prev = step.at;
      if (wait > 0) await sleep(wait);
      if (token !== this.runToken) return false;
      if (step.events) this.apply(step.events);
      step.messages?.forEach((m) => this.post(m));
      if (step.marker) window.parent?.postMessage({ promoMarker: step.marker }, '*');
      if (opts.honorStop && stopMarker && step.marker === stopMarker) return false;
    }
    return true;
  }

  async start() {
    this.post({ type: 'init', state: this.view });
    await sleep(60);
    if (scenario === 'research') {
      const { steps } = researchScenario();
      await this.play(steps, { honorStop: true });
    }
    await sleep(speed === 0 ? 120 : 200);
    window.__ND_READY__ = true;
  }

  handle(m: WebviewMessage) {
    window.__ND_LOG__?.push(m);
    switch (m.type) {
      case 'ready':
        void this.start();
        break;
      case 'market_open':
        this.post({ type: 'market_state', state: sampleMarket() });
        break;
      case 'chrome_status':
        this.post({ type: 'market_state', state: { ...sampleMarket(), partial: true } });
        break;
      case 'plugin_market_refresh':
        this.post({ type: 'market_state', state: { ...sampleMarket(), partial: true } });
        break;
      case 'queue_remove':
        this.patch({ queued: (this.view.queued ?? []).filter((q) => q.id !== m.id) });
        break;
      case 'get_image':
        // Host thật tìm ảnh gốc trong lịch sử; harness trả bản lớn để kiểm hộp xem ảnh đổi từ bản thu nhỏ sang bản đẹp.
        window.setTimeout(() => this.post({ type: 'image_data', key: m.key, mediaType: 'image/png', data: BIG_PNG }), 250);
        break;
      case 'set_orchestration':
        this.patch({ orchestration: { mode: m.mode, pool: this.view.orchestration?.pool ?? [] } });
        break;
      case 'send': {
        // Mô hình Locaith mà chưa đồng ý thông báo dữ liệu: không trả lời, mở thẻ thông báo ngay trong khung chat (như host thật).
        if (this.view.provider === 'locaith' && this.view.locaith && !this.view.locaith.accepted) {
          this.patch({ locaith: { ...this.view.locaith, card: true, error: undefined } });
          break;
        }
        const id = `a_${++this.replyCount}`;
        const prompt = m.text;
        const steps = scenario === 'promo'
          ? promoReply(promoKind, id, prompt, this.view.provider, this.view.model)
          : /intelligence|so sánh điểm/i.test(prompt)
          ? researchScenario({ id, provider: this.view.provider, model: this.view.model }).steps
          : quickReply(id, prompt || '(đính kèm)', this.view.provider, this.view.model);
        if (!this.view.title) this.patch({ title: prompt.slice(0, 48) });
        if (m.attachments.length) steps[0].events = steps[0].events?.map((e) => (e.t === 'user' ? { ...e, attachments: m.attachments.map((a) => ({ ...a, data: undefined })) } : e));
        void this.play(steps, { honorStop: false });
        break;
      }
      case 'stop': {
        this.runToken++;
        if (this.view.modelQueue) this.patch({ modelQueue: undefined });
        const last = [...this.view.transcript].reverse().find((i) => i.kind === 'assistant');
        if (last) this.apply([{ t: 'assistant_end', id: last.id, stopReason: 'aborted' }]);
        this.apply([{ t: 'run_state', running: false }]);
        break;
      }
      case 'locaith_consent': {
        const cur = this.view.locaith;
        if (!cur) break;
        if (m.action === 'accept') {
          this.patch({ locaith: { ...cur, saving: true, error: undefined } });
          setTimeout(() => this.patch({ locaith: { ...cur, accepted: true, card: false, saving: false, error: undefined }, providers: this.view.providers.map((p) => (p.account ? { ...p, needsConsent: false } : p)) }), 700);
        } else if (m.action === 'decline') {
          this.patch({ locaith: { ...cur, card: false }, provider: 'anthropic', model: 'claude-opus-5-5' });
        } else if (m.action === 'withdraw') {
          this.patch({ locaith: { ...cur, accepted: false, card: false }, providers: this.view.providers.map((p) => (p.account ? { ...p, needsConsent: true } : p)) });
        } else if (m.action === 'review') {
          this.patch({ locaith: { ...cur, card: true }, screen: 'chat' });
        }
        break;
      }
      case 'new_session':
        this.runToken++;
        this.patch({ transcript: [], todos: [], title: '', running: false, sessionId: `s_${Date.now()}` });
        break;
      case 'set_model':
        this.patch({ provider: m.provider, model: m.model });
        break;
      case 'set_mode':
        this.patch({ mode: m.mode });
        break;
      case 'set_swarm':
        this.patch({ swarm: m.on });
        break;
      case 'set_thinking':
        this.patch({ thinkingLevel: m.level });
        break;
      case 'set_ui_setting':
        this.patch({ settings: { ...this.view.settings, [m.key]: m.value } as ViewState['settings'] });
        break;
      case 'search_files':
        setTimeout(() => this.post({ type: 'files', reqId: m.reqId, items: fileHits(m.query) }), 180);
        break;
      case 'save_api_key':
        this.patch({ providers: this.view.providers.map((p) => (p.id === m.provider ? { ...p, hasKey: true, keyFromEnv: false } : p)) });
        this.toast('Đã lưu khóa API.');
        break;
      case 'clear_api_key':
        this.patch({ providers: this.view.providers.map((p) => (p.id === m.provider ? { ...p, hasKey: false, keyFromEnv: false } : p)) });
        break;
      case 'test_connection':
        setTimeout(() => {
          const fail = m.provider === 'deepseek';
          this.post({
            type: 'test_result',
            provider: m.provider,
            ok: !fail,
            message: fail ? 'Không kết nối được: khóa API không hợp lệ (HTTP 401).' : 'Kết nối thành công — tìm thấy 4 model.',
          });
        }, 900);
        break;
      case 'refresh_models':
        setTimeout(() => this.patch({ providers: this.view.providers.map((p) => (p.id === m.provider ? { ...p, modelSource: 'live', modelError: undefined } : p)) }), 700);
        break;
      case 'permission_response': {
        const last = [...this.view.transcript].reverse().find((i) => i.kind === 'assistant');
        if (!last || last.kind !== 'assistant') break;
        const tool = last.blocks.find((b) => b.type === 'tool' && b.state === 'awaiting_permission');
        if (tool && tool.type === 'tool') {
          const denied = m.decision === 'deny';
          this.apply([
            { t: 'tool_end', id: last.id, callId: tool.id, state: denied ? 'denied' : 'done', summary: denied ? undefined : '+9 −3', output: denied ? m.feedback : 'Đã áp dụng.', durationMs: 180 },
            { t: 'text', id: last.id, delta: denied ? '\n\nĐã hiểu, mình sẽ không thực hiện thay đổi này.' : '\n\nXong rồi! Mình đã áp dụng thay đổi.' },
            { t: 'assistant_end', id: last.id, stopReason: 'end_turn' },
            { t: 'run_state', running: false },
          ]);
        }
        break;
      }
      case 'load_session':
        this.patch({ sessionId: m.id, title: this.view.sessions.find((s) => s.id === m.id)?.title ?? '', transcript: longConversation().transcript });
        break;
      case 'delete_session': {
        const gone = this.view.sessions.find((s) => s.id === m.id);
        this.patch({ sessions: this.view.sessions.filter((s) => s.id !== m.id), trash: gone ? [{ ...gone, deletedAt: Date.now() }, ...this.view.trash] : this.view.trash });
        break;
      }
      case 'restore_session': {
        const back = this.view.trash.find((s) => s.id === m.id);
        if (back) {
          const { deletedAt: _d, ...rest } = back;
          this.patch({ sessions: [rest, ...this.view.sessions], trash: this.view.trash.filter((s) => s.id !== m.id) });
        }
        break;
      }
      case 'purge_session':
        this.patch({ trash: this.view.trash.filter((s) => s.id !== m.id) });
        break;
      case 'empty_trash':
        this.patch({ trash: [] });
        break;
      case 'rename_session':
        this.patch({ sessions: this.view.sessions.map((s) => (s.id === m.id ? { ...s, title: m.title } : s)) });
        break;
      case 'edit_last': {
        const last = [...this.view.transcript].reverse().find((i) => i.kind === 'user');
        if (last && last.kind === 'user') this.post({ type: 'draft', text: last.text });
        break;
      }
      case 'retry':
        this.toast('Đã gửi yêu cầu thử lại.');
        break;
      default:
        this.toast(`Host nhận: ${m.type}`);
        break;
      // (0.6.3) xem trước kết quả: tệp mẫu thật ở webview/dev/media (ảnh, GIF, video ngang/dọc, âm thanh, video hỏng, tài liệu)
      case 'resolve_media': {
        const items = m.paths.map(harnessMedia);
        window.setTimeout(() => this.post({ type: 'media_resolved', key: m.key, items }), 90);
        break;
      }
      case 'open_media':
        this.toast(`Mở (${m.how}): ${m.path}`);
    }
  }
}

function sampleMarket(): import('../../src/shared/protocol').MarketState {
  const skills = Array.from({ length: 60 }, (_, i) => ({
    id: `skill-mau-${i + 1}`,
    name: ['pdf-doctor', 'sql-tuner', 'azure-cost-review', 'docker-compose-pro', 'frontend-design', 'mcp-builder'][i % 6] + (i >= 6 ? `-${i}` : ''),
    description: 'Hướng dẫn chuyên môn đóng gói sẵn: đọc kỹ yêu cầu, chọn công cụ phù hợp, kiểm tra kết quả và báo lại những điểm chưa chắc chắn cho người dùng.',
    group: (i % 18 === 0 ? 'anthropic' : i % 18 === 5 || i % 18 === 6 ? 'community' : 'vendor') as 'anthropic' | 'vendor' | 'community',
    // Đủ 18 nguồn kỹ năng thật (market/licenses) để xem logo hãng.
    repo: ['anthropic-claude-plugins-official', 'microsoft-skills', 'google-skills', 'cloudflare-skills', 'supabase-agent-skills', 'wshobson-agents', 'obra-superpowers', 'twilio-skills', 'getsentry-skills', 'expo-skills', 'docker-skills', 'mongodb-agent-skills', 'elevenlabs-skills', 'hashicorp-agent-skills', 'planetscale-skills', 'prisma-skills', 'firebase-skills', 'airtable-skills'][i % 18],
    license: ['Apache-2.0', 'MIT', 'MIT'][i % 3],
    files: 3 + (i % 5),
    bytes: 12_000 + i * 900,
  }));
  return {
    skills,
    installedSkills: [skills[0].id, skills[4].id],
    plugins: [
      { id: 'bao-gia', name: 'Báo giá Locaith', version: '1.2.0', description: 'Bộ kỹ năng + lệnh soạn báo giá theo mẫu của công ty.', enabled: true, skills: 2, agents: 1, commands: 1, mcp: 0, dir: '~/.locaith/plugins/bao-gia' },
      { id: 'db-tools', name: 'Công cụ CSDL', version: '0.3.1', description: '', enabled: false, skills: 1, agents: 0, commands: 0, mcp: 1, dir: '~/.locaith/plugins/db-tools' },
    ],
    mcp: [
      { name: 'filesystem', scope: 'user', origin: 'settings', transport: 'stdio', status: 'running', approved: true, summary: 'npx -y @modelcontextprotocol/server-filesystem C:\\du-an', tools: [{ name: 'read_file', description: 'Đọc một tệp' }, { name: 'list_directory', description: 'Liệt kê thư mục' }] },
      { name: 'playwright', scope: 'workspace', origin: '.mcp.json', transport: 'stdio', status: 'stopped', approved: false, summary: 'npx -y @playwright/mcp@latest', tools: [] },
      { name: 'db:postgres', scope: 'plugin', origin: 'Công cụ CSDL', transport: 'stdio', status: 'error', error: 'Không chạy được "psql-mcp": spawn ENOENT', approved: true, summary: 'psql-mcp --readonly', tools: [] },
    ],
    agents: [
      { name: 'explore', description: 'Do thám nhanh, chỉ đọc: tìm tệp/ký hiệu/sự kiện rồi báo lại kèm bằng chứng.', tier: 'fast', tools: 'readonly', source: 'builtin' },
      { name: 'reviewer', description: 'Phản biện nghiêm khắc một giải pháp rồi kết luận đạt / không đạt / chưa chắc.', tier: 'top', tools: 'readonly', source: 'builtin' },
      { name: 'kiem-thu', description: 'Viết và chạy kiểm thử cho phần vừa sửa.', tier: 'balanced', tools: 'read_file, run_command', source: 'user' },
    ],
    chrome: { running: true, paired: false, connected: false, port: 47615, pairing: { code: 'K7QM-2XPD', expiresAt: Date.now() + 4 * 60_000 } },
    pluginMarket: {
      source: 'anthropics/claude-plugins-official',
      loading: false,
      items: [
        { id: "agent-sdk-dev", name: "agent-sdk-dev", description: "Công cụ phát triển ứng dụng với Claude Agent SDK: lệnh tạo dự án và agent kiểm tra.", category: "development", installed: true, installable: true, origin: "anthropics" },
        { id: "github", name: "github", description: "MCP chính thức của GitHub: issue, pull request, Actions.", category: "productivity", installed: false, installable: true, origin: "anthropics" },
        { id: "figma", name: "figma", description: "Đọc thiết kế, thành phần và biến từ Figma Dev Mode.", category: "design", installed: false, installable: true, origin: "figma/mcp-server-guide" },
        { id: "slack", name: "slack", description: "Tìm kiếm, đọc và gửi tin nhắn Slack.", category: "productivity", installed: false, installable: true, origin: "slackapi/slack-mcp-plugin" },
        { id: "supabase", name: "supabase", description: "Quản lý dự án, bảng và hàm Edge của Supabase.", category: "database", installed: false, installable: true, origin: "supabase-community/supabase-plugin" },
        { id: "vercel", name: "vercel", description: "Triển khai và xem nhật ký trên Vercel.", category: "deployment", installed: false, installable: true, origin: "vercel/vercel-plugin" },
        { id: "stripe", name: "stripe", description: "Kỹ năng và MCP cho API thanh toán Stripe.", category: "development", installed: false, installable: true, origin: "stripe/ai" },
        { id: "notion", name: "notion", description: "Đọc và ghi trang, cơ sở dữ liệu Notion.", category: "productivity", installed: false, installable: true, origin: "makenotion/claude-code-notion-plugin" },
        { id: "linear", name: "linear", description: "Issue và dự án trên Linear.", category: "productivity", installed: false, installable: true, origin: "anthropics" },
        { id: "sentry", name: "sentry", description: "Xem lỗi và sự cố trên Sentry.", category: "monitoring", installed: false, installable: true, origin: "getsentry/plugin-claude" },
        { id: "aws-serverless", name: "aws-serverless", description: "Xây dựng ứng dụng serverless trên AWS.", category: "development", installed: false, installable: true, origin: "awslabs/agent-plugins" },
        { id: "azure", name: "azure", description: "Kỹ năng triển khai và vận hành trên Microsoft Azure.", category: "deployment", installed: false, installable: true, origin: "microsoft/azure-skills" },
        { id: "bigquery-data-analytics", name: "bigquery-data-analytics", description: "Phân tích dữ liệu BigQuery bằng ngôn ngữ tự nhiên.", category: "database", installed: false, installable: true, origin: "gemini-cli-extensions/bigquery-data-analytics" },
        { id: "cloudflare", name: "cloudflare", description: "Workers, KV, R2, D1 trên Cloudflare.", category: "deployment", installed: false, installable: true, origin: "cloudflare/skills" },
        { id: "typescript-lsp", name: "typescript-lsp", description: "Máy chủ ngôn ngữ TypeScript cho chẩn đoán và đi tới định nghĩa.", category: "development", installed: false, installable: true, origin: "anthropics" },
        { id: "pyright-lsp", name: "pyright-lsp", description: "Kiểm tra kiểu Python bằng Pyright.", category: "development", installed: false, installable: true, origin: "anthropics" },
        { id: "rust-analyzer-lsp", name: "rust-analyzer-lsp", description: "Phân tích mã Rust.", category: "development", installed: false, installable: true, origin: "anthropics" },
        { id: "clickhouse", name: "clickhouse", description: "Truy vấn và tối ưu ClickHouse.", category: "database", installed: false, installable: true, origin: "ClickHouse/clickhouse-claude-code-plugin" },
        { id: "duckdb-skills", name: "duckdb-skills", description: "Phân tích dữ liệu cục bộ với DuckDB.", category: "database", installed: false, installable: true, origin: "duckdb/duckdb-skills" },
        { id: "miro", name: "miro", description: "Bảng trắng và sơ đồ trên Miro.", category: "design", installed: false, installable: true, origin: "miroapp/miro-ai" },
        { id: "huggingface-skills", name: "huggingface-skills", description: "Huấn luyện và đăng model lên Hugging Face.", category: "development", installed: false, installable: true, origin: "huggingface/skills" },
        { id: "code-review", name: "code-review", description: "Rà soát mã tự động bằng nhiều agent song song.", category: "productivity", installed: false, installable: true, origin: "anthropics" },
        { id: "superpowers", name: "superpowers", description: "Bộ kỹ năng kỷ luật phát triển: TDD, gỡ lỗi có hệ thống.", category: "development", installed: false, installable: true, origin: "obra/superpowers" },
        { id: "serena", name: "serena", description: "Tìm và sửa mã theo ký hiệu (semantic) — plugin của bên thứ ba.", category: "development", installed: false, installable: true, origin: "anthropics" },
        { id: "vanguard-advisor-tools", name: "vanguard-advisor-tools", description: "Công cụ cho cố vấn tài chính.", category: "productivity", installed: false, installable: true, origin: "Vanguard-oss/vanguard-advisor-tools" },
        { id: "datadog", name: "datadog", description: "Nhật ký, chỉ số và cảnh báo Datadog.", category: "monitoring", installed: false, installable: true, origin: "datadog-labs/claude-code-plugin" },
        { id: 'postgres-tools', name: 'postgres-tools', description: 'Kỹ năng và MCP cho PostgreSQL: tối ưu truy vấn, đọc cấu trúc bảng.', category: 'database', installed: false, installable: true, origin: 'acme/postgres-tools' },
        { id: 'sec-scan', name: 'sec-scan', description: 'Quét bảo mật mã nguồn và phụ thuộc.', category: 'security', installed: false, installable: true, origin: 'sec-co/claude-plugins' },
        { id: 'gl-plugin', name: 'gl-plugin', description: 'Nguồn nằm ngoài GitHub.', category: 'other', installed: false, installable: false, reason: 'Nguồn nằm ngoài GitHub (gitlab.com) — dùng "Cài từ Git…" nếu bạn tin tưởng.', origin: 'gitlab.com' },
      ],
    },
    // Toàn bộ kho kết nối thật (src/core/mcp/catalog.ts) để xem logo của mọi dịch vụ.
    catalog: (
      [
        ["memory", "Memory (Anthropic)", "Anthropic", "memory", "Đồ thị tri thức đơn giản (server tham chiếu của Anthropic). KHÔNG phải Bio-Memory của Locaith.", "stdio", "local", ""],
        ["github", "GitHub", "GitHub", "dev", "Repo, issue, pull request, Actions, quét mã… bằng chính tài khoản GitHub của bạn (đăng nhập bằng tài khoản đã đăng nhập trong VS Code).", "http", "github", ""],
        ["sentry", "Sentry", "Sentry", "dev", "Xem lỗi, sự cố và dự án trên Sentry ngay trong cuộc trò chuyện.", "http", "oauth", ""],
        ["vercel", "Vercel", "Vercel", "dev", "Quản lý dự án, triển khai và nhật ký trên Vercel.", "http", "oauth", ""],
        ["cloudflare-bindings", "Cloudflare (Workers & bindings)", "Cloudflare", "dev", "Quản lý Workers, KV, R2, D1 trên Cloudflare.", "http", "oauth", ""],
        ["huggingface", "Hugging Face", "Hugging Face", "dev", "Tìm model, dataset, Space và bài báo trên Hugging Face.", "http", "none", ""],
        ["sequential-thinking", "Sequential Thinking", "Anthropic", "dev", "Suy luận từng bước có thể sửa/rẽ nhánh cho bài toán phức tạp.", "stdio", "local", ""],
        ["notion", "Notion", "Notion", "pm", "Đọc, tìm và ghi trang, cơ sở dữ liệu trong Notion.", "http", "oauth", ""],
        ["linear", "Linear", "Linear", "pm", "Issue, dự án và chu kỳ trên Linear.", "http", "oauth", ""],
        ["clickup", "ClickUp", "ClickUp", "pm", "Công việc, tài liệu và không gian ClickUp.", "http", "oauth", ""],
        ["monday", "monday.com", "monday.com", "pm", "Bảng, mục và cập nhật trên monday.com.", "http", "oauth", ""],
        ["asana", "Asana", "Asana", "pm", "Dự án và công việc trên Asana.", "http", "oauth", "Asana yêu cầu ứng dụng OAuth riêng của bạn (không cho đăng ký tự động) — chưa hỗ trợ."],
        ["slack", "Slack", "Slack", "comm", "Tìm và đọc kênh, gửi tin trên Slack.", "http", "oauth", "Slack yêu cầu ứng dụng OAuth riêng của bạn (không cho đăng ký tự động) — chưa hỗ trợ."],
        ["intercom", "Intercom", "Intercom", "comm", "Hội thoại và khách hàng trên Intercom.", "http", "oauth", ""],
        ["supabase", "Supabase", "Supabase", "data", "Quản lý dự án, bảng và truy vấn Supabase.", "http", "oauth", ""],
        ["neon", "Neon", "Neon", "data", "Quản lý cơ sở dữ liệu Postgres trên Neon.", "http", "oauth", ""],
        ["prisma", "Prisma Postgres", "Prisma", "data", "Tạo và quản lý cơ sở dữ liệu Prisma Postgres.", "http", "oauth", ""],
        ["airtable", "Airtable", "Airtable", "data", "Đọc và ghi bản ghi, cấu trúc bảng trên Airtable.", "http", "oauth", ""],
        ["honeycomb", "Honeycomb", "Honeycomb", "data", "Truy vấn dữ liệu quan sát (trace, sự kiện) trên Honeycomb.", "http", "oauth", ""],
        ["datadog", "Datadog", "Datadog", "data", "Nhật ký, chỉ số và cảnh báo trên Datadog.", "http", "oauth", ""],
        ["stripe", "Stripe", "Stripe", "pay", "Khách hàng, thanh toán, hoá đơn trên Stripe.", "http", "oauth", ""],
        ["paypal", "PayPal", "PayPal", "pay", "Giao dịch và hoá đơn PayPal.", "http", "oauth", ""],
        ["square", "Square", "Square", "pay", "Cửa hàng, đơn hàng và thanh toán Square.", "http", "oauth", "Square dùng giao thức SSE cũ — chưa hỗ trợ."],
        ["figma", "Figma", "Figma", "design", "Đọc thiết kế, thành phần và biến từ Figma.", "http", "oauth", ""],
        ["canva", "Canva", "Canva", "design", "Tạo và chỉnh thiết kế trên Canva.", "http", "oauth", ""],
        ["webflow", "Webflow", "Webflow", "design", "Quản lý site và CMS trên Webflow.", "http", "oauth", ""],
        ["wix", "Wix", "Wix", "design", "Quản lý site Wix.", "http", "oauth", ""],
        ["context7", "Context7", "Upstash", "docs", "Tài liệu mới nhất của thư viện/framework, ngay trong cuộc trò chuyện.", "http", "none", ""],
        ["deepwiki", "DeepWiki", "Cognition", "docs", "Hỏi đáp về mọi kho GitHub công khai.", "http", "none", ""],
        ["microsoft-learn", "Microsoft Learn", "Microsoft", "docs", "Tra cứu tài liệu Microsoft, Azure, .NET chính thức.", "http", "none", ""],
        ["cloudflare-docs", "Cloudflare Docs", "Cloudflare", "docs", "Tra cứu tài liệu Cloudflare.", "http", "none", ""],
        ["exa", "Exa Search", "Exa", "search", "Tìm kiếm web theo ngữ nghĩa.", "http", "none", ""],
        ["playwright", "Playwright", "Microsoft", "browser", "Điều khiển một trình duyệt riêng bằng Playwright (mở trang, bấm, chụp ảnh, kiểm thử web).", "stdio", "local", ""],
        ["chrome-devtools", "Chrome DevTools", "Google", "browser", "Điều khiển và kiểm tra một trình duyệt Chrome đang chạy (hiệu năng, mạng, console).", "stdio", "local", ""],
        ["filesystem", "Filesystem", "Anthropic", "files", "Đọc/ghi tệp trong thư mục workspace qua MCP.", "stdio", "local", ""],
      ] as const
    ).map(([id, name, vendor, category, description, transport, auth, unsupported]) => ({
      id, name, vendor, category, description, transport, auth, connected: id === 'notion' || id === 'context7', ...(id === 'notion' ? { status: 'running' as const } : {}), ...(unsupported ? { unsupported } : {}), ...(transport === 'stdio' ? { needs: 'node' as const } : {}),
    })),
    bio: { state: 'ready', enabled: true, dataDir: 'C:\\Users\\anh\\.locaith\\bio-memory\\data' },
    presets: [
      { id: 'filesystem', name: 'filesystem', description: 'Đọc/ghi tệp trong thư mục workspace qua MCP.', added: true },
      { id: 'memory', name: 'memory', description: 'Bộ nhớ dài hạn dạng đồ thị tri thức.', added: false },
      { id: 'context7', name: 'context7', description: 'Tra tài liệu thư viện/framework mới nhất.', added: false },
    ],
  };
}

function thinkingState(): ViewState {
  const v = baseState();
  const thought = 'Người dùng hỏi về cách chia tải giữa các nhà cung cấp. Trước hết cần phân biệt chuyển dự phòng (failover) với chia tải thật sự. Failover chỉ kích hoạt khi hãng đang dùng báo lỗi 429 hoặc quá tải. Chia tải cần đếm số lượt đã dùng ở mỗi hãng và ưu tiên hãng ít dùng nhất cho các agent con chạy song song. '.repeat(6);
  return {
    ...v,
    running: true,
    transcript: [
      { kind: 'user', id: 'u1', text: 'Giải thích cách bạn chia tải giữa các hãng AI', attachments: [], ts: Date.now() - 20000 },
      { kind: 'assistant', id: 'a1', provider: 'anthropic', model: 'claude-opus-5-5', ts: Date.now() - 19000, done: false, blocks: [{ type: 'thinking', id: 'k1', text: thought }] },
    ],
  };
}

/** Đang chạy, đã chèn một tin giữa chừng và còn hai tin xếp hàng. */
function queueState(): ViewState {
  const v = thinkingState();
  const now = Date.now();
  return {
    ...v,
    canQueue: true,
    transcript: [
      { kind: 'user', id: 'u1', text: 'Đọc thư mục src và liệt kê các module chính', attachments: [], ts: now - 40000 },
      {
        kind: 'assistant',
        id: 'a0',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: now - 39000,
        done: true,
        stopReason: 'end_turn',
        usage: { inputTokens: 5200, outputTokens: 640 },
        blocks: [{ type: 'tool', id: 't1', name: 'list_dir', args: { path: 'src' }, state: 'done', summary: '12 mục', startedAt: now - 38000, durationMs: 120 }],
      },
      { kind: 'user', id: 'u2', text: 'Nhớ bỏ qua thư mục test nhé', attachments: [], ts: now - 30000, steer: true },
      ...v.transcript.slice(1),
    ],
    queued: [
      { id: 'q1', text: 'Sau đó viết thêm test cho phần điều phối', attachments: [], ts: now - 5000 },
      {
        id: 'q2',
        text: 'Và cập nhật CHANGELOG với một đoạn thật dài để kiểm tra việc cắt dòng khi tin đang chờ có nội dung vượt quá hai dòng hiển thị trong khung hẹp',
        attachments: [{ kind: 'file', label: 'CHANGELOG.md', path: 'CHANGELOG.md' }],
        ts: now - 3000,
      },
    ],
  };
}

const SMALL_PNG = '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';
const BIG_PNG = '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';

/** Tin đã gửi có hai ảnh (chỉ còn bản thu nhỏ + khoá, như sau khi tải lại phiên) và một ảnh khác không còn trong lịch sử. */
/** (0.6.3) Tệp mẫu có thật trong webview/dev/media (dung lượng thật) — host giả trả `src` tương đối với harness.html. */
const HARNESS_MEDIA: Record<string, number> = {
  'demo-locaith.mp4': 1604845,
  'short-9x16.mp4': 627054,
  'loop.gif': 71337,
  'cover.png': 76699,
  'mandelbrot.jpg': 111371,
  'logo.svg': 434,
  'voice.mp3': 36720,
  'broken.mp4': 4096,
  'bao-cao.pdf': 19,
  'trang-demo.html': 53,
  // nằm ngoài các thư mục webview đọc được: có thật nhưng không nhúng (thẻ mở)
  'ngoai-vung.mp4': 52_428_800,
};

function harnessMedia(p: string): MediaItem {
  const name = p.split(/[\\/]/).pop() ?? p;
  const size = HARNESS_MEDIA[name];
  const kind = mediaKindOf(name);
  if (size === undefined || !kind) return { path: p, ok: false };
  const abs = /^[A-Za-z]:/.test(p) ? p : `C:\\Users\\anh\\du-an-demo\\${p.replace(/\//g, '\\')}`;
  const inline = kind !== 'doc' && name !== 'ngoai-vung.mp4';
  return { path: p, ok: true, kind, name, abs, size, mtime: Date.now(), src: inline ? `media/${name}` : undefined };
}

const FENCE = '```';
const MEDIA_ANSWER = [
  'Xong rồi anh. Video quảng cáo đã dựng xong ở `out/demo-locaith.mp4` (1280×720, 4 giây), kèm bản dọc cho Shorts: `out/short-9x16.mp4`.',
  '',
  'Ảnh dùng kèm:',
  '- Ảnh bìa: `out/cover.png`',
  '- Ảnh động xem trước: out/loop.gif',
  '- Hình nền thử: [mandelbrot.jpg](out/mandelbrot.jpg)',
  '- Logo: `assets/logo.svg`',
  '',
  '![Ảnh bìa](out/cover.png)',
  '',
  'Nhạc nền: `out/voice.mp3`. Bản nháp hỏng (để kiểm tra trình phát): `out/broken.mp4`.',
  '',
  '| Tệp | Ghi chú |',
  '|:--|:--|',
  '| `docs/bao-cao.pdf` | Báo cáo PDF |',
  '| `site/trang-demo.html` | Trang giới thiệu |',
  '',
  'Bản gốc ở máy quay: `E:\\may-quay\\ngoai-vung.mp4`. Tệp chưa có: `out/khong-co.png`. Ảnh trên mạng (không xem trước): https://example.com/a.png',
  '',
  'Lệnh đã chạy (không phải kết quả, không xem trước):',
  FENCE + 'bash',
  'ffmpeg -i out/raw.mp4 -vf scale=1280:-2 out/demo-locaith.mp4',
  FENCE,
].join('\n');

/** (0.6.3) Lượt đã xong có quá trình dài (suy nghĩ, công cụ, chữ xen giữa) + câu trả lời nhắc tới nhiều loại tệp kết quả. `live`: cùng nội dung nhưng đang chạy. */
function mediaScene(live = false): ViewState {
  const v = baseState();
  const now = Date.now();
  const t0 = now - 133_000;
  const tool = (id: string, name: string, args: Record<string, unknown>, at: number, ms: number, extra: Partial<ToolBlock> = {}): ToolBlock => ({
    type: 'tool',
    id,
    name,
    args,
    state: 'done',
    startedAt: t0 + at,
    durationMs: ms,
    ...extra,
  });
  const blocks: ABlock[] = [
    { type: 'tasks', id: 'm:task', added: ['Dựng video 1280×720', 'Xuất bản dọc 9:16', 'Làm ảnh bìa + ảnh động'] },
    { type: 'thinking', id: 'm:k1', text: 'Cần một video ngang cho trang chủ và một bản dọc cho Shorts. Dùng ffmpeg với testsrc để dựng nháp, rồi xuất GIF xem trước bằng palettegen.' },
    tool('m:r1', 'read_file', { path: 'kich-ban.md' }, 2000, 40, { summary: '38 dòng' }),
    tool('m:c1', 'run_command', { command: 'ffmpeg -f lavfi -i testsrc2=size=1280x720 -t 4 out/demo-locaith.mp4' }, 6000, 41_000, { output: 'frame=  120 fps= 30 q=-1.0 Lsize=    1567kB time=00:00:04.00' }),
    { type: 'text', id: 'm:t1', text: 'Video ngang đã xong (`out/demo-locaith.mp4`), giờ mình xuất bản dọc và ảnh động xem trước.' },
    tool('m:c2', 'run_command', { command: 'ffmpeg -i out/demo-locaith.mp4 -vf crop=ih*9/16:ih out/short-9x16.mp4' }, 50_000, 30_000),
    tool('m:c3', 'run_command', { command: 'ffmpeg -i out/demo-locaith.mp4 -vf palettegen out/palette.png' }, 82_000, 9_000),
    tool('m:c4', 'run_command', { command: 'ffmpeg -i out/demo-locaith.mp4 -i out/palette.png -lavfi paletteuse out/loop.gif' }, 92_000, 14_000),
    tool('m:w1', 'write_file', { path: 'assets/logo.svg' }, 108_000, 60, { summary: '+12' }),
    { type: 'text', id: 'm:t2', text: 'Đã có ảnh động; kiểm lại thời lượng và kích thước các tệp trước khi báo anh.' },
    tool('m:c5', 'run_command', { command: 'ffprobe -v error -show_entries format=duration out/demo-locaith.mp4' }, 124_000, 1_200, { output: 'duration=4.000000', state: live ? 'running' : 'done' }),
  ];
  if (!live) blocks.push({ type: 'text', id: 'm:t3', text: MEDIA_ANSWER });
  return {
    ...v,
    title: 'Dựng video quảng cáo',
    running: live,
    transcript: [
      { kind: 'user', id: 'u_m', text: 'Dựng giúp anh video quảng cáo 4 giây kèm ảnh bìa, ảnh động và bản dọc cho Shorts nhé', attachments: [], ts: t0 - 1000 },
      {
        kind: 'assistant',
        id: 'a_m',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        ts: t0,
        ...(live ? {} : { endedAt: now - 2000, stopReason: 'end_turn', usage: { inputTokens: 41_200, outputTokens: 3_870 } }),
        done: !live,
        blocks,
      },
    ],
  };
}

function imageScene(): ViewState {
  const v = baseState();
  const now = Date.now();
  return {
    ...v,
    transcript: [
      { kind: 'user', id: 'u_img', text: 'Xem giúp anh hai ảnh này có gì lạ không', ts: now - 5000, attachments: [
        { kind: 'image', label: 'Ảnh 1', mediaType: 'image/png', thumb: SMALL_PNG, imgKey: 'k-1' },
        { kind: 'image', label: 'Ảnh 2', mediaType: 'image/png', thumb: SMALL_PNG, imgKey: 'k-2' },
      ] },
      { kind: 'assistant', id: 'a_img', provider: 'anthropic', model: 'claude-opus-5-5', ts: now - 3000, done: true, stopReason: 'end_turn', blocks: [{ type: 'text', id: 't1', text: 'Em thấy cả hai ảnh đều là cùng một dải màu chuyển từ xanh ngọc sang tím.' }] },
    ],
  };
}

/** Đang chạy: nhiều lần sửa tệp (gộp một dòng), một lần đang sửa, ba agent con đang chạy, một agent lỗi. */
function agentsScene(): ViewState {
  const v = baseState();
  const now = Date.now();
  const edit = (i: number, done = true) => ({
    type: 'tool' as const,
    id: `e${i}`,
    name: 'edit_file',
    args: { path: `training/gen_if_data_${i}.py` },
    state: done ? ('done' as const) : ('running' as const),
    summary: done ? undefined : 'đang ghi',
    startedAt: now - 60000 + i * 1000,
    ...(done ? { durationMs: 120, diff: { path: `training/gen_if_data_${i}.py`, added: 3 + i, removed: 1, hunks: [] } } : {}),
  });
  const agent = (i: number, name: string, state: 'running' | 'error', activity: string) => ({
    type: 'tool' as const,
    id: `a${i}`,
    name: 'agent',
    args: { description: name, agent_type: 'explore' },
    state,
    startedAt: now - (30000 + i * 5000),
    agent: { tokens: 4200 + i * 900, tools: 3 + i, failed: state === 'error' ? 1 : 0, activity },
  });
  return {
    ...v,
    running: true,
    transcript: [
      { kind: 'user', id: 'u1', text: 'Dọn bộ dữ liệu huấn luyện và kiểm ràng buộc', attachments: [], ts: now - 120000 },
      {
        kind: 'assistant',
        id: 'a1',
        provider: 'locaith-auto',
        model: 'locaith-v5-flash',
        ts: now - 110000,
        done: false,
        blocks: [
          { type: 'tool', id: 't0', name: 'run_command', args: { command: 'py -3.11 -I gen_if_data.py --n 50000' }, state: 'done', summary: 'thành công', startedAt: now - 100000, durationMs: 38000, output: 'ok' },
          edit(1), edit(2), edit(3), edit(4), edit(5), edit(6, false),
          agent(1, 'Rà ràng buộc dữ liệu', 'running', 'đang đọc training/gen_if_data.py'),
          agent(2, 'Đối chiếu bộ kiểm tra', 'running', 'đang chạy grep'),
          agent(3, 'Soát định dạng JSONL', 'running', 'đang chạy python'),
          agent(4, 'Dò trùng lặp', 'error', ''),
          { type: 'pill', id: 'p1', kind: 'working', text: 'Đang chạy lệnh…', active: true },
        ],
      },
    ],
  };
}

/** Hai «việc» liên tiếp: mỗi việc có lệnh + sửa tệp riêng → mỗi việc gộp MỘT dòng. */
function taskflowScene(): ViewState {
  const v = baseState();
  const now = Date.now();
  const t = (i: number, name: string, extra: Record<string, unknown> = {}) => ({ type: 'tool' as const, id: 'x' + i, name, args: { path: 'training/gen_if_data.py', command: 'py -3.11 -I gen_if_data.py --n 50000' }, state: 'done' as const, startedAt: now - 60000 + i * 800, durationMs: 900, ...extra });
  const edit = (i: number) => t(i, 'edit_file', { diff: { path: 'training/gen_if_data.py', added: 4, removed: 2, hunks: [] } });
  return {
    ...v,
    running: true,
    transcript: [
      { kind: 'user', id: 'u1', text: 'Dọn dữ liệu huấn luyện và kiểm ràng buộc', attachments: [], ts: now - 90000 },
      {
        kind: 'assistant', id: 'a1', provider: 'locaith-auto', model: 'locaith-v5-flash', ts: now - 88000, done: false,
        blocks: [
          { type: 'tasks', id: 'k1', added: ['A. Sinh và làm sạch bộ dữ liệu'] },
          t(1, 'read_file', { args: { path: 'training/check_if.py' } }),
          edit(2), edit(3), edit(4),
          { type: 'thinking', id: 'th1', text: 'Cần kiểm lại ràng buộc trước khi chạy tiếp.' },
          t(5, 'run_command', { summary: 'thành công', output: 'ok' }),
          { type: 'tasks', id: 'k2', added: ['B. Viết bộ kiểm ràng buộc (check_if.py)'] },
          t(6, 'run_command', { summary: 'thành công', output: 'ok' }),
          t(7, 'run_command', { summary: 'thành công', output: 'ok' }),
          t(8, 'run_command', { summary: 'thành công', output: 'ok' }),
          { type: 'text', id: 'ans', text: 'Xong: dữ liệu sạch, bộ kiểm ràng buộc đã chạy qua.' },
        ],
      },
    ],
  };
}

function initialView(): ViewState {
  let v: ViewState;
  switch (scenario) {
    case 'onboarding':
      v = onboardingState();
      break;
    case 'long':
    case 'history':
      v = longConversation();
      if (scenario === 'history') v = { ...v, screen: 'history' };
      break;
    case 'perm-edit':
    case 'perm-cmd':
    case 'perm-plan':
      v = permissionState(scenario.slice(5) as 'edit' | 'cmd' | 'plan');
      break;
    case 'error':
      v = errorState();
      break;
    // (lane:output-timeouts) trả lời bị cắt + nút «Chạy tiếp phần 2» · buộc dừng vì model treo + nút «Chạy tiếp»
    case 'cut-continue':
      v = cutContinueState();
      break;
    case 'cut-forced':
      v = cutContinueState({ forced: true });
      break;
    case 'settings':
      v = settingsState(true);
      break;
    case 'settings-nokeys':
      v = settingsState(false);
      break;
    case 'high-context':
      v = { ...longConversation(), context: { usedTokens: 188_000, limitTokens: 200_000 } };
      break;
    case 'market':
      v = { ...baseState(), screen: 'market' };
      break;
    // ── tài khoản locaith.ai ──
    case 'acct-out':
      v = { ...baseState(), account: { status: 'signedOut', webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-wait':
      v = { ...baseState(), account: { status: 'signingIn', webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-wait-manual':
      v = { ...baseState(), account: { status: 'signingIn', manual: true, webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-expired':
      v = { ...baseState(), account: { status: 'expired', reason: 'revoked', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-error':
      v = { ...baseState(), account: { status: 'signedOut', error: 'invalid_grant', webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-settings':
      v = { ...settingsState(true), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' } };
      break;
    case 'acct-settings-offline':
      v = { ...settingsState(true), account: { status: 'signedIn', offline: true, user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' } };
      break;
    // ── Remote trong khung chat ──
    case 'remote-queue':
    case 'remote-queue-fresh':
    case 'remote-queue-trying': {
      const now = Date.now();
      const q = scenario === 'remote-queue-fresh' ? { attempt: 1, retryAt: now + 17000, waitMs: 20000, since: now - 3000 } : { attempt: 2, retryAt: now + 31000, waitMs: 45000, since: now - 70000 };
      v = { ...longConversation(), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' }, remote: { enabled: true, signedIn: true, relay: 'queued', queue: { kind: 'connections', ...q, trying: scenario === 'remote-queue-trying' }, devices: 0, streams: 0 } };
      break;
    }
    case 'remote-settings':
      v = { ...settingsState(true), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' }, remote: { enabled: true, signedIn: true, relay: 'online', devices: 2, streams: 1 } };
      break;
    case 'remote-settings-trust':
      // 0.6.5: tin cậy theo tài khoản đang hoạt động → nút «Mở trang Remote» thay cho «Ghép đôi thiết bị mới», lời giải thích khác.
      v = { ...settingsState(true), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' }, remote: { enabled: true, signedIn: true, relay: 'online', devices: 0, streams: 1, trust: true } };
      break;
    case 'remote-settings-queued': {
      const now = Date.now();
      v = { ...settingsState(true), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' }, remote: { enabled: true, signedIn: true, relay: 'queued', queue: { kind: 'connections', attempt: 2, retryAt: now + 31000, waitMs: 45000, since: now - 70000, trying: false }, devices: 0, streams: 0 } };
      break;
    }
    case 'remote-settings-off':
      v = { ...settingsState(true), account: { status: 'signedIn', user: { name: 'Nguyễn Tuấn Anh', email: 'tuananh@locaith.ai' }, webUrl: 'https://locaith.ai' }, remote: { enabled: false, signedIn: true, relay: 'off', devices: 1, streams: 0 } };
      break;
    // ── Mô hình Locaith (AI Local) ──
    case 'locaith-welcome':
      v = locaithState({ accepted: true });
      break;
    case 'promo':
      v = { ...locaithState({ accepted: true }), workspace: { name: 'locaith-demo', folders: ['C:/Users/you/locaith-demo'] }, editor: null, settings: { ...baseState().settings, language: 'en' } };
      break;
    // ── (0.6.1) lối tắt ngay trong khung chat: công tắc Remote, thẻ Chrome xin kết nối, dải Trí nhớ sinh học ──
    case 'chat-strips':
    case 'chat-strips-error':
    case 'chat-strips-off': {
      const base = locaithState({ accepted: true, conversation: true });
      v = {
        ...base,
        remote: { enabled: scenario !== 'chat-strips-off', signedIn: true, relay: scenario === 'chat-strips-off' ? 'off' : 'online', devices: 1, streams: 0 },
        ...(scenario === 'chat-strips-off' ? {} : { chromePair: { id: 'req1', extensionId: 'abcdefghijklmnopabcdefk3f9d2xyz'.slice(0, 26) + 'k3f9d2', expiresAt: Date.now() + 110000 } }),
        memory: scenario === 'chat-strips-error' ? { state: 'error', message: 'Không tìm thấy Python 3.10 trở lên (đã thử py, python, python3). Cài Python rồi thử lại.' } : { state: 'installing' },
      };
      break;
    }
    case 'locaith-queue':
      v = locaithState({ accepted: true, conversation: true, queue: { position: 7, attempt: 2, leftSec: 8, waitSec: 12, limit: 100 } });
      break;
    case 'locaith-queue-fresh':
      v = locaithState({ accepted: true, conversation: true, queue: { position: 23, attempt: 1, leftSec: 12, waitSec: 12, limit: 100 } });
      break;
    case 'locaith-queue-trying':
      v = locaithState({ accepted: true, conversation: true, queue: { position: 1, attempt: 5, leftSec: 0, waitSec: 3 } });
      break;
    case 'locaith-consent':
      v = locaithState({ card: true });
      break;
    case 'locaith-consent-conv':
      v = locaithState({ card: true, conversation: true });
      break;
    case 'locaith-consent-saving':
      v = locaithState({ card: true, saving: true });
      break;
    case 'locaith-consent-error':
      v = locaithState({ card: true, error: 'Không kết nối được máy chủ Locaith để ghi nhận đồng ý. Kiểm tra mạng rồi bấm lại.' });
      break;
    case 'locaith-consent-outdated':
      v = locaithState({ card: true, outdated: true });
      break;
    case 'locaith-settings':
      v = locaithState({ accepted: true, screen: 'settings' });
      break;
    case 'locaith-settings-pending':
      v = locaithState({ accepted: false, screen: 'settings' });
      break;
    // ── nhiều việc chạy cùng lúc: dòng tóm tắt lệnh gọi + agent con sống (parallel.css) ──
    case 'parallel-agents':
      v = parallelAgentsState();
      break;
    // ── (lane:cc-timeline-ui) dòng thời gian gọn kiểu Claude Code (ba ảnh mẫu) ──
    case 'cc-timeline':
      v = ccTimelineState();
      break;
    case 'cc-working':
      v = ccTimelineState({ working: true });
      break;
    case 'parallel-narrow':
      v = parallelAgentsState({ narrow: true });
      break;
    case 'thinking':
      v = thinkingState();
      break;
    case 'queue':
      v = queueState();
      break;
    case 'images':
      v = imageScene();
      break;
    case 'agents':
      v = agentsScene();
      break;
    case 'taskflow':
      v = taskflowScene();
      break;
    case 'media':
    case 'media-live':
      v = mediaScene(scenario === 'media-live');
      break;
    case 'history-other':
      v = { ...baseState(), screen: 'history', sessions: [...SESSIONS.slice(0, 2), { id: 's_o1', title: 'Sửa lỗi thanh toán trang bán hàng', updatedAt: Date.now() - 3 * 3600_000, provider: 'anthropic', model: 'claude-sonnet-5', messageCount: 64, other: true, workspaceName: 'web-ban-hang' }, { id: 's_o2', title: 'Viết tài liệu API', updatedAt: Date.now() - 30 * 3600_000, provider: 'deepseek', model: 'deepseek-chat', messageCount: 22, other: true, workspaceName: 'api-docs' }] };
      break;
    default:
      v = baseState();
  }
  if (langParam === 'en') v = { ...v, settings: { ...v.settings, language: 'en' } };
  if (fontParam) v = { ...v, settings: { ...v.settings, fontFamily: fontParam as ViewState['settings']['fontFamily'] } };
  if (params.get('bypass') === '1') v = { ...v, allowBypass: true };
  // (lane:cc-timeline-ui) platform=browser: cùng giao diện chạy như bản Chrome/Edge (không nút mở tệp, placeholder tab).
  if (params.get('platform') === 'browser') v = { ...v, platform: 'browser', canQueue: false, remote: undefined, account: undefined };
  v = {
    ...v,
    orchestration: {
      mode: 'failover',
      pool: [
        { providerId: 'anthropic', providerLabel: 'Claude (Anthropic)', cooling: false, tiers: { top: { model: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, balanced: { model: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, fast: { model: 'claude-haiku-5', label: 'Claude Haiku 5' } } },
        { providerId: 'deepseek', providerLabel: 'DeepSeek', cooling: true, tiers: { top: { model: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }, fast: { model: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' } } },
      ],
    },
  };
  return v;
}

const host = new MockHost(initialView());
void PROVIDERS;
