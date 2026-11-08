// Đóng gói bản trình duyệt (Chrome / Microsoft Edge, Manifest V3) → dist-browser/ (thư mục "Load unpacked").
//   node esbuild.browser.mjs                 build
//   node esbuild.browser.mjs --production    nén, không sourcemap
//   node esbuild.browser.mjs --watch         theo dõi thay đổi
//   node esbuild.browser.mjs --test          ra dist-browser-test/ với quyền truy cập mọi trang CẤP SẴN (chỉ để kiểm thử tự động)
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { artifactsSkillForBrowser } from './scripts/browser-skill-transform.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(root, ...p);
const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');
const testBuild = args.includes('--test');
// --out=<thư mục> : dựng ra chỗ khác (test dùng để không đè dist-browser/ của người khác).
const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const outdir = outArg ? path.resolve(outArg) : at(testBuild ? 'dist-browser-test' : 'dist-browser');

const pkg = JSON.parse(await readFile(at('package.json'), 'utf8'));

// ── manifest ────────────────────────────────────────────────────────────────
const PROVIDER_HOSTS = [
  'https://api.anthropic.com/*',
  'https://api.openai.com/*',
  'https://generativelanguage.googleapis.com/*',
  'https://api.deepseek.com/*',
  'https://api.x.ai/*',
  // OpenRouter: một khoá dùng được hàng trăm model + đăng nhập OAuth một chạm (đổi mã lấy khoá ở api/v1/auth/keys)
  'https://openrouter.ai/*',
  // web_search mặc định
  'https://html.duckduckgo.com/*',
  'https://www.bing.com/*',
];

// Máy chủ của Locaith mà tiện ích gọi: CHỈ nhận đánh giá người dùng tự chạm sao (src/browser/rating.ts, RATING_ENDPOINT). Gói 0.4.4 đã được cửa hàng duyệt cũng khai báo máy chủ này.
const SERVICE_HOSTS = ['https://studio-api.locaith.com/*'];

// Artifact HTML chạy trong trang "sandbox" (origin riêng, không có API extension).
// KHÔNG có tên miền CDN nào: Chrome Web Store coi script/style tải từ internet là «mã lưu trữ từ xa» (bản VS Code vẫn cho ba CDN — chỉ khác ở đây).
// Cờ __ND_NO_REMOTE_CODE__ (xem common.define) làm danh sách CDN của lõi rỗng, nên kiểm tra artifact và CSP của khung xem trước cũng khớp.
const SANDBOX_CSP =
  `sandbox allow-scripts allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
  `font-src data:; img-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; ` +
  `manifest-src 'none'; base-uri 'none'; form-action 'none'`;

// Thông báo về dữ liệu + đồng ý trong thanh bên (src/browser/static/store-consent*.js, src/browser/consent.ts). Trang chính sách quyền riêng tư PHẢI tồn tại trước khi nộp cửa hàng.
const PRIVACY_URL = process.env.STORE_PRIVACY_URL || 'https://www.locaith.ai/chinh-sach-quyen-rieng-tu-chrome/';
const CONSENT_TAG = '<script src="store-consent.js"></script>\n';

function manifest() {
  const m = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'Locaith AI',
    version: pkg.version.replace(/-.*$/, ''),
    description: '__MSG_extDescription__',
    default_locale: 'vi',
    minimum_chrome_version: '116',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_title: '__MSG_actionTitle__', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'background.js' },
    permissions: ['sidePanel', 'storage', 'unlimitedStorage', 'scripting', 'activeTab', 'contextMenus', 'tabGroups'],
    // PROVIDER_HOSTS: nhà cung cấp AI + tìm web. SERVICE_HOSTS: chỉ để gửi đánh giá một chạm (POST /api/feedback) — không gửi gì khác tới đó.
    host_permissions: [...PROVIDER_HOSTS, ...SERVICE_HOSTS],
    // Quyền đọc/điều khiển mọi trang xin lúc chạy, khi người dùng bấm nút trong Cài đặt (có thể rút lại bất cứ lúc nào).
    // identity: chỉ xin khi người dùng bấm "Đăng nhập" (OAuth) — cần để mở cửa sổ đăng nhập do trình duyệt quản lý.
    // KHÔNG khai báo `tabs`: mã không bao giờ xin quyền này (URL/tiêu đề tab có được nhờ quyền trang do người dùng cấp),
    // và Chrome Web Store bắt khai lý do cho mọi quyền khai báo mà không dùng — đúng lỗi "cần lý do sử dụng quyền tabs".
    optional_permissions: ['identity'],
    // Phải đúng chuỗi "<all_urls>": chrome.tabs.captureVisibleTab chỉ chấp nhận `<all_urls>` hoặc activeTab (không chấp nhận https://*/* + http://*/*).
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'", sandbox: SANDBOX_CSP },
    sandbox: { pages: ['artifact-sandbox.html'] },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+N' }, description: '__MSG_cmdOpen__' },
    },
  };
  if (testBuild) {
    m.name = 'Locaith AI (TEST)';
    m.permissions.push('tabs', 'identity');
    m.host_permissions.push('<all_urls>');
    delete m.optional_permissions;
    delete m.optional_host_permissions;
  }
  return m;
}

const LOCALES = {
  vi: {
    extName: { message: 'Locaith AI — Trợ lý trình duyệt' },
    extDescription: {
      // GIỚI HẠN CỨNG của Chrome Web Store: ≤ 132 ký tự (đếm theo code point). Vượt là cả gói bị từ chối khi tải lên.
      // KHÔNG liệt kê tên thương hiệu (Claude, ChatGPT, Gemini…): lần nộp đầu bị từ chối mã «Yellow Argon» vì danh sách tên hãng trong mô tả. Xem docs/CHROME-STORE.md.
      message: 'Trợ lý AI trong thanh bên: đọc trang, tra cứu web, soạn báo cáo. Dùng khoá API của chính bạn.',
    },
    actionTitle: { message: 'Mở Locaith AI' },
    cmdOpen: { message: 'Mở/đóng khung Locaith AI' },
    menuAskSelection: { message: 'Hỏi Locaith AI về đoạn đã chọn' },
    menuExplainSelection: { message: 'Giải thích đoạn đã chọn' },
    menuSummarizePage: { message: 'Tóm tắt trang này' },
  },
  en: {
    extName: { message: 'Locaith AI — Browser agent' },
    extDescription: {
      message: 'Side-panel AI assistant: reads the page, searches the web, drafts reports. Use your own API key.',
    },
    actionTitle: { message: 'Open Locaith AI' },
    cmdOpen: { message: 'Open/close the Locaith AI panel' },
    menuAskSelection: { message: 'Ask Locaith AI about the selection' },
    menuExplainSelection: { message: 'Explain the selection' },
    menuSummarizePage: { message: 'Summarize this page' },
  },
};

/**
 * Chrome Web Store từ chối CẢ GÓI nếu một chuỗi bản địa hoá vượt giới hạn của nó — và thông báo lỗi lại hiện ra
 * như "sự cố khi tải tệp", rất khó đoán. Chặn ngay lúc build: mô tả ≤ 132 ký tự (giới hạn của trường description),
 * tên ≤ 75. Đếm theo code point để ký tự tiếng Việt có dấu không bị tính sai.
 */
for (const [loc, strings] of Object.entries(LOCALES)) {
  const desc = [...strings.extDescription.message].length;
  const name = [...strings.extName.message].length;
  if (desc > 132) throw new Error(`_locales/${loc}: extDescription ${desc} ký tự > 132 (giới hạn Chrome Web Store)`);
  if (name > 75) throw new Error(`_locales/${loc}: extName ${name} ký tự > 75 (giới hạn Chrome Web Store)`);
}

// ── esbuild ─────────────────────────────────────────────────────────────────
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  outdir,
  loader: { '.md': 'text', '.woff2': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
  assetNames: 'assets/[name]-[hash]',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"', __ND_TEST__: testBuild ? 'true' : 'false', __ND_NO_REMOTE_CODE__: 'true' },
  // MV3 cấm unsafe-eval: Ajv (biên dịch bằng new Function) và node:crypto đồng bộ được thay bằng bản thuần.
  plugins: [
    {
      // Bản trình duyệt: kỹ năng artifacts không được hứa cho tải script/style từ CDN (xem scripts/browser-skill-transform.mjs).
      name: 'browser-artifacts-skill',
      setup(b) {
        b.onLoad({ filter: /[\\/]skills[\\/]artifacts[\\/]SKILL\.md$/ }, async (a) => ({ contents: artifactsSkillForBrowser(await readFile(a.path, 'utf8')), loader: 'text' }));
      },
    },
  ],
  alias: { ajv: at('src/browser/shims/ajv.ts'), 'node:crypto': at('src/browser/shims/crypto.ts') },
};

const targets = {
  panel: { ...common, entryPoints: { panel: at('src/browser/panel.tsx') } },
  background: { ...common, entryPoints: { background: at('src/browser/background.ts') } },
  runtime: { ...common, entryPoints: { 'page-runtime': at('src/browser/page/runtime.ts') } },
  artifact: { ...common, entryPoints: { artifact: at('src/browser/artifactViewer.ts'), 'artifact-sandbox': at('src/browser/artifactSandbox.ts') } },
  // Bộ đọc tệp tải lên (PDF/Word/Excel…): ESM riêng, panel.js nạp lười bằng import() ở lần tải tệp đầu tiên (pdf.js nặng, không nhét vào panel.js).
  docparse: { ...common, format: 'esm', entryPoints: { docparse: at('src/browser/docparse.ts') } },
};

async function copyStatic() {
  const s = at('src/browser/static');
  await mkdir(outdir, { recursive: true });
  await cp(s, outdir, { recursive: true });
  const panelHtml = path.join(outdir, 'sidepanel.html');
  const html = await readFile(panelHtml, 'utf8');
  if (!html.includes(CONSENT_TAG)) throw new Error('sidepanel.html (nguồn) thiếu thẻ nạp store-consent.js');
  if (testBuild) {
    // Bản --test (e2e): TỰ BỎ QUA cổng đồng ý — không có tệp, không có thẻ nạp, background.js không importScripts (xem __ND_TEST__) — để e2e không kẹt sau lớp phủ.
    await rm(path.join(outdir, 'store-consent.js'), { force: true });
    await rm(path.join(outdir, 'store-consent-sw.js'), { force: true });
    await writeFile(panelHtml, html.replace(CONSENT_TAG, ''));
  } else {
    const ui = await readFile(path.join(outdir, 'store-consent.js'), 'utf8');
    const slot = "'__PRIVACY_URL__'";
    if (ui.split(slot).length !== 2) throw new Error('store-consent.js (nguồn) cần đúng một chỗ chèn URL chính sách: ' + slot);
    await writeFile(path.join(outdir, 'store-consent.js'), ui.replace(slot, () => `'${PRIVACY_URL.replace(/['\\]/g, '')}'`));
  }
  // Font nhúng vào artifact (trang xem trước tự đọc và nhúng dạng data URI).
  await cp(at('media/fonts'), path.join(outdir, 'fonts'), { recursive: true });
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest(), null, 2) + '\n');
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    const dir = path.join(outdir, '_locales', loc);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'messages.json'), JSON.stringify(msgs, null, 2) + '\n');
  }
  // Giấy phép của chính tiện ích + thông báo bản quyền của các thư viện/phông nhúng: gói PHẢI mang theo (FSL và từng giấy phép MIT/Apache/OFL đều đòi giữ thông báo).
  // Bản 0.7.0–0.7.5 đã đi cửa hàng thiếu cả hai tệp. THIRD_PARTY_NOTICES.browser.md do `npm run notices:browser` sinh từ source map; test/browser/notices.test.ts giữ cho nó không lỗi thời.
  for (const [from, to] of [['LICENSE.txt', 'LICENSE.txt'], ['THIRD_PARTY_NOTICES.browser.md', 'THIRD_PARTY_NOTICES.md']]) {
    try {
      await cp(at(from), path.join(outdir, to));
    } catch (e) {
      if (production) throw new Error(`Thiếu ${from} — gói phát hành Chrome/Edge phải kèm giấy phép và thông báo bên thứ ba. Chạy \`npm run notices:browser\` rồi dựng lại. (${e instanceof Error ? e.message : e})`);
      console.warn(`[esbuild:browser] cảnh báo: chưa có ${from} (chỉ bắt buộc ở bản phát hành --production)`);
    }
  }
}

const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const selected = Object.entries(targets).filter(([k]) => !only || only.split(',').includes(k));

if (!watch) await rm(outdir, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctxs = await Promise.all(selected.map(([, t]) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild:browser] đang theo dõi thay đổi…');
} else {
  await Promise.all(selected.map(([, t]) => esbuild.build(t)));
  console.log(`[esbuild:browser] xong → ${path.relative(root, outdir)}${testBuild ? ' (bản TEST: cấp sẵn quyền mọi trang)' : ''}`);
}
