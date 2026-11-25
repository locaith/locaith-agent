// Chốt chặn tổng cho GÓI Chrome / Edge trước khi nộp Chrome Web Store: kiểm một THƯ MỤC gói (dist-browser/, hoặc thư mục vừa giải nén từ tệp zip).
//   node scripts/verify-browser-package.mjs <thư-mục-gói>
//   import { verifyBrowserPackage } from './verify-browser-package.mjs'   (scripts/pack-browser.mjs gọi hàm này TRƯỚC khi nén; test/browser/verifyPackage.test.ts kiểm cả hàm này)
//
// Vì sao có: bản 0.6.27 đưa lên cửa hàng (dựng từ mã nguồn dùng chung giao diện với VS Code) mang biểu tượng chữ «N» của dự án cũ và làm mất MỌI bản vá đã giúp dòng 0.4.4 qua duyệt
// (mô tả có danh sách tên hãng → «Yellow Argon»; CSP cho tải script từ CDN → mã từ xa; chuỗi nói sai nơi lưu khoá API; thiếu thông báo dữ liệu + đồng ý trong sản phẩm).
// Không ai kiểm nội dung TRONG gói. Mỗi mục dưới đây là một bài học đó, chuyển thành kiểm tra tự động.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(here, '..');

/** Tên hãng/nhà cung cấp không được có ở tên + mô tả ngắn (lần nộp đầu bị từ chối «Yellow Argon» vì danh sách tên hãng trong mô tả). */
export const BRAND_NAMES = /\b(Claude|ChatGPT|Gemini|DeepSeek|Grok|OpenAI|Anthropic|OpenRouter|xAI|Google)\b/i;
/** Tên miền CDN: script/style tải từ đây là «mã lưu trữ từ xa» theo chính sách Chrome Web Store. */
export const CDN_HOSTS = /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/i;
/** Câu nói khoá API nằm trong kho bí mật của VS Code — SAI ở Chrome (khoá nằm trong chrome.storage.local, không mã hoá). */
const VSCODE_SECRET_CLAIM = /VS Code|secret storage|kho bí mật/i;
const NAME_MAX = 75;
const DESC_MAX = 132;

function listFiles(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** Đọc giá trị chuỗi của khoá dạng `"khoá":"giá trị"` trong gói JS đã nén (esbuild thoát ký tự → thực thi đúng literal để giải mã). */
export function readBundledString(js, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`["']${k}["']\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')`).exec(js);
  if (!m) return undefined;
  try {
    return vm.runInNewContext(`(${m[1]})`);
  } catch {
    return undefined;
  }
}

/**
 * Kiểm một thư mục gói. Trả `{ passed: string[] }` nếu đạt hết; ngược lại ném Error liệt kê MỌI mục hỏng (không dừng ở mục đầu).
 * @param {string} dir  thư mục chứa manifest.json
 * @param {{ root?: string }} [opts]  root = thư mục `extension/` (nơi có package.json và scripts/browser-brand-icons.json)
 */
export function verifyBrowserPackage(dir, opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const passed = [];
  const failed = [];
  const check = (cond, name, detail = '') => {
    if (cond) passed.push(name);
    else failed.push(detail ? `${name} — ${detail}` : name);
  };

  if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error(`Không thấy manifest.json trong ${dir} (cần chính thư mục gói, manifest ở gốc).`);
  const files = listFiles(dir);
  const bytes = (f) => readFileSync(path.join(dir, f));
  const text = (f) => bytes(f).toString('utf8');
  const manifest = JSON.parse(text('manifest.json'));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  // ── bản dựng và phiên bản
  const isTest = /TEST/.test(String(manifest.name));
  check(!isTest, 'không phải bản TEST (cấp sẵn quyền mọi trang)', `tên «${manifest.name}» — build lại bằng \`npm run build:browser:prod\``);
  check(manifest.manifest_version === 3, 'Manifest V3');
  const wantVersion = String(pkg.version).replace(/-.*$/, '');
  check(manifest.version === wantVersion, 'manifest.version khớp package.json', `manifest ${manifest.version}, package.json ${wantVersion}`);
  const testFiles = files.filter((f) => /testHooks/i.test(f));
  check(testFiles.length === 0, 'không có tệp móc kiểm thử (testHooks)', testFiles.join(', '));
  const panel = files.includes('panel.js') ? text('panel.js') : '';
  check(!!panel, 'có panel.js');
  check(!/__ndTest|ScriptedProvider/.test(panel), 'panel.js không chứa móc kiểm thử (__ndTest / ScriptedProvider)');
  check(!/nd\.test\.account/.test(panel), 'panel.js không chứa móc đổi máy chủ tài khoản của bản kiểm thử (nd.test.account)', 'bản phát hành mà đọc được địa chỉ máy chủ tài khoản từ chrome.storage thì ai ghi được vào kho sẽ hứng được mã kết nối');

  // ── giấy phép của tiện ích + thông báo bản quyền bên thứ ba PHẢI nằm trong gói (bản 0.7.0–0.7.5 đã lên cửa hàng thiếu cả hai, dù README hứa «trong gói có sẵn»)
  const eol = (s) => s.replace(/\r\n/g, '\n').trim();
  check(files.includes('LICENSE.txt'), 'gói có LICENSE.txt', 'thiếu — người dùng và cửa hàng không thấy giấy phép của tiện ích; dựng lại bằng esbuild.browser.mjs');
  const rootLicense = path.join(root, 'LICENSE.txt');
  if (files.includes('LICENSE.txt') && existsSync(rootLicense)) check(eol(text('LICENSE.txt')) === eol(readFileSync(rootLicense, 'utf8')), 'LICENSE.txt trong gói trùng LICENSE.txt của mã nguồn', 'khác bản trong kho — dựng lại gói');
  check(files.includes('THIRD_PARTY_NOTICES.md'), 'gói có THIRD_PARTY_NOTICES.md', 'thiếu — MIT/Apache/OFL đều đòi giữ thông báo bản quyền khi phân phối; chạy `npm run notices:browser` rồi dựng lại');
  if (files.includes('THIRD_PARTY_NOTICES.md')) {
    const notices = text('THIRD_PARTY_NOTICES.md');
    check(notices.includes('| Package | Version | License | Source |') && notices.includes('## License texts') && notices.length > 20000, 'THIRD_PARTY_NOTICES.md có bảng gói và văn bản giấy phép đầy đủ', `${notices.length} ký tự`);
    // Phông chữ nằm trong gói (assets/ + fonts/) phải được ghi nhận; thư viện lõi của bản trình duyệt cũng vậy. Tính đúng-đủ tuyệt đối do test/browser/notices.test.ts (so với source map) giữ.
    const families = new Set();
    for (const f of files) {
      const m = /^(?:assets|fonts)\/(.*?)-(?:latin|vietnamese|cyrillic|greek)/.exec(f);
      if (m) families.add(m[1]);
    }
    for (const fam of [...families].sort()) check(notices.includes(`| @fontsource/${fam} |`), `THIRD_PARTY_NOTICES.md ghi nhận phông ${fam}`, 'phông có trong gói nhưng không có trong thông báo');
    for (const lib of ['preact', 'marked', 'dompurify', 'highlight.js', '@anthropic-ai/sdk', 'fflate', 'unpdf', 'node-html-parser']) {
      check(notices.includes(`| ${lib} |`), `THIRD_PARTY_NOTICES.md ghi nhận ${lib}`, 'thư viện nhúng trong panel.js nhưng không có trong thông báo');
    }
  }

  // ── biểu tượng phải là logo «Lo» (bản 0.6.27 mang chữ «N» của dự án cũ)
  const brandFile = path.join(root, 'scripts', 'browser-brand-icons.json');
  const brand = JSON.parse(readFileSync(brandFile, 'utf8')).icons;
  for (const [size, want] of Object.entries(brand)) {
    const rel = `icons/${size}.png`;
    if (!files.includes(rel)) {
      check(false, `biểu tượng ${size}px là logo Lo`, `thiếu ${rel} trong gói`);
      continue;
    }
    const b = bytes(rel);
    const got = createHash('sha256').update(b).digest('hex');
    check(got === want, `biểu tượng ${size}px là logo Lo`, `${rel} không phải logo Lo của Locaith (băm ${got.slice(0, 12)}…, cần ${want.slice(0, 12)}…). Khôi phục từ src/browser/static/icons rồi build lại.`);
    check(b.readUInt32BE(16) === Number(size) && b.readUInt32BE(20) === Number(size), `biểu tượng ${size}px đúng kích thước`, `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`);
  }
  const refs = [...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {}), manifest.background?.service_worker, manifest.side_panel?.default_path, ...(manifest.sandbox?.pages ?? [])].filter(Boolean);
  for (const f of new Set(refs)) check(files.includes(f), `tệp manifest tham chiếu có trong gói: ${f}`, 'thiếu tệp');

  // ── tên + mô tả ngắn mọi ngôn ngữ: không tên hãng, đúng giới hạn độ dài, đủ khoá
  check(!BRAND_NAMES.test(String(manifest.short_name ?? '')), 'short_name không chứa tên hãng', String(manifest.short_name));
  const locales = files.filter((f) => /^_locales\/[^/]+\/messages\.json$/.test(f)).map((f) => f.split('/')[1]);
  check(locales.length > 0 && locales.includes(manifest.default_locale), 'có _locales cho default_locale', `default_locale=${manifest.default_locale}, có: ${locales.join(',') || 'không'}`);
  const usedMsgs = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  for (const loc of locales) {
    const msgs = JSON.parse(text(`_locales/${loc}/messages.json`));
    for (const k of usedMsgs) check(!!msgs[k]?.message, `_locales/${loc} có khoá ${k}`);
    const name = msgs.extName?.message ?? '';
    const desc = msgs.extDescription?.message ?? '';
    check(!BRAND_NAMES.test(name), `tên (${loc}) không chứa tên hãng`, name);
    check(!BRAND_NAMES.test(desc), `mô tả ngắn (${loc}) không chứa tên hãng`, desc);
    check([...name].length > 0 && [...name].length <= NAME_MAX, `tên (${loc}) ≤ ${NAME_MAX} ký tự`, `${[...name].length} ký tự`);
    check([...desc].length > 0 && [...desc].length <= DESC_MAX, `mô tả ngắn (${loc}) ≤ ${DESC_MAX} ký tự`, `${[...desc].length} ký tự`);
  }

  // ── không tải mã từ internet
  const csps = manifest.content_security_policy ?? {};
  for (const [kind, csp] of Object.entries(csps)) {
    check(!CDN_HOSTS.test(String(csp)), `CSP ${kind} không có tên miền CDN (jsdelivr / cdnjs / unpkg)`, String(csp));
    check(!/https?:/i.test(String(csp)), `CSP ${kind} không cho nguồn http(s) nào`, String(csp));
  }
  check(!/unsafe-eval/.test(String(csps.extension_pages ?? '')), 'CSP trang tiện ích không có unsafe-eval');
  const textFiles = files.filter((f) => /\.(js|mjs|html|json|css)$/.test(f) && !f.startsWith('fonts/') && !f.startsWith('assets/'));
  const cdnHits = textFiles.filter((f) => CDN_HOSTS.test(text(f)));
  check(cdnHits.length === 0, 'không tệp nào trong gói nhắc tên miền CDN (jsdelivr / cdnjs / unpkg)', cdnHits.join(', '));
  const remoteLoads = files.filter((f) => /\.(js|mjs)$/.test(f) && /importScripts\(\s*["'`]https?:|\bimport\(\s*["'`]https?:/.test(text(f)));
  check(remoteLoads.length === 0, 'không nạp script từ URL http(s)', remoteLoads.join(', '));
  const remoteTags = files.filter((f) => f.endsWith('.html') && /<(script|link|iframe|img)\b[^>]*\s(src|href)=["']https?:/i.test(text(f)));
  check(remoteTags.length === 0, 'HTML không tham chiếu tài nguyên http(s)', remoteTags.join(', '));

  // ── quyền: không `tabs`; quyền nào khai báo thì phải được dùng trong mã (Chrome Web Store bắt khai lý do cho quyền thừa)
  const perms = manifest.permissions ?? [];
  const optPerms = manifest.optional_permissions ?? [];
  // (0.7.12) `tabs` chỉ là quyền TUỲ CHỌN, xin lúc người dùng bật công tắc «Kết nối với VS Code» (để cầu nối thấy địa chỉ/tên tab). Bản 0.6.27–0.7.11 không khai nó vì mã không xin; nay mã xin thật.
  check(!perms.includes('tabs'), 'quyền «tabs» KHÔNG nằm trong quyền bắt buộc (chỉ tuỳ chọn, xin khi người dùng bật cầu nối VS Code)');
  const codeFiles = files.filter((f) => /\.(js|mjs)$/.test(f) && f !== 'store-consent.js');
  const code = codeFiles.map(text).join('\n');
  const used = {
    storage: /chrome\.storage\./,
    unlimitedStorage: /chrome\.storage\./, // không có API riêng: nới hạn dung lượng của chrome.storage / IndexedDB cho phiên dài
    sidePanel: /chrome\.sidePanel\./,
    scripting: /chrome\.scripting\./,
    contextMenus: /chrome\.contextMenus\./,
    tabGroups: /chrome\.tabGroups\./,
    identity: /chrome\.identity\./,
    activeTab: /captureVisibleTab|chrome\.action\b|_execute_action|activeTab/,
  };
  for (const p of [...perms, ...optPerms]) {
    const re = used[p] ?? new RegExp(`chrome\\.${p}\\.`);
    check(re.test(code) || (p === 'activeTab' && !!manifest.action), `quyền «${p}» có chỗ dùng trong mã`, `khai báo trong manifest nhưng mã không gọi API tương ứng — gỡ khỏi manifest hoặc thêm lý do`);
  }
  if (optPerms.includes('tabs')) check(/permissions\s*:\s*\[\s*["']tabs["']\s*\]/.test(code), 'mã có xin quyền «tabs» lúc chạy (khai tuỳ chọn mà không xin là quyền thừa)');
  if (optPerms.includes('identity')) check(/permissions\s*:\s*\[\s*["']identity["']\s*\]/.test(code), 'mã có xin quyền «identity» lúc chạy');

  // ── (0.7.12) cầu nối VS Code (src/browser/link): tính năng TẮT mặc định, chỉ nói chuyện với VS Code trên CHÍNH máy này; mỗi trang web hỏi duyệt riêng trong trình duyệt.
  {
    const bgFile = manifest.background?.service_worker;
    const bgCode = files.includes(bgFile) ? text(bgFile) : '';
    check(files.includes('bridge-approve.html') && files.includes('bridge-approve.js'), 'có cửa sổ hỏi duyệt từng trang của cầu nối VS Code (bridge-approve.html + bridge-approve.js)', 'thiếu → lệnh của VS Code trên trang chưa duyệt sẽ không bao giờ được hỏi người dùng');
    const approve = files.includes('bridge-approve.html') ? text('bridge-approve.html') : '';
    check(/<script src="bridge-approve\.js"><\/script>/.test(approve) && !/<script(?![^>]*\ssrc=)/i.test(approve), 'bridge-approve.html chỉ nạp bridge-approve.js (không có script nội tuyến — CSP của trang tiện ích)');
    check(/\/v1\/pair\/request/.test(bgCode) && /127\.0\.0\.1/.test(bgCode) && /nd-link-toggle/.test(bgCode), 'dịch vụ nền có cầu nối VS Code (xin ghép đôi tới 127.0.0.1)', 'mất cầu nối VS Code của bản Chrome — đã từng rơi khỏi bản dựng lại 0.6.27–0.7.11');
    check(
      /\/v1\/poll\?wait=20/.test(bgCode) && /v=\$\{|v=2/.test(bgCode) && /\.body\.cancel\(|body\?\.cancel\(|\.cancel\(\)\.catch/.test(bgCode),
      'cầu nối VS Code gắn dấu giao thức ?v=2 và có đường huỷ thân câu trả lời (0.7.17)',
      'bản 0.7.12 bỏ quên thân câu trả lời 401 và rò 2 MB mỗi 7 giây — dựng nhầm mã cũ?',
    );
    check(/\/v1\/pair\/status/.test(bgCode) && /method:\s*["']POST["']/.test(bgCode), 'cầu nối hỏi kết quả ghép đôi bằng POST (Chrome không gắn Origin vào GET từ extension)');
    check(!/studio-api\.locaith|\/api\/llm\/v1|\/api\/feedback|locaith\.ai/.test(bgCode), 'dịch vụ nền KHÔNG có đường nào tới máy chủ Locaith (cầu nối chỉ nói chuyện với VS Code trên máy này)', 'nội dung trang đi qua cầu nối không được tới máy chủ Locaith');
    check((manifest.host_permissions ?? []).every((h) => !/127\.0\.0\.1|localhost/.test(h)), 'không xin quyền máy chủ cho 127.0.0.1 (máy chủ cầu cấp CORS cho origin tiện ích)');
    for (const key of ['set.link', 'set.link.hint', 'set.link.toggle']) {
      const v = readBundledString(panel, key);
      check(typeof v === 'string' && v.length > 0, `panel.js có chuỗi ${key} (mục «Kết nối với VS Code» trong Cài đặt)`, 'không thấy khoá — người dùng sẽ không thấy chỗ bật cầu nối VS Code');
    }
    const linkHint = readBundledString(panel, 'set.link.hint');
    if (typeof linkHint === 'string') check(/TẮT mặc định/.test(linkHint) && /không tới máy chủ Locaith/.test(linkHint), 'mô tả cầu nối nói rõ: tắt mặc định, dữ liệu chỉ tới VS Code trên máy này (không tới máy chủ Locaith)', linkHint);
  }

  // ── đánh giá một chạm (src/browser/rating.ts): mã gửi sao tới `<máy chủ>/api/feedback`. Máy chủ đó PHẢI nằm trong host_permissions
  //    (backend không cho CORS với origin tiện ích → thiếu quyền là mọi lần chạm sao đều lỗi âm thầm), và thông báo đồng ý phải nói việc đó.
  const feedbackOrigins = [...new Set([...code.matchAll(/https:\/\/[a-z0-9.-]+(?=\/api\/feedback)/gi)].map((m) => m[0]))];
  for (const origin of feedbackOrigins) {
    check((manifest.host_permissions ?? []).includes(`${origin}/*`), `host_permissions có ${origin}/* (điểm gửi đánh giá một chạm)`, 'mã gửi đánh giá tới máy chủ này nhưng manifest không khai báo → trình duyệt chặn (CORS)');
  }

  // ── (0.7.10) mô hình Locaith: mã gọi cổng `<máy chủ>/api/llm/v1` thì máy chủ đó PHẢI có trong host_permissions (backend không cho CORS với origin tiện ích),
  //    và giao diện phải nói thật chuyện «mã kết nối» (token thiết bị) nằm ở đâu. Máy chủ tài khoản (Supabase) trả CORS cho mọi origin nên không cần quyền riêng.
  const gatewayOrigins = [...new Set([...code.matchAll(/https:\/\/[a-z0-9.-]+(?=\/api\/llm\/v1)/gi)].map((m) => m[0]))];
  for (const origin of gatewayOrigins) {
    check((manifest.host_permissions ?? []).includes(`${origin}/*`), `host_permissions có ${origin}/* (cổng mô hình Locaith)`, 'mã gọi cổng mô hình Locaith nhưng manifest không khai báo máy chủ này → trình duyệt chặn (CORS)');
  }
  if (gatewayOrigins.length) {
    for (const key of ['acct.b.title', 'acct.b.hint', 'locaith.notice.p1.browser']) {
      const v = readBundledString(panel, key);
      check(typeof v === 'string' && v.length > 0, `panel.js có chuỗi ${key} (mô hình Locaith trong bản trình duyệt)`, 'không thấy khoá — giao diện bản trình duyệt sẽ thiếu thẻ kết nối / thông báo dữ liệu riêng');
    }
    const hint = readBundledString(panel, 'acct.b.hint');
    if (typeof hint === 'string') check(/không mã hoá|not encrypted/i.test(hint) && !/secret storage|kho bí mật/i.test(hint), 'acct.b.hint nói rõ mã kết nối nằm trong bộ nhớ tiện ích, không mã hoá, và không nói «kho bí mật»', hint);
    const notice = readBundledString(panel, 'locaith.notice.p1.browser');
    if (typeof notice === 'string') check(/web|trang web/i.test(notice) && /Locaith/.test(notice), 'thông báo dữ liệu của bản trình duyệt nói nội dung trang web được gửi tới Locaith', notice);
  }

  // ── chuỗi giao diện bản trình duyệt nói đúng nơi lưu khoá API
  for (const key of ['set.providers.hint.browser', 'welcome.nokey.body.browser']) {
    const v = readBundledString(panel, key);
    check(typeof v === 'string' && v.length > 0, `panel.js có chuỗi ${key}`, 'không thấy khoá (UI bản trình duyệt sẽ rơi về câu «kho bí mật của VS Code»)');
    if (typeof v === 'string') {
      check(!VSCODE_SECRET_CLAIM.test(v), `${key} không nói khoá nằm trong kho bí mật của VS Code`, v);
      check(/không mã hoá|not encrypted/i.test(v), `${key} nói rõ khoá không mã hoá`, v);
    }
  }

  // ── thông báo dữ liệu + đồng ý trong sản phẩm (bản phát hành). Bản --test cố ý không có.
  if (!isTest) {
    const html = files.includes('sidepanel.html') ? text('sidepanel.html') : '';
    const iConsent = html.indexOf('<script src="store-consent.js"></script>');
    const iPanel = html.indexOf('<script src="panel.js"></script>');
    check(iConsent >= 0 && iPanel >= 0 && iConsent < iPanel, 'sidepanel.html nạp store-consent.js TRƯỚC panel.js');
    check(files.includes('store-consent.js'), 'có store-consent.js (giao diện thông báo + đồng ý)');
    check(files.includes('store-consent-sw.js'), 'có store-consent-sw.js (cổng đồng ý cho dịch vụ nền)');
    const ui = files.includes('store-consent.js') ? text('store-consent.js') : '';
    const url = /const PRIVACY_URL = ["']([^"']*)["']/.exec(ui)?.[1] ?? '';
    check(/^https:\/\/[^\s/]+\/\S+/.test(url) && !url.includes('__PRIVACY_URL__'), 'store-consent.js có URL chính sách quyền riêng tư thật (không còn chỗ giữ chỗ)', url || 'không thấy PRIVACY_URL');
    if (feedbackOrigins.length) check(/chạm một ngôi sao/.test(ui) && /tap a star/i.test(ui) && /Locaith/.test(ui), 'thông báo đồng ý nói việc chấm sao được gửi tới Locaith', 'mã có gửi đánh giá về Locaith nhưng thông báo đồng ý không nhắc (cần nói trước khi dữ liệu rời máy)');
    if (gatewayOrigins.length) check(/mô hình Locaith/.test(ui) && /Locaith models/i.test(ui) && /cải thiện mô hình/.test(ui) && /improve the models/i.test(ui) && /tuỳ chọn/.test(ui) && /optional/i.test(ui), 'thông báo đồng ý nói việc dùng mô hình Locaith (tuỳ chọn) gửi nội dung tới Locaith để lưu và cải thiện mô hình', 'mã gọi cổng mô hình Locaith nhưng thông báo đồng ý không nhắc (cần nói trước khi dữ liệu rời máy)');
    const key = /const KEY = ["']([^"']+)["']/.exec(ui)?.[1];
    const sw = files.includes('store-consent-sw.js') ? text('store-consent-sw.js') : '';
    check(!!key && sw.includes(`'${key}'`), 'giao diện và cổng nền dùng cùng khoá đồng ý', `giao diện: ${key}`);
    const bg = files.includes(manifest.background?.service_worker) ? text(manifest.background.service_worker) : '';
    check(/importScripts\(\s*["']store-consent-sw\.js["']\s*\)/.test(bg), 'dịch vụ nền nạp store-consent-sw.js (menu chuột phải chờ đồng ý)');
    check(/__ndConsent/.test(bg), 'dịch vụ nền đọc cổng đồng ý (__ndConsent)');
  }

  if (failed.length) {
    throw new Error(`Gói Chrome/Edge KHÔNG đạt chuẩn cửa hàng — ${failed.length} mục hỏng (${passed.length} mục đạt):\n${failed.map((f) => `  ✘ ${f}`).join('\n')}`);
  }
  return { passed };
}

// ── CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Cách dùng: node scripts/verify-browser-package.mjs <thư-mục-gói>');
    process.exit(2);
  }
  try {
    const { passed } = verifyBrowserPackage(path.resolve(dir));
    for (const p of passed) console.log(`  ✔ ${p}`);
    console.log(`\nGói đạt: ${passed.length} mục kiểm.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
