/**
 * Remote (điều khiển từ xa) NGAY TRONG khung chat của extension — không dùng thông báo hay thanh trạng thái của hệ thống VS Code.
 *  • RemoteStrip: dải gọn phía trên ô nhập khi relay QUÁ TẢI — nói rõ nguyên nhân, đếm ngược tới lần thử kế tiếp, «Thử ngay» / «Tắt Remote».
 *    Chat vẫn dùng bình thường trong lúc chờ. Đây là hàng chờ phía máy khách (đếm ngược tới lần thử kế tiếp), không bịa số thứ tự (xem src/core/remote/queue.ts).
 *  • RemoteCard: thẻ «Remote» trong Cài đặt — công tắc (BẬT SẴN cho người đã đăng nhập), trạng thái, ghép đôi / quản lý thiết bị.
 */
import { useEffect, useState } from 'preact/hooks';
import { fmtCountdown, QUEUE_MIN_RETRY_GAP_MS } from '../../../src/core/remote/queue';
import type { RemoteView } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import type { I18nKey } from '../i18n';
import { cx } from '../util';
import { post } from '../vscode';
import { LoSpinner } from './Brand';
import { Icon } from './Icons';
import { Button, Switch } from './ui';

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

export function RemoteStrip({ remote }: { remote: RemoteView }) {
  const { t } = useApp();
  const q = remote.relay === 'queued' ? remote.queue : undefined;
  const now = useNow(!!q, q?.retryAt);
  if (!q) return null;

  const left = q.retryAt - now;
  const trying = q.trying || left <= 0;
  const waited = now - (q.retryAt - q.waitMs);
  const progress = trying ? 1 : Math.min(1, Math.max(0, waited / q.waitMs));
  // «Thử ngay» chỉ mở sau khoảng tối thiểu kể từ lần thử trước (host cũng kiểm lại) — một nút bấm không được biến thành đòn dội vào relay đang quá tải.
  const canRetry = !trying && waited >= QUEUE_MIN_RETRY_GAP_MS;

  return (
    <div class="rmt" role="status" aria-live="polite" data-testid="remote-queue">
      <div class="rmt-row">
        <span class="rmt-ico" aria-hidden="true">
          {trying ? <LoSpinner size={14} /> : <Icon name="clock" size={14} />}
        </span>
        <div class="rmt-text">
          <b>{t('remote.queue.title')}</b>{' '}
          <span class="rmt-sub">{trying ? t('remote.queue.trying') : t('remote.queue.retryIn', { time: fmtCountdown(left), n: q.attempt })}</span>
        </div>
        <div class="rmt-actions">
          <button type="button" class="rmt-btn" disabled={!canRetry} onClick={() => post({ type: 'remote_retry' })}>
            {t('remote.queue.now')}
          </button>
          <button type="button" class="rmt-btn is-ghost" onClick={() => post({ type: 'remote_set_enabled', enabled: false })}>
            {t('remote.queue.off')}
          </button>
        </div>
      </div>
      <div class="rmt-why">{t('remote.queue.why')}</div>
      <div class="rmt-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}

const STATE_KEY: Record<RemoteView['relay'], I18nKey> = {
  off: 'remote.state.cloudOff',
  connecting: 'remote.state.connecting',
  online: 'remote.state.online',
  offline: 'remote.state.offline',
  queued: 'remote.state.queued',
};

/**
 * Công tắc Remote ngay trên thanh tiêu đề khung chat: MỘT cú bấm bật/tắt (không mã, không hộp thoại) kèm chấm trạng thái — xám = tắt, vàng = đang nối/xếp hàng/mất mạng,
 * xanh = đã nối relay. Bật rồi thì mở locaith.ai → «VS Code từ xa» (cùng tài khoản) là thấy máy này và vào được ngay (0.6.5, tin cậy theo tài khoản — không ghép đôi); khi tắt
 * `locaithAgent.remote.trustAccount` thì mỗi lần ghép đôi vẫn cần bạn bấm Cho phép trong VS Code.
 */
export function RemoteToggle({ remote }: { remote: RemoteView }) {
  const { t } = useApp();
  const on = remote.enabled;
  const tone = !on ? 'off' : remote.relay === 'online' ? 'ok' : remote.relay === 'off' ? 'off' : 'warn';
  const state = !on ? t('remote.state.off') : t(STATE_KEY[remote.relay]);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      class={cx('hdr-remote', on && 'is-on', `is-${tone}`)}
      title={t(on ? 'remote.toggle.titleOn' : 'remote.toggle.titleOff', { state })}
      onClick={() => post({ type: 'remote_set_enabled', enabled: !on })}
    >
      <Icon name="radio" size={14} />
      <span class="hdr-remote-label">{t('remote.toggle')}</span>
      <span class="hdr-remote-dot" aria-hidden="true" />
    </button>
  );
}

export function RemoteCard({ remote }: { remote: RemoteView }) {
  const { t } = useApp();
  const q = remote.relay === 'queued' ? remote.queue : undefined;
  const now = useNow(!!q, q?.retryAt);

  let state: string;
  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  if (!remote.enabled) state = t('remote.state.off');
  else {
    tone = remote.relay === 'online' ? 'ok' : remote.relay === 'off' ? 'muted' : 'warn';
    state = q ? (q.trying || q.retryAt - now <= 0 ? t('remote.state.queuedTrying') : t('remote.state.queued', { time: fmtCountdown(q.retryAt - now) })) : t(STATE_KEY[remote.relay]);
  }

  return (
    <section class="set-section rmc" aria-label={t('remote.set.title')} data-testid="remote-card">
      <div class="rmc-head">
        <h2 class="set-title">{t('remote.set.title')}</h2>
        <Switch checked={remote.enabled} label={t('remote.set.toggle')} onChange={(v) => post({ type: 'remote_set_enabled', enabled: v })} />
      </div>
      <div class={`rmc-state is-${tone}`}>
        <span class="rmc-dot" aria-hidden="true" />
        {state}
      </div>
      {remote.enabled && (remote.devices > 0 || remote.streams > 0) && <div class="rmc-meta">{t('remote.set.devices', { n: remote.devices, s: remote.streams })}</div>}
      <div class="acct-actions rmc-actions">
        {remote.trust ? (
          // Tin cậy theo tài khoản: một nút mở thẳng locaith.ai (trang tự vào máy này nhờ cùng tài khoản) — không còn bước ghép đôi.
          <Button small variant="secondary" onClick={() => post({ type: 'remote_open' })}>
            {t('remote.set.open')}
          </Button>
        ) : (
          <Button small variant="secondary" onClick={() => post({ type: 'remote_pair' })}>
            {t('remote.set.pair')}
          </Button>
        )}
        {(remote.devices > 0 || remote.trust) && (
          <Button small variant="ghost" onClick={() => post({ type: 'remote_manage' })}>
            {t('remote.set.manage')}
          </Button>
        )}
      </div>
      <p class="set-hint">{t(remote.trust ? 'remote.set.hintTrust' : 'remote.set.hint')}</p>
    </section>
  );
}
