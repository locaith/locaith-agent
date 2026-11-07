import { useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';

/**
 * Lời mời đánh giá trên Chrome Web Store — một dải gọn, hiện MỘT lần sau khi người dùng đã gửi vài tin.
 *
 * Bấm một ngôi sao (hoặc «Đánh giá ngay») = mở thẳng trang đánh giá của tiện ích; bấm X = tắt hẳn.
 * Không khoá tính năng, không hỏi lại sau khi đã tắt — đúng chính sách của Chrome Web Store.
 */
export function RatingStrip({ sends }: { sends: number }) {
  const { t } = useApp();
  /** Sao đang rê/đã chọn — chỉ để phản hồi thị giác trước khi mở trang đánh giá. */
  const [hover, setHover] = useState(0);
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
          <button type="button" class="rmt-btn" onClick={() => post({ type: 'rating_rate' })}>
            {t('rating.cta')}
          </button>
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
            onClick={() => post({ type: 'rating_rate' })}
          >
            ★
          </button>
        ))}
        <span class="rate-hint">{t('rating.hint')}</span>
      </div>
    </div>
  );
}
