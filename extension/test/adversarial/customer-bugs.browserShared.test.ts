import { describe, it, expect } from 'vitest';
import { openExternalOnce } from '../../src/core/host/openOnce';
import { openExternalLink } from '../../webview/src/externalLink';

// Bản Chrome/Edge: webview và BrowserController chạy CÙNG trang ⇒ cùng singleton openExternalOnce.
// Webview đã allow(url) khi bấm; controller sau đó gọi openExternalOnce(url, open) và bị chặn ⇒ liên kết không bao giờ mở.
describe('customer-bugs adversarial: singleton dùng chung webview+controller (bản trình duyệt)', () => {
  it('bấm một liên kết vẫn phải mở được ở phía host', async () => {
    openExternalOnce.reset();
    (globalThis as any).window ??= { parent: { postMessage() {} } };
    try { openExternalLink('https://example.com/a'); } catch { /* post có thể cần môi trường */ }
    let opened = 0;
    await openExternalOnce('https://example.com/a', () => { opened++; });
    expect(opened).toBe(1);
  });
});
