/**
 * Điểm vào của khung chat (side panel). Dựng toàn bộ trong MỘT trang: dịch vụ nền tảng (cấu hình, khoá, kho phiên), controller và giao diện Preact
 * dùng chung với bản VS Code. Giao diện nói chuyện với controller qua "cầu nối" cùng trang thay vì postMessage giữa hai tiến trình.
 */

import '../../webview/src/styles/main.css';
import './panel.css';
import { render } from 'preact';
import { App } from '../../webview/src/App';
import { installBridge } from '../../webview/src/vscode';
import { ChromeBrowserApi } from './api';
import { BrowserConfig } from './config';
import { BrowserController } from './controller';
import { ChromeKv } from './kv';
import { BrowserLogger } from './logger';
import { PENDING_KEY, type PendingAction } from './pending';
import { postRating } from './ratingSend';
import { OAuthManager } from './oauth';
import { BrowserSecrets } from './secrets';
import { browserSkills } from './skills';
import { idbStoreIO } from './storeIO';
import { BaseSessionStore } from '../shared/sessionStore';
import { ProviderService } from '../core/providers/service';
import { SkillRegistry } from '../core/skills/registry';
import type { DocExtractor } from '../shared/docWrap';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import { ArtifactOpener } from './artifacts';
import { applyTheme } from './theme';
import { cleanText, wrapPage } from './tools/policy';

declare const __ND_TEST__: boolean;

/**
 * Đọc tệp tải lên: bộ đọc (pdf.js, Word/Excel…) nằm trong docparse.js, tệp ESM riêng chỉ nạp ở lần tải tệp đầu tiên để panel.js luôn nhỏ và không chứa mã eval.
 * Nạp lỗi (hiếm: tệp thiếu trong gói) thì lần sau thử lại chứ không nhớ lỗi mãi.
 */
let docparse: Promise<{ extractDocument: DocExtractor }> | undefined;
const extractDocument: DocExtractor = async (bytes, name, opts) => {
  docparse ??= (import(chrome.runtime.getURL('docparse.js')) as Promise<{ extractDocument: DocExtractor }>).catch((err) => {
    docparse = undefined;
    throw err;
  });
  return (await docparse).extractDocument(bytes, name, opts);
};

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const kv = new ChromeKv('local');
  const sessionKv = new ChromeKv('session');
  const logger = new BrowserLogger();
  const config = new BrowserConfig(kv);
  await config.load();
  const secrets = new BrowserSecrets(kv);
  for (const v of await secrets.values()) logger.registerSecret(v);
  const api = new ChromeBrowserApi({ fixedAnchorTabId: params.get('anchor') ? Number(params.get('anchor')) : undefined });

  // Đăng nhập bằng tài khoản (OAuth + PKCE) qua cửa sổ đăng nhập do trình duyệt quản lý (chrome.identity). Quyền `identity` là quyền tuỳ chọn: chỉ xin khi người dùng bấm "Đăng nhập".
  const oauth = new OAuthManager({
    kv,
    ensureIdentity: async () => {
      try {
        if (typeof chrome.identity?.launchWebAuthFlow === 'function') return true;
        return (await chrome.permissions.request({ permissions: ['identity'] })) && typeof chrome.identity?.launchWebAuthFlow === 'function';
      } catch {
        return false;
      }
    },
    launch: async (url) => {
      const finalUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
      if (!finalUrl) throw new Error('empty redirect');
      return finalUrl;
    },
    redirectUri: () => chrome.identity.getRedirectURL(),
    setKey: async (id, key) => {
      await secrets.set(id, key);
      logger.registerSecret(key);
    },
    deleteKey: (id) => secrets.delete(id),
    ensureOrigin: (url) => api.ensureOrigin(url),
  });

  applyTheme();
  document.documentElement.lang = config.language();

  const providers = new ProviderService({
    baseUrls: () => config.baseUrls(),
    customProviders: () => config.customProviders(),
    eagerInput: () => config.eagerInput(),
    summarizerModel: () => config.summarizerModel(),
    // Token OAuth (tự làm mới) ưu tiên hơn khoá đã lưu; mọi giá trị bí mật đi qua đây đều được đăng ký với bộ che bí mật của nhật ký.
    resolveKey: async (id) => {
      const token = await oauth.accessToken(id);
      if (token) {
        logger.registerSecret(token);
        return token;
      }
      return secrets.get(id);
    },
    log: (l, m) => logger.log(l, m),
    env: {}, // không có biến môi trường trong trình duyệt
    // Gọi API trực tiếp từ trình duyệt: Anthropic yêu cầu cờ này (xem tài liệu "direct browser access").
    extraHeaders: { anthropic: { 'anthropic-dangerous-direct-browser-access': 'true' } },
  });

  const skills = new SkillRegistry(browserSkills());
  const store = new BaseSessionStore(idbStoreIO(), 'browser');
  const artifacts = new ArtifactOpener(logger);
  // Mỗi cửa sổ có khung chat riêng: "phiên gần nhất" cũng phải riêng theo cửa sổ, nếu không khung thứ hai nhận lại phiên đang chạy của khung thứ nhất.
  const myWindow = await api.windowId();
  const lastSessionKey = myWindow === undefined ? 'nd.lastSession' : `nd.lastSession.${myWindow}`;

  const listeners = new Set<(m: HostMessage) => void>();
  const deliver = (msg: HostMessage) => {
    // Bản sao (structured clone) như postMessage thật: giao diện và controller không dùng chung đối tượng.
    const data = structuredClone(msg);
    window.dispatchEvent(new MessageEvent('message', { data }));
    for (const l of listeners) l(data);
  };

  const controller = new BrowserController({
    config,
    secrets,
    oauth,
    providers,
    skills,
    store,
    logger,
    api,
    artifacts,
    post: deliver,
    version: chrome.runtime.getManifest().version,
    extractDocument,
    // Đánh giá một chạm gửi về Locaith (xem rating.ts); host_permissions của manifest cho phép máy chủ này.
    sendFeedback: (payload) => postRating(payload),
    lastSession: {
      get: async () => sessionKv.get<string>(lastSessionKey),
      set: async (id) => (id ? sessionKv.set(lastSessionKey, id) : sessionKv.remove(lastSessionKey)),
    },
  });

  // Chặn MỌI message "thật" (isTrusted) tới trang này: chúng chỉ có thể đến từ khung/cửa sổ khác (ví dụ iframe artifact).
  // Controller phát sự kiện tổng hợp (isTrusted=false) nên vẫn đi qua; nhờ vậy nội dung artifact không giả mạo được host.
  window.addEventListener('message', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);

  let uiState: unknown = {};
  installBridge({
    postMessage: (m: unknown) => queueMicrotask(() => void controller.onMessage(m as WebviewMessage)),
    getState: () => uiState,
    setState: (s: unknown) => {
      uiState = s;
      try {
        sessionStorage.setItem('nd.ui', JSON.stringify(s));
      } catch {
        /* bỏ qua */
      }
    },
  });
  try {
    uiState = JSON.parse(sessionStorage.getItem('nd.ui') ?? '{}');
  } catch {
    uiState = {};
  }

  await controller.start();

  // Hành động từ menu chuột phải (đã được background ghi vào storage.session). Chỉ khung chat của ĐÚNG cửa sổ nhận hành động, và nhận một lần:
  // "đọc rồi xoá" chạy trong khoá Web Locks (dùng chung giữa các trang của extension) nên hai khung không cùng thực hiện một hành động.
  const claimPending = async (): Promise<PendingAction | null> => {
    const take = async () => {
      const p = await sessionKv.get<PendingAction>(PENDING_KEY);
      if (!p || Date.now() - p.ts > 15_000) return null;
      if (p.windowId !== undefined && myWindow !== undefined && p.windowId !== myWindow) return null;
      await sessionKv.remove(PENDING_KEY);
      return p;
    };
    return navigator.locks ? navigator.locks.request('nd.pending', take) : take();
  };
  const consumePending = async () => {
    const p = await claimPending();
    if (!p) return;
    const vi = config.language() === 'vi';
    // Đoạn bôi đen là chữ của trang web (có thể chứa lời dụ) và được gửi đi mà không qua mắt người dùng → bọc thành dữ liệu không đáng tin.
    const quoted = p.text ? wrapPage(p.url ?? '', p.title ?? '', p.text) : '';
    // Người dùng bấm menu trên MỘT tab cụ thể: việc họ hỏi là về trang đó → gắn trợ lý vào đúng tab này (kể cả khi trước đó đang bám tab khác).
    if (p.tabId !== undefined) await controller.pinTab(p.tabId);
    if (p.kind === 'summarize') await controller.ask(vi ? 'Tóm tắt trang tôi đang xem: ý chính, số liệu quan trọng và những điểm cần lưu ý.' : 'Summarize the page I am viewing: key points, important figures and caveats.');
    else if (p.kind === 'explain' && p.text) await controller.ask(vi ? `Giải thích giúp tôi đoạn này trong ngữ cảnh của trang đang xem:\n\n${quoted}` : `Explain this passage in the context of the page I am viewing:\n\n${quoted}`);
    // "Hỏi về đoạn đã chọn" đi qua ô nhập: người dùng thấy đúng chữ (đã bỏ ký tự ẩn) và tự quyết định gửi.
    else if (p.kind === 'ask' && p.text) controller.insert(`"${cleanText(p.text)}"\n\n`);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[PENDING_KEY]) void consumePending();
  });
  void consumePending();

  // Nút Dừng trên lớp phủ của trợ lý (nằm trong trang web, do runtime của CHÍNH extension này vẽ) gửi tin về đây. Chỉ nhận từ content script
  // của extension này (có sender.tab) — trang web không gửi được tin vào chrome.runtime của extension nếu extension không khai báo externally_connectable.
  chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    if ((msg as { type?: unknown } | null)?.type === 'nd-presence-stop') controller.stopFromPage(sender.tab.id);
  });

  // Đóng khung chat = dừng tác vụ + lưu hội thoại (trang bị huỷ ngay sau đó).
  window.addEventListener('pagehide', () => controller.dispose());

  (globalThis as unknown as { __nd?: unknown }).__nd = { controller, config, providers, store, api, logger };
  // Chỉ bản build kiểm thử: cài nhà cung cấp theo kịch bản (cờ này là hằng số lúc build nên nhánh bị loại khỏi bản phát hành).
  if (__ND_TEST__) (await import('./testHooks')).installTestHooks({ providers, controller });
  render(<App />, document.getElementById('root')!);
}

main().catch((err) => {
  console.error('[ND] khởi động thất bại', err);
  const root = document.getElementById('root');
  if (root) root.textContent = `Không khởi động được: ${err instanceof Error ? err.message : String(err)}`;
});
