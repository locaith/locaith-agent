import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (0.6.1) Những thứ người dùng thấy NGAY trong khung chat mà không phải vào Cài đặt:
 *  • «Bỏ qua mọi xác nhận» luôn có trong danh sách chế độ quyền (cả VS Code), bật bằng một hộp xác nhận — không còn cổng theo cài đặt;
 *  • công tắc Remote một chạm trên thanh tiêu đề (không mã);
 *  • dải «Trí nhớ sinh học» khi Locaith-v5 tự bật nó;
 *  • model Locaith luôn mang logo Locaith ở bộ chọn;
 *  • thanh tab của Chợ là dải cố định, không phải phần tử dính nền trong suốt đè lên danh sách đang cuộn.
 */
const W = path.resolve(__dirname, '../../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');
const i18n = read('i18n.ts');
/** Số lần khoá xuất hiện làm khoá từ điển (đủ hai ngôn ngữ = 2). */
const defs = (k: string) => i18n.split(`'${k}':`).length - 1;

describe('khung chat: các lối tắt không cần Cài đặt', () => {
  it('danh sách chế độ quyền luôn có bypass ở mọi nền tảng; chọn khi chưa bật thì mở hộp xác nhận', () => {
    const src = read('components/composer/Pickers.tsx');
    expect(src).toContain("['default', 'acceptEdits', 'plan', 'bypass'] as PermissionMode[]");
    expect(src).not.toContain("view.allowBypass || view.mode === 'bypass'"); // không còn lọc theo cài đặt
    expect(src).toContain("modes[i] === 'bypass' && !view.allowBypass) bus.fullAccess.emit()");
  });

  it('hộp xác nhận có lời riêng cho VS Code (không nói về bấm/gõ/tab); dải nhắc đã bỏ hẳn', () => {
    expect(read('components/Overlays.tsx')).toContain("'.code'");
    // Từ 0.6.6 dải nhắc «Bỏ qua mọi xác nhận» bị bỏ (chiếm chỗ trong khung chat): chỉ còn hộp xác nhận khi bật.
    expect(read('App.tsx')).not.toContain('FullAccessBar');
    expect(read('components/Overlays.tsx')).not.toContain('fullaccess-bar');
    for (const k of ['title', 'body', 'safe', 'remember', 'enable', 'bar']) expect(defs(`fullAccess.${k}.code`), `thiếu fullAccess.${k}.code ở một trong hai ngôn ngữ`).toBe(2);
    const vi = i18n.match(/'fullAccess\.body\.code': '([^']*)'/)![1]!;
    expect(vi).toMatch(/sửa tệp và chạy lệnh/);
    expect(vi).not.toMatch(/\b(tab|bấm|chuyển trang)\b/i);
  });

  it('công tắc Remote: một cú bấm gửi remote_set_enabled, là role=switch, có chấm trạng thái; khung hẹp chỉ còn biểu tượng', () => {
    const tsx = read('components/RemoteView.tsx');
    expect(tsx).toContain('role="switch"');
    expect(tsx).toContain("post({ type: 'remote_set_enabled', enabled: !on })");
    expect(read('components/Header.tsx')).toContain('remote && inChat && <RemoteToggle remote={remote} />');
    expect(read('styles/remote.css')).toMatch(/@container app \(max-width: 420px\)[^}]*\.hdr-remote-label/s);
    for (const k of ['remote.toggle', 'remote.toggle.titleOn', 'remote.toggle.titleOff']) expect(defs(k), k).toBe(2);
  });

  it('dải Trí nhớ sinh học: mọi chuỗi memory.* có đủ hai ngôn ngữ; nút bấm là <button> thật; có Thử lại và Ẩn (không còn Bỏ qua/Đừng hỏi lại)', () => {
    const tsx = read('components/MemoryStrip.tsx');
    const keys = [...new Set([...tsx.matchAll(/'(memory\.[a-zA-Z.]+)'/g)].map((m) => m[1]!))];
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of keys) expect(defs(k), `thiếu ${k}`).toBe(2);
    expect(tsx).toContain('role="status" aria-live="polite"');
    expect(tsx).toContain('<button type="button" class="rmt-btn"');
    expect(tsx).toContain('bio_auto_retry');
    expect(tsx).toContain('bio_auto_hide');
    expect(tsx).not.toContain('bio_auto_decline');
    expect(tsx).not.toContain('memory.skip');
    // Ẩn có tác dụng ngay ở giao diện, không chờ host
    expect(tsx).toMatch(/setGone\(true\);\s*post\(\{ type: 'bio_auto_hide' \}\)/);
  });

  it('model Locaith mang logo Locaith ở bộ chọn: ProviderBadge của nhà cung cấp locaith vẽ LoMark, không phải chữ cái', () => {
    expect(read('components/ui.tsx')).toMatch(/if \(id === 'locaith'\)[\s\S]*?<LoMark size=\{size\} \/>/);
    expect(read('styles/components.css')).toContain('.prov-badge.prov-badge-lo');
  });

  it('Chợ: thanh tab là dải cố định phía trên, chỉ .mk-body cuộn — không còn thanh dính nền trong suốt đè lên danh sách', () => {
    const css = read('styles/market.css').replace(/\/\*[\s\S]*?\*\//g, ''); // sau khi bỏ chú thích
    expect(css).not.toMatch(/position:\s*sticky/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).toMatch(/\.mk-body\s*\{[^}]*overflow-y:\s*auto/);
    expect(read('components/MarketView.tsx')).toContain('<div class="mk-body" key={tab}>');
    expect(read('App.tsx')).toContain('<div class="pane pane-fill">');
  });
});

/**
 * (0.7.13) Dai "han muc tai khoan Locaith" duoi khung chat: nguoi dung dang chat phai thay minh da dung bao nhieu.
 * Kiem o muc ma nguon (nhu cac dai khac trong tep nay) vi test nay khong render Preact: no ghim hop dong
 * "chuoi + class + khoa i18n + loi goi host" de mot lan sua vo tinh khong lam mat dai.
 */
describe('dai han muc tai khoan Locaith (0.7.13)', () => {
  const strip = read('components/UsageStrip.tsx');

  it('duoc gan vao chan khung chat khi dang nhap Locaith, va chi khi co so lieu', () => {
    expect(read('App.tsx')).toContain('{view.locaith?.usage && <UsageStrip usage={view.locaith.usage} />}');
    expect(read('App.tsx')).toContain("import { UsageStrip } from './components/UsageStrip';");
    // Bang Tasks da bo han khoi giao dien (0.7.x): khong con duong nao render no.
    expect(read('App.tsx')).not.toContain('TodoPanel');
  });

  it('ba loai han muc (phien 5 gio, tuan, token mien phi) + nhan goi', () => {
    expect(strip).toContain("usage.session");
    expect(strip).toContain("usage.week");
    expect(strip).toContain("usage.credit");
    expect(strip).toContain('planName(usage.plan)');
    expect(strip).toContain('usage.sessionHours ?? 5');
  });

  it('thanh do dung nguong: >=80% vang, 100% do; co role=progressbar', () => {
    expect(strip).toContain("p >= 100 ? 'is-full' : p >= 80 ? 'is-high' : ''");
    expect(strip).toContain('role="progressbar"');
    const css = read('styles/components.css');
    expect(css).toMatch(/\.usage-strip\s*\{/);
    expect(css).toMatch(/\.us-fill\.is-high/);
    expect(css).toMatch(/\.us-fill\.is-full/);
  });

  it('chi phan tram, khong bao gio hien so tien', () => {
    expect(strip).toContain('percentText(r.percent)');
    // ` ${p} ` trong template literal khong phai tien: chi bat ki hieu tien di kem CHU SO, hoac API dinh dang tien.
    expect(strip).not.toMatch(/[$€₫]\s?\d/);
    expect(strip).not.toMatch(/Intl\.NumberFormat|toLocaleString|currency/i);
  });

  it('can han muc thi co duong mo trang goi', () => {
    expect(strip).toContain('openExternalLink(usage.upgradeUrl)');
    expect(strip).toContain("usage.state.startsWith('limit')");
    expect(strip).toContain("usage.state === 'free_exhausted'");
  });

  it('moi khoa i18n co du hai ngon ngu', () => {
    for (const k of ['usage.title', 'usage.plan', 'usage.free', 'usage.session', 'usage.week', 'usage.credit', 'usage.creditNote', 'usage.resets', 'usage.buy', 'usage.upgrade']) {
      expect(defs(k), k).toBe(2);
    }
  });

  it('doc so lieu ngay khi mo khung chat, khong cho luot dau', () => {
    const ctl = fs.readFileSync(path.resolve(__dirname, '../../src/host/chatController.ts'), 'utf8');
    const init = ctl.slice(ctl.indexOf('async sendInit('));
    expect(init.slice(0, 1500)).toContain('this.refreshLocaithUsage({ always: true });');
  });
});
