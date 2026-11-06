/**
 * Dựng tài liệu xem trước artifact (HTML / SVG / Markdown) cùng chính sách CSP + sandbox tương ứng — PHẦN THUẦN, dùng chung cho
 * VS Code (webview) và trình duyệt (trang sandbox của extension). CSS font nhúng được truyền vào (mỗi bề mặt tự nạp font theo cách của nó).
 */

import { Marked } from 'marked';
import type { ArtifactRecord } from '../core/engine/types';
import { CDN_ALLOWLIST } from '../core/tools/artifact';

/** Markdown của artifact KHÔNG cho HTML thô lọt qua (đúng như đặc tả "HTML thô bị lọc"): thẻ HTML được hiển thị thành chữ, không phải phần tử. */
const mdParser = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: (token) => escapeHtml(token.text),
  },
});

export const VI_RANGE = 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB';
export const LATIN_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

/** Thoát cho giá trị thuộc tính đặt trong dấu ngoặc kép (srcdoc, content). */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Thoát cho nội dung văn bản của phần tử (ví dụ <title>): tiêu đề do model đặt nên không được tin. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Đặt TRƯỚC mọi nội dung artifact HTML (nên không thể bị một thẻ <head> giả trong chú thích/chuỗi qua mặt):
 *  - CSP bổ sung (giao với CSP của trang bọc): không khung con, không worker/object/media.
 *  - Tắt DNS prefetch và Referer.
 *  - Vô hiệu hoá WebRTC — CSP không chặn được nó và nó có thể đưa dữ liệu ra ngoài qua STUN/DNS — cùng đường lấy cửa sổ khung con "nguyên bản".
 *  - Chặn mã tạo phần tử <link> lúc chạy (createElement, innerHTML, insertAdjacentHTML, document.write…). Đo thực nghiệm trên Chrome 156 / Edge 156: CSP
 *    KHÔNG chặn được `<link rel="prerender">` (trình duyệt vẫn gửi HTTP GET tới URL trong href — đường đưa dữ liệu ra ngoài) và `rel="preconnect"` (mở kết nối/DNS).
 *    Thẻ <link> có sẵn trong nguồn do bộ lọc nguồn xử lý (findBlockedResources + artifactSanitize); đoạn này lo các đường tạo bằng mã. Đây là lớp phòng thủ theo
 *    kiểu "nâng rào" (còn đường vòng hiếm gặp), không phải bảo đảm tuyệt đối — xem README.
 */
export const INNER_PRELUDE =
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'">` +
  '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">' +
  '<script>(function(){' +
  "var n=['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate'];" +
  'for(var i=0;i<n.length;i++){try{Object.defineProperty(window,n[i],{value:undefined,writable:false,configurable:false})}catch(e){}}' +
  "try{Object.defineProperty(navigator,'sendBeacon',{value:function(){return false},writable:false,configurable:false})}catch(e){}" +
  "['contentWindow','contentDocument'].forEach(function(k){try{Object.defineProperty(HTMLIFrameElement.prototype,k,{get:function(){return null},configurable:false})}catch(e){}});" +
  // ── chặn tạo <link> bằng mã ──
  'function scrub(s){if(typeof s!=="string")return s;var p;do{p=s;s=s.replace(/<\\s*link\\b[^>]*>?/gi,"")}while(s!==p);return s}' +
  'function lock(o,k,v){try{Object.defineProperty(o,k,{value:v,writable:false,configurable:false})}catch(e){}}' +
  'function wrapSet(P,k){try{var d=Object.getOwnPropertyDescriptor(P,k);if(d&&d.set)Object.defineProperty(P,k,{get:d.get,set:function(v){d.set.call(this,scrub(v))},enumerable:d.enumerable,configurable:false})}catch(e){}}' +
  'function wrapArg(P,k,i){try{var f=P[k];if(typeof f==="function")lock(P,k,function(){var a=[].slice.call(arguments);if(a.length>i)a[i]=scrub(a[i]);return f.apply(this,a)})}catch(e){}}' +
  "wrapSet(Element.prototype,'innerHTML');wrapSet(Element.prototype,'outerHTML');" +
  "if(window.ShadowRoot){wrapSet(ShadowRoot.prototype,'innerHTML');wrapArg(ShadowRoot.prototype,'setHTMLUnsafe',0)}" +
  "wrapArg(Element.prototype,'insertAdjacentHTML',1);wrapArg(Element.prototype,'setHTMLUnsafe',0);" +
  "wrapArg(Range.prototype,'createContextualFragment',0);wrapArg(DOMParser.prototype,'parseFromString',0);" +
  "try{var pu=Document.parseHTMLUnsafe;if(typeof pu==='function')lock(Document,'parseHTMLUnsafe',function(h){return pu.call(this,scrub(h))})}catch(e){}" +
  "['write','writeln'].forEach(function(k){try{var f=Document.prototype[k];lock(Document.prototype,k,function(){return f.apply(this,[].map.call(arguments,scrub))})}catch(e){}});" +
  "try{var ce=Document.prototype.createElement;lock(Document.prototype,'createElement',function(t,o){t=String(t);if(t.toLowerCase()==='link')t='span';return ce.call(this,t,o)})}catch(e){}" +
  "try{var cn=Document.prototype.createElementNS;lock(Document.prototype,'createElementNS',function(ns,q,o){q=String(q);if(q.toLowerCase().split(':').pop()==='link')q='span';return cn.call(this,ns,q,o)})}catch(e){}" +
  '})()</script>';

const BASE_DOC_CSS = `
:root{color-scheme:light dark}
html,body{margin:0;padding:0}
body{font-family:'Be Vietnam Pro',system-ui,'Segoe UI',sans-serif;font-size:15px;line-height:1.7;color:#1f1d2b;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e4f0;background:#14121c}}
code,pre{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:13px}
`;

function markdownPage(md: string, css: string): string {
  const body = mdParser.parse(md) as string;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${css}${BASE_DOC_CSS}
main{max-width:860px;margin:0 auto;padding:32px 28px 64px}
h1,h2,h3,h4{line-height:1.3;color:#04000b}@media (prefers-color-scheme:dark){h1,h2,h3,h4{color:#fff}}
h1{font-size:1.9em;letter-spacing:-.01em}h2{font-size:1.45em;margin-top:2em}h3{font-size:1.2em}
a{color:#5138ee}@media (prefers-color-scheme:dark){a{color:#a89bff}}
pre{background:rgba(127,127,127,.12);padding:14px 16px;border-radius:10px;overflow:auto}
code{background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid rgba(127,127,127,.3);padding:8px 12px;text-align:left}
th{background:rgba(81,56,238,.08)}blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid #5138ee;color:inherit;opacity:.85}
img{max-width:100%}
</style></head><body><main>${body}</main></body></html>`;
}

function svgPage(svg: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${svg}</body></html>`;
}

export function htmlPage(html: string, css: string): string {
  const style = `<style>${css}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${style}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${style}</head>`);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

/**
 * Nội dung đã bọc + chính sách CSP/sandbox tương ứng với từng loại artifact.
 * `sanitize` (tuỳ chọn): lọc tài liệu bên trong trước khi nhúng (bản trình duyệt dùng DOMParser để bỏ thẻ <link> tải trước, meta refresh…); nếu nó ném lỗi thì
 * artifact không được hiển thị.
 */
export function renderArtifactDocumentWithFonts(rec: Pick<ArtifactRecord, 'type' | 'content' | 'title'>, css: string, sanitize?: (innerDocument: string) => string): string {
  const cdn = CDN_ALLOWLIST.map((h) => `https://${h}`).join(' ');
  const interactive = rec.type === 'html';
  // Trang bọc không có script nào của extension; CSP của nó được khung srcdoc thừa hưởng. `frame-src about:` cũng chặn
  // việc điều hướng khung artifact sang http(s) (meta refresh, liên kết) — con đường rò dữ liệu qua URL.
  const common = `object-src 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'`;
  const csp = interactive
    ? `default-src 'none'; script-src 'unsafe-inline' ${cdn}; style-src 'unsafe-inline' ${cdn}; font-src data: ${cdn}; img-src data: blob:; connect-src 'none'; frame-src about:; ${common}`
    : `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; frame-src about:; ${common}`;
  const rawInner = rec.type === 'html' ? INNER_PRELUDE + htmlPage(rec.content, css) : rec.type === 'svg' ? svgPage(rec.content) : markdownPage(rec.content, css);
  const inner = sanitize ? sanitize(rawInner) : rawInner;
  // Không cấp allow-same-origin: mã của artifact không chạm được vào webview cha, extension hay mạng nội bộ.
  const sandbox = interactive ? 'allow-scripts' : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(rec.title)}</title><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="${sandbox}" srcdoc="${escapeAttr(inner)}"></iframe></body></html>`;
}

