/**
 * Thẻ «Trước | Sau» (lane:customer-bugs) cho công cụ `show_before_after`: hai ảnh cạnh nhau (khung hẹp tự xếp dọc), bấm để phóng to,
 * hoặc chuyển sang chế độ trượt để kéo thanh so sánh. Nguồn ảnh: `block.images` (hai ảnh do công cụ gửi lên); phiên đã đóng/mở lại thì
 * ảnh không còn trong bộ nhớ — bản VS Code hỏi lại host qua `resolve_media` bằng đường dẫn còn lưu trong đối số.
 */
import { useEffect, useState } from 'preact/hooks';
import type { MediaItem, ToolBlock } from '../../../../src/shared/protocol';
import { bus } from '../../bus';
import { useApp } from '../../ctx';
import { beforeAfterModel, type BeforeAfterModel } from '../../beforeAfterModel';
import { cx } from '../../util';
import { post } from '../../vscode';

let seq = 0;

/** Hai địa chỉ ảnh: ưu tiên ảnh đã gửi lên, nếu không có (phiên cũ) thì nhờ host tra theo đường dẫn. */
function useSources(block: ToolBlock, m: BeforeAfterModel): [string, string] | null {
  const { platform } = useApp();
  const live = block.images && block.images.length >= 2 ? block.images : null;
  const [resolved, setResolved] = useState<[string, string] | null>(null);
  const want = !live && platform === 'vscode' && block.state === 'done';

  useEffect(() => {
    if (!want) return;
    const key = `ba-${++seq}`;
    const off = bus.mediaResolved.on((r) => {
      if (r.key !== key) return;
      const [b, a] = r.items as MediaItem[];
      if (b?.ok && b.kind === 'image' && b.src && a?.ok && a.kind === 'image' && a.src) setResolved([b.src, a.src]);
    });
    post({ type: 'resolve_media', key, paths: [m.before, m.after] });
    return off;
  }, [want, m.before, m.after]);

  if (live) return [`data:${live[0].mediaType};base64,${live[0].data}`, `data:${live[1].mediaType};base64,${live[1].data}`];
  return resolved;
}

export function BeforeAfter({ block }: { block: ToolBlock }) {
  const { t } = useApp();
  const m = beforeAfterModel(block.args);
  const [slide, setSlide] = useState(false);
  const [pos, setPos] = useState(50);
  const srcs = useSources(block, m ?? { before: '', after: '' });
  if (!m || !srcs) return null;

  const lb = m.labelBefore ?? t('ba.before');
  const la = m.labelAfter ?? t('ba.after');
  const zoom = (src: string, label: string) => bus.lightbox.emit({ src, label });

  return (
    <div class="ba" role="group" aria-label={m.caption ?? t('ba.region')}>
      <div class="ba-bar">
        <span class="ba-title">{m.caption ?? t('ba.region')}</span>
        <button type="button" class="ba-mode" aria-pressed={slide} onClick={() => setSlide((v) => !v)}>
          {slide ? t('ba.sideBySide') : t('ba.slide')}
        </button>
      </div>
      {slide ? (
        <div class="ba-slider" style={`--pos:${pos}%`}>
          <img class="ba-img" src={srcs[0]} alt={lb} draggable={false} />
          <img class="ba-img ba-over" src={srcs[1]} alt={la} draggable={false} />
          <span class="ba-tag ba-tag-l">{lb}</span>
          <span class="ba-tag ba-tag-r is-after">{la}</span>
          <input
            class="ba-range"
            type="range"
            min={0}
            max={100}
            value={pos}
            aria-label={t('ba.slideAria', { a: lb, b: la })}
            onInput={(e) => setPos(Number((e.currentTarget as HTMLInputElement).value))}
          />
        </div>
      ) : (
        <div class="ba-grid">
          {([[lb, srcs[0], false], [la, srcs[1], true]] as const).map(([label, src, after]) => (
            <figure key={after ? 'a' : 'b'} class="ba-pane">
              <button type="button" class="ba-zoom" title={t('ba.zoom')} aria-label={`${t('ba.zoom')}: ${label}`} onClick={() => zoom(src, label)}>
                <img class="ba-img" src={src} alt={label} loading="lazy" decoding="async" />
              </button>
              <figcaption class={cx('ba-tag', after && 'is-after')}>{label}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
