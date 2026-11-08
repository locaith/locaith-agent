/**
 * (0.6.3) Xem trước kết quả ngay dưới khối câu trả lời nhắc tới (markdown/mediaRefs.ts):
 *  - ảnh / GIF hiện thẳng (bấm để phóng to), nhiều ảnh xếp lưới;
 *  - video và âm thanh có trình phát (định dạng khung chat không phát được thì đổi sang thẻ mở bằng ứng dụng khác);
 *  - HTML / PDF / Word / Excel / PowerPoint là thẻ một dòng có nút mở.
 * Host xác nhận từng đường dẫn (`resolve_media`): tệp không có thật, nằm ngoài vùng xem hoặc bị từ chối thì không hiện gì — không bao giờ có
 * khung trống hay thông báo lỗi chỉ vì câu trả lời nhắc tới một tệp chưa tồn tại.
 */
import { useEffect, useState } from 'preact/hooks';
import type { MediaItem } from '../../../../src/shared/protocol';
import { bus } from '../../bus';
import { useApp } from '../../ctx';
import { formatBytes } from '../../format';
import type { I18nKey } from '../../i18n';
import type { MediaRef } from '../../markdown/mediaRefs';
import { cx } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import type { IconName } from '../../iconNames';

let seq = 0;
/** Kết quả gần nhất theo đường dẫn: dựng lại (mở/đóng nhóm quá trình, đổi màn hình) thì hiện ngay, không nháy. */
const cache = new Map<string, MediaItem>();

const open = (it: MediaItem, how: 'editor' | 'external' | 'reveal') => {
  if (it.abs) post({ type: 'open_media', path: it.abs, how });
};

function dedupe(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (!it.ok || !it.abs) return false;
    const k = it.abs.replace(/\\/g, '/').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function IconBtn({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" class="media-btn" title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  );
}

function Caption({ item, actions }: { item: MediaItem; actions: ('editor' | 'external' | 'reveal')[] }) {
  const { t, lang } = useApp();
  const label: Record<'editor' | 'external' | 'reveal', [IconName, I18nKey]> = {
    editor: ['external', 'media.open'],
    external: ['play', 'media.external'],
    reveal: ['folder', 'media.reveal'],
  };
  return (
    <figcaption class="media-cap">
      <span class="media-name" title={item.abs}>
        {item.name}
      </span>
      {typeof item.size === 'number' && <span class="media-size">{formatBytes(item.size, lang)}</span>}
      <span class="media-acts">
        {actions.map((a) => (
          <IconBtn key={a} icon={label[a][0]} label={t(label[a][1])} onClick={() => open(item, a)} />
        ))}
      </span>
    </figcaption>
  );
}

function ImageTile({ item }: { item: MediaItem }) {
  const { t } = useApp();
  return (
    <figure class="media-tile media-image">
      <button
        type="button"
        class="media-thumb"
        title={t('media.zoom')}
        aria-label={`${t('media.zoom')}: ${item.name}`}
        onClick={() => bus.lightbox.emit({ src: item.src!, label: item.name ?? '', mediaPath: item.abs })}
      >
        <img src={item.src} alt={item.name} loading="lazy" decoding="async" />
      </button>
      <Caption item={item} actions={['editor', 'reveal']} />
    </figure>
  );
}

function PlayerTile({ item }: { item: MediaItem }) {
  const { t } = useApp();
  const [failed, setFailed] = useState(false);
  if (failed) return <FileCard item={item} note={t('media.cantPlay')} />;
  const video = item.kind === 'video';
  return (
    <figure class={cx('media-tile', video ? 'media-video' : 'media-audio')}>
      {video ? (
        <video class="media-player" src={item.src} controls preload="metadata" playsInline aria-label={item.name} onError={() => setFailed(true)} />
      ) : (
        <div class="media-audio-row">
          <span class="media-audio-icon">
            <Icon name="music" size={16} />
          </span>
          <audio class="media-player" src={item.src} controls preload="metadata" aria-label={item.name} onError={() => setFailed(true)} />
        </div>
      )}
      <Caption item={item} actions={['editor', 'external', 'reveal']} />
    </figure>
  );
}

const DOC_ICON: Record<string, IconName> = { html: 'globe', htm: 'globe', pdf: 'file-text', docx: 'file-text', xlsx: 'layout', pptx: 'layout' };

function FileCard({ item, note }: { item: MediaItem; note?: string }) {
  const { t, lang } = useApp();
  const ext = (item.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  const html = ext === 'html' || ext === 'htm';
  const icon: IconName = item.kind === 'video' ? 'film' : item.kind === 'audio' ? 'music' : item.kind === 'image' ? 'image' : DOC_ICON[ext] ?? 'file';
  return (
    <div class="media-file">
      <span class="media-file-icon">
        <Icon name={icon} size={16} />
      </span>
      <span class="media-file-info">
        <span class="media-name" title={item.abs}>
          {item.name}
        </span>
        <span class="media-file-sub">
          {ext.toUpperCase()}
          {typeof item.size === 'number' ? ` · ${formatBytes(item.size, lang)}` : ''}
          {note ? ` · ${note}` : ''}
        </span>
      </span>
      <span class="media-acts">
        <IconBtn icon={html ? 'globe' : 'play'} label={t(html ? 'media.browser' : 'media.external')} onClick={() => open(item, 'external')} />
        {(html || item.kind !== 'doc') && <IconBtn icon={html ? 'file-text' : 'external'} label={t(html ? 'media.source' : 'media.open')} onClick={() => open(item, 'editor')} />}
        <IconBtn icon="folder" label={t('media.reveal')} onClick={() => open(item, 'reveal')} />
      </span>
    </div>
  );
}

export function MediaPreviews({ refs }: { refs: readonly { path: MediaRef['path'] }[] }) {
  const { t, settings } = useApp();
  // (0.7.2) Chế độ nhẹ: không tự dò/nạp ảnh-video-âm thanh; chỉ nạp khi người dùng bấm «Xem trước».
  const [manual, setManual] = useState(false);
  const auto = !settings.liteMode || manual;
  const sig = refs.map((r) => r.path).join('\n');
  const [items, setItems] = useState<MediaItem[]>(() => dedupe(refs.map((r) => cache.get(r.path)).filter((x): x is MediaItem => !!x)));

  useEffect(() => {
    if (!sig || !auto) return;
    const key = `media-${++seq}`;
    const off = bus.mediaResolved.on((r) => {
      if (r.key !== key) return;
      if (cache.size > 600) cache.clear();
      for (const it of r.items) if (it && typeof it.path === 'string') cache.set(it.path, it);
      setItems(dedupe(r.items));
    });
    post({ type: 'resolve_media', key, paths: sig.split('\n') });
    return off;
  }, [sig, auto]);

  if (!auto && !items.length) {
    return (
      <div class="media" role="group" aria-label={t('media.region')}>
        <button type="button" class="link-btn media-lite" onClick={() => setManual(true)}>
          {t('media.lite.show')}
        </button>
      </div>
    );
  }
  if (!items.length) return null;
  const images = items.filter((i) => i.kind === 'image' && i.src);
  const players = items.filter((i) => (i.kind === 'video' || i.kind === 'audio') && i.src);
  const files = items.filter((i) => !images.includes(i) && !players.includes(i));
  return (
    <div class="media" role="group" aria-label={t('media.region')}>
      {images.length > 0 && (
        <div class={cx('media-images', images.length > 1 && 'is-grid')} style={images.length > 1 ? `--n:${images.length}` : undefined}>
          {images.map((it) => (
            <ImageTile key={it.abs} item={it} />
          ))}
        </div>
      )}
      {players.map((it) => (
        <PlayerTile key={it.abs} item={it} />
      ))}
      {files.map((it) => (
        <FileCard key={it.abs} item={it} note={it.kind !== 'doc' ? t('media.noInline') : undefined} />
      ))}
    </div>
  );
}
