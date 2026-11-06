/**
 * Khung hiện mã QR ghép đôi Remote (qua Internet): quét bằng điện thoại để mở thẳng trang ghép đôi trên locaith.ai.
 * Liên kết chứa `psk` bí mật (hiệu lực 5 phút, một lần) — chỉ hiện trong khung này, trên máy của người dùng; không gửi đi đâu.
 * Khung tự cập nhật theo diễn biến ghép đôi (có người xin → mã xác nhận → xong/từ chối/hết hạn).
 */

import { randomBytes } from 'node:crypto';
import { renderSVG } from 'uqr';
import * as vscode from 'vscode';

export type QrState =
  | { state: 'waiting' }
  | { state: 'requested'; label: string; sas: string }
  | { state: 'done'; label: string }
  | { state: 'denied' }
  | { state: 'expired' }
  /** Relay quá tải, máy này đang xếp hàng: hiện đếm ngược tới lần thử kế tiếp. Mã QR vẫn hợp lệ và dùng được ngay khi vào được. */
  | { state: 'queued'; retryAt: number; attempt: number; trying: boolean }
  /** Đã vào được relay (hết xếp hàng). */
  | { state: 'online' };

export interface QrPanel {
  update(s: QrState): void;
  dispose(): void;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function showPairingQr(o: { link: string; expiresAt: number; vi: boolean; /** Trạng thái ban đầu (vd. đang xếp hàng) — nhúng sẵn vào trang vì tin gửi trước khi trang nạp xong có thể bị mất. */ initial?: QrState; onDispose?: () => void }): QrPanel {
  const vi = o.vi;
  const panel = vscode.window.createWebviewPanel('locaithRemoteQr', vi ? 'Locaith Remote — ghép đôi' : 'Locaith Remote — pair', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('base64');
  const svg = renderSVG(o.link, { ecc: 'M', border: 1 });
  const T = {
    title: vi ? 'Ghép đôi điện thoại / máy khác' : 'Pair a phone / another computer',
    hint: vi ? 'Quét mã bằng camera điện thoại (đã đăng nhập locaith.ai), hoặc mở liên kết bên dưới trên thiết bị cần ghép. Dữ liệu được mã hoá đầu-cuối — relay không đọc được.' : 'Scan with your phone camera (signed in to locaith.ai), or open the link below on the device you want to pair. Data is end-to-end encrypted — the relay cannot read it.',
    left: vi ? 'Còn' : 'Expires in',
    copy: vi ? 'Sao chép liên kết' : 'Copy link',
    copied: vi ? 'Đã sao chép' : 'Copied',
    waiting: vi ? 'Đang chờ thiết bị…' : 'Waiting for a device…',
    expired: vi ? 'Mã ghép đôi đã hết hạn. Chạy lại lệnh «Remote: ghép đôi thiết bị mới».' : 'The pairing code expired. Run “Remote: pair a new device” again.',
    secret: vi ? 'Liên kết này là bí mật dùng một lần — đừng gửi cho người khác.' : 'This link is a one-time secret — do not share it.',
    queued: vi ? 'Máy chủ relay đang quá tải — bạn đang xếp hàng.' : 'The relay is overloaded — you are in the queue.',
    retry: vi ? 'Tự thử lại sau' : 'Retrying in',
    attempt: vi ? 'lần' : 'attempt',
    trying: vi ? 'Đang thử vào lại…' : 'Trying again…',
    queuedNote: vi ? 'Mã QR dùng được ngay khi vào được; mã hết hạn sau 5 phút.' : 'The QR code works as soon as you are in; it expires in 5 minutes.',
  };
  const q0 = o.initial?.state === 'queued' ? { retryAt: o.initial.retryAt, attempt: o.initial.attempt, trying: o.initial.trying } : null;
  panel.webview.html = `<!DOCTYPE html><html lang="${vi ? 'vi' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px;line-height:1.6}
h2{margin:0;font-weight:600}
.qr{width:264px;height:264px;background:#fff;border-radius:14px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.qr svg{width:100%;height:100%;display:block}
.hint{max-width:420px;text-align:center;color:var(--vscode-descriptionForeground)}
.state{min-height:48px;text-align:center;font-size:1.05em}
.sas{font-size:2em;letter-spacing:.12em;font-weight:700;color:var(--vscode-textLink-foreground)}
textarea{width:min(440px,92vw);height:64px;font-family:var(--vscode-editor-font-family);font-size:.85em;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:6px;padding:6px;resize:none}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:6px;padding:6px 14px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
.warn{font-size:.9em;color:var(--vscode-editorWarning-foreground)}
.queue{max-width:440px;text-align:center;padding:10px 14px;border-radius:8px;border:1px solid var(--vscode-editorWarning-foreground);background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 12%,transparent)}
.queue .note{font-size:.9em;color:var(--vscode-descriptionForeground)}
</style></head><body>
<h2>${esc(T.title)}</h2>
<div class="qr" role="img" aria-label="QR">${svg}</div>
<p class="hint">${esc(T.hint)}</p>
<div class="queue" id="queue" role="status" aria-live="polite" hidden></div>
<div class="state" id="state">${esc(T.waiting)}</div>
<textarea id="link" readonly aria-label="link">${esc(o.link)}</textarea>
<button id="copy">${esc(T.copy)}</button>
<div class="warn">${esc(T.secret)}</div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const exp = ${Math.floor(o.expiresAt)};
const state = document.getElementById('state');
let done = false;
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtUp = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let q = ${JSON.stringify(q0)};
const qEl = document.getElementById('queue');
const renderQueue = () => {
  if (!q || done) { qEl.hidden = true; return; }
  const left = q.retryAt - Date.now();
  qEl.hidden = false;
  qEl.innerHTML = '⏳ <b>' + ${JSON.stringify(T.queued)} + '</b><br>' + ((q.trying || left <= 0) ? ${JSON.stringify(T.trying)} : (${JSON.stringify(T.retry)} + ' <b>' + fmtUp(left) + '</b> (' + ${JSON.stringify(T.attempt)} + ' ' + q.attempt + ')')) + '<br><span class="note">' + ${JSON.stringify(T.queuedNote)} + '</span>';
};
const tick = () => { renderQueue(); if (done) return; const left = exp - Date.now(); if (left <= 0) { state.textContent = ${JSON.stringify(T.expired)}; done = true; renderQueue(); return; } if (!state.dataset.busy) state.innerHTML = ${JSON.stringify(T.waiting + ' · ' + T.left)} + ' <b>' + fmt(left) + '</b>'; };
setInterval(tick, 500); tick();
document.getElementById('copy').onclick = () => { vs.postMessage({ type: 'copy' }); const b = document.getElementById('copy'); b.textContent = ${JSON.stringify(T.copied)}; setTimeout(() => (b.textContent = ${JSON.stringify(T.copy)}), 1500); };
window.addEventListener('message', (e) => {
  const m = e.data || {};
  const set = (html) => { state.dataset.busy = '1'; state.innerHTML = html; };
  const t = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  if (m.state === 'requested') set(${JSON.stringify(vi ? '«' : '"')} + t(m.label) + ${JSON.stringify(vi ? '» đang xin ghép đôi.<br>Mã xác nhận:' : '" wants to pair.<br>Confirmation code:')} + ' <span class="sas">' + t(m.sas) + '</span><br>' + ${JSON.stringify(vi ? 'So với mã trên trình duyệt rồi trả lời trong hộp thoại của VS Code.' : 'Compare it with the browser, then answer the VS Code dialog.')});
  else if (m.state === 'done') { done = true; set('✅ ' + ${JSON.stringify(vi ? 'Đã ghép đôi «' : 'Paired "')} + t(m.label) + ${JSON.stringify(vi ? '». Bạn có thể đóng khung này.' : '". You can close this panel.')}); }
  else if (m.state === 'denied') { done = true; set(${JSON.stringify(vi ? 'Đã từ chối. Cửa sổ ghép đôi đã đóng.' : 'Declined. The pairing window is closed.')}); }
  else if (m.state === 'expired') { done = true; set(${JSON.stringify(T.expired)}); }
  else if (m.state === 'queued') { q = { retryAt: Number(m.retryAt) || 0, attempt: Number(m.attempt) || 1, trying: !!m.trying }; renderQueue(); }
  else if (m.state === 'online') { q = null; renderQueue(); }
  if (done) renderQueue();
});
</script></body></html>`;
  const sub = panel.webview.onDidReceiveMessage((m: { type?: string }) => {
    if (m?.type === 'copy') void vscode.env.clipboard.writeText(o.link);
  });
  panel.onDidDispose(() => {
    sub.dispose();
    o.onDispose?.();
  });
  return {
    update: (s) => void panel.webview.postMessage(s),
    dispose: () => panel.dispose(),
  };
}
