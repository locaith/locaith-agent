// Locaith AI (bản Chrome / Edge) — thông báo về dữ liệu + đồng ý, hiện ngay trong thanh bên ở lần mở đầu tiên.
// Vì sao có: chính sách dữ liệu người dùng của Chrome Web Store đòi thông báo NGAY TRONG sản phẩm (không chỉ ở trang cửa hàng hay trong chính sách quyền riêng tư)
// trước khi nội dung trang / tin nhắn của người dùng được gửi tới bên thứ ba (ở đây: nhà cung cấp AI do người dùng chọn).
// Chưa đồng ý thì khung chat bị khoá (không gõ, không bấm được) và dịch vụ nền không gửi gì đi (xem store-consent-sw.js, src/browser/background.ts).
// Văn bản này đã được Chrome Web Store duyệt ở dòng 0.4.4 (bản đã vá); chỉ bỏ dòng về tính năng theo dõi tin nhắn vì bản dùng chung giao diện không có tính năng đó.
// Giá trị giữ chỗ trong dòng `const PRIVACY_URL` dưới đây được esbuild.browser.mjs thay lúc build (scripts/verify-browser-package.mjs bắt nếu còn sót). Bản --test (e2e) không có tệp này.
(() => {
  'use strict';
  const KEY = 'nd.consent.v1';
  const PRIVACY_URL = '__PRIVACY_URL__';
  const lang = (() => {
    try { return String(chrome.i18n.getUILanguage() || navigator.language || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en'; } catch (e) { return 'en'; }
  })();
  const T = {
    vi: {
      title: 'Trước khi dùng Locaith AI',
      intro: 'Khi bạn gửi một yêu cầu, tiện ích gửi những thông tin dưới đây tới nhà cung cấp AI do BẠN chọn:',
      items: [
        'câu hỏi bạn gõ và các tệp bạn đính kèm;',
        'nội dung (văn bản, ảnh chụp) của trang hoặc đoạn mà bạn yêu cầu trợ lý đọc;',
      ],
      more: 'Khoá API của bạn nằm trong bộ nhớ riêng của tiện ích trên máy này (không mã hoá) và chỉ được gửi tới đúng nhà cung cấp của nó. Tiện ích không theo dõi lịch sử duyệt web, không chạy quảng cáo và không bán dữ liệu. Mỗi nhà cung cấp xử lý dữ liệu theo chính sách riêng của họ.',
      policy: 'Đọc chính sách quyền riêng tư',
      accept: 'Đồng ý và tiếp tục',
      decline: 'Không đồng ý',
      declined: 'Không sao — chưa có dữ liệu nào được gửi đi. Tiện ích sẽ không hoạt động cho tới khi bạn đồng ý; bạn có thể đóng thanh bên hoặc gỡ tiện ích bất cứ lúc nào.',
      back: 'Xem lại',
    },
    en: {
      title: 'Before you use Locaith AI',
      intro: 'When you send a request, the extension sends the following to the AI provider YOU choose:',
      items: [
        'the question you type and any files you attach;',
        'the content (text, screenshots) of the page or selection you ask the assistant to read;',
      ],
      more: 'Your API keys stay in the extension’s own storage on this device (not encrypted) and are only sent to the provider they belong to. The extension does not track your browsing history, show ads or sell data. Each provider processes data under its own policy.',
      policy: 'Read the privacy policy',
      accept: 'Agree and continue',
      decline: 'Do not agree',
      declined: 'That’s fine — nothing has been sent. The extension stays inactive until you agree; you can close the side panel or uninstall the extension at any time.',
      back: 'Review again',
    },
  }[lang];

  const css = `
  #nd-consent{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:20px 16px;box-sizing:border-box;
    background:#ffffff;color:#1d1d1f;font:14px/1.55 system-ui,"Segoe UI",sans-serif}
  #nd-consent .c{max-width:520px;width:100%;margin:auto 0}
  #nd-consent h1{font-size:19px;margin:0 0 10px}
  #nd-consent p{margin:0 0 10px}
  #nd-consent ul{margin:0 0 12px;padding-left:20px}
  #nd-consent li{margin:3px 0}
  #nd-consent a{color:#5138ee}
  #nd-consent .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  #nd-consent button{font:inherit;font-weight:600;border-radius:999px;padding:9px 18px;cursor:pointer;border:1px solid #5138ee}
  #nd-consent button.p{background:#5138ee;color:#fff}
  #nd-consent button.s{background:transparent;color:#5138ee}
  #nd-consent .no{display:none;margin-top:14px;padding:10px 12px;border-radius:10px;background:#8881}
  #nd-consent.declined .no{display:block}
  @media (prefers-color-scheme:dark){#nd-consent{background:#14151c;color:#ececf1}#nd-consent a{color:#a79bff}#nd-consent button{border-color:#8f84ff}#nd-consent button.p{background:#6a5cff}#nd-consent button.s{color:#a79bff}}`;

  const show = () => {
    const root = document.getElementById('root');
    const wrap = document.createElement('div');
    wrap.id = 'nd-consent';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'nd-consent-t');
    const style = document.createElement('style');
    style.textContent = css;
    wrap.appendChild(style);
    const c = document.createElement('div');
    c.className = 'c';
    const h = document.createElement('h1'); h.id = 'nd-consent-t'; h.textContent = T.title; c.appendChild(h);
    const p1 = document.createElement('p'); p1.textContent = T.intro; c.appendChild(p1);
    const ul = document.createElement('ul');
    for (const t of T.items) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    c.appendChild(ul);
    const p2 = document.createElement('p'); p2.textContent = T.more; c.appendChild(p2);
    const p3 = document.createElement('p'); const a = document.createElement('a'); a.href = PRIVACY_URL; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = T.policy; p3.appendChild(a); c.appendChild(p3);
    const row = document.createElement('div'); row.className = 'row';
    const ok = document.createElement('button'); ok.className = 'p'; ok.type = 'button'; ok.textContent = T.accept; ok.id = 'nd-consent-accept';
    const no = document.createElement('button'); no.className = 's'; no.type = 'button'; no.textContent = T.decline; no.id = 'nd-consent-decline';
    row.appendChild(ok); row.appendChild(no); c.appendChild(row);
    const msg = document.createElement('div'); msg.className = 'no'; msg.setAttribute('role', 'status');
    const mt = document.createElement('span'); mt.textContent = T.declined + ' ';
    const back = document.createElement('a'); back.href = '#'; back.textContent = T.back;
    back.addEventListener('click', (e) => { e.preventDefault(); wrap.classList.remove('declined'); ok.focus(); });
    msg.appendChild(mt); msg.appendChild(back); c.appendChild(msg);
    wrap.appendChild(c);
    if (root) root.setAttribute('inert', '');
    document.body.appendChild(wrap);
    ok.focus();
    ok.addEventListener('click', async () => {
      try { await chrome.storage.local.set({ [KEY]: { v: 1, at: Date.now() } }); } catch (e) { return; }
      wrap.remove();
      if (root) root.removeAttribute('inert');
    });
    no.addEventListener('click', () => { wrap.classList.add('declined'); });
  };

  chrome.storage.local.get(KEY).then((o) => { if (!(o && o[KEY] && o[KEY].v === 1)) show(); }, () => show());
})();
