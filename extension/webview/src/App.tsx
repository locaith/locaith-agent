import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostMessage, MarketState, UiSettings, ViewState } from '../../src/shared/protocol';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/protocol';
import { reduceView } from '../../src/shared/transcript';
import { bus } from './bus';
import { ChatView } from './components/ChatView';
import { Composer } from './components/composer/Composer';
import { FullAccessDialog, Lightbox, type LightboxState } from './components/Overlays';
import { Header, type Screen } from './components/Header';
import { LoDefs, LoSpinner } from './components/Brand';
import { HistoryView } from './components/HistoryView';
import { MarketView } from './components/MarketView';
import { SettingsView } from './components/SettingsView';
import { ModelQueueStrip } from './components/ModelQueue';
import { BgTasksStrip } from './components/BgTasksStrip'; // (lane:bg-tasks)
import { ChromePairStrip } from './components/ChromePairStrip';
import { MemoryStrip } from './components/MemoryStrip';
import { RatingStrip } from './components/RatingStrip';
import { RemoteStrip } from './components/RemoteView';
import { Toasts, type ToastItem } from './components/Toasts';
import { AccountGate } from './components/AccountGate';
import { AppContext, type AppContextValue } from './ctx';
import { applyUiSettings } from './fonts';
import { makeT } from './i18n';
import { post } from './vscode';

let toastSeq = 0;

export function App() {
  const [view, setView] = useState<ViewState | null>(null);
  const [screen, setScreen] = useState<Screen>('chat');
  const [market, setMarket] = useState<MarketState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [srText, setSrText] = useState('');
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [fullAccessOpen, setFullAccessOpen] = useState(false);
  const overlayRef = useRef(false);
  overlayRef.current = lightbox !== null || fullAccessOpen;
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const addToast = useCallback((level: ToastItem['level'], text: string) => {
    setToasts((prev) => [...prev.slice(-2), { id: ++toastSeq, level, text }]);
  }, []);
  const closeToast = useCallback((id: number) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);

  // Đăng nhập xong thì bỏ các toast «Hãy đăng nhập…» còn sót (do thử gửi tin trước khi đăng nhập) — không để chúng treo trên giao diện chính.
  const signedIn = !view?.account || view.account.status === 'signedIn';
  useEffect(() => {
    if (signedIn) setToasts([]);
  }, [signedIn]);

  // Lớp phủ do giao diện tự mở (không qua host): ảnh phóng to, hộp xác nhận Toàn quyền.
  useEffect(() => {
    const offs = [bus.lightbox.on((item) => setLightbox(item)), bus.fullAccess.on(() => setFullAccessOpen(true)),
      bus.imageData.on((d) => setLightbox((cur) => (cur && cur.key === d.key ? { ...cur, src: `data:${d.mediaType};base64,${d.data}` } : cur)))];
    return () => offs.forEach((off) => off());
  }, []);

  // ── nhận tin từ host ──
  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'init':
          setView(m.state);
          if (m.state.screen) setScreen(m.state.screen);
          break;
        case 'events':
          setView((v) => (v ? m.events.reduce((acc, ev) => reduceView(acc, ev), v) : v));
          break;
        case 'patch':
          setView((v) => (v ? { ...v, ...m.patch } : v));
          if (m.patch.screen) setScreen(m.patch.screen);
          break;
        case 'files':
          bus.files.emit({ reqId: m.reqId, items: m.items });
          break;
        case 'document_parsed':
          bus.documentParsed.emit({ reqId: m.reqId, name: m.name, doc: m.doc, error: m.error });
          break;
        case 'insert':
          setScreen('chat');
          bus.insert.emit({ text: m.text, attachments: m.attachments });
          break;
        case 'draft':
          setScreen('chat');
          bus.draft.emit({ text: m.text, attachments: m.attachments });
          break;
        case 'focus':
          setScreen('chat');
          bus.focus.emit();
          break;
        case 'market_state':
          // `partial`: chỉ có plugin/MCP/agent (cập nhật nhanh) — giữ nguyên danh sách kỹ năng đã có.
          setMarket((prev) => (m.state.partial && prev ? { ...prev, plugins: m.state.plugins, mcp: m.state.mcp, agents: m.state.agents, presets: m.state.presets, catalog: m.state.catalog ?? prev.catalog, bio: m.state.bio ?? prev.bio, pluginMarket: m.state.pluginMarket ?? prev.pluginMarket, chrome: m.state.chrome ?? prev.chrome } : m.state));
          break;
        case 'image_data':
          bus.imageData.emit({ key: m.key, mediaType: m.mediaType, data: m.data });
          break;
        case 'media_resolved':
          bus.mediaResolved.emit({ key: m.key, items: Array.isArray(m.items) ? m.items : [] });
          break;
        case 'toast':
          addToast(m.level, m.text);
          break;
        case 'test_result':
          bus.testResult.emit({ provider: m.provider, ok: m.ok, message: m.message });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [addToast]);

  const settings: UiSettings = view?.settings ?? DEFAULT_UI_SETTINGS;
  useEffect(() => applyUiSettings(settings), [settings]);

  const lang = settings.language;
  const t = useMemo(() => makeT(lang), [lang]);

  // Vùng thông báo cho trình đọc màn hình: chỉ nói khi bắt đầu/xong, không đọc từng mảnh stream.
  const running = view?.running ?? false;
  const prevRunning = useRef(false);
  useEffect(() => {
    if (running !== prevRunning.current) {
      setSrText(running ? t('app.assistantBusy') : prevRunning.current ? t('app.assistantDone') : '');
      prevRunning.current = running;
    }
  }, [running, t]);

  const goChat = useCallback(() => setScreen('chat'), []);
  const openSettings = useCallback(() => setScreen('settings'), []);

  // Esc: quay lại từ màn hình phụ, hoặc dừng tác vụ đang chạy.
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (overlayRef.current) {
        setLightbox(null);
        setFullAccessOpen(false);
        return;
      }
      if (screenRef.current !== 'chat') {
        setScreen('chat');
      } else if (runningRef.current) {
        post({ type: 'stop' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSetting = useCallback(<K extends keyof UiSettings>(key: K, value: UiSettings[K]) => {
    // Cập nhật lạc quan để giao diện đổi ngay; host sẽ gửi lại bản chuẩn qua `patch`.
    setView((v) => (v ? { ...v, settings: { ...v.settings, [key]: value } } : v));
    post({ type: 'set_ui_setting', key, value: value as string | number | boolean });
  }, []);

  const ctx: AppContextValue = useMemo(
    () => ({
      lang,
      t,
      settings,
      editor: view?.editor ?? null,
      folders: view?.workspace?.folders ?? [],
      hasSelection: Boolean(view?.editor?.selection),
      platform: view?.platform ?? 'vscode',
      openSettings,
      toast: addToast,
    }),
    [lang, t, settings, view?.editor, view?.workspace, view?.platform, openSettings, addToast],
  );

  if (!view) {
    return (
      <div class="app app-loading" role="status">
        <LoDefs />
        <LoSpinner size={30} />
        <span>{makeT(lang)('app.loading')}</span>
      </div>
    );
  }

  const hasAnyKey = view.providers.some((p) => p.hasKey);

  // CỔNG TÀI KHOẢN: chưa đăng nhập locaith.ai thì chỉ hiện màn đăng nhập (host cũng từ chối mọi thao tác khác — đây chỉ là phần giao diện).
  if (view.account && view.account.status !== 'signedIn') {
    return (
      <AppContext.Provider value={ctx}>
        <div class="app screen-account">
          <LoDefs />
          <AccountGate account={view.account} />
          <Toasts items={toasts} onClose={closeToast} />
        </div>
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <div class={`app screen-${screen}`}>
        <LoDefs />
        <Header
          title={view.title}
          screen={screen}
          running={view.running}
          onNew={() => {
            post({ type: 'new_session' });
            setScreen('chat');
          }}
          onHistory={() => setScreen((s) => (s === 'history' ? 'chat' : 'history'))}
          onMarket={() => setScreen((s) => (s === 'market' ? 'chat' : 'market'))}
          onSettings={() => setScreen((s) => (s === 'settings' ? 'chat' : 'settings'))}
          onBack={goChat}
          remote={view.remote}
          context={view.context}
          meter={view.meter}
        />

        <main class="app-main">
          <div class="pane pane-chat" hidden={screen !== 'chat'}>
            <ChatView view={view} hasAnyKey={hasAnyKey} />
          </div>
          {screen === 'history' && (
            <div class="pane pane-scroll">
              <HistoryView view={view} onOpen={goChat} />
            </div>
          )}
          {screen === 'settings' && (
            <div class="pane pane-scroll">
              <SettingsView view={view} onSetting={onSetting} />
            </div>
          )}
          {screen === 'market' && (
            // Not a scrolling pane: the tab bar stays a fixed band and only the list under it scrolls (see MarketView / market.css).
            <div class="pane pane-fill">
              <MarketView state={market} />
            </div>
          )}
        </main>

        <footer class="app-foot" hidden={screen !== 'chat'}>
          {view.modelQueue && <ModelQueueStrip queue={view.modelQueue} />}
          {view.remote && <RemoteStrip remote={view.remote} />}
          {view.chromePair && <ChromePairStrip pair={view.chromePair} />}
          {view.memory && <MemoryStrip memory={view.memory} />}
          {view.platform === 'browser' && view.rating && <RatingStrip sends={view.rating.sends} picked={view.rating.picked} sent={view.rating.sent} />}
          {view.bgTasks && view.bgTasks.length > 0 && <BgTasksStrip tasks={view.bgTasks} />} {/* (lane:bg-tasks) */}
          <Composer view={view} />
        </footer>

        {lightbox && <Lightbox item={lightbox} onClose={() => setLightbox(null)} />}
        {fullAccessOpen && <FullAccessDialog view={view} onClose={() => setFullAccessOpen(false)} />}
        <Toasts items={toasts} onClose={closeToast} />
        <div class="sr-only" role="status" aria-live="polite">
          {srText}
        </div>
      </div>
    </AppContext.Provider>
  );
}
