/**
 * Hàng chờ của mô hình Locaith NGAY TRONG khung chat — không dùng thông báo hay thanh trạng thái của hệ thống VS Code.
 * Khi hơn 100 người dùng cùng lúc, cổng Locaith xếp bạn vào hàng: dải này nói rõ nguyên nhân («Đang có nhiều lượt sử dụng, vui lòng chờ xử lý»), vị trí THẬT cổng báo
 * và đếm ngược từng giây tới lần tự hỏi lại; bấm «Hủy» là dừng (rời hàng). Vào được là dải biến mất và câu trả lời chạy như thường.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ModelQueueView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { queueProgress, secondsLeft } from '../queueMath';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { Icon } from './Icons';

/** Đồng hồ mỗi giây khi `active` (đếm ngược); không chạy khi không cần. */
function useNow(active: boolean, key: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, key]);
  return now;
}

export function ModelQueueStrip({ queue }: { queue: ModelQueueView }) {
  const { t } = useApp();
  const now = useNow(true, queue.retryAt);
  const left = secondsLeft(queue.retryAt, now);
  const trying = left <= 0;
  const progress = queueProgress(queue.retryAt, queue.waitMs, now);

  return (
    <div class="mq" data-testid="model-queue">
      <div class="mq-row">
        <span class="mq-ico" aria-hidden="true">
          {trying ? <LoSpinner size={14} /> : <Icon name="clock" size={14} />}
        </span>
        <div class="mq-text">
          {/* Chỉ phần này là vùng thông báo: đổi khi VỊ TRÍ đổi, không đọc lại mỗi giây. */}
          <span role="status" aria-live="polite">
            <b>{t('locaith.queue.title')}</b> {t('locaith.queue.position', { pos: queue.position })}
          </span>
          <span class="mq-sub" aria-hidden="true">
            {' · '}
            {trying ? t('locaith.queue.trying') : t('locaith.queue.retryIn', { s: left })}
          </span>
        </div>
        <div class="mq-actions">
          <button type="button" class="mq-btn" onClick={() => post({ type: 'stop' })}>
            {t('locaith.queue.cancel')}
          </button>
        </div>
      </div>
      <div class="mq-why">{queue.limit ? t('locaith.queue.whyLimit', { n: queue.limit }) : t('locaith.queue.why')}</div>
      <div class="mq-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
