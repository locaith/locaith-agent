/**
 * Cửa sổ nhỏ hỏi người dùng NGAY TRONG trình duyệt (xem linkSw.ts):
 *  • mặc định — trước khi trợ lý của một ứng dụng trên máy (VS Code, Locaith Work…) thao tác trên MỘT trang (askApproval).
 *    Tham số: `req`, `origin` (trang), `app` (tên ứng dụng đang yêu cầu). Quyền truy cập trang được xin ngay trong cú bấm.
 *  • `mode=app` (0.7.20) — ứng dụng trên máy vừa mở trang /link của nó để xin kết nối với trình duyệt này (ghép đôi do ứng dụng khởi xướng).
 *    Tham số: `req`, `app` (tên ứng dụng TỰ XƯNG), `port`. Bấm «Kết nối» thì xin quyền `tabs` (tuỳ chọn) ngay trong cú bấm.
 */

export {}; // trang riêng (không import): khai báo module để tên không đụng biến toàn cục của DOM

const q = new URLSearchParams(location.search);
const req = q.get('req') ?? '';
const origin = q.get('origin') ?? '';
const mode = q.get('mode') === 'app' ? 'app' : 'page';
const app = (q.get('app') ?? '').slice(0, 40) || (mode === 'app' ? '' : 'VS Code');
const port = (q.get('port') ?? '').replace(/\D/g, '').slice(0, 5);
const vi = !/^en/i.test(navigator.language);
const T = vi
  ? {
      title: `Trợ lý Locaith trong ${app} muốn thao tác trên trang này`,
      what: `Trợ lý sẽ có thể đọc nội dung, bấm, nhập chữ trên trang này bằng chính tài khoản bạn đang đăng nhập. Nội dung đọc được đi tới ${app} trên máy này và từ đó tới nhà cung cấp AI mà ứng dụng đó đang dùng.`,
      hint: 'Chỉ cho phép khi chính bạn vừa nhờ trợ lý làm việc này. Bạn thu hồi được bất cứ lúc nào trong khung Locaith AI → Cài đặt → Kết nối với ứng dụng trên máy.',
      once: 'Cho phép lần này (đến khi đóng trình duyệt)',
      always: 'Luôn cho phép trang này',
      deny: 'Từ chối',
      noGrant: 'Trình duyệt không cấp quyền truy cập trang (bạn đã từ chối hộp thoại của trình duyệt?)',
      appTitle: 'Kết nối trình duyệt này với ứng dụng trên máy?',
      appWho: `Ứng dụng trên máy này — tự giới thiệu là «${app || 'không rõ tên'}»${port ? `, cổng ${port}` : ''}`,
      appWhat: 'Trợ lý của ứng dụng đó sẽ nhờ tiện ích đọc và điều khiển các trang web bạn cho phép trong trình duyệt này. Mỗi trang vẫn hỏi bạn trước. Tiện ích chỉ gửi nội dung tới ứng dụng đó trên chính máy này; từ đó nội dung đi tới nhà cung cấp AI mà ứng dụng dùng (có thể là mô hình Locaith).',
      appHint: 'Chỉ bấm «Kết nối» khi chính bạn vừa bấm «Kết nối trình duyệt» trong ứng dụng đó. Ngắt bất cứ lúc nào trong khung Locaith AI → Cài đặt → Kết nối với ứng dụng trên máy.',
      connect: 'Kết nối',
      noConnect: 'Không kết nối',
    }
  : {
      title: `The Locaith assistant in ${app} wants to act on this page`,
      what: `The assistant will be able to read, click and type on this page as the account you are signed in with. What it reads goes to ${app} on this computer and from there to the AI provider that app uses.`,
      hint: 'Allow only if you just asked the assistant to do this. You can revoke it any time in the Locaith AI panel → Settings → Connect to desktop apps.',
      once: 'Allow this time (until the browser closes)',
      always: 'Always allow this site',
      deny: 'Deny',
      noGrant: 'The browser did not grant access to the site (did you decline its dialog?)',
      appTitle: 'Connect this browser to an app on this computer?',
      appWho: `An app on this computer — it calls itself “${app || 'unnamed'}”${port ? `, port ${port}` : ''}`,
      appWhat: 'That app’s assistant will be able to ask the extension to read and control the pages you allow in this browser. Every page still asks you first. The extension sends content only to that app on this computer; from there it goes to the AI provider the app uses (which may be a Locaith model).',
      appHint: 'Click Connect only if you just clicked “Connect browser” in that app. Disconnect any time in the Locaith AI panel → Settings → Connect to desktop apps.',
      connect: 'Connect',
      noConnect: 'Don’t connect',
    };
document.documentElement.lang = vi ? 'vi' : 'en';
const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let sent = false;
async function send(decision: string, reason?: string): Promise<void> {
  // Chờ dịch vụ nền xác nhận đã ghi quyết định rồi mới đóng cửa sổ (đóng sớm từng bị hiểu nhầm là "từ chối").
  try {
    await chrome.runtime.sendMessage({ type: 'nd-link-decision', req, decision, reason });
  } catch {
    /* dịch vụ nền vừa khởi động lại: đóng vẫn an toàn */
  }
  window.close();
}

if (mode === 'app') {
  byId('title').textContent = T.appTitle;
  byId('origin').textContent = T.appWho;
  byId('what').textContent = T.appWhat;
  byId('hint').textContent = T.appHint;
  byId('once').textContent = T.connect;
  byId('always').hidden = true;
  byId('deny').textContent = T.noConnect;
  byId('once').addEventListener('click', () => {
    if (sent) return;
    sent = true;
    // Quyền `tabs` (tuỳ chọn) để thấy tiêu đề / địa chỉ tab trước khi bạn duyệt — xin NGAY trong cú bấm; từ chối thì vẫn kết nối được.
    void chrome.permissions
      .request({ permissions: ['tabs'] })
      .catch(() => false)
      .then(() => send('connect'));
  });
  byId('deny').addEventListener('click', () => {
    if (sent) return;
    sent = true;
    void send('deny');
  });
} else {
  byId('title').textContent = T.title;
  byId('origin').textContent = origin;
  byId('what').textContent = T.what;
  byId('hint').textContent = T.hint;
  byId('once').textContent = T.once;
  byId('always').textContent = T.always;
  byId('deny').textContent = T.deny;
  const decide = async (decision: 'once' | 'always' | 'deny'): Promise<void> => {
    if (sent) return;
    sent = true;
    let d = decision;
    let reason: string | undefined;
    if (d !== 'deny') {
      // Xin quyền truy cập trang NGAY trong cú bấm này (cần cử chỉ người dùng). Đã có quyền thì trả về true mà không hỏi lại.
      // (Mẫu quyền không có cổng; việc duyệt của extension vẫn theo origin đầy đủ.)
      try {
        const u = new URL(origin);
        const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
        if (!granted) {
          d = 'deny';
          reason = T.noGrant;
        }
      } catch (e) {
        d = 'deny';
        reason = String((e as Error)?.message ?? e);
      }
    }
    await send(d, reason);
  };
  byId('once').addEventListener('click', () => void decide('once'));
  byId('always').addEventListener('click', () => void decide('always'));
  byId('deny').addEventListener('click', () => void decide('deny'));
}
