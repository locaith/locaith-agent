/**
 * (lane:checkpoints-rewind) Quay lại điểm trước + thanh thay đổi sau mỗi lượt.
 *
 * Kiểu Claude Code, gọn: mỗi thứ là MỘT dòng (chấm trạng thái + nhãn xám nhạt + hành động chữ), mở ra thì có thanh dọc mảnh bên trái
 * và nút Thu gọn ở cuối. Không tô nền kín. Mọi dữ liệu đến từ `view.checkpoints` / `view.rewind` (giao thức chung với Remote).
 */
import { useState } from 'preact/hooks';
import type { CheckpointFile, CheckpointTurn, RewindPlanFile, RewindView, RewindWhat } from '../../../../src/shared/checkpoints';
import type { ViewState } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { filesFrom } from '../../rewindMath';
import { cx } from '../../util';
import { post } from '../../vscode';
import { CollapseFoot } from './CollapseFoot';

const LIST_LIMIT = 8;

type TFn = ReturnType<typeof useApp>['t'];

function filesText(t: TFn, n: number): string {
  return t(n === 1 ? 'rw.files.one' : 'rw.files.other', { n });
}

/** Nút nhỏ dưới tin nhắn người dùng. Ẩn khi cuộc trò chuyện cũ không có điểm quay lại cho tin này. */
export function RewindTrigger({ promptId, view }: { promptId: string; view: ViewState }) {
  const { t } = useApp();
  if (!view.checkpoints?.some((c) => c.promptId === promptId) || view.running) return null;
  return (
    <div class="rw-trigger">
      <button type="button" class="rw-link" onClick={() => post({ type: 'rewind_open', promptId })}>
        {t('rw.trigger')}
      </button>
    </div>
  );
}

function ChangeBarView({ turn, running }: { turn: CheckpointTurn; running: boolean }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  if (turn.files.length === 0 || running) return null;
  const added = turn.files.reduce((a, f) => a + f.added, 0);
  const removed = turn.files.reduce((a, f) => a + f.removed, 0);
  const files = filesText(t, turn.files.length);
  const undoable = turn.files.some((f) => !f.skipped);

  if (turn.undone) {
    return (
      <div class="cp-bar is-undone" role="status">
        <span class="cp-dot" aria-hidden="true" />
        <span class="cp-label">{t('cp.undone', { files })}</span>
      </div>
    );
  }
  return (
    <div class={cx('cp-bar', open && 'is-open')}>
      <div class="cp-line">
        <span class="cp-dot is-ok" aria-hidden="true" />
        <button type="button" class="cp-label cp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('cp.bar', { files })}
          <span class="cp-stat">
            <span class="cp-add">+{added}</span> <span class="cp-del">−{removed}</span>
          </span>
        </button>
        <button type="button" class="rw-link" onClick={() => setOpen(!open)}>
          {t('cp.view')}
        </button>
        {undoable && (
          <button type="button" class="rw-link" onClick={() => post({ type: 'rewind_plan', promptId: turn.promptId, what: 'code', scope: 'turn' })}>
            {t('cp.undo')}
          </button>
        )}
      </div>
      {open && (
        <div class="cp-list">
          <ul>
            {turn.files.map((f) => (
              <ChangeFile key={f.rel} f={f} promptId={turn.promptId} />
            ))}
          </ul>
          <CollapseFoot onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function ChangeFile({ f, promptId }: { f: CheckpointFile; promptId: string }) {
  const { t } = useApp();
  return (
    <li class="cp-file">
      <button type="button" class="cp-path" title={t('cp.diff')} disabled={!!f.skipped} onClick={() => post({ type: 'checkpoint_diff', promptId, rel: f.rel })}>
        {f.rel}
      </button>
      {f.kind === 'create' && <span class="cp-tag">{t('cp.created')}</span>}
      {f.skipped ? (
        <span class="cp-tag is-warn">{t('cp.noUndo')}</span>
      ) : (
        <>
          <span class="cp-stat">
            <span class="cp-add">+{f.added}</span> <span class="cp-del">−{f.removed}</span>
          </span>
          <button type="button" class="rw-link" onClick={() => post({ type: 'rewind_plan', promptId, what: 'code', scope: 'turn', files: [f.rel] })}>
            {t('cp.undo')}
          </button>
        </>
      )}
    </li>
  );
}

export const ChangeBar = ChangeBarView;

/** Thẻ «Quay lại»: menu → xem trước → kết quả. Thanh dọc mảnh bên trái, không tô nền. */
export function RewindCard({ view, rewind }: { view: ViewState; rewind: RewindView }) {
  const { t } = useApp();
  const id = rewind.promptId;
  const close = () => post({ type: 'rewind_cancel' });

  if (rewind.stage === 'menu') {
    const n = filesFrom(view.checkpoints ?? [], id);
    const pick = (what: RewindWhat) => post({ type: 'rewind_plan', promptId: id, what, scope: 'from' });
    return (
      <div class="rw-card" role="group" aria-label={t('rw.menu.title')}>
        <div class="rw-title">
          <span class="cp-dot is-ok" aria-hidden="true" />
          {t('rw.menu.title')}
        </div>
        {rewind.recent && rewind.recent.length > 0 && (
          <div class="rw-recent">
            <div class="rw-sub">{t('rw.recent')}</div>
            <ul>
              {rewind.recent.map((r) => (
                <li key={r.promptId}>
                  <button type="button" class={cx('rw-pick', r.promptId === id && 'is-on')} onClick={() => post({ type: 'rewind_open', promptId: r.promptId, list: true })}>
                    <span class="rw-pick-text">{r.text || '…'}</span>
                    {r.files > 0 && <span class="rw-pick-n">{filesText(t, r.files)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div class="rw-options">
          <button type="button" class="rw-opt" disabled={n === 0} onClick={() => pick('code')}>
            <span class="rw-opt-name">{t('rw.menu.code')}</span>
            <span class="rw-opt-hint">{n === 0 ? t('rw.menu.none') : t('rw.menu.code.hint', { files: filesText(t, n) })}</span>
          </button>
          <button type="button" class="rw-opt" onClick={() => pick('conversation')}>
            <span class="rw-opt-name">{t('rw.menu.conv')}</span>
            <span class="rw-opt-hint">{t('rw.menu.conv.hint')}</span>
          </button>
          <button type="button" class="rw-opt" onClick={() => pick('both')}>
            <span class="rw-opt-name">{t('rw.menu.both')}</span>
            <span class="rw-opt-hint">{t('rw.menu.both.hint')}</span>
          </button>
        </div>
        {rewind.error && <div class="rw-error">{rewind.error}</div>}
        <div class="rw-actions">
          <button type="button" class="rw-link" onClick={close}>
            {t('rw.close')}
          </button>
        </div>
      </div>
    );
  }

  if (rewind.stage === 'plan') return <PlanCard rewind={rewind} />;

  if (rewind.stage === 'applying') {
    return (
      <div class="rw-card" role="status">
        <div class="rw-title">
          <span class="cp-dot is-busy" aria-hidden="true" />
          {t('rw.applying')}
        </div>
      </div>
    );
  }

  // done
  const files = filesText(t, rewind.restored ?? 0);
  const text = rewind.redone
    ? t('rw.done.redo', { files })
    : rewind.what === 'conversation'
      ? t('rw.done.conv')
      : rewind.what === 'both'
        ? t('rw.done.both', { files })
        : t('rw.done.code', { files });
  return (
    <div class="rw-card" role="status">
      <div class="rw-title">
        <span class={cx('cp-dot', rewind.error ? 'is-err' : 'is-ok')} aria-hidden="true" />
        {text}
      </div>
      {!!rewind.skipped && <div class="rw-note">{t('rw.done.skipped', { files: filesText(t, rewind.skipped) })}</div>}
      {rewind.error && <div class="rw-error">{rewind.error}</div>}
      <div class="rw-actions">
        {rewind.canRedo && (
          <button type="button" class="rw-link" onClick={() => post({ type: 'rewind_redo' })}>
            {t('rw.redo')}
          </button>
        )}
        <button type="button" class="rw-link" onClick={close}>
          {t('rw.close')}
        </button>
      </div>
    </div>
  );
}

function PlanCard({ rewind }: { rewind: RewindView }) {
  const { t } = useApp();
  const [all, setAll] = useState(false);
  const files = rewind.files ?? [];
  const writes = files.filter((f) => f.action !== 'skip').length;
  const shown = all ? files : files.slice(0, LIST_LIMIT);
  const what = rewind.what ?? 'code';
  const wantsCode = what !== 'conversation';
  const nothing = what === 'code' && writes === 0;
  return (
    <div class="rw-card" role="group" aria-label={t('rw.menu.title')}>
      <div class="rw-title">
        <span class="cp-dot is-ok" aria-hidden="true" />
        {t('rw.menu.title')}
      </div>
      {wantsCode && (
        <div class="rw-plan">
          <div class="rw-sub">{writes > 0 ? t('rw.plan.code', { files: filesText(t, writes) }) : t('rw.plan.none')}</div>
          {files.length > 0 && (
            <ul class="rw-files">
              {shown.map((f) => (
                <PlanRow key={f.rel} f={f} />
              ))}
            </ul>
          )}
          {!all && files.length > LIST_LIMIT && (
            <button type="button" class="rw-link" onClick={() => setAll(true)}>
              {t('rw.more', { n: files.length - LIST_LIMIT })}
            </button>
          )}
          {all && files.length > LIST_LIMIT && <CollapseFoot onCollapse={() => setAll(false)} />}
          {!!rewind.conflicts && <div class="rw-warn">{t('rw.conflict.note', { files: filesText(t, rewind.conflicts) })}</div>}
        </div>
      )}
      {what !== 'code' && rewind.messages !== undefined && <div class="rw-sub">{t('rw.plan.conv', { n: rewind.messages })}</div>}
      {rewind.error && <div class="rw-error">{rewind.error}</div>}
      <div class="rw-actions">
        <button type="button" class="rw-link is-strong" disabled={nothing} onClick={() => post({ type: 'rewind_apply' })}>
          {rewind.conflicts ? t('rw.confirm.overwrite') : t('rw.confirm')}
        </button>
        <button type="button" class="rw-link" onClick={() => post({ type: 'rewind_cancel' })}>
          {t('rw.cancel')}
        </button>
      </div>
    </div>
  );
}

function PlanRow({ f }: { f: RewindPlanFile }) {
  const { t } = useApp();
  return (
    <li class={cx('cp-file', f.conflict && 'is-conflict')}>
      <span class="cp-path is-static">{f.rel}</span>
      <span class="cp-tag">{t(`rw.act.${f.action}` as 'rw.act.restore')}</span>
      {f.reason && <span class="cp-tag is-warn">{t(`rw.skip.${f.reason}` as 'rw.skip.binary')}</span>}
      {f.conflict && <span class="cp-tag is-warn">{t('rw.conflict')}</span>}
      {f.action !== 'skip' && (
        <span class="cp-stat">
          <span class="cp-add">+{f.added}</span> <span class="cp-del">−{f.removed}</span>
        </span>
      )}
    </li>
  );
}
