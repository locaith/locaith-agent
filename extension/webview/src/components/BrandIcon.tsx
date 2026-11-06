/**
 * Ô logo thương hiệu (28/36/44 px) cho các dòng dịch vụ MCP, plugin và nguồn kỹ năng — kiểu thư mục ứng dụng của ChatGPT / Claude.
 *  - Logo màu: glyph màu hãng trên nền nhuộm nhẹ; màu glyph tự pha sáng/tối theo theme để luôn đủ tương phản.
 *  - Logo đơn sắc (GitHub, Notion, Vercel…): ô trung tính, glyph theo màu chữ của theme.
 *  - Logo nhiều màu (Google, Microsoft, Figma, AWS…): giữ nguyên màu trên ô trung tính.
 *  - Không có logo: monogram 1–2 chữ, sắc độ cố định theo tên, cùng kích thước để các dòng luôn thẳng hàng.
 * SVG chỉ dựng từ kho đã kiểm duyệt (brand/logos.ts), không bao giờ từ chuỗi nhận qua mạng; không có ảnh từ xa.
 */
import { useMemo } from 'preact/hooks';
import { brandFor, inkFor, monogram, onSolid, type BrandQuery } from '../brand/logos';
import { cx } from '../util';

export type BrandIconSize = 28 | 36 | 44;

/** Cỡ glyph (px nguyên) để tâm rơi đúng điểm ảnh: (ô − 2 viền − glyph) chia hết cho 2. */
const GLYPH: Record<BrandIconSize, number> = { 28: 16, 36: 20, 44: 26 };

export interface BrandIconProps extends BrandQuery {
  /** Nhãn dùng cho monogram khi không có logo (mặc định: name → vendor → id). */
  label?: string;
  size?: BrandIconSize;
  class?: string;
}

export function BrandIcon({ id, name, vendor, origin, url, label, size = 36, class: klass }: BrandIconProps) {
  const match = useMemo(() => brandFor({ id, name, vendor, origin, url }), [id, name, vendor, origin, url]);
  const style = useMemo(() => {
    if (!match) return undefined;
    const { c, tone } = match.logo;
    if (tone === 'color') {
      return { '--bi-c': c, '--bi-ink-d': inkFor(c, 'dark'), '--bi-ink-l': inkFor(c, 'light'), '--bi-ink-hcd': inkFor(c, 'hcDark'), '--bi-ink-hcl': inkFor(c, 'hcLight') };
    }
    if (tone === 'solid') return { '--bi-c': c, '--bi-on': onSolid(c) };
    return { '--bi-c': c };
  }, [match]);

  if (!match) {
    const m = monogram(label ?? name ?? vendor ?? id ?? '?');
    return (
      <span class={cx('bi', `bi-${size}`, 'bi-t-gram', klass)} style={{ '--bi-h': String(m.hue) }} aria-hidden="true">
        <span class={cx('bi-gram', m.text.length > 1 && 'is-two')}>{m.text}</span>
      </span>
    );
  }

  const { logo } = match;
  const px = GLYPH[size];
  const fillOf = (f?: string): string => (logo.tone === 'multi' ? (f ?? 'currentColor') : logo.tone === 'locaith' ? 'url(#lo-g)' : 'currentColor');
  return (
    <span class={cx('bi', `bi-${size}`, `bi-t-${logo.tone}`, klass)} style={style} data-brand={match.key} aria-hidden="true">
      <svg width={px} height={px} viewBox={logo.vb} focusable="false" aria-hidden="true">
        {logo.l.map((l, i) => (
          <path key={i} d={l.d} fill={fillOf(l.fill)} fill-rule={l.evenodd ? 'evenodd' : undefined} clip-rule={l.evenodd ? 'evenodd' : undefined} opacity={l.opacity} />
        ))}
      </svg>
    </span>
  );
}
