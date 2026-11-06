import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAITH_NOTICE_VERSION } from '../../src/core/providers/locaithGateway';
import { queueProgress, secondsLeft } from '../../webview/src/queueMath';

/**
 * Giao diện mô hình Locaith (AI Local): dải hàng chờ khi đông người dùng, thẻ thông báo dữ liệu trong khung chat, mục Cài đặt.
 * Kiểm bằng phân tích mã (như remoteStyles.test.ts — không dựng DOM): giảm chuyển động, quy tắc chữ tiếng Việt, truy cập, đủ hai ngôn ngữ,
 * không dùng thông báo hệ thống của VS Code, và CANH PHIÊN BẢN thông báo dữ liệu.
 */
const W = path.resolve(__dirname, '../../webview/src');
const css = fs.readFileSync(path.join(W, 'styles/locaith.css'), 'utf8');
const queueTsx = fs.readFileSync(path.join(W, 'components/ModelQueue.tsx'), 'utf8');
const consentTsx = fs.readFileSync(path.join(W, 'components/LocaithConsent.tsx'), 'utf8');
const i18n = fs.readFileSync(path.join(W, 'i18n.ts'), 'utf8');
const main = fs.readFileSync(path.join(W, 'styles/main.css'), 'utf8');

/** Bảng chữ của một ngôn ngữ: phần vi trước `export type I18nKey`, phần en sau đó. */
const split = i18n.indexOf('export type I18nKey');
const TABLES = { vi: i18n.slice(0, split), en: i18n.slice(split) };
const str = (lang: 'vi' | 'en', key: string): string => {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']*)'`).exec(TABLES[lang]);
  if (!m) throw new Error(`thiếu chuỗi ${lang}:${key}`);
  return m[1]!;
};

describe('dải hàng chờ (ModelQueueStrip)', () => {
  it('stylesheet được nạp, và thanh tiến trình tắt chuyển động khi người dùng chọn giảm chuyển động', () => {
    expect(main).toMatch(/@import '\.\/locaith\.css';/);
    const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(i).toBeGreaterThan(0);
    expect(css.slice(i)).toMatch(/\.mq-bar > span\s*\{\s*transition:\s*none/);
  });

  it('quy tắc chữ tiếng Việt: không IN HOA, không letter-spacing âm, không chữ nhỏ hơn 12px', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
    for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it('truy cập: vùng thông báo chỉ gồm tiêu đề + vị trí (đếm ngược từng giây bị ẩn khỏi trình đọc màn hình); nút là <button> thật; Hủy = stop', () => {
    expect(queueTsx).toMatch(/role="status" aria-live="polite"/);
    expect(queueTsx).toMatch(/class="mq-sub" aria-hidden="true"/);
    expect(queueTsx).toMatch(/<button type="button" class="mq-btn" onClick=\{\(\) => post\(\{ type: 'stop' \}\)\}>/);
    expect(queueTsx).toMatch(/t\('locaith\.queue\.cancel'\)/);
  });

  it('đếm ngược chạy phía giao diện từ retryAt (mỗi giây), vị trí là số THẬT cổng báo; không dùng thông báo/thanh trạng thái của VS Code', () => {
    expect(queueTsx).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
    expect(queueTsx).toMatch(/secondsLeft\(queue\.retryAt, now\)/);
    expect(queueTsx).toMatch(/queue\.position/);
    for (const src of [queueTsx, consentTsx]) expect(src).not.toMatch(/showInformationMessage|showWarningMessage|StatusBar|new Notification/);
  });

  it('secondsLeft làm tròn LÊN và không âm; queueProgress chạy 0 → 1 rồi dừng ở 1', () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_600)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
    expect(queueProgress(10_000, 10_000, 0)).toBe(0);
    expect(queueProgress(10_000, 10_000, 5_000)).toBeCloseTo(0.5);
    expect(queueProgress(10_000, 10_000, 10_000)).toBe(1);
    expect(queueProgress(10_000, 10_000, 99_000)).toBe(1);
    expect(queueProgress(10_000, 0, 5_000)).toBe(0);
  });

  it('nội dung đúng yêu cầu: «Đang có nhiều lượt sử dụng, vui lòng chờ xử lý», vị trí, đếm ngược theo giây, nút Hủy (cả hai ngôn ngữ)', () => {
    expect(str('vi', 'locaith.queue.title')).toBe('Đang có nhiều lượt sử dụng, vui lòng chờ xử lý.');
    expect(str('vi', 'locaith.queue.position')).toBe('Vị trí của bạn: {pos}');
    expect(str('vi', 'locaith.queue.retryIn')).toBe('tự thử lại sau {s} giây');
    expect(str('vi', 'locaith.queue.cancel')).toBe('Hủy');
    expect(str('en', 'locaith.queue.title')).toMatch(/Many people are using Locaith.*please wait/);
    expect(str('en', 'locaith.queue.retryIn')).toMatch(/\{s\}s/);
    expect(str('vi', 'locaith.queue.why')).toMatch(/không phải lỗi mạng của bạn/);
    expect(str('en', 'locaith.queue.why')).toMatch(/not a problem with your network/);
    expect(str('vi', 'locaith.queue.whyLimit')).toContain('{n}');
    expect(str('en', 'locaith.queue.whyLimit')).toContain('{n}');
  });
});

describe('thẻ thông báo dữ liệu & mục Cài đặt', () => {
  it('mọi chuỗi locaith.* / welcome.locaith / model.needsConsent dùng trong mã đều có ở CẢ HAI ngôn ngữ', () => {
    const keys = new Set<string>();
    for (const src of [queueTsx, consentTsx, fs.readFileSync(path.join(W, 'components/Welcome.tsx'), 'utf8'), fs.readFileSync(path.join(W, 'components/composer/Pickers.tsx'), 'utf8')]) {
      for (const m of src.matchAll(/'((?:locaith\.[a-zA-Z.]+)|welcome\.locaith|model\.needsConsent)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(18);
    for (const k of keys) {
      for (const lang of ['vi', 'en'] as const) expect(() => str(lang, k), `${lang}:${k}`).not.toThrow();
    }
  });

  it('thẻ trong khung chat: là vùng có nhãn, nút thật, lỗi hiện NGAY trong thẻ (role=alert) và không đóng thẻ; nút Đồng ý khoá khi tiện ích lỗi thời', () => {
    expect(consentTsx).toMatch(/role="region" aria-labelledby="lcn-title"/);
    expect(consentTsx).toMatch(/role="alert"[\s\S]{0,120}\{info\.error\}/);
    expect(consentTsx).toMatch(/action: 'accept'/);
    expect(consentTsx).toMatch(/action: 'decline'/);
    expect(consentTsx).toMatch(/disabled=\{info\.outdated\}/);
    expect(consentTsx).toMatch(/busy=\{info\.saving\}/);
    expect(consentTsx).toMatch(/action: 'withdraw'/);
    expect(consentTsx).toMatch(/action: 'review'/);
  });

  it('thông báo nói đủ bốn ý: gửi đi đâu · lưu lại (đã che khoá) để làm gì · đối tác hạ tầng AI · cách tránh (API riêng)', () => {
    const vi = ['p1', 'p2', 'p3', 'p4'].map((k) => str('vi', `locaith.notice.${k}`)).join(' ');
    expect(vi).toMatch(/gửi tới máy chủ của Locaith/);
    expect(vi).toMatch(/lưu lại/);
    expect(vi).toMatch(/đã che các khoá API, mật khẩu, token/);
    expect(vi).toMatch(/tìm lỗi và cải thiện mô hình/);
    expect(vi).toMatch(/đối tác hạ tầng AI/);
    expect(vi).toMatch(/API key của chính bạn/);
    const en = ['p1', 'p2', 'p3', 'p4'].map((k) => str('en', `locaith.notice.${k}`)).join(' ');
    expect(en).toMatch(/sent to Locaith’s servers/);
    expect(en).toMatch(/masked/);
    expect(en).toMatch(/find bugs and improve the model/);
    expect(en).toMatch(/AI infrastructure partners/);
    expect(en).toMatch(/your own API key/);
    expect(str('vi', 'locaith.notice.accept')).toBe('Đồng ý và dùng');
    expect(str('vi', 'locaith.notice.decline')).toBe('Dùng API riêng');
  });

  /**
   * CANH PHIÊN BẢN: máy chủ coi bản ghi đồng ý có số phiên bản thấp hơn là CHƯA đồng ý, nên mọi lần đổi NỘI DUNG thông báo phải đi kèm tăng
   * LOCAITH_NOTICE_VERSION (src/core/providers/locaithGateway.ts, và LOCAITH_LLM_NOTICE_VERSION phía backend). Đổi chữ mà quên tăng số = người dùng cũ
   * "đồng ý" một thông báo họ chưa từng đọc. Test này đỏ khi chữ đổi: tăng số phiên bản, rồi cập nhật băm dưới đây.
   */
  it('CANH PHIÊN BẢN: chữ của thông báo khớp băm đã duyệt cho phiên bản hiện hành', () => {
    const keys = ['title', 'p1', 'p2', 'p3', 'p4', 'accept', 'decline'];
    const text = (['vi', 'en'] as const).flatMap((lang) => keys.map((k) => str(lang, `locaith.notice.${k}`))).join('\n');
    const hash = createHash('sha256').update(text).digest('hex');
    const APPROVED: Record<number, string> = {
      1: 'b5da73ffc34d4fde46ddd89cc8506187aca1ff890245269ec530ab933569db3c',
    };
    expect(APPROVED[LOCAITH_NOTICE_VERSION], `chưa có băm cho phiên bản ${LOCAITH_NOTICE_VERSION}`).toBeDefined();
    expect(hash, `Chữ thông báo đã đổi (băm mới: ${hash}). Tăng LOCAITH_NOTICE_VERSION rồi thêm băm mới vào APPROVED.`).toBe(APPROVED[LOCAITH_NOTICE_VERSION]);
  });
});
