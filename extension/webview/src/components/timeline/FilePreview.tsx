/**
 * (lane:cc-timeline-ui) Khung xem trước nội dung tệp vừa ghi (Write): 3–4 dòng đầu, tô màu cú pháp nhẹ, mờ dần ở đáy;
 * bấm để xem đủ (tối đa PREVIEW_MAX_LINES dòng — đủ để đọc, không kéo cả tệp lớn vào DOM), có nút Thu gọn ở cuối.
 */
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../../ctx';
import { highlight } from '../../markdown/highlight';
import { firstLines, langOfPath } from '../../timelineCc';
import { cx } from '../../util';
import { CollapseFoot } from './CollapseFoot';

export const PREVIEW_LINES = 4;
export const PREVIEW_MAX_LINES = 400;

export function FilePreview({ content, path }: { content: string; path: string }) {
  const { t } = useApp();
  const [full, setFull] = useState(false);
  const lang = useMemo(() => langOfPath(path), [path]);
  const { lines, more } = useMemo(() => firstLines(content, full ? PREVIEW_MAX_LINES : PREVIEW_LINES), [content, full]);
  const code = lines.join('\n');
  const html = useMemo(() => (code ? highlight(code, lang) : null), [code, lang]);
  if (!content.trim()) return null;
  const total = lines.length + more;
  return (
    <div class={cx('cc-preview', !full && more > 0 && 'is-clamped')}>
      {html ? <pre class="cc-preview-pre" dangerouslySetInnerHTML={{ __html: html }} /> : <pre class="cc-preview-pre">{code}</pre>}
      {!full && more > 0 && (
        <button type="button" class="cc-preview-more" onClick={() => setFull(true)} title={t('cc.showAllLines', { n: total })} aria-label={t('cc.showAllLines', { n: total })} />
      )}
      {full && <CollapseFoot onCollapse={() => setFull(false)} label={t('tool.showLess')} />}
    </div>
  );
}
