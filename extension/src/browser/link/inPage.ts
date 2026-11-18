/**
 * Mã chạy TRONG trang web cho cầu nối VS Code (chrome.scripting.executeScript chuyển nguyên mã nguồn của MỘT hàm sang trang, nên mọi hàm phụ
 * phải nằm bên trong hàm này — không được dùng import/biến ngoài). Dịch từ bản 0.4.x (đã dùng thực tế) gần như nguyên văn.
 * Trả về đối tượng thuần; `ok: false` + `error` khi thao tác thất bại.
 */

export type InPageKind = 'read' | 'snapshot' | 'click' | 'type' | 'key' | 'scroll' | 'wait';
export interface InPageArgs {
  ref?: string;
  selector?: string;
  text?: string;
  max?: number;
  clear?: boolean;
  submit?: boolean;
  key?: string;
  dy?: number;
  ms?: number;
}

export async function inPage(kind: InPageKind, a: InPageArgs): Promise<Record<string, unknown>> {
  const find = (t: InPageArgs): Element | null => {
    if (t.ref) return document.querySelector('[data-nd-ref="' + CSS.escape(t.ref) + '"]');
    if (t.selector) return document.querySelector(t.selector);
    if (t.text) {
      const q = String(t.text).toLowerCase();
      const els = document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],label,summary');
      return (
        [...els].find((e) => String((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute('aria-label') || '').toLowerCase().includes(q)) || null
      );
    }
    return null;
  };
  const label = (el: Element): string =>
    String((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el as HTMLElement).title || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
  const key = (el: Element, k: string): void => {
    const init = { key: k, code: k === 'Enter' ? 'Enter' : k, keyCode: k === 'Enter' ? 13 : 0, which: k === 'Enter' ? 13 : 0, bubbles: true, cancelable: true };
    // Sự kiện bàn phím do mã sinh ra KHÔNG tự gửi biểu mẫu như phím Enter thật. Nếu trang không «nhận» phím (keydown không bị preventDefault) và đây là ô <input> nằm trong <form>,
    // gửi biểu mẫu như Enter thật sẽ làm (requestSubmit chạy cả kiểm tra hợp lệ và sự kiện submit). Trang có bộ xử lý Enter riêng (thường preventDefault) thì để nó làm — không gửi đúp.
    const claimed = !el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    const form = (el as HTMLInputElement).form;
    if (k === 'Enter' && !claimed && el.tagName === 'INPUT' && form && typeof form.requestSubmit === 'function') form.requestSubmit();
  };
  if (kind === 'read') {
    const max = a.max || 40000;
    const full = document.body ? document.body.innerText : '';
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .map((l) => ({ text: label(l), href: l.href }))
      .filter((l) => l.text && /^https?:/.test(l.href))
      .slice(0, 100);
    return {
      url: location.href,
      title: document.title,
      text: full.replace(/\n{3,}/g, '\n\n').slice(0, max),
      truncated: full.length > max,
      links,
      selection: String(getSelection() || '').slice(0, 500),
    };
  }
  if (kind === 'snapshot') {
    document.querySelectorAll('[data-nd-ref]').forEach((e) => e.removeAttribute('data-nd-ref'));
    const sel =
      'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=checkbox],[role=menuitem],[role=tab],[contenteditable=""],[contenteditable=true],[onclick]';
    const out: Record<string, unknown>[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (out.length >= (a.max || 150)) break;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none' || r.bottom < 0 || r.top > innerHeight * 3) continue;
      const ref = 'e' + (out.length + 1);
      el.setAttribute('data-nd-ref', ref);
      const inp = el as HTMLInputElement;
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        type: inp.type || undefined,
        text: label(el),
        href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined,
        disabled: inp.disabled || undefined,
        checked: inp.checked === true ? true : undefined,
        editable: el.isContentEditable || undefined,
      });
    }
    return { url: location.href, title: document.title, elements: out, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
  }
  if (kind === 'click') {
    const el = find(a) as HTMLElement | null;
    if (!el) return { ok: false, error: 'Không thấy phần tử (hãy chạy snapshot rồi dùng ref).' };
    el.scrollIntoView({ block: 'center' });
    if (el.focus) el.focus();
    el.click();
    return { ok: true, clicked: label(el) || el.tagName.toLowerCase() };
  }
  if (kind === 'type') {
    const el = find(a) as HTMLElement | null;
    if (!el) return { ok: false, error: 'Không thấy ô nhập (hãy chạy snapshot rồi dùng ref).' };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const text = String(a.text ?? '');
    if (el.isContentEditable) {
      if (a.clear !== false) document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = (a.clear === false ? input.value : '') + text;
      if (set) set.call(input, next);
      else input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else return { ok: false, error: 'Phần tử này không nhập chữ được.' };
    if (a.submit) key(el, 'Enter');
    return { ok: true };
  }
  if (kind === 'key') {
    key(document.activeElement || document.body, String(a.key ?? ''));
    return { ok: true };
  }
  if (kind === 'scroll') {
    if (a.ref || a.selector) {
      const el = find(a);
      if (!el) return { ok: false, error: 'Không thấy phần tử.' };
      el.scrollIntoView({ block: 'center' });
    } else window.scrollBy(0, a.dy || 0);
    return { ok: true, y: Math.round(scrollY) };
  }
  if (kind === 'wait') {
    const end = Date.now() + Math.min(a.ms || 10000, 30000);
    while (Date.now() < end) {
      if (!a.selector || document.querySelector(a.selector)) return { ok: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, error: 'Hết giờ chờ.' };
  }
  return { ok: false, error: 'Lệnh không hợp lệ.' };
}
