/**
 * Lớp phủ của trợ lý TRÊN TRANG đang được điều khiển (chạy trong runtime của trang, xem runtime.ts):
 *  - viền sáng xanh lam ngọc quanh khung nhìn + thanh nhỏ ở dưới có nút Dừng đỏ ruby;
 *  - CON TRỎ CHUỘT ảo bay tới phần tử trợ lý sắp bấm/gõ, vòng sóng lúc bấm, khung đánh dấu phần tử, và DẤU SỐ (1, 2, 3…) giữ lại ở các chỗ đã thao tác để
 *    người dùng biết trợ lý đã bấm vào đâu — số này trùng với số bước hiện trong khung chat nên sau này có thể bảo "quay lại bước 3".
 *
 * Mọi thứ nằm trong shadow DOM ĐÓNG (CSS của trang không đụng tới, mã của trang không với tới nút bên trong), pointer-events: none ở mọi nơi trừ nút Dừng,
 * z-index cao nhất. Tự gỡ sau ttlMs nếu extension không gia hạn (khung chat đóng giữa chừng không để lại viền mồ côi).
 */

export const OVERLAY_ATTR = 'data-nd-overlay';

export type ActionKind = 'click' | 'type' | 'select' | 'hover';

export interface PresenceArgs {
  on: boolean;
  ttlMs?: number;
  label?: string;
  stopLabel?: string;
}

/** Hiệu ứng cho MỘT thao tác lên phần tử (do extension cấp, cùng số bước với khung chat). */
export interface ActionFx {
  n: number;
  kind: ActionKind;
  /** Động từ hiện cạnh con trỏ ("Bấm", "Gõ vào"…), theo ngôn ngữ giao diện. */
  verb: string;
  /** Thứ được thao tác, ví dụ: nút “Thêm vào giỏ”. Bỏ trống thì runtime tự mô tả phần tử. */
  what?: string;
  /** Dữ liệu dựng lớp phủ nếu nó chưa có (thao tác đầu tiên ngay sau khi chuyển trang). Không có = người dùng đã tắt hiệu ứng → không vẽ gì. */
  show?: PresenceArgs;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** rAF bị dừng ở tab nền → không đợi quá 60 ms. */
const frame = () => Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(60)]);

interface Marker {
  n: number;
  ref: WeakRef<Element>;
  node: HTMLElement;
}

interface Overlay {
  host: HTMLElement;
  label: HTMLElement;
  fx: HTMLElement;
  hl: HTMLElement;
  cursor: HTMLElement;
  tag: HTMLElement;
  markers: Marker[];
  /** Nơi con trỏ đang đứng (toạ độ khung nhìn); chưa có = chưa hiện lần nào. */
  pos?: { x: number; y: number };
  timer?: ReturnType<typeof setTimeout>;
  hlTimer?: ReturnType<typeof setTimeout>;
  relayout: () => void;
  off: () => void;
}

let overlay: Overlay | null = null;

/** Tối đa bao nhiêu dấu số giữ lại cùng lúc (cũ nhất rụng trước). */
const MAX_MARKERS = 12;

const CSS = `
.glow{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(34,211,238,.95),inset 0 0 22px 4px rgba(34,211,238,.55),inset 0 0 72px 14px rgba(59,130,246,.30);animation:nd-pulse 2.4s ease-in-out infinite alternate}
@keyframes nd-pulse{from{opacity:.6}to{opacity:1}}
.bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:6px 6px 6px 12px;border-radius:999px;background:rgba(6,24,38,.94);color:#e8fbff;border:1px solid rgba(34,211,238,.7);box-shadow:0 6px 22px rgba(0,0,0,.35),0 0 0 3px rgba(34,211,238,.18);font:600 12.5px/1.2 'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:#22d3ee;box-shadow:0 0 10px #22d3ee;animation:nd-blink 1.2s ease-in-out infinite}
@keyframes nd-blink{50%{opacity:.35}}
.txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{all:unset;box-sizing:border-box;flex:none;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:999px;background:#e11d48;color:#fff;font-family:inherit;font-weight:700;font-size:12px;line-height:1}
button:hover{background:#be123c}
button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.fx{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.hl{position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;border:2px solid #22d3ee;border-radius:7px;background:rgba(34,211,238,.08);box-shadow:0 0 0 4px rgba(34,211,238,.28),0 0 20px rgba(34,211,238,.6);opacity:0;transition:opacity .3s ease}
.hl.on{opacity:1}
.cur{position:fixed;left:0;top:0;display:flex;align-items:flex-start;opacity:0;will-change:transform;transition:opacity .2s ease;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
.cur.on{opacity:1}
.cur.fly{transition:transform .42s cubic-bezier(.22,.8,.3,1),opacity .2s ease}
.cur svg{flex:none;width:26px;height:26px;margin:-3px 0 0 -4px;overflow:visible}
.cur .tag{margin:16px 0 0 -2px;max-width:260px;padding:4px 10px 4px 5px;display:flex;align-items:center;gap:6px;border-radius:999px;background:rgba(6,24,38,.94);color:#e8fbff;border:1px solid rgba(34,211,238,.7);font:600 12px/1.2 'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',sans-serif}
.cur.left{flex-direction:row-reverse}
.cur.left .tag{margin:16px -2px 0 0}
.cur.up .tag{margin-top:-38px}
.tag .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.n{flex:none;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#0891b2;color:#fff;border:2px solid #fff;font:800 10.5px/14px system-ui,sans-serif;text-align:center}
.rip{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;box-sizing:border-box;border-radius:50%;border:3px solid #22d3ee;background:rgba(34,211,238,.18);box-shadow:0 0 16px rgba(34,211,238,.75);transform:scale(.2);animation:nd-rip .7s ease-out forwards}
.rip.soft{width:34px;height:34px;margin:-17px 0 0 -17px;border-width:2px;background:none;animation-duration:.9s}
@keyframes nd-rip{60%{opacity:.9}to{transform:scale(1.3);opacity:0}}
.mk{position:fixed;left:0;top:0;width:24px;height:24px;margin:-12px 0 0 -12px;box-sizing:border-box;border-radius:50%;background:#0891b2;color:#fff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5),0 0 0 3px rgba(34,211,238,.35);font:800 12px/20px system-ui,sans-serif;text-align:center;animation:nd-pop .3s ease-out}
@keyframes nd-pop{from{transform:scale(.3);opacity:0}}
@media (prefers-reduced-motion:reduce){.glow,.dot,.mk{animation:none}.cur.fly{transition:none}.rip{animation-duration:.01s}}
@media print{:host{display:none!important}}
`;

const ARROW =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2.5 L4 19 L8.3 15.1 L11.2 21.6 L14 20.4 L11.1 14 L16.9 14 Z" fill="#22d3ee" stroke="#06222c" stroke-width="1.7" stroke-linejoin="round" paint-order="stroke"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function removeOverlay(): void {
  if (overlay) {
    if (overlay.timer) clearTimeout(overlay.timer);
    if (overlay.hlTimer) clearTimeout(overlay.hlTimer);
    overlay.off();
    overlay.host.remove();
    overlay = null;
  }
  // Dọn cả phần tử mồ côi do một bản runtime cũ để lại.
  for (const h of document.querySelectorAll('[' + OVERLAY_ATTR + ']')) h.remove();
}

/** Di chuyển bằng transform (con trỏ, khung đánh dấu): chỉ dùng cho phần tử KHÔNG có animation trên transform. */
function place(node: HTMLElement, x: number, y: number): void {
  node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
}

/** Đặt bằng left/top (vòng sóng, dấu số): chúng có animation trên transform nên không dùng transform để định vị được. */
function placeAbs(node: HTMLElement, x: number, y: number): void {
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
}

/** Đặt lại vị trí các dấu số theo phần tử mà chúng gắn vào (cuộn trang, đổi cỡ, bố cục dịch chuyển); dấu của phần tử đã biến mất thì gỡ. */
function layoutMarkers(o: Overlay): void {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  o.markers = o.markers.filter((m) => {
    const target = m.ref.deref();
    if (!target || !target.isConnected) {
      m.node.remove();
      return false;
    }
    const r = target.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    m.node.style.visibility = inView ? 'visible' : 'hidden';
    // Góc trên-trái của phần tử (không đè lên chữ ở giữa); kẹp trong khung nhìn để dấu ở mép vẫn thấy được.
    placeAbs(m.node, Math.min(Math.max(r.left, 12), vw - 12), Math.min(Math.max(r.top, 12), vh - 12));
    return true;
  });
}

function buildOverlay(stopLabel: string): Overlay {
  const host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
  const root = host.attachShadow({ mode: 'closed' });
  // Stylesheet dựng bằng mã (adoptedStyleSheets) không chịu CSP `style-src` của trang; trình duyệt không có thì dùng thẻ <style>.
  const styles: Node[] = [];
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    styles.push(style);
  }
  const glow = el('div', 'glow');

  const bar = el('div', 'bar');
  bar.setAttribute('role', 'status');
  const label = el('span', 'txt');
  const stop = el('button');
  stop.type = 'button';
  stop.textContent = '■ ' + stopLabel;
  stop.addEventListener('click', (e) => {
    // Chỉ cú bấm THẬT của người dùng (isTrusted) mới dừng trợ lý; mã của trang không giả được.
    if (!e.isTrusted) return;
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: 'nd-presence-stop' });
    } catch {
      /* tiện ích vừa được tải lại: bản chạy cũ không còn liên lạc được */
    }
  });
  bar.append(el('span', 'dot'), label, stop);

  const fx = el('div', 'fx');
  fx.setAttribute('aria-hidden', 'true');
  const hl = el('div', 'hl');
  const cursor = el('div', 'cur');
  cursor.innerHTML = ARROW;
  const tag = el('span', 'tag');
  cursor.append(tag);
  fx.append(hl, cursor);

  root.append(...styles, glow, fx, bar);
  document.documentElement.appendChild(host);

  const o: Overlay = { host, label, fx, hl, cursor, tag, markers: [], relayout: () => undefined, off: () => undefined };
  // Cuộn (kể cả khung cuộn bên trong: sự kiện cuộn không nổi bọt nên nghe ở pha bắt) hay đổi cỡ cửa sổ → đặt lại dấu số theo phần tử.
  let queued = false;
  o.relayout = () => {
    if (queued) return;
    queued = true;
    const run = () => {
      if (!queued) return;
      queued = false;
      if (overlay === o) layoutMarkers(o);
    };
    requestAnimationFrame(run);
    setTimeout(run, 120); // tab nền không chạy rAF
  };
  const on = () => o.relayout();
  window.addEventListener('scroll', on, { capture: true, passive: true });
  window.addEventListener('resize', on, { passive: true });
  o.off = () => {
    window.removeEventListener('scroll', on, { capture: true });
    window.removeEventListener('resize', on);
  };
  return o;
}

/** Bật/gia hạn (on) hoặc gỡ (off) lớp phủ. Gia hạn đặt lại hạn tự gỡ và sắp lại các dấu số. */
export function presence(a: PresenceArgs) {
  if (!a.on) {
    removeOverlay();
    return { ok: true as const, shown: false };
  }
  if (!overlay || !overlay.host.isConnected) {
    removeOverlay();
    overlay = buildOverlay(a.stopLabel || 'Dừng');
  }
  if (a.label) overlay.label.textContent = a.label;
  if (overlay.timer) clearTimeout(overlay.timer);
  overlay.timer = setTimeout(removeOverlay, Math.min(Math.max(a.ttlMs ?? 15000, 2000), 120000));
  layoutMarkers(overlay);
  return { ok: true as const, shown: true };
}

/**
 * Ẩn/hiện tạm toàn bộ lớp phủ (khi chụp màn hình để ảnh gửi cho mô hình là trang sạch). Khi ẨN thì đợi trình duyệt vẽ xong khung hình không còn
 * lớp phủ rồi mới trả về — chụp ngay sau khi đổi kiểu có thể vẫn dính khung hình cũ.
 */
export async function overlayVisible(a: { hidden: boolean }) {
  if (!overlay) return { ok: true as const };
  overlay.host.style.setProperty('visibility', a.hidden ? 'hidden' : 'visible', 'important');
  if (a.hidden) {
    await frame();
    await frame();
    await sleep(40);
  }
  return { ok: true as const };
}

const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * BƯỚC 1 của một thao tác lên phần tử: khung đánh dấu phần tử + con trỏ bay tới đó (chờ bay xong nếu người dùng đang xem trang này).
 * Gọi sau khi đã cuộn phần tử vào khung nhìn. Không làm gì nếu `fx` rỗng, hoặc người dùng đã tắt hiệu ứng (không có lớp phủ và `fx.show` rỗng).
 */
export async function aim(target: Element, fx: ActionFx | undefined, at: { x: number; y: number }, what: string): Promise<void> {
  if (!fx) return;
  if (!overlay || !overlay.host.isConnected) {
    if (!fx.show) return;
    presence({ ...fx.show, on: true });
  }
  const o = overlay!;
  const r = target.getBoundingClientRect();
  place(o.hl, r.left - 3, r.top - 3);
  o.hl.style.width = `${Math.max(r.width + 6, 12)}px`;
  o.hl.style.height = `${Math.max(r.height + 6, 12)}px`;
  o.hl.classList.add('on');
  if (o.hlTimer) clearTimeout(o.hlTimer);
  o.hlTimer = setTimeout(() => o.hl.classList.remove('on'), 1800);

  // Nhãn cạnh con trỏ: số bước + việc đang làm.
  o.tag.replaceChildren(el('span', 'n', String(fx.n)), el('span', 't', `${fx.verb} ${fx.what || what}`));
  const vw = document.documentElement.clientWidth;
  o.cursor.classList.toggle('left', at.x > vw - 290);
  o.cursor.classList.toggle('up', at.y > window.innerHeight - 70);

  const visible = document.visibilityState === 'visible' && !reducedMotion();
  const dist = o.pos ? Math.hypot(o.pos.x - at.x, o.pos.y - at.y) : 0;
  // Lần đầu: hiện ngay tại đích (không có chỗ để bay từ đó); những lần sau: bay từ chỗ đứng cũ.
  o.cursor.classList.toggle('fly', visible && !!o.pos && dist > 4);
  place(o.cursor, at.x, at.y);
  o.cursor.classList.add('on');
  o.pos = at;
  if (visible && dist > 4) await sleep(Math.min(420, 160 + dist * 0.5));
}

/**
 * BƯỚC 2: lúc thao tác thật sự diễn ra — vòng sóng tại điểm bấm và dấu số gắn vào phần tử (còn lại tới hết lượt chạy). `hover` chỉ gợn nhẹ, không để dấu.
 * Dấu số CHỈ có khi thao tác thật sự xảy ra (bị chặn vì "bị che"… thì không có dấu).
 */
export function strike(target: Element, fx: ActionFx | undefined, at: { x: number; y: number }): void {
  const o = overlay;
  if (!fx || !o || !o.host.isConnected) return;
  const soft = fx.kind === 'hover';
  const ring = el('div', soft ? 'rip soft' : 'rip');
  placeAbs(ring, at.x, at.y);
  o.fx.append(ring);
  ring.addEventListener('animationend', () => ring.remove(), { once: true });
  setTimeout(() => ring.remove(), 1500);
  if (soft) return;
  const node = el('div', 'mk', String(fx.n));
  o.fx.append(node);
  o.markers.push({ n: fx.n, ref: new WeakRef(target), node });
  while (o.markers.length > MAX_MARKERS) o.markers.shift()?.node.remove();
  layoutMarkers(o);
}
