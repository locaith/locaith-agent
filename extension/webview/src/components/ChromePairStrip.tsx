/**
 * Thẻ «Chrome muốn kết nối với VS Code» NGAY TRONG khung chat, phía trên ô nhập: ghép đôi KHÔNG MÃ. Người dùng bật công tắc «VS Code» trong khung chat của extension Chrome,
 * extension xin kết nối qua cổng cục bộ, VS Code hiện thẻ này; bấm Cho phép là xong (không gõ mã, không mở trang cầu nối). Mỗi trang web vẫn cần duyệt ngay trong Chrome.
 * Thẻ tự ẩn khi yêu cầu hết hạn (2 phút). Dùng lại kiểu dải của Remote (.rmt).
 */
import { useEffect, useState } from 'preact/hooks';
import type { ChromePairView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';

export function ChromePairStrip({ pair }: { pair: ChromePairView }) {
  const { t } = useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pair.id]);
  if (pair.expiresAt <= now) return null;
  const tail = pair.extensionId.slice(-6);
  return (
    <div class="rmt" role="alert" data-testid="chrome-pair">
      <div class="rmt-row">
        <span class="rmt-ico" aria-hidden="true">
          <Icon name="globe" size={14} />
        </span>
        <div class="rmt-text">
          <b>{t('chromePair.title')}</b> <span class="rmt-sub">{t('chromePair.ext', { tail })}</span>
        </div>
        <div class="rmt-actions">
          <button type="button" class="rmt-btn" onClick={() => post({ type: 'chrome_pair_allow', id: pair.id })}>
            {t('chromePair.allow')}
          </button>
          <button type="button" class="rmt-btn is-ghost" onClick={() => post({ type: 'chrome_pair_deny', id: pair.id })}>
            {t('chromePair.deny')}
          </button>
        </div>
      </div>
      <div class="rmt-why">{pair.rePair ? `${t('chromePair.rePair')} ${t('chromePair.why')}` : t('chromePair.why')}</div>
    </div>
  );
}
