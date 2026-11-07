import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';

/** Lời cảm ơn tự đóng sau chừng này (ms) nếu người dùng không gõ nhận xét; gửi nhận xét xong thì đóng sớm hơn. */
const THANKS_MS = 9000;
const THANKS_AFTER_COMMENT_MS = 2500;
const COMMENT_MAX = 500;

/**
 * Lời mời đánh giá (bản trình duyệt) — một dải gọn, hiện MỘT lần sau khi người dùng đã gửi vài tin.
 *
 * Chạm một ngôi sao = GỬI NGAY về Locaith (như nút 👍/👎 của Claude): không mở trang nào, không bắt viết gì. Dải chuyển sang lời cảm ơn
 * (báo «đã gửi» hoặc «sẽ gửi khi có mạng»); chỉ SAU đó mới có ô nhận xét tuỳ chọn, và — với 4–5 sao — nút riêng để đánh giá thêm
 * công khai trên Chrome Web Store. Bấm X = tắt hẳn, không hỏi lại. Không khoá tính năng — đúng chính sách của Chrome Web Store.
 */
export function RatingStrip({ sends, picked, sent }: { sends: number; picked?: number; sent?: boolean }) {
  const { t } = useApp();
  /** Sao đang rê chuột — chỉ để phản hồi thị giác. */
  const [hover, setHover] = useState(0);
  const [text, setText] = useState('');
  const [commentSent, setCommentSent] = useState(false);
  /** Người dùng đang gõ nhận xét → không tự đóng lời cảm ơn giữa chừng. */
  const typing = useRef(false);
  const thanks = picked !== undefined;

  useEffect(() => {
    if (!thanks) return;
    const id = window.setTimeout(() => {
      if (!typing.current) post({ type: 'rating_close' });
    }, commentSent ? THANKS_AFTER_COMMENT_MS : THANKS_MS);
    return () => window.clearTimeout(id);
  }, [thanks, commentSent]);

  if (thanks) {
    const stars = picked ?? 0;
    const submit = (e: Event) => {
      e.preventDefault();
      const v = text.trim();
      if (!v) return;
      post({ type: 'rating_comment', text: v });
      typing.current = false;
      setCommentSent(true);
    };
    return (
      <div class="rmt rate is-thanks" role="status" data-testid="rating-thanks">
        <div class="rmt-row">
          <span class="rmt-ico" aria-hidden="true">
            <Icon name="check" size={15} />
          </span>
          <div class="rmt-text">
            <b>{t(sent ? 'rating.thanks' : 'rating.queued', { n: stars })}</b>
          </div>
          <div class="rmt-actions">
            <button type="button" class="icon-btn" onClick={() => post({ type: 'rating_close' })} title={t('rating.close')} aria-label={t('rating.close')}>
              <Icon name="x" size={13} />
            </button>
          </div>
        </div>
        {commentSent ? (
          <div class="rate-note">{t('rating.comment.sent')}</div>
        ) : (
          <form class="rate-comment" onSubmit={submit}>
            <input
              type="text"
              class="rate-input"
              maxLength={COMMENT_MAX}
              value={text}
              placeholder={t(stars <= 3 ? 'rating.comment.ph.low' : 'rating.comment.ph')}
              aria-label={t(stars <= 3 ? 'rating.comment.ph.low' : 'rating.comment.ph')}
              onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
              onFocus={() => (typing.current = true)}
              onBlur={() => (typing.current = text.trim().length > 0)}
            />
            <button type="submit" class="rmt-btn" disabled={!text.trim()}>
              {t('rating.comment.send')}
            </button>
          </form>
        )}
        {stars >= 4 && (
          <button type="button" class="link-btn rate-store" onClick={() => post({ type: 'rating_rate' })}>
            {t('rating.store')}
          </button>
        )}
      </div>
    );
  }

  const stars = [1, 2, 3, 4, 5];
  return (
    <div class="rmt rate" role="status" data-testid="rating-strip">
      <div class="rmt-row">
        <span class="rmt-ico" aria-hidden="true">
          <Icon name="sparkle" size={15} />
        </span>
        <div class="rmt-text">
          <b>{t('rating.title')}</b> <span class="rmt-sub">{t('rating.sub', { n: sends })}</span>
        </div>
        <div class="rmt-actions">
          <button type="button" class="icon-btn" onClick={() => post({ type: 'rating_dismiss' })} title={t('rating.dismiss')} aria-label={t('rating.dismiss')}>
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div class="rate-stars" role="group" aria-label={t('rating.stars')} onMouseLeave={() => setHover(0)}>
        {stars.map((n) => (
          <button
            key={n}
            type="button"
            class={n <= hover ? 'rate-star is-on' : 'rate-star'}
            title={t('rating.star', { n })}
            aria-label={t('rating.star', { n })}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onClick={() => post({ type: 'rating_submit', stars: n })}
          >
            ★
          </button>
        ))}
        <span class="rate-hint">{t('rating.hint')}</span>
      </div>
    </div>
  );
}
