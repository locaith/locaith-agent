import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Dải «Remote đang xếp hàng» và thẻ Remote trong Cài đặt: giữ đường lui giảm chuyển động, quy tắc chữ tiếng Việt của dự án, và nội dung bắt buộc của giao diện
 * (đếm ngược, «Thử ngay», «Tắt Remote», lời trấn an "chat vẫn dùng bình thường", không bịa số thứ tự).
 */
const W = path.resolve(__dirname, '../../webview/src');
const css = fs.readFileSync(path.join(W, 'styles/remote.css'), 'utf8');
const tsx = fs.readFileSync(path.join(W, 'components/RemoteView.tsx'), 'utf8');
const i18n = fs.readFileSync(path.join(W, 'i18n.ts'), 'utf8');

describe('RemoteStrip / RemoteCard', () => {
  it('thanh tiến trình tắt chuyển động khi người dùng chọn giảm chuyển động', () => {
    const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(i).toBeGreaterThan(0);
    expect(css.slice(i)).toMatch(/\.rmt-bar > span\s*\{\s*transition:\s*none/);
  });

  it('quy tắc chữ tiếng Việt: không IN HOA, không letter-spacing âm, không chữ nhỏ hơn 12px', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
    for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  it('dải xếp hàng là vùng trạng thái đọc được bằng trình đọc màn hình, nút bấm là <button> thật', () => {
    expect(tsx).toMatch(/role="status" aria-live="polite"/);
    expect(tsx).toMatch(/<button type="button" class="rmt-btn"/);
  });

  it('«Thử ngay» chỉ mở sau khoảng tối thiểu (khớp QUEUE_MIN_RETRY_GAP_MS), và không bịa số thứ tự hàng chờ', () => {
    expect(tsx).toMatch(/QUEUE_MIN_RETRY_GAP_MS/);
    expect(tsx).not.toMatch(/vị trí|position|thứ \d+ trong/i);
  });

  it('mọi chuỗi remote.* có đủ tiếng Việt và tiếng Anh', () => {
    const keys = [...tsx.matchAll(/'(remote\.[a-zA-Z.]+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(10);
    for (const k of new Set(keys)) {
      const n = i18n.split(`'${k}':`).length - 1;
      expect(n, `thiếu khoá ${k} ở một trong hai ngôn ngữ`).toBe(2);
    }
  });

  it('lời giải thích nói rõ đây không phải lỗi mạng và chat vẫn dùng bình thường (cả hai ngôn ngữ)', () => {
    expect(i18n).toMatch(/'remote\.queue\.why': '[^']*không phải lỗi mạng của bạn[^']*Chat vẫn dùng bình thường/);
    expect(i18n).toMatch(/'remote\.queue\.why': '[^']*not a problem with your network[^']*Chat works normally/);
  });
});
