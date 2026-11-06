/**
 * Dải «Trí nhớ sinh học» NGAY TRONG khung chat, phía trên ô nhập: Locaith-v5 dùng Bio-Memory-Locaith MẶC ĐỊNH nên host tự cài và bật nó ở lần đầu dùng model Locaith.
 * Dải chỉ hiện khi đang cài hoặc chưa bật được (kèm lý do, nút Thử lại / Ẩn); bật xong thì biến mất. «Ẩn» chỉ ẩn dải, KHÔNG dừng việc cài ngầm. Dùng lại kiểu dải của Remote (.rmt).
 */
import { useState } from 'preact/hooks';
import type { MemoryView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { Icon } from './Icons';

export function MemoryStrip({ memory }: { memory: MemoryView }) {
  const { t } = useApp();
  const installing = memory.state === 'installing';
  // Ẩn có tác dụng NGAY ở phía giao diện (không chờ host); host chỉ ghi nhớ để không hiện lại. Việc cài vẫn chạy ngầm.
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return (
    <div class="rmt" role="status" aria-live="polite" data-testid="memory-strip">
      <div class="rmt-row">
        <span class="rmt-ico" aria-hidden="true">
          {installing ? <LoSpinner size={14} /> : <Icon name="alert" size={14} />}
        </span>
        <div class="rmt-text">
          <b>{t(installing ? 'memory.installing.title' : 'memory.error.title')}</b>{' '}
          <span class="rmt-sub">{installing ? t('memory.installing.sub') : memory.message}</span>
        </div>
        <div class="rmt-actions">
          {!installing && (
            <button type="button" class="rmt-btn" onClick={() => post({ type: 'bio_auto_retry' })}>
              {t('memory.retry')}
            </button>
          )}
          <button
            type="button"
            class="rmt-btn is-ghost"
            onClick={() => {
              setGone(true);
              post({ type: 'bio_auto_hide' });
            }}
          >
            {t('memory.hide')}
          </button>
        </div>
      </div>
      {!installing && <div class="rmt-why">{t('memory.error.why')}</div>}
    </div>
  );
}
