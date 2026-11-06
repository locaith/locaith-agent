/**
 * Bộ đọc/điều khiển trang — chạy TRONG tab (thế giới "ISOLATED" của content script), được nạp bằng chrome.scripting.executeScript.
 * Build thành IIFE độc lập (`page-runtime.js`) và gắn `globalThis.__ndRuntime`; phía extension gọi từng phương thức qua `callRuntime`.
 *
 * Nguyên tắc:
 *  - Chỉ nhìn thấy cái người dùng nhìn thấy: bỏ phần tử ẩn (display/visibility/opacity/aria-hidden/ngoài màn hình quá xa).
 *  - Ref là số tăng dần theo phần tử (WeakMap), nên ref cũ không bao giờ vô tình trỏ sang phần tử khác.
 *  - Không bao giờ trả giá trị của ô mật khẩu/thẻ/OTP.
 *  - Mọi kết quả là JSON thuần (qua structured clone).
 */

import { classifySensitive, clip, collapse, fold, foldMap, formatSnapshotLine, isDegenerateTransform, isTransparentColor, keyInfo, labelsDiffer, parseKeyCombo, roleOfInput, shortUrl, squeeze, type Sensitivity, type SnapshotItem } from './pure';

import { aim, overlayVisible, presence, strike, type ActionFx } from './overlay';
import { RUNTIME_VERSION as VERSION } from './version';

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

// ─────────────────────────────────────────────────────────────────────────────
// Ref
// ─────────────────────────────────────────────────────────────────────────────

const REFS = { seq: 0, ids: new WeakMap<Element, number>(), byId: new Map<number, WeakRef<Element>>() };

function refOf(el: Element): number {
  let id = REFS.ids.get(el);
  if (id === undefined) {
    id = ++REFS.seq;
    REFS.ids.set(el, id);
    REFS.byId.set(id, new WeakRef(el));
  }
  return id;
}

function elOf(ref: unknown): Element | null {
  const n = typeof ref === 'number' ? ref : Number(ref);
  const el = REFS.byId.get(n)?.deref();
  return el && el.isConnected ? el : null;
}

function pruneRefs(): void {
  if (REFS.byId.size < 2000) return;
  for (const [id, w] of REFS.byId) if (!w.deref()?.isConnected) REFS.byId.delete(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiện ích DOM
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** rAF bị dừng ở tab nền → không đợi quá 60 ms. */
const frame = () => Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(60)]);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO', 'OBJECT', 'EMBED', 'MAP', 'DATALIST']);
const BLOCK_DISPLAY = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-caption', 'table-row-group', 'table-header-group', 'table-footer-group', 'flow-root']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'combobox', 'textbox', 'searchbox', 'option', 'slider', 'spinbutton', 'treeitem', 'listbox']);

function isVisible(el: Element, requireBox = true): boolean {
  const h = el as HTMLElement;
  if (typeof h.checkVisibility === 'function') {
    try {
      // Hai bộ tên tuỳ chọn (cũ/mới) — trình duyệt bỏ qua tên nó không biết.
      if (!h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true } as never)) return false;
    } catch {
      /* dùng nhánh dự phòng */
    }
  } else {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  }
  if (!requireBox) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Phần tử đứng ngoài màn hình quá xa về trái/trên (thủ thuật giấu chữ kiểu "left:-9999px"). */
function farOffscreen(r: DOMRect): boolean {
  return r.right < -400 || (r.bottom < -400 && window.scrollY === 0);
}

/**
 * Hộp của phần tử khiến CẢ NHÁNH không nhìn thấy được (không tính màu/cỡ chữ: phần tử con có thể đặt lại — xem `textHidden`).
 * Các thủ thuật giấu lời dụ khỏi mắt người nhưng vẫn để mô hình đọc được: opacity 0, thu nhỏ về 0 (transform), đẩy ra ngoài màn hình,
 * hộp 1px bị cắt ("chỉ dành cho trình đọc màn hình"), clip/clip-path xoá sạch.
 */
function boxHidden(cs: CSSStyleDeclaration, r: DOMRect): boolean {
  if (cs.display === 'none') return true;
  if (cs.display === 'contents') return false;
  if (parseFloat(cs.opacity) === 0) return true;
  if (cs.transform !== 'none' && isDegenerateTransform(cs.transform)) return true;
  if (farOffscreen(r)) return true;
  if (r.width <= 1 && r.height <= 1 && cs.overflow !== 'visible') return true;
  if (/^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(cs.clip)) return true;
  if (cs.clipPath !== 'none' && /^inset\(\s*(?:50|100)%/.test(cs.clipPath)) return true;
  return false;
}

/**
 * Chữ của phần tử này không nhìn thấy được vì kiểu của chính nó: ẩn, cỡ chữ < 1px, màu tô chữ trong suốt (trừ chữ gradient `background-clip: text`
 * — kiểu tiêu đề phổ biến), thụt đầu dòng khổng lồ ("text-indent: -9999px").
 */
function textHidden(cs: CSSStyleDeclaration): boolean {
  if (cs.visibility !== 'visible') return true;
  if (parseFloat(cs.fontSize) < 1) return true;
  const fill = cs.getPropertyValue('-webkit-text-fill-color') || cs.color;
  if (isTransparentColor(fill) && cs.getPropertyValue('background-clip') !== 'text' && cs.getPropertyValue('-webkit-background-clip') !== 'text') return true;
  if (parseFloat(cs.textIndent) <= -900) return true;
  return false;
}

/** Một nút DOM nằm trong (hoặc là) `ancestor`, tính cả khi đi xuyên shadow root (Node.contains thì không). */
function composedContains(ancestor: Node, node: Node | null): boolean {
  for (let n: Node | null = node; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === ancestor) return true;
  return false;
}

function lang(): string {
  return document.documentElement.lang || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Biểu mẫu — truy cập qua nguyên mẫu gốc, KHÔNG qua thuộc tính trên đối tượng.
// <form> cho phép phần tử con ghi đè thuộc tính của nó bằng name/id (DOM clobbering): `<input name="action">` làm `form.action` thành chính ô nhập,
// `<input name="elements">` làm `form.elements` mất tác dụng, `name="requestSubmit"` vô hiệu hoá việc gửi… Thế giới ISOLATED không miễn nhiễm vì cơ chế này
// nằm ở tầng DOM. Mọi truy cập dưới đây dùng getter/phương thức lấy từ nguyên mẫu ngay lúc nạp.
// ─────────────────────────────────────────────────────────────────────────────

const protoGetter = (proto: object, prop: string): ((this: unknown) => unknown) | undefined => Object.getOwnPropertyDescriptor(proto, prop)?.get;
const getFormAction = protoGetter(HTMLFormElement.prototype, 'action');
const getFormElements = protoGetter(HTMLFormElement.prototype, 'elements');
const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
const CONTROL_FORM_GETTERS: Array<[Function, ((this: unknown) => unknown) | undefined]> = [HTMLInputElement, HTMLButtonElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFieldSetElement, HTMLOutputElement, HTMLObjectElement].map((c) => [c, protoGetter(c.prototype, 'form')]);

/** Biểu mẫu liên kết với phần tử (kể cả thuộc tính form="id"); phần tử khác → <form> bao ngoài gần nhất. */
function formOf(el: Element): HTMLFormElement | null {
  if (el instanceof HTMLFormElement) return el;
  for (const [ctor, get] of CONTROL_FORM_GETTERS) {
    if (get && el instanceof (ctor as typeof Element)) {
      try {
        const f = get.call(el);
        return f instanceof HTMLFormElement ? f : null;
      } catch {
        return null;
      }
    }
  }
  const c = el.closest('form');
  return c instanceof HTMLFormElement ? c : null;
}

/** Địa chỉ nhận dữ liệu của biểu mẫu; `odd` = thuộc tính `action` bị ghi đè (đáng ngờ: coi như không biết đích). */
function formActionOf(form: HTMLFormElement): { action?: string; odd: boolean } {
  let real: unknown;
  try {
    real = getFormAction?.call(form);
  } catch {
    /* bỏ qua */
  }
  const viaProp = (form as unknown as { action?: unknown }).action;
  return { action: typeof real === 'string' ? real : undefined, odd: typeof real !== 'string' || typeof viaProp !== 'string' || viaProp !== real };
}

function formControls(form: HTMLFormElement): Element[] {
  try {
    const col = getFormElements?.call(form) as HTMLFormControlsCollection | undefined;
    return col ? (Array.from(col) as Element[]) : [];
  } catch {
    return [];
  }
}

function submitForm(form: HTMLFormElement): boolean {
  try {
    nativeRequestSubmit.call(form);
    return true;
  } catch {
    return false; // biểu mẫu không hợp lệ → trang tự xử lý
  }
}

function childNodesOf(el: Element): Node[] {
  if (el instanceof HTMLSlotElement) {
    const assigned = el.assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  if ((el as HTMLElement).shadowRoot) return [...(el as HTMLElement).shadowRoot!.childNodes];
  return [...el.childNodes];
}

/** Duyệt cây theo thứ tự tài liệu, xuyên shadow DOM mở; `visit` trả false để bỏ qua cả nhánh. */
function walk(root: Node, visit: (el: Element) => boolean | void): void {
  const go = (node: Node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (visit(el) === false) return;
    for (const c of childNodesOf(el)) go(c);
  };
  if (root.nodeType === Node.DOCUMENT_NODE) go((root as Document).documentElement);
  else if (root.nodeType === Node.ELEMENT_NODE) go(root);
}

function deepElementFromPoint(x: number, y: number): Element | null {
  // Bỏ qua lớp phủ của chính trợ lý (nút Dừng nhỏ ở dưới nhận được con trỏ) khi xét xem phần tử có bị che không.
  let el = document.elementsFromPoint(x, y).find((e) => !e.hasAttribute('data-nd-overlay')) ?? null;
  for (let guard = 0; el && (el as HTMLElement).shadowRoot && guard < 8; guard++) {
    const inner = (el as HTMLElement).shadowRoot!.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function describeEl(el: Element | null): string {
  if (!el) return 'một phần tử khác';
  const role = roleOf(el) ?? el.tagName.toLowerCase();
  const name = accessibleName(el) || visibleText(el, 60);
  return name ? `${role} "${clip(name, 60)}"` : role;
}

/** Chữ NGƯỜI DÙNG NHÌN THẤY trong phần tử (đi xuyên shadow DOM; bỏ phần ẩn/trong suốt/ngoài màn hình), gộp thành một dòng. */
function visibleText(el: Element, max = 120): string {
  return clip(collapse(pageText(el, false, max * 3)), max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tên, vai trò, nhạy cảm
// ─────────────────────────────────────────────────────────────────────────────

function textFromIds(ids: string): string {
  return collapse(
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clip(collapse(aria), 100);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = textFromIds(by);
    if (t) return clip(t, 100);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const labels = el.labels ? [...el.labels].map((l) => collapse(l.textContent ?? '')).filter(Boolean) : [];
    if (labels.length) return clip(labels.join(' '), 100);
    if (el instanceof HTMLInputElement && /^(button|submit|reset)$/i.test(el.type) && el.value) return clip(el.value, 100);
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return clip(collapse(ph), 100);
    const title = el.getAttribute('title');
    if (title && title.trim()) return clip(collapse(title), 100);
    return el.getAttribute('name') ? `(${el.getAttribute('name')})` : '';
  }
  if (el instanceof HTMLImageElement) return clip(collapse(el.alt || el.title || ''), 100);
  const text = visibleText(el, 100);
  if (text) return text;
  // Tên suy ra từ phần tử con chỉ lấy từ con NHÌN THẤY được (con ẩn có thể chứa lời dụ).
  for (const img of el.querySelectorAll<HTMLImageElement>('img[alt]')) if (img.alt.trim() && isVisible(img)) return clip(collapse(img.alt), 100);
  for (const labelled of el.querySelectorAll('[aria-label]')) if ((labelled.getAttribute('aria-label') ?? '').trim() && isVisible(labelled)) return clip(collapse(labelled.getAttribute('aria-label') ?? ''), 100);
  const svgTitle = el.querySelector('svg title');
  if (svgTitle?.textContent?.trim() && svgTitle.closest('svg') && isVisible(svgTitle.closest('svg')!)) return clip(collapse(svgTitle.textContent), 100);
  const title = el.getAttribute('title');
  return title ? clip(collapse(title), 100) : '';
}

function roleOf(el: Element): string | null {
  const explicit = (el.getAttribute('role') ?? '').split(/\s+/)[0].toLowerCase();
  if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit;
  const tag = el.tagName;
  if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text';
    return type === 'hidden' ? null : roleOfInput(type);
  }
  if (tag === 'SELECT') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce !== 'false') return 'textbox';
  return null;
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
}

function sensitivityOf(el: Element): Sensitivity {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return null;
  return classifySensitive({
    type: el instanceof HTMLInputElement ? el.type : undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    hints: [el.getAttribute('name') ?? '', el.id, el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', ...(el.labels ? [...el.labels].map((l) => l.textContent ?? '') : [])],
  });
}

function hasLooksLikeClickable(el: Element): boolean {
  if (el.hasAttribute('onclick')) return true;
  const cs = getComputedStyle(el);
  if (cs.cursor !== 'pointer') return false;
  // Chỉ lấy phần tử "lá" của vùng bấm được: bỏ nếu cha cũng có con trỏ bàn tay (cha mới là vùng bấm).
  const p = el.parentElement;
  return !(p && getComputedStyle(p).cursor === 'pointer');
}

// ─────────────────────────────────────────────────────────────────────────────
// Thông tin trang
// ─────────────────────────────────────────────────────────────────────────────

function scrollInfo() {
  const doc = document.scrollingElement ?? document.documentElement;
  return { y: Math.round(window.scrollY), max: Math.max(0, Math.round(doc.scrollHeight - window.innerHeight)), vh: window.innerHeight, vw: window.innerWidth };
}

/**
 * Hộp thoại CHẶN trang: `<dialog>` mở bằng showModal() (`:modal`), hoặc hộp aria-modal / alertdialog phủ ≥ 20% khung nhìn.
 * Cửa sổ trò chuyện / widget nhỏ ở góc có thể gắn aria-modal nhưng không chặn gì — không được coi là hộp thoại (nếu không ảnh chụp chỉ còn widget).
 */
function findModal(): Element | null {
  const cands = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  for (const c of cands) {
    if (!isVisible(c)) continue;
    let modal = false;
    try {
      modal = c.matches(':modal');
    } catch {
      /* trình duyệt cũ không có :modal */
    }
    if (!modal && (c.getAttribute('aria-modal') === 'true' || c.getAttribute('role') === 'alertdialog')) {
      const r = c.getBoundingClientRect();
      modal = r.width * r.height >= 0.2 * window.innerWidth * window.innerHeight;
    }
    if (modal) return c;
  }
  return null;
}

/** Khung nhúng của cổng thanh toán: ô nhập bên trong không đọc được từ đây, nên chính sự có mặt của khung đã đủ để coi trang là "có thanh toán". */
const PAY_FRAME = /(?:^|[.-])(?:stripe|paypal|adyen|braintreegateway|braintree|checkout|vnpay|momo|zalopay|payoo|squareup|razorpay|worldpay|klarna|2checkout|payment|payments|pay)(?:[.-]|$)/i;

function hasPaymentFrame(): boolean {
  for (const f of document.querySelectorAll('iframe[src]')) {
    try {
      if (PAY_FRAME.test(new URL(f.getAttribute('src') ?? '', document.baseURI).hostname)) return true;
    } catch {
      /* src lạ */
    }
  }
  return false;
}

function pageInfo() {
  let hasPassword = false;
  let hasPayment = false;
  for (const inp of document.querySelectorAll('input, textarea')) {
    if (!isVisible(inp, false)) continue;
    const s = sensitivityOf(inp);
    if (s === 'password') hasPassword = true;
    else if (s === 'payment') hasPayment = true;
  }
  if (!hasPayment && hasPaymentFrame()) hasPayment = true;
  const modal = findModal();
  return {
    url: location.href,
    title: document.title,
    lang: lang(),
    readyState: document.readyState,
    scroll: scrollInfo(),
    hasPassword,
    hasPayment,
    modal: modal ? describeEl(modal) : null,
    frames: document.querySelectorAll('iframe, frame').length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// read — văn bản nhìn thấy, có cấu trúc nhẹ
// ─────────────────────────────────────────────────────────────────────────────

/** Chữ nhìn thấy của một khối định dạng sẵn (<pre>), giữ nguyên xuống dòng và thụt lề, nhưng bỏ phần ẩn (innerText của trình duyệt vẫn lấy chữ trong suốt). */
function rawText(el: Element): string {
  let out = '';
  const go = (node: Node): void => {
    if (out.length > 200_000) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (p && textHidden(getComputedStyle(p))) return;
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (SKIP_TAGS.has(e.tagName.toUpperCase())) return;
    const cs = getComputedStyle(e);
    if (cs.display === 'none') return;
    if (cs.display !== 'contents' && boxHidden(cs, e.getBoundingClientRect())) return;
    if (e.tagName === 'BR') {
      out += '\n';
      return;
    }
    for (const c of childNodesOf(e)) go(c);
  };
  go(el);
  return out;
}

function pageText(root: Element, links: boolean, cap: number): string {
  const out: string[] = [];
  let total = 0;
  let line = '';
  const flush = (closing = false) => {
    const t = line.replace(/[ \t\f\v]+/g, ' ').trim();
    // Dấu đầu dòng / dấu # chưa kèm chữ (khối con sắp xuống dòng): giữ lại để dính vào nội dung kế tiếp, tránh dòng "-" trơ trọi; hết khối mà vẫn trơ thì bỏ.
    if (t === '-' || /^#{1,6}$/.test(t)) {
      if (closing) line = '';
      return;
    }
    line = '';
    if (!t) return;
    out.push(t);
    total += t.length + 1;
  };
  const visit = (node: Node): void => {
    if (total > cap) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (!p) {
        line += (node.nodeValue ?? '').replace(/\s+/g, ' ');
        return;
      }
      const ps = getComputedStyle(p);
      if (textHidden(ps)) return;
      // Như trình duyệt: chuỗi khoảng trắng (kể cả xuống dòng trong mã nguồn HTML) chỉ là MỘT dấu cách, trừ vùng white-space: pre*.
      line += ps.whiteSpace.startsWith('pre') ? (node.nodeValue ?? '') : (node.nodeValue ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag.toUpperCase())) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    // Chữ ẩn khỏi mắt người nhưng mô hình đọc được (opacity 0, thu về 0, ngoài màn hình, hộp 1px bị cắt…) là thủ thuật giấu lời dụ → bỏ cả nhánh.
    // (Màu/cỡ chữ trong suốt được xét riêng ở từng đoạn chữ: phần tử con có thể đặt lại.)
    const rect = cs.display === 'contents' ? null : el.getBoundingClientRect();
    if (rect && boxHidden(cs, rect)) return;

    if (tag === 'BR') {
      flush();
      return;
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      if (rect && rect.width < 2 && rect.height < 2) return; // khung 0×0 chỉ để theo dõi
      flush();
      const src = el.getAttribute('src');
      line = `[khung nhúng${src ? `: ${shortUrl(src, location.href, 60)}` : ''}]`;
      flush();
      return;
    }
    if (tag === 'IMG') {
      if (cs.visibility !== 'visible' || (rect && (rect.width < 2 || rect.height < 2))) return; // điểm ảnh theo dõi, ảnh bị ẩn
      const alt = collapse((el as HTMLImageElement).alt || '');
      if (alt) line += ` [ảnh: ${clip(alt, 80)}] `;
      return;
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // điều khiển nằm trong page_snapshot

    const display = cs.display;
    const block = BLOCK_DISPLAY.has(display) || /^(H[1-6]|P|DIV|SECTION|ARTICLE|LI|UL|OL|TR|TABLE|HEADER|FOOTER|NAV|ASIDE|MAIN|FORM|FIELDSET|BLOCKQUOTE|PRE|HR|DT|DD|DL|FIGURE|FIGCAPTION|DETAILS|SUMMARY)$/.test(tag);
    const cell = display === 'table-cell' || tag === 'TD' || tag === 'TH';

    if (block) flush();
    if (/^H[1-6]$/.test(tag)) line += `${'#'.repeat(Number(tag[1]))} `;
    else if (tag === 'LI') line += '- ';
    else if (tag === 'HR') {
      line = '---';
      flush();
      return;
    }

    if (tag === 'PRE') {
      flush();
      const code = rawText(el);
      for (const l of code.replace(/\s+$/, '').split('\n')) {
        out.push(l);
        total += l.length + 1;
      }
      return;
    }

    if (tag === 'A' && links && el.getAttribute('href')) {
      const href = el.getAttribute('href') ?? '';
      const skipHref = /^(#|javascript:)/i.test(href);
      const target = shortUrl(href, location.href, 100);
      // Liên kết bọc khối (thẻ bài, kết quả tìm kiếm: <a><h3>…</h3><div>…</div></a>): tách khỏi chữ đứng trước để đích gắn đúng dòng đầu của nó.
      const hasBlocks = !!el.querySelector('div, p, h1, h2, h3, h4, h5, h6, li, ul, ol, section, article, table, figure, header, footer, nav, pre, blockquote');
      if (hasBlocks) flush();
      const savedLen = line.length;
      const before = out.length;
      for (const c of childNodesOf(el)) visit(c);
      if (out.length === before) {
        // Liên kết nội tuyến: chỉ có chữ cùng dòng.
        const inner = line.slice(savedLen).replace(/\s+/g, ' ').trim();
        line = line.slice(0, savedLen);
        const label = inner || accessibleName(el); // liên kết chỉ có ảnh/biểu tượng: dùng nhãn trợ năng
        if (label) line += skipHref ? ` ${label} ` : ` [${label}](${target}) `;
      } else if (!skipHref) {
        out[before] += ` (→ ${target})`;
        total += target.length + 5;
      }
      return;
    }

    for (const c of childNodesOf(el)) visit(c);
    if (cell) line += ' | ';
    if (block) flush(true);
  };

  visit(root);
  flush();
  return out.join('\n');
}

function read(a: { selector?: string; maxChars?: number; start?: number; links?: boolean }) {
  const maxChars = Math.min(Math.max(a.maxChars ?? 30000, 1000), 80000);
  const start = Math.max(0, a.start ?? 0);
  let root: Element | null = document.body ?? document.documentElement;
  if (a.selector) {
    try {
      root = document.querySelector(a.selector);
    } catch {
      return fail('not_found', `Selector không hợp lệ: ${a.selector}`);
    }
    if (!root) return fail('not_found', `Không có phần tử khớp selector: ${a.selector}`);
  }
  // Không có phương án dự phòng bằng innerText: nó gồm cả chữ trong suốt/cỡ 0, nên kẻ xấu chỉ cần để trang có ít chữ thấy được là đẩy được lời dụ ẩn vào kết quả.
  const text = pageText(root!, a.links !== false, 400_000);
  const slice = text.slice(start, start + maxChars);
  return {
    ok: true as const,
    ...pageInfo(),
    text: slice,
    totalChars: text.length,
    start,
    end: start + slice.length,
    selection: visibleSelection(4000),
  };
}

/**
 * Văn bản người dùng đang bôi đen, CHỈ phần nhìn thấy. `Selection.toString()` gồm cả chữ trong suốt / ngoài màn hình / cỡ 0 nằm trong vùng chọn
 * (Ctrl+A, hoặc bôi cả đoạn có span ẩn) — đúng chỗ kẻ xấu giấu lời dụ. Không có chữ ẩn nào trong vùng chọn thì dùng nguyên văn của trình duyệt.
 */
function visibleSelection(max: number): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const raw = (sel.toString() ?? '').trim();
  if (!raw) return '';
  const kept: string[] = [];
  let hiddenFound = false;
  const styleCache = new Map<Element, boolean>();
  const textVisible = (n: Node): boolean => {
    const p = n.parentElement;
    if (!p) return true;
    let ok = styleCache.get(p);
    if (ok === undefined) {
      ok = true;
      for (let e: Element | null = p; e && ok; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || (e === p && textHidden(cs)) || (cs.display !== 'contents' && boxHidden(cs, e.getBoundingClientRect()))) ok = false;
      }
      styleCache.set(p, ok);
    }
    return ok;
  };
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const rootNode = range.commonAncestorContainer;
    const walker = document.createTreeWalker(rootNode.nodeType === Node.TEXT_NODE ? (rootNode.parentNode ?? rootNode) : rootNode, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      let text = n.nodeValue ?? '';
      if (n === range.endContainer) text = text.slice(0, range.endOffset);
      if (n === range.startContainer) text = text.slice(range.startOffset);
      if (!text.trim()) continue;
      if (textVisible(n)) kept.push(text);
      else hiddenFound = true;
    }
  }
  return clip((hiddenFound ? collapse(kept.join(' ')) : raw).trim(), max);
}

// ─────────────────────────────────────────────────────────────────────────────
// snapshot — các phần tử tương tác kèm ref
// ─────────────────────────────────────────────────────────────────────────────

interface Entry {
  kind: 'item' | 'heading' | 'landmark';
  text?: string;
  item?: SnapshotItem;
  inView?: boolean;
}

function itemOf(el: Element, baseUrl: string): SnapshotItem | null {
  const role = roleOf(el);
  if (!role) return null;
  const item: SnapshotItem = { ref: refOf(el), role, name: accessibleName(el) };
  const states: string[] = [];
  if (isDisabled(el)) states.push('disabled');
  const sens = sensitivityOf(el);

  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') states.push(el.checked ? 'checked' : 'unchecked');
    else if (type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'image' && type !== 'file') {
      if (sens) item.value = '[ẩn]';
      else if (el.value) item.value = clip(el.value, 80);
      if (type !== 'text') item.note = `type=${type}`;
    }
    if (el.required) states.push('required');
    if (el.readOnly) states.push('readonly');
  } else if (el instanceof HTMLTextAreaElement) {
    if (sens) item.value = '[ẩn]';
    else if (el.value) item.value = clip(collapse(el.value), 80);
    if (el.required) states.push('required');
  } else if (el instanceof HTMLSelectElement) {
    const sel = [...el.selectedOptions].map((o) => collapse(o.text)).join(', ');
    item.value = clip(sel, 80);
    item.note = `${el.options.length} lựa chọn`;
    if (el.required) states.push('required');
  } else if (el instanceof HTMLAnchorElement) {
    const href = el.getAttribute('href') ?? '';
    if (href && !/^(javascript:|#)/i.test(href)) item.href = shortUrl(href, baseUrl);
    if (el.target === '_blank') states.push('tab mới');
  } else {
    const ce = el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') {
      const v = visibleText(el, 80);
      if (v) item.value = v;
    }
  }

  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  else if (expanded === 'false') states.push('collapsed');
  const pressed = el.getAttribute('aria-pressed');
  if (pressed === 'true') states.push('pressed');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true' && !(el instanceof HTMLInputElement)) states.push('checked');
  if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
  if (el.tagName === 'DETAILS' || (el.tagName === 'SUMMARY' && el.parentElement instanceof HTMLDetailsElement)) states.push((el.parentElement as HTMLDetailsElement).open ? 'expanded' : 'collapsed');
  if (sens) states.push(`trường ${sens === 'password' ? 'mật khẩu' : sens === 'payment' ? 'thanh toán' : 'mã xác thực'}`);
  if (states.length) item.states = states;
  return item;
}

function snapshot(a: { scope?: number; viewportOnly?: boolean; maxItems?: number; clickable?: boolean }) {
  pruneRefs();
  const maxItems = Math.min(Math.max(a.maxItems ?? 160, 10), 400);
  let root: Element | null = document.body ?? document.documentElement;
  let note = '';
  if (a.scope !== undefined) {
    root = elOf(a.scope);
    if (!root) return fail('stale_ref', 'Ref phạm vi không còn trên trang.');
  } else {
    const modal = findModal();
    if (modal) {
      root = modal;
      note = `Đang có hộp thoại mở (${describeEl(modal)}): chỉ liệt kê phần tử bên trong. Đóng hộp thoại để thao tác phần còn lại.`;
    }
  }

  const vh = window.innerHeight;
  const entries: Entry[] = [];
  let headings = 0;
  let totalItems = 0;
  const base = location.href;

  walk(root!, (el) => {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag.toUpperCase())) return false;
    if (el.getAttribute('aria-hidden') === 'true' && !el.matches('[role="dialog"], [aria-modal]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    if (cs.display !== 'contents' && boxHidden(cs, r)) return false; // cùng bộ lọc "ẩn khỏi mắt người" như page_read
    if (cs.visibility === 'hidden') return true; // con có thể bật lại visibility
    const hasBox = r.width > 0 && r.height > 0;

    if (/^H[1-6]$/.test(tag) && hasBox && headings < 40) {
      const t = visibleText(el, 100);
      if (t) {
        entries.push({ kind: 'heading', text: `${'#'.repeat(Number(tag[1]))} ${t}` });
        headings++;
      }
    } else if (/^(NAV|MAIN|ASIDE|HEADER|FOOTER|FORM)$/.test(tag) && hasBox) {
      const label = el.getAttribute('aria-label');
      entries.push({ kind: 'landmark', text: `· ${tag.toLowerCase()}${label ? ` "${clip(collapse(label), 40)}"` : ''}` });
    }

    let item = roleOf(el) && hasBox ? itemOf(el, base) : null;
    // Vùng bấm tự chế (div có con trỏ bàn tay): chỉ xét phần tử có ít chữ (thẻ bài lớn vẫn được), tránh duyệt chữ trên các khối khổng lồ.
    if (!item && a.clickable !== false && hasBox && (el.textContent ?? '').length < 600 && !el.closest('a[href], button, [role="button"], [role="link"]') && hasLooksLikeClickable(el)) {
      const t = accessibleName(el);
      if (t) item = { ref: refOf(el), role: 'clickable', name: t };
    }
    if (item) {
      totalItems++;
      const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < window.innerWidth;
      if (!inView) item.off = r.top >= vh ? 'below' : 'above';
      entries.push({ kind: 'item', item, inView });
    }
    return true;
  });

  // Quá nhiều phần tử: ưu tiên những cái đang trong khung nhìn, rồi lấp bằng thứ tự tài liệu.
  const items = entries.filter((e) => e.kind === 'item');
  let keep = new Set<Entry>(items);
  const pool = a.viewportOnly ? items.filter((e) => e.inView) : items;
  if (pool.length > maxItems || a.viewportOnly) {
    const picked = [...pool.filter((e) => e.inView), ...pool.filter((e) => !e.inView)].slice(0, maxItems);
    keep = new Set(picked);
  }

  const lines: string[] = [];
  let shown = 0;
  let pendingContext: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'item') {
      pendingContext.push(e.text!);
      if (pendingContext.length > 3) pendingContext.shift();
      continue;
    }
    if (!keep.has(e)) continue;
    if (pendingContext.length) {
      lines.push(...pendingContext);
      pendingContext = [];
    }
    lines.push(formatSnapshotLine(e.item!));
    shown++;
  }

  const sc = scrollInfo();
  const inner = sc.max === 0 ? mainScroller() : null;
  const innerNote = inner ? ` — cả trang không cuộn nhưng có một khung cuộn bên trong: ${describeEl(inner)} (${scrollInfoOf(inner).y}/${scrollInfoOf(inner).max}px); page_scroll tự cuộn khung đó` : '';
  const header = `Trang: ${document.title || '(không tiêu đề)'} — ${location.href}\nCuộn: ${sc.y}/${sc.max}px (khung nhìn ${sc.vh}px)${innerNote}`;
  const trailer = shown < totalItems ? `\n(Đã liệt kê ${shown}/${totalItems} phần tử${a.viewportOnly ? ' trong khung nhìn' : ''}. Cuộn rồi gọi lại, hoặc thu hẹp bằng scope/page_find.)` : '';
  if (shown === 0) lines.push('(Không thấy phần tử tương tác nào. Trang có thể đang tải, nằm trong khung nhúng (iframe) hoặc chỉ là văn bản — thử page_read.)');
  return {
    ok: true as const,
    text: `${header}${note ? `\n${note}` : ''}\n\n${lines.join('\n')}${trailer}`,
    shown,
    total: totalItems,
    url: location.href,
    title: document.title,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// describe — mô tả một phần tử để xin phép và kiểm tra an toàn
// ─────────────────────────────────────────────────────────────────────────────

function describe(a: { ref?: number }) {
  const el = a.ref !== undefined ? elOf(a.ref) : (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  if (!el) return fail(a.ref !== undefined ? 'stale_ref' : 'not_found', a.ref !== undefined ? 'Phần tử không còn trên trang.' : 'Chưa có phần tử nào đang được focus.');
  const form = formOf(el);
  const type = el instanceof HTMLInputElement ? el.type : undefined;
  const submitLike = el instanceof HTMLButtonElement ? el.type === 'submit' : el instanceof HTMLInputElement ? type === 'submit' || type === 'image' : false;
  const anchor = el.closest('a[href]');
  const r = el.getBoundingClientRect();
  const info = pageInfo();

  // Đích gửi dữ liệu THỰC SỰ: nút gửi có thể mang `formaction` riêng, ghi đè địa chỉ của biểu mẫu.
  let formAction: string | undefined;
  let formOdd = false;
  let formSensitive = false;
  if (form) {
    const fa = formActionOf(form);
    formAction = fa.action;
    formOdd = fa.odd;
    formSensitive = formControls(form).some((x) => sensitivityOf(x) !== null);
    const own = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.getAttribute('formaction') : null;
    if (own) {
      try {
        formAction = new URL(own, document.baseURI).href;
      } catch {
        formOdd = true;
      }
    }
  }

  // Tên hiển thị = chữ NGƯỜI DÙNG NHÌN THẤY; nhãn trợ năng khác hẳn thì báo riêng (`<button aria-label="Hủy">Chuyển tiền</button>`).
  const ariaName = (el.getAttribute('aria-label') ?? '').trim() || (el.getAttribute('aria-labelledby') ? textFromIds(el.getAttribute('aria-labelledby') ?? '') : '');
  const shown = visibleText(el, 80);
  return {
    ok: true as const,
    ref: a.ref ?? refOf(el),
    tag: el.tagName.toLowerCase(),
    role: roleOf(el) ?? 'clickable',
    name: shown || accessibleName(el),
    ariaMismatch: ariaName && shown && labelsDiffer(shown, ariaName) ? clip(collapse(ariaName), 80) : undefined,
    type,
    sensitive: sensitivityOf(el),
    disabled: isDisabled(el),
    href: anchor ? hrefOf(anchor) : undefined,
    target: anchor?.getAttribute('target') || undefined,
    formAction,
    formOdd,
    submitLike: !!form && submitLike,
    inView: r.bottom > 0 && r.top < window.innerHeight,
    // Biểu mẫu chứa phần tử này có ô mật khẩu/thanh toán/OTP không (gửi nó = đăng nhập/trả tiền). Phần tử ngoài biểu mẫu: không biết → false.
    formSensitive,
    page: { url: info.url, hasPassword: info.hasPassword, hasPayment: info.hasPayment },
  };
}

/** URL tuyệt đối của liên kết, tính từ thuộc tính (không dùng `a.href`: với <a> trong SVG nó là một đối tượng chứ không phải chuỗi). */
function hrefOf(a: Element): string | undefined {
  const raw = a.getAttribute('href');
  if (!raw) return undefined;
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Thao tác
// ─────────────────────────────────────────────────────────────────────────────

async function settle(quietMs = 250, maxMs = 2000): Promise<void> {
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const finish = () => {
      mo.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const arm = () => {
      clearTimeout(timer);
      const left = maxMs - (Date.now() - started);
      if (left <= 0) return finish();
      timer = setTimeout(finish, Math.min(quietMs, left));
    };
    const mo = new MutationObserver(arm);
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    arm();
  });
}

function fire(el: Element, type: string, x: number, y: number, extra: MouseEventInit = {}): boolean {
  const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, ...extra };
  const ev = type.startsWith('pointer') ? new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, base);
  return el.dispatchEvent(ev);
}

function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1), y: Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1), r };
}

async function bringIntoView(el: Element) {
  (el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await frame();
}

function covered(el: Element, x: number, y: number): Element | null {
  const top = deepElementFromPoint(x, y);
  // Chứa nhau tính cả xuyên shadow root: bấm vào "máy chủ" của custom element có nội dung trong shadow DOM không phải là bị che.
  if (!top || top === el || composedContains(el, top) || composedContains(top, el)) return null;
  // Nhãn <label> bọc/đi kèm ô nhập vẫn là cùng một vùng bấm.
  if (el instanceof HTMLInputElement && el.labels && [...el.labels].some((l) => l === top || composedContains(l, top))) return null;
  return top;
}

async function click(a: { ref: number; double?: boolean; button?: 'left' | 'right' | 'middle'; fx?: ActionFx }) {
  const el = elOf(a.ref);
  if (!el) return fail('stale_ref', 'Phần tử không còn trên trang.');
  if (isDisabled(el)) return fail('blocked', `${describeEl(el)} đang bị vô hiệu hoá.`);
  const before = { url: location.href, title: document.title };
  await bringIntoView(el);
  let { x, y, r } = centerOf(el);
  if (r.width === 0 || r.height === 0) return fail('blocked', `${describeEl(el)} không có kích thước (đang bị ẩn).`);
  if (a.fx) {
    await aim(el, a.fx, { x, y }, describeEl(el)); // con trỏ ảo bay tới phần tử
    ({ x, y, r } = centerOf(el)); // trang có thể đã xê dịch trong lúc con trỏ bay
    if (r.width === 0 || r.height === 0) return fail('blocked', `${describeEl(el)} không có kích thước (đang bị ẩn).`);
  }
  const cov = covered(el, x, y);
  if (cov) return fail('blocked', `${describeEl(el)} đang bị che bởi ${describeEl(cov)} (hộp thoại, banner cookie hoặc lớp phủ?). Xử lý lớp che trước.`);
  strike(el, a.fx, { x, y }); // vòng sóng + dấu số: thao tác thật sự diễn ra

  const button = a.button === 'right' ? 2 : a.button === 'middle' ? 1 : 0;
  fire(el, 'pointerover', x, y);
  fire(el, 'mouseover', x, y);
  fire(el, 'pointermove', x, y);
  fire(el, 'mousemove', x, y);
  fire(el, 'pointerdown', x, y, { button, buttons: 1 });
  fire(el, 'mousedown', x, y, { button, buttons: 1 });
  (el as HTMLElement).focus?.({ preventScroll: true });
  fire(el, 'pointerup', x, y, { button });
  fire(el, 'mouseup', x, y, { button });
  if (button === 2) fire(el, 'contextmenu', x, y, { button });
  else if (typeof (el as HTMLElement).click === 'function') {
    (el as HTMLElement).click();
    if (a.double) {
      (el as HTMLElement).click();
      fire(el, 'dblclick', x, y);
    }
  } else fire(el, 'click', x, y);

  await settle();
  const active = document.activeElement;
  return {
    ok: true as const,
    clicked: describeEl(el),
    urlChanged: location.href !== before.url,
    url: location.href,
    title: document.title,
    focused: active && active !== document.body ? describeEl(active) : null,
    modal: findModal() ? describeEl(findModal()) : null,
  };
}

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

async function type(a: { ref: number; text: string; clear?: boolean; submit?: boolean; fx?: ActionFx }) {
  const el = elOf(a.ref);
  if (!el) return fail('stale_ref', 'Phần tử không còn trên trang.');
  if (isDisabled(el)) return fail('blocked', `${describeEl(el)} đang bị vô hiệu hoá.`);
  await bringIntoView(el);
  if (a.fx) {
    const { x, y } = centerOf(el);
    await aim(el, a.fx, { x, y }, describeEl(el));
    strike(el, a.fx, { x, y });
  }
  const text = a.text ?? '';
  const clear = a.clear !== false;
  let truncatedTo: number | undefined;
  let rejected: string | undefined;
  (el as HTMLElement).focus?.({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const t = el instanceof HTMLInputElement ? el.type.toLowerCase() : 'textarea';
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes(t)) {
      return fail('blocked', `${describeEl(el)} không phải ô nhập văn bản (kiểu ${t}) — dùng page_click${t === 'file' ? ' (tải tệp lên không được hỗ trợ)' : ''}.`);
    }
    if (el.readOnly) return fail('blocked', `${describeEl(el)} chỉ đọc.`);
    let next = clear ? text : el.value + text;
    // Người gõ thật bị `maxlength` chặn; gán giá trị bằng mã thì không → tự cắt cho đúng hành vi (và báo lại).
    if (el.maxLength >= 0 && [...next].length > el.maxLength) {
      next = [...next].slice(0, el.maxLength).join('');
      truncatedTo = el.maxLength;
    }
    nativeSet(el, next);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Ô date / number / time… tự xoá giá trị sai định dạng (vd. "01/05/2024" vào type=date cần "2024-05-01").
    if (el.value !== next && next !== '' && el.value === '') rejected = t;
  } else if ((el as HTMLElement).isContentEditable) {
    const sel = window.getSelection();
    if (clear && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      (el as HTMLElement).textContent = clear ? text : (el.textContent ?? '') + text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  } else {
    return fail('blocked', `${describeEl(el)} không phải ô nhập — dùng page_snapshot để tìm ô nhập (textbox).`);
  }

  if (a.submit) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
    const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    const form = formOf(el);
    if (down && form) submitForm(form);
  }
  await settle();
  const sens = sensitivityOf(el);
  const current = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : collapse(el.textContent ?? '');
  return { ok: true as const, typed: describeEl(el), length: [...text].length, value: sens ? '[ẩn]' : clip(current, 120), url: location.href, truncatedTo, rejected };
}

async function selectOption(a: { ref: number; value?: string; label?: string; index?: number; fx?: ActionFx }) {
  const el = elOf(a.ref);
  if (!el) return fail('stale_ref', 'Phần tử không còn trên trang.');
  if (!(el instanceof HTMLSelectElement)) return fail('blocked', `${describeEl(el)} không phải ô chọn <select>. Với danh sách tuỳ biến: page_click để mở rồi page_click vào mục cần chọn.`);
  await bringIntoView(el);
  if (a.fx) {
    const { x, y } = centerOf(el);
    await aim(el, a.fx, { x, y }, describeEl(el));
    strike(el, a.fx, { x, y });
  }
  const opts = [...el.options];
  let idx = -1;
  if (typeof a.index === 'number') idx = a.index;
  else if (a.value !== undefined) idx = opts.findIndex((o) => o.value === a.value);
  if (idx < 0 && (a.label !== undefined || a.value !== undefined)) {
    const want = fold(collapse(a.label ?? a.value ?? ''));
    idx = opts.findIndex((o) => fold(collapse(o.text)) === want);
    if (idx < 0) idx = opts.findIndex((o) => fold(collapse(o.text)).includes(want));
  }
  if (idx < 0 || idx >= opts.length) {
    return fail('not_found', `Không có lựa chọn khớp. Các lựa chọn: ${opts.slice(0, 25).map((o) => `"${collapse(o.text)}"`).join(', ')}${opts.length > 25 ? ', …' : ''}`);
  }
  if (opts[idx].disabled) return fail('blocked', `Lựa chọn "${collapse(opts[idx].text)}" đang bị vô hiệu hoá.`);
  el.selectedIndex = idx;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  return { ok: true as const, selected: collapse(opts[idx].text), value: opts[idx].value };
}

const roleOfAttr = (e: Element) => (e.getAttribute('role') ?? '').split(/\s+/)[0].toLowerCase();

/** Enter làm gì với phần tử này (trình duyệt thật bấm nó; sự kiện giả lập thì không tự làm). */
function enterActivates(e: Element): boolean {
  if (e instanceof HTMLButtonElement || e.tagName === 'SUMMARY') return true;
  if (e instanceof HTMLAnchorElement) return e.hasAttribute('href');
  if (e instanceof HTMLInputElement) return /^(button|submit|reset|image)$/i.test(e.type);
  return ['button', 'link', 'menuitem'].includes(roleOfAttr(e));
}

function spaceActivates(e: Element): boolean {
  if (e instanceof HTMLButtonElement || e.tagName === 'SUMMARY') return true;
  if (e instanceof HTMLInputElement) return /^(button|submit|reset|image|checkbox|radio)$/i.test(e.type);
  return ['button', 'checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio', 'tab'].includes(roleOfAttr(e));
}

async function press(a: { key: string; ref?: number }) {
  const target = a.ref !== undefined ? elOf(a.ref) : (document.activeElement ?? document.body);
  if (!target) return fail('stale_ref', 'Phần tử không còn trên trang.');
  if (a.ref !== undefined) {
    await bringIntoView(target);
    (target as HTMLElement).focus?.({ preventScroll: true });
  }
  const combo = parseKeyCombo(a.key);
  const k = keyInfo(combo.key);
  const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, ctrlKey: combo.ctrl, shiftKey: combo.shift, altKey: combo.alt, metaKey: combo.meta, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  const notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (k.key.length === 1 || k.key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  if (notPrevented) {
    // Hành vi mặc định mà sự kiện giả lập (isTrusted=false) không tự kích hoạt.
    const plain = !combo.ctrl && !combo.alt && !combo.meta && !combo.shift;
    const form = target instanceof HTMLInputElement ? formOf(target) : null;
    if (k.key === 'Enter' && plain && target instanceof HTMLInputElement && form && !/^(button|submit|reset|image|checkbox|radio)$/i.test(target.type)) {
      submitForm(form);
    } else if (plain && ((k.key === 'Enter' && enterActivates(target)) || (k.key === ' ' && spaceActivates(target)))) {
      (target as HTMLElement).click();
    } else if (k.key === 'Tab') {
      const focusables = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter((e) => isVisible(e) && !isDisabled(e) && e.tabIndex >= 0);
      const i = focusables.indexOf(target as HTMLElement);
      const next = focusables[(i + (combo.shift ? -1 : 1) + focusables.length) % Math.max(1, focusables.length)];
      next?.focus();
    } else if (k.key === 'Escape') {
      const open = document.querySelector('dialog[open]') as HTMLDialogElement | null;
      open?.close?.();
    }
  }
  await settle(150, 1200);
  return { ok: true as const, pressed: a.key, url: location.href, modal: findModal() ? describeEl(findModal()) : null };
}

function scrollInfoOf(el: HTMLElement) {
  return { y: Math.round(el.scrollTop), max: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)), vh: el.clientHeight, vw: el.clientWidth };
}

function isScrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 4) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
}

/** Khung cuộn gần nhất bao quanh phần tử (đi xuyên shadow root). */
function nearestScroller(el: Element): HTMLElement | null {
  for (let n: Element | null = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null); n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
    if (n !== document.documentElement && n !== document.body && isScrollable(n)) return n;
  }
  return null;
}

/**
 * Khung cuộn chính khi CẢ TRANG không cuộn: ứng dụng kiểu chat / hộp thư / ghi chú đặt `html, body { height: 100%; overflow: hidden }` và cuộn trong một
 * khung bên trong. Chọn khung cuộn nhìn thấy có diện tích lớn nhất.
 */
function mainScroller(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  let n = 0;
  for (const el of document.body ? document.body.querySelectorAll<HTMLElement>('*') : []) {
    if (++n > 8000) break;
    if (el.clientHeight < 80 || el.scrollHeight <= el.clientHeight + 4) continue;
    if (!isScrollable(el) || !isVisible(el)) continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

async function scroll(a: { ref?: number; direction?: 'up' | 'down' | 'top' | 'bottom'; pages?: number }) {
  const docBefore = scrollInfo();
  let scroller: HTMLElement | null = null;
  if (a.ref !== undefined) {
    const el = elOf(a.ref);
    if (!el) return fail('stale_ref', 'Phần tử không còn trên trang.');
    if (docBefore.max === 0) scroller = nearestScroller(el);
    const sBefore = scroller?.scrollTop;
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    await sleep(120);
    await frame();
    if (scroller) {
      const info = scrollInfoOf(scroller);
      return { ok: true as const, scroll: info, moved: info.y !== Math.round(sBefore ?? 0), atTop: info.y <= 0, atBottom: info.y >= info.max - 2, scroller: describeEl(scroller) };
    }
  } else {
    const dir = a.direction ?? 'down';
    if (docBefore.max === 0) scroller = mainScroller();
    if (scroller) {
      const sBefore = Math.round(scroller.scrollTop);
      const step = Math.round(scroller.clientHeight * 0.85 * (a.pages ?? 1));
      const top = dir === 'top' ? 0 : dir === 'bottom' ? scroller.scrollHeight : scroller.scrollTop + (dir === 'down' ? step : -step);
      scroller.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
      await sleep(120);
      await frame();
      const info = scrollInfoOf(scroller);
      return { ok: true as const, scroll: info, moved: info.y !== sBefore, atTop: info.y <= 0, atBottom: info.y >= info.max - 2, scroller: describeEl(scroller) };
    }
    const step = Math.round(window.innerHeight * 0.85 * (a.pages ?? 1));
    const top = dir === 'top' ? 0 : dir === 'bottom' ? 1e9 : window.scrollY + (dir === 'down' ? step : -step);
    window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
    await sleep(120);
    await frame();
  }
  const after = scrollInfo();
  return { ok: true as const, scroll: after, moved: after.y !== docBefore.y, atTop: after.y <= 0, atBottom: after.y >= after.max - 2 };
}

async function hover(a: { ref: number; fx?: ActionFx }) {
  const el = elOf(a.ref);
  if (!el) return fail('stale_ref', 'Phần tử không còn trên trang.');
  await bringIntoView(el);
  const { x, y } = centerOf(el);
  if (a.fx) {
    await aim(el, a.fx, { x, y }, describeEl(el));
    strike(el, a.fx, { x, y });
  }
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(el, t, x, y);
  await settle(200, 1200);
  return { ok: true as const, hovered: describeEl(el) };
}

/** Một đoạn chữ liền mạch trong cùng một khối hiển thị (như người đọc thấy), kèm nơi từng mảnh chữ bắt nguồn để tìm phần tử gần nhất của chỗ khớp. */
interface TextBlock {
  el: Element;
  text: string;
  segs: { start: number; parent: Element }[];
}

/**
 * Gom chữ NHÌN THẤY theo khối (block): chữ bị chia bởi thẻ nội tuyến (<b>, <a>, <span>), xuống dòng trong mã nguồn hay &nbsp; vẫn nối thành một đoạn,
 * nên "Thêm vào giỏ" khớp dù HTML là `<b>Thêm</b> vào\n  <i>giỏ</i>`. Dùng cùng bộ lọc ẩn như page_read.
 */
function textBlocks(root: Element, cap: number): TextBlock[] {
  const blocks: TextBlock[] = [];
  let total = 0;
  let current: TextBlock | null = null;
  const visit = (node: Node, blockEl: Element): void => {
    if (total > cap) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (!p || textHidden(getComputedStyle(p))) return;
      let add = squeeze(node.nodeValue ?? '');
      if (!add) return;
      if (!current || current.el !== blockEl) {
        current = { el: blockEl, text: '', segs: [] };
        blocks.push(current);
      }
      if (current.text.endsWith(' ') && add.startsWith(' ')) add = add.slice(1);
      if (!add) return;
      current.segs.push({ start: current.text.length, parent: p });
      current.text += add;
      total += add.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (cs.display !== 'contents' && boxHidden(cs, el.getBoundingClientRect())) return;
    if (tag === 'BR') {
      if (current && current.el === blockEl && !current.text.endsWith(' ')) current.text += ' ';
      return;
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const inline = cs.display === 'inline' || cs.display === 'contents';
    if (!inline) current = null;
    for (const c of childNodesOf(el)) visit(c, inline ? blockEl : el);
    if (!inline) current = null;
  };
  visit(root, root);
  return blocks;
}

function find(a: { query: string; max?: number; scroll?: boolean }) {
  const q = fold(collapse(a.query ?? ''));
  if (!q) return fail('not_found', 'Thiếu chuỗi cần tìm.');
  const max = Math.min(Math.max(a.max ?? 8, 1), 25);
  const root = document.body ?? document.documentElement;
  const hits: { ref: number; role: string; snippet: string; inView: boolean }[] = [];
  let first: Element | null = null;
  for (const b of textBlocks(root, 600_000)) {
    if (hits.length >= max) break;
    if (!fold(b.text).includes(q)) continue; // loại nhanh trước khi dựng bản đồ vị trí
    const { f, idx } = foldMap(b.text);
    for (let from = 0; hits.length < max; ) {
      const at = f.indexOf(q, from);
      if (at < 0) break;
      const start = idx[at] ?? 0;
      const end = (idx[Math.min(at + q.length - 1, idx.length - 1)] ?? start) + 1;
      let seg = b.segs[0];
      for (const s of b.segs) if (s.start <= start) seg = s;
      const target = seg.parent.closest('a[href], button, [role="button"], [role="link"], input, select, textarea, label, li, p, td, th, h1, h2, h3, h4, h5, h6') ?? seg.parent;
      const r = target.getBoundingClientRect();
      hits.push({
        ref: refOf(target),
        role: roleOf(target) ?? target.tagName.toLowerCase(),
        snippet: collapse(b.text.slice(Math.max(0, start - 40), end + 60)),
        inView: r.bottom > 0 && r.top < window.innerHeight,
      });
      first ??= target;
      from = at + q.length + 40; // các chỗ khớp trong cùng một đoạn: cách nhau một đoạn để khỏi lặp
    }
  }
  if (hits.length === 0) return fail('not_found', `Không thấy "${a.query}" trên trang (chỉ tìm trong chữ đang hiển thị; thử cuộn xuống hoặc đổi từ khoá).`);
  if (a.scroll && first) (first as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  return { ok: true as const, hits, scroll: scrollInfo() };
}

async function waitFor(a: { text?: string; goneText?: string; timeoutMs?: number }) {
  const timeout = Math.min(Math.max(a.timeoutMs ?? 8000, 500), 30000);
  const want = a.text ? fold(collapse(a.text)) : '';
  const gone = a.goneText ? fold(collapse(a.goneText)) : '';
  const started = Date.now();
  const present = (needle: string) => fold(collapse((document.body?.innerText ?? '').slice(0, 400_000))).includes(needle);
  while (Date.now() - started < timeout) {
    if (!want && !gone) {
      await settle(300, timeout);
      return { ok: true as const, waited: Date.now() - started, ...pageInfo() };
    }
    if ((!want || present(want)) && (!gone || !present(gone))) return { ok: true as const, waited: Date.now() - started, ...pageInfo() };
    await sleep(200);
  }
  return fail('timeout', `Hết ${Math.round(timeout / 1000)} giây mà ${want ? `chưa thấy "${a.text}"` : `"${a.goneText}" vẫn còn`}.`);
}

function selection() {
  return { ok: true as const, text: visibleSelection(4000), url: location.href, title: document.title };
}


const api = {
  version: VERSION,
  ping: () => ({ ok: true as const, version: VERSION, url: location.href }),
  info: pageInfo,
  read,
  snapshot,
  describe,
  click,
  type,
  selectOption,
  press,
  scroll,
  hover,
  find,
  waitFor,
  selection,
  presence,
  overlay: overlayVisible,
};

// Nạp lại cùng phiên bản thì giữ nguyên (giữ ref cũ); khác phiên bản thì thay thế.
const g = globalThis as unknown as { __ndRuntime?: { version?: number } };
if (!g.__ndRuntime || g.__ndRuntime.version !== VERSION) g.__ndRuntime = api;
