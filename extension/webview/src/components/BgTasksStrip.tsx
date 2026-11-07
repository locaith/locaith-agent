/**
 * (lane:bg-tasks) Chip «N tác vụ nền» phía trên ô nhập. Một dòng: chấm trạng thái + nhãn xám + mũi tên; bấm mở danh sách gọn
 * (thanh dọc mảnh bên trái, mỗi tác vụ: lệnh rút gọn, thời gian chạy, trạng thái, 5 dòng cuối, nút Dừng / Sao chép / Xem đầy đủ)
 * và nút Thu gọn ở cuối. Dùng chung cho VS Code, Chrome và Remote (Remote chỉ có nút Dừng — xem `onAction`).
 */
import { useState } from 'preact/hooks';
import type { BgTaskView } from '../../../src/shared/bgTasks';
import { useApp } from '../ctx';
import { formatDuration } from '../format';
import { post } from '../vscode';
import { CollapseFoot } from './timeline/CollapseFoot';
import { Icon } from './Icons';
import { useNow } from './timeline/useTick';

export type BgTaskAction = 'stop' | 'copy' | 'open';

/** Chấm: đang chạy = xanh; thoát lỗi/không chạy được = đỏ; xong/đã dừng = xám. */
export function bgDotClass(s: BgTaskView['status']): string {
  return s === 'running' ? 'bgt-dot is-run' : s === 'failed' ? 'bgt-dot is-bad' : 'bgt-dot is-done';
}

function statusKey(t: BgTaskView): 'bgt.running' | 'bgt.exited' | 'bgt.killed' | 'bgt.failed' {
  if (t.status === 'running') return 'bgt.running';
  if (t.status === 'exited') return 'bgt.exited';
  if (t.status === 'killed') return 'bgt.killed';
  return 'bgt.failed';
}

export function BgTasksStrip({ tasks, onAction }: { tasks: BgTaskView[]; onAction?: (id: string, action: BgTaskAction) => void }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const running = tasks.filter((x) => x.status === 'running').length;
  const now = useNow(running > 0 && open);
  if (!tasks.length) return null;
  const act = onAction ?? ((id: string, action: BgTaskAction) => post({ type: 'bg_task', id, action }));
  const anyBad = tasks.some((x) => x.status === 'failed');
  const dot = running ? 'bgt-dot is-run' : anyBad ? 'bgt-dot is-bad' : 'bgt-dot is-done';
  const label = running ? t('bgt.chip.running', { n: running }) : t('bgt.chip.done', { n: tasks.length });
  return (
    <div class="bgt" data-testid="bg-tasks">
      <button type="button" class="bgt-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={dot} aria-hidden="true" />
        <span class="bgt-label">{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open && (
        <div class="bgt-body">
          {tasks.map((x) => {
            const dur = formatDuration((x.endedAt ?? now) - x.startedAt, lang);
            const st = x.status === 'failed' && typeof x.exitCode === 'number' ? t('bgt.failedCode', { code: x.exitCode }) : t(statusKey(x));
            return (
              <div class="bgt-item" key={x.id}>
                <div class="bgt-head">
                  <span class={bgDotClass(x.status)} aria-hidden="true" />
                  <code class="bgt-id">{x.id}</code>
                  <span class="bgt-cmd" title={x.command}>
                    {x.description || x.command}
                  </span>
                </div>
                <div class="bgt-meta">
                  {st} · {dur}
                  {x.ready ? ` · ${t('bgt.ready')}: ${x.ready}` : ''}
                </div>
                {x.tail.length > 0 && <pre class="bgt-tail">{x.tail.join('\n')}</pre>}
                <div class="bgt-actions">
                  {x.status === 'running' && (
                    <button type="button" class="bgt-btn" onClick={() => act(x.id, 'stop')}>
                      {t('bgt.stop')}
                    </button>
                  )}
                  {!onAction && (
                    <>
                      <button type="button" class="bgt-btn" onClick={() => act(x.id, 'copy')}>
                        {t('bgt.copy')}
                      </button>
                      <button type="button" class="bgt-btn" onClick={() => act(x.id, 'open')}>
                        {t('bgt.open')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <CollapseFoot onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
