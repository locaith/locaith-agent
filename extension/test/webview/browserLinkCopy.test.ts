import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (0.7.20) Cầu nối không còn chỉ là «VS Code»: bản trình duyệt nói «Kết nối với ứng dụng trên máy» (VS Code, bản desktop Locaith Work…),
 * liệt kê từng ứng dụng; VS Code có nút «Kết nối trình duyệt này» mở trang /link trong trình duyệt người dùng đang dùng.
 */
const W = path.resolve(__dirname, '../../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');
const i18n = read('i18n.ts');
/** Số lần khoá xuất hiện làm khoá từ điển (đủ hai ngôn ngữ = 2). */
const defs = (k: string) => i18n.split(`'${k}':`).length - 1;
/** Giá trị của khoá ở bản vi (lần 0) / en (lần 1). */
const val = (k: string, which: 0 | 1) => [...i18n.matchAll(new RegExp(`^  '${k.replace(/\./g, '\\.')}': (['"])(.*)\\1,$`, 'gm'))][which]?.[2] ?? '';

describe('(0.7.20) chữ của cầu nối ứng dụng trên máy', () => {
  it('mọi khoá mới có đủ hai ngôn ngữ', () => {
    const keys = [
      'chr.link',
      'chr.linkAgain',
      'chr.linkHint',
      'chr.link.opening',
      'chr.link.asked',
      'chr.link.missing',
      'chr.link.store',
      'chr.link.denied',
      'chr.link.expired',
      'set.link.lostSome',
      'set.link.appsAny',
      'set.link.apps',
      'set.link.app.on',
      'set.link.app.off',
    ];
    for (const k of keys) expect(defs(k), `thiếu ${k} ở một trong hai ngôn ngữ`).toBe(2);
  });

  it('công tắc đổi tên «Kết nối với ứng dụng trên máy»; không còn «Kết nối với VS Code» ở mục Cài đặt của bản trình duyệt', () => {
    expect(val('set.link', 0)).toBe('Kết nối với ứng dụng trên máy');
    expect(val('set.link.toggle', 0)).toBe('Kết nối với ứng dụng trên máy');
    expect(val('set.link', 1)).toBe('Connect to desktop apps');
    expect(val('set.link.toggle', 1)).toBe('Connect to desktop apps');
    const linkKeys = [...i18n.matchAll(/^  '(set\.link[^']*)': (['"])(.*)\2,$/gm)];
    expect(linkKeys.length).toBeGreaterThan(20);
    for (const m of linkKeys) expect(m[3], m[1]).not.toMatch(/Kết nối với VS Code|Connect to VS Code/);
  });

  it('mô tả vẫn nói rõ: TẮT mặc định, nội dung không tới máy chủ Locaith (bộ kiểm gói trình duyệt đòi hai câu này)', () => {
    expect(val('set.link.hint', 0)).toMatch(/TẮT mặc định/);
    expect(val('set.link.hint', 0)).toMatch(/không tới máy chủ Locaith/);
    expect(val('set.link.hint', 1)).toMatch(/OFF by default/);
    expect(val('set.link.hint', 1)).toMatch(/not to a Locaith server/);
  });

  it('(0.7.21) nói đúng nội dung đi đâu SAU ứng dụng: tiện ích chỉ gửi tới ứng dụng trên máy, rồi ứng dụng gửi tới nhà cung cấp AI của nó (có thể là Locaith)', () => {
    // Locaith Work dùng mô hình Locaith thì nội dung đi tiếp tới Locaith — câu «không tới máy chủ Locaith» một mình là sai với người dùng Work.
    expect(val('set.link.hint', 0)).toMatch(/Tiện ích chỉ gửi .* không tới máy chủ Locaith; từ ứng dụng, nội dung đi tới nhà cung cấp AI .*mô hình Locaith/);
    expect(val('set.link.hint', 1)).toMatch(/The extension sends what it reads only to that app .* not to a Locaith server; from the app it goes to the AI provider .*Locaith model/);
    const approve = fs.readFileSync(path.resolve(__dirname, '../../src/browser/link/approvePage.ts'), 'utf8');
    const appWhat = [...approve.matchAll(/appWhat: '([^']*)'/g)].map((m) => m[1]);
    expect(appWhat).toHaveLength(2);
    expect(appWhat[0]).toMatch(/nhà cung cấp AI mà ứng dụng dùng \(có thể là mô hình Locaith\)/);
    expect(appWhat[1]).toMatch(/AI provider the app uses \(which may be a Locaith model\)/);
    for (const s of appWhat) expect(s).not.toMatch(/không tới máy chủ Locaith|not to a Locaith server/);
  });

  it('trạng thái nêu tên ứng dụng ({apps}) ở «đã kết nối», «chờ», «đã ngắt»', () => {
    for (const k of ['set.link.state.connected', 'set.link.state.paired', 'set.link.state.lost', 'set.link.lostSome']) {
      expect(val(k, 0), k).toContain('{apps}');
      expect(val(k, 1), k).toContain('{apps}');
    }
    // e2e (0.7.17) chờ câu này khi ứng dụng không còn nhận trình duyệt
    expect(val('set.link.state.lost', 0)).toMatch(/không còn nhận trình duyệt này/);
  });

  it('Cài đặt liệt kê từng ứng dụng; tab Chrome của VS Code có nút «Kết nối trình duyệt này» và lời nhắn theo trang /link', () => {
    const settings = read('components/BrowserSettings.tsx');
    expect(settings).toContain('data-testid="vscode-link-apps"');
    expect(settings).toContain("t('set.link.lostSome'");
    const panel = read('components/ChromePanel.tsx');
    expect(panel).toContain("post({ type: 'chrome_link_open' })");
    expect(panel).toContain('data-testid="chr-link-open"');
    expect(panel).toContain("'chr.link.missing'");
    expect(panel).toContain("post({ type: 'open_external', url: STORE_URL })");
    expect(panel).toMatch(/chromewebstore\.google\.com\/detail\/amngiccgboohakecgdiadjkdfcablkjc/);
  });
});
