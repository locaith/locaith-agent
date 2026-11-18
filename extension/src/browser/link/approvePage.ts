/**
 * Cửa sổ nhỏ hỏi người dùng NGAY TRONG Chrome trước khi trợ lý trong VS Code thao tác trên một trang (xem linkSw.ts, askApproval).
 * Tham số địa chỉ: `req` (mã yêu cầu) và `origin` (trang). Quyền truy cập trang được xin ngay trong cú bấm (cần cử chỉ người dùng).
 */

export {}; // trang riêng (không import): khai báo module để tên không đụng biến toàn cục của DOM

const q = new URLSearchParams(location.search);
const req = q.get('req') ?? '';
const origin = q.get('origin') ?? '';
const vi = !/^en/i.test(navigator.language);
const T = vi
  ? {
      title: 'Trợ lý Locaith trong VS Code muốn thao tác trên trang này',
      what: 'Trợ lý sẽ có thể đọc nội dung, bấm, nhập chữ trên trang này bằng chính tài khoản bạn đang đăng nhập. Nội dung đọc được đi tới VS Code trên máy này và từ đó tới nhà cung cấp AI mà VS Code đang dùng.',
      hint: 'Chỉ cho phép khi chính bạn vừa nhờ trợ lý làm việc này. Bạn thu hồi được bất cứ lúc nào trong khung Locaith AI → Cài đặt → Kết nối với VS Code.',
      once: 'Cho phép lần này (đến khi đóng Chrome)',
      always: 'Luôn cho phép trang này',
      deny: 'Từ chối',
      noGrant: 'Chrome không cấp quyền truy cập trang (bạn đã từ chối hộp thoại của Chrome?)',
    }
  : {
      title: 'The Locaith assistant in VS Code wants to act on this page',
      what: 'The assistant will be able to read, click and type on this page as the account you are signed in with. What it reads goes to VS Code on this computer and from there to the AI provider VS Code uses.',
      hint: 'Allow only if you just asked the assistant to do this. You can revoke it any time in the Locaith AI panel → Settings → Connect to VS Code.',
      once: 'Allow this time (until Chrome closes)',
      always: 'Always allow this site',
      deny: 'Deny',
      noGrant: 'Chrome did not grant access to the site (did you decline the Chrome dialog?)',
    };
document.documentElement.lang = vi ? 'vi' : 'en';
const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
byId('title').textContent = T.title;
byId('origin').textContent = origin;
byId('what').textContent = T.what;
byId('hint').textContent = T.hint;
byId('once').textContent = T.once;
byId('always').textContent = T.always;
byId('deny').textContent = T.deny;

let sent = false;
async function decide(decision: 'once' | 'always' | 'deny'): Promise<void> {
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
  // Chờ dịch vụ nền xác nhận đã ghi quyết định rồi mới đóng cửa sổ (đóng sớm từng bị hiểu nhầm là "từ chối").
  try {
    await chrome.runtime.sendMessage({ type: 'nd-link-decision', req, decision: d, reason });
  } catch {
    /* dịch vụ nền vừa khởi động lại: đóng vẫn an toàn */
  }
  window.close();
}
byId('once').addEventListener('click', () => void decide('once'));
byId('always').addEventListener('click', () => void decide('always'));
byId('deny').addEventListener('click', () => void decide('deny'));
