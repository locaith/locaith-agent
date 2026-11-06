/**
 * Lọc tài liệu artifact trong trang xem trước (vỏ tin cậy của extension, KHÔNG phải trong sandbox) trước khi chuyển vào khung sandbox.
 *
 * Đây là lớp PHÒNG THỦ THÊM, không phải chốt chặn duy nhất. Bối cảnh (đã đo bằng thực nghiệm):
 *  - Ở TRANG CẤP CAO NHẤT, `<link rel="prerender">` (Chromium "NoStatePrefetch") làm trình duyệt gửi yêu cầu tới địa chỉ trong `href` dù CSP là
 *    `default-src 'none'`, và xoá phần tử ngay sau khi chèn cũng không kịp — một đường đưa dữ liệu ra ngoài qua URL mà CSP không chặn được.
 *  - Trong đường ống xem trước thật (vỏ → sandbox.html → iframe sandbox srcdoc) thì trên Chrome 156 và Edge 156 KHÔNG kênh nào rò: đã thử 31 kênh
 *    (prerender/prefetch/preload/preconnect/modulepreload/dns-prefetch kể cả tạo bằng JS, meta refresh, location, iframe, img, fetch, sendBeacon, form, window.open,
 *    liên kết, @import, font, script, object/embed, WebSocket, EventSource, media, Worker, import(), ping, speculationrules, base, SVG) — xem test canary trong e2e.
 *  Lọc ở đây phòng trường hợp một phiên bản trình duyệt sau này đổi hành vi: nếu test canary đỏ thì đây trở thành chốt chặn quan trọng.
 *
 * Giới hạn: chỉ chặn phần tử có sẵn trong nguồn; artifact có script vẫn có thể tạo `<link>` lúc chạy. Do đó artifact chỉ mở khi người dùng bấm "Mở".
 */

import { CDN_ALLOWLIST } from '../core/tools/artifact';

/** URL tuyệt đối http(s) tới máy chủ khác (kể cả dạng `//host/…`); đường dẫn tương đối/`data:` → null. */
function externalUrl(href: string | null): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), 'https://relative.invalid/');
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== 'relative.invalid' ? u : null;
  } catch {
    return null;
  }
}

/** Phần tử/thuộc tính không được phép có trong tài liệu artifact. */
function forbidden(doc: Document): Element[] {
  const out: Element[] = [];
  for (const link of doc.querySelectorAll('link')) {
    const ext = externalUrl(link.getAttribute('href'));
    if (!ext) continue; // không tới máy chủ ngoài (data:, tương đối): vô hại
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const okSheet = rel.length === 1 && rel[0] === 'stylesheet' && CDN_ALLOWLIST.includes(ext.hostname.toLowerCase());
    if (!okSheet) out.push(link);
  }
  for (const meta of doc.querySelectorAll('meta[http-equiv]')) {
    if ((meta.getAttribute('http-equiv') ?? '').toLowerCase() !== 'refresh') continue;
    const url = /url\s*=\s*['"]?([^'"]+)/i.exec(meta.getAttribute('content') ?? '')?.[1];
    if (externalUrl(url ?? null)) out.push(meta);
  }
  for (const base of doc.querySelectorAll('base')) out.push(base);
  return out;
}

/** Trả tài liệu đã bỏ mọi phần tử bị cấm; ném lỗi nếu sau khi lọc mà phân tích lại vẫn còn (không hiển thị artifact đó). */
export function sanitizeArtifactDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of forbidden(doc)) el.remove();
  for (const el of doc.querySelectorAll('[ping]')) el.removeAttribute('ping'); // <a ping> gửi POST tới địa chỉ ngoài khi bấm
  const out = `<!doctype html>${doc.documentElement.outerHTML}`;
  // Kiểm tra lại bản đã dựng: một khác biệt giữa bộ phân tích và bộ tuần tự hoá không được để lọt phần tử bị cấm.
  const again = new DOMParser().parseFromString(out, 'text/html');
  if (forbidden(again).length > 0) throw new Error('Artifact chứa thẻ tải tài nguyên ngoài không loại bỏ được; từ chối hiển thị.');
  return out;
}
