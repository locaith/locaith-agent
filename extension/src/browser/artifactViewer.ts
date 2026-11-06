/**
 * Trang xem trước artifact (tab riêng). Trang này là "vỏ" tin cậy của extension; nội dung artifact do model viết KHÔNG BAO GIỜ chạy ở đây:
 * nó được gửi sang trang `artifact-sandbox.html` (khai báo `sandbox` trong manifest → origin riêng, không có API extension, CSP không có mạng)
 * và chỉ chạy trong đó. Vỏ chỉ dựng tài liệu (cùng mã dựng với bản VS Code) và chuyển qua postMessage.
 */

import type { ArtifactRecord } from '../core/engine/types';
import { LATIN_RANGE, renderArtifactDocumentWithFonts, VI_RANGE } from '../shared/artifactDoc';
import { artifactKey } from './artifacts';
import { sanitizeArtifactDocument } from './artifactSanitize';

const FONTS: { family: string; pkg: string; weights: number[] }[] = [
  { family: 'Be Vietnam Pro', pkg: 'be-vietnam-pro', weights: [400, 600, 700] },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', weights: [400, 700] },
];

let fontCache: string | null = null;

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `data:font/woff2;base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/** @font-face nhúng dạng data URI: artifact luôn có Be Vietnam Pro + JetBrains Mono, không cần mạng. */
async function fontCss(): Promise<string> {
  if (fontCache !== null) return fontCache;
  const rules: string[] = [];
  for (const f of FONTS) {
    for (const w of f.weights) {
      for (const [subset, range] of [['vietnamese', VI_RANGE], ['latin', LATIN_RANGE]] as const) {
        const data = await toDataUrl(chrome.runtime.getURL(`fonts/${f.pkg}-${subset}-${w}-normal.woff2`));
        if (data) rules.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};font-display:swap;src:url(${data}) format('woff2');unicode-range:${range}}`);
      }
    }
  }
  fontCache = rules.join('\n');
  return fontCache;
}

const id = new URLSearchParams(location.search).get('id') ?? '';
const key = artifactKey(id);
const frame = document.getElementById('frame') as HTMLIFrameElement;
const status = document.getElementById('status') as HTMLElement;


async function render(): Promise<void> {
  const rec = (await chrome.storage.session.get(key))[key] as Pick<ArtifactRecord, 'id' | 'title' | 'type' | 'content'> | undefined;
  if (!rec) {
    status.hidden = false;
    status.textContent = 'Không tìm thấy artifact này (đã đóng trình duyệt hoặc đã bị xoá). Hãy mở lại từ cuộc trò chuyện.';
    frame.hidden = true;
    return;
  }
  let html: string;
  try {
    html = renderArtifactDocumentWithFonts(rec, await fontCss(), sanitizeArtifactDocument);
  } catch (err) {
    status.hidden = false;
    status.textContent = err instanceof Error ? err.message : 'Không hiển thị được artifact này.';
    frame.hidden = true;
    return;
  }
  status.hidden = true;
  frame.hidden = false;
  document.title = rec.title;
  // Nạp lại khung sandbox rồi gửi tài liệu: mỗi lần vẽ là một tài liệu mới, không sót trạng thái cũ.
  await new Promise<void>((resolve) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.src = 'artifact-sandbox.html';
  });
  frame.contentWindow?.postMessage({ type: 'nd-render', html }, '*');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[key]) void render();
});
void render();
