import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (0.6.2) Kéo khung (sidebar, tab, cửa sổ phụ) rộng hết cỡ thì nội dung phải GIÃN THEO. Trước đây cột nội dung bị chặn ở 1000px và chỉ chiếm 58% khung
 * (clamp(720px, 58cqw, 1000px)) — ở khung 1800px hai bên trống trơn ~400px. Giờ mọi màn dùng chung lề tỉ lệ `clamp(14px, 3cqw, 48px)`.
 * Ảnh trước/sau: _work/shots/wide-before, _work/shots/wide-after (1800px, 2560px, 640px, 380px).
 */
const W = path.resolve(__dirname, '../../webview/src/styles');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');
const css = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ''); // bỏ chú thích (chú thích được nhắc tới công thức cũ)

describe('bố cục ở khung rộng: nội dung lấp đầy bề rộng', () => {
  it('không còn trần cột nội dung cố định ở bất kỳ tệp CSS nào', () => {
    for (const f of fs.readdirSync(W).filter((n) => n.endsWith('.css'))) {
      const t = css(f);
      expect(t, f).not.toMatch(/clamp\(\s*720px/);
      expect(t, f).not.toMatch(/100%\s*-\s*760px/);
      expect(t, f).not.toMatch(/100%\s*-\s*var\(--col\)/);
    }
  });

  it('dòng thời gian, các màn (Cài đặt/Lịch sử/Chợ) và ô nhập dùng cùng lề tỉ lệ 3% (14–48px)', () => {
    const r = css('responsive.css');
    expect(r).toMatch(/\.timeline-inner,\s*\.screen\s*\{\s*--gutter:\s*clamp\(14px,\s*3cqw,\s*48px\);\s*padding-left:\s*var\(--gutter\);\s*padding-right:\s*var\(--gutter\);/);
    expect(r).toMatch(/\.app-foot\s*\{\s*--gutter:\s*clamp\(12px,\s*3cqw,\s*48px\);\s*padding-left:\s*var\(--gutter\);\s*padding-right:\s*var\(--gutter\);/);
    expect(css('market.css')).toMatch(/--mk-x:\s*clamp\(14px,\s*3cqw,\s*48px\)/);
  });

  it('đoạn chào của model Locaith không còn bị bó 46ch trong khi đoạn bên trên giãn hết khung', () => {
    const block = /\.welcome-locaith\s*\{([^}]*)\}/.exec(css('locaith.css'))?.[1] ?? '';
    expect(block).not.toMatch(/max-width/);
  });
});
