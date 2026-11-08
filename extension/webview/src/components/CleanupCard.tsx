import { useEffect, useRef, useState } from 'preact/hooks';
import type { CleanupStatsView } from '../../../src/shared/protocol';
import { bus } from '../bus';
import { useApp } from '../ctx';
import { CLEANUP_ROWS, parseDays, rowFigure } from '../cleanupModel';
import { formatBytes, formatInt } from '../format';
import { post } from '../vscode';
import { Button, Spinner } from './ui';

/**
 * (0.7.2) Thẻ «Dọn dẹp bộ nhớ» (Cài đặt, chỉ bản VS Code). Hiện dung lượng phiên / Thùng rác / điểm quay lại / số ảnh; mỗi nút gửi `cleanup_run`
 * và HOST hỏi xác nhận (modal) có ghi rõ dung lượng sẽ giải phóng. Lệnh `locaithAgent.cleanup` mở màn Cài đặt rồi cuộn tới thẻ này.
 */
export function CleanupCard() {
  const { t, lang } = useApp();
  const root = useRef<HTMLElement>(null);
  const [stats, setStats] = useState<CleanupStatsView | undefined>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState<Record<string, string>>({});

  useEffect(() => {
    const off = bus.cleanupStats.on((m) => {
      if (m.stats) {
        setStats(m.stats);
        setError('');
        setBusy(false);
      } else if (m.error) {
        setError(m.error);
        setBusy(false);
      } else if (m.busy) setBusy(true);
    });
    const off2 = bus.focusSection.on((s) => {
      if (s === 'cleanup') root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    post({ type: 'cleanup_stats' });
    return () => {
      off();
      off2();
    };
  }, []);

  const figure = (n: { count: number; bytes: number } | null, noun: 'sessions' | 'images' | 'trash' | 'checkpoints'): string => {
    if (!n) return '…';
    return `${formatInt(n.count, lang)} ${t(`cleanup.unit.${noun}` as const)} · ${formatBytes(n.bytes, lang)}`;
  };

  return (
    <section class="set-section cleanup-card" ref={root} id="cleanup" aria-label={t('cleanup.title')}>
      <h2 class="set-title">{t('cleanup.title')}</h2>
      <p class="set-hint">{t('cleanup.hint')}</p>
      {error && <p class="cleanup-error" role="alert">{error}</p>}
      <div class="cleanup-total">
        <span>{t('cleanup.total')}</span>
        <strong>{stats ? formatBytes(stats.sessions.bytes + stats.trash.bytes + stats.checkpoints.bytes, lang) : '…'}</strong>
        {busy && <Spinner size={13} />}
        <span class="cleanup-spacer" />
        <Button small icon="refresh" disabled={busy} onClick={() => post({ type: 'cleanup_stats' })}>
          {t('cleanup.refresh')}
        </Button>
      </div>
      {CLEANUP_ROWS.map((r) => {
        const fig = rowFigure(r.action, stats);
        const val = days[r.action] ?? String(r.defaultDays);
        return (
          <div class="cleanup-row" key={r.action}>
            <div class="cleanup-info">
              <div class="cleanup-label">
                {r.days ? t(r.label, { n: parseDays(val, r.defaultDays) }) : t(r.label)}
              </div>
              <div class="cleanup-figure">
                {figure(fig, r.action === 'images' ? 'images' : r.action === 'sessions' ? 'sessions' : r.action === 'trash' ? 'trash' : 'checkpoints')}
              </div>
              <div class="cleanup-hint">{t(r.hint)}</div>
            </div>
            <div class="cleanup-act">
              {r.days && (
                <label class="cleanup-days">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={val}
                    aria-label={t('cleanup.days')}
                    onInput={(e) => setDays({ ...days, [r.action]: (e.target as HTMLInputElement).value })}
                  />
                  <span>{t('cleanup.daysUnit')}</span>
                </label>
              )}
              <Button
                small
                variant={r.action === 'trash' ? 'danger' : 'secondary'}
                disabled={busy}
                onClick={() => post({ type: 'cleanup_run', action: r.action, ...(r.days ? { days: parseDays(val, r.defaultDays) } : {}) })}
              >
                {t(r.button)}
              </Button>
            </div>
          </div>
        );
      })}
      <div class="cleanup-auto">
        <span>
          {stats && stats.autoCleanImagesDays > 0 ? t('cleanup.auto.on', { n: stats.autoCleanImagesDays }) : t('cleanup.auto.off')}
        </span>
        <button type="button" class="link-btn" onClick={() => post({ type: 'open_vscode_settings', query: 'locaithAgent.history.autoCleanImagesDays' })}>
          {t('cleanup.auto.change')}
        </button>
      </div>
    </section>
  );
}
