import type { AttachmentInfo } from '../../../src/shared/protocol';
import { bus } from '../bus';
import { useApp } from '../ctx';
import { formatBytes } from '../format';
import { basename } from '../text';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icons';

/** Ảnh trong suốt 1×1: chỗ giữ khi chỉ có khoá ảnh và bản đầy đủ chưa về. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** "app.ts:12–20" cho vùng chọn, tên tệp cho tệp. */
export function attachmentText(a: AttachmentInfo): string {
  if (a.kind === 'selection' && a.path) {
    const base = basename(a.path);
    if (a.range) return a.range[0] === a.range[1] ? `${base}:${a.range[0]}` : `${base}:${a.range[0]}–${a.range[1]}`;
    return base;
  }
  return a.label || (a.path ? basename(a.path) : '');
}

export function AttachmentChip({ a, onRemove }: { a: AttachmentInfo; onRemove?: () => void }) {
  const { t, lang } = useApp();
  const text = attachmentText(a);
  const isImage = a.kind === 'image';
  // Ô nhập có đủ dữ liệu ảnh; tin đã gửi chỉ còn bản thu nhỏ (thumb) + khoá để xin bản đầy đủ từ lịch sử.
  const full = isImage && a.data && a.mediaType ? `data:${a.mediaType};base64,${a.data}` : null;
  const small = isImage && a.thumb ? `data:image/jpeg;base64,${a.thumb}` : null;
  const thumb = full ?? small;
  const previewable = isImage && (thumb !== null || !!a.imgKey);
  const openable = a.path && a.kind !== 'image' && a.kind !== 'tab' && a.kind !== 'doc';
  // Tệp tải lên: "12 trang · 340 KB · đã cắt bớt" (số trang/trang tính/hàng tuỳ loại tệp).
  const d = a.kind === 'doc' ? a.doc : undefined;
  const docBits = d
    ? [
        d.pages ? t('doc.pages', { n: d.pages }) : '',
        d.sheets ? t('doc.sheets', { n: d.sheets }) : '',
        d.rows ? t('doc.rows', { n: d.rows }) : '',
        d.truncated ? t('doc.truncated') : '',
        ...(d.notes ?? []),
      ].filter(Boolean)
    : [];
  const title = [a.path ?? text, a.sizeBytes ? formatBytes(a.sizeBytes, lang) : '', ...docBits].filter(Boolean).join(' · ');

  const preview = () => {
    bus.lightbox.emit({ src: thumb ?? BLANK, label: text, key: a.imgKey });
    if (!full && a.imgKey) post({ type: 'get_image', key: a.imgKey });
  };

  const body = (
    <>
      {thumb ? (
        <img class="chip-thumb" src={thumb} alt="" />
      ) : (
        <Icon name={a.kind === 'image' ? 'image' : a.kind === 'folder' ? 'folder' : a.kind === 'tab' ? 'globe' : 'file-text'} size={13} />
      )}
      <span class="chip-text">{text}</span>
      {d?.truncated && (
        <span class="chip-warn">
          <Icon name="alert" size={12} />
        </span>
      )}
    </>
  );

  return (
    <span class={cx('chip', `chip-${a.kind}`)} title={title}>
      {openable ? (
        <button type="button" class="chip-main" onClick={() => post({ type: 'open_file', path: a.path!, line: a.range?.[0] })}>
          {body}
        </button>
      ) : previewable ? (
        <button type="button" class="chip-main chip-zoom" title={t('chip.preview')} aria-label={`${t('chip.preview')}: ${text}`} onClick={preview}>
          {body}
        </button>
      ) : (
        <span class="chip-main">{body}</span>
      )}
      {onRemove && (
        <button type="button" class="chip-x" onClick={onRemove} aria-label={t('composer.removeAttachment', { name: text })}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}
