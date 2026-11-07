/**
 * Biểu tượng của bản Chrome / Edge phải là logo «Lo» của Locaith.
 *
 * Lý do có test này: bản 0.6.27 đưa lên Chrome Web Store mang biểu tượng chữ «N» của dự án cũ (thanh công cụ và thông báo «đã được thêm vào Chrome» hiện «N»),
 * trong khi ảnh ở trang cửa hàng là «Lo». Không ai kiểm biểu tượng TRONG gói. Nay băm SHA-256 của bốn biểu tượng nằm trong `scripts/browser-brand-icons.json`;
 * đổi logo thì phải sửa tệp đó có chủ đích. `scripts/pack-browser.mjs` đối chiếu lại lần nữa trên chính thư mục sắp nén.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const SIZES = [16, 32, 48, 128] as const;
const brand = JSON.parse(readFileSync(path.join(root, 'scripts/browser-brand-icons.json'), 'utf8')) as { icons: Record<string, string> };
const iconPath = (sz: number): string => path.join(root, 'src/browser/static/icons', `${sz}.png`);

describe('biểu tượng bản trình duyệt = logo Lo', () => {
  it('danh sách băm có đủ bốn cỡ', () => {
    expect(Object.keys(brand.icons).sort((a, b) => Number(a) - Number(b))).toEqual(SIZES.map(String));
  });

  for (const sz of SIZES) {
    it(`${sz}px: PNG RGBA đúng cỡ và đúng băm logo Lo`, () => {
      const b = readFileSync(iconPath(sz));
      expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([sz, sz]);
      expect(b[25]).toBe(6); // RGBA: nền trong suốt như logo trên cửa hàng
      expect(createHash('sha256').update(b).digest('hex')).toBe(brand.icons[String(sz)]);
    });
  }

  it('manifest của bản build trỏ đúng bốn tệp này (không có đường dẫn biểu tượng nào khác)', () => {
    const src = readFileSync(path.join(root, 'esbuild.browser.mjs'), 'utf8');
    expect(src).toContain("icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' }");
    expect(src).toContain("default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' }");
  });
});
