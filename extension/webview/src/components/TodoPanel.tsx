import { useState } from 'preact/hooks';
import type { TodoItem } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { cx } from '../util';
import { loadUiState, post, saveUiState } from '../vscode';
import { Icon } from './Icons';

/**
 * Bảng tác vụ (kế hoạch của trợ lý). Hai chế độ:
 *  - ĐANG CHẠY: chỉ xem tiến độ (như trước).
 *  - ĐÃ DỪNG mà còn việc dở (người dùng bấm Dừng, khung chat vừa mở lại, trợ lý kết thúc sớm): mỗi bước còn lại là một nút — bấm để trợ lý LÀM TIẾP bước đó,
 *    kèm "Tiếp tục tất cả". Không còn việc nào để chọn thì ẩn hẳn (danh sách đã xong không còn ý nghĩa gì để bấm).
 */
export function TodoPanel({ todos, running }: { todos: TodoItem[]; running: boolean }) {
  const { t } = useApp();
  const [open, setOpen] = useState<boolean>(() => loadUiState().todoOpen ?? true);
  /** Chữ ký của danh sách việc còn lại đã bị người dùng ẩn; danh sách đổi (trợ lý lập kế hoạch mới) thì hiện lại. */
  const [dismissed, setDismissed] = useState('');
  /** Mở danh sách "việc còn lại" để chọn bước — mặc định đóng, chỉ hiện một dòng gọn. */
  const [showRemaining, setShowRemaining] = useState(false);
  if (todos.length === 0) return null;

  const done = todos.filter((x) => x.status === 'completed').length;
  const remaining = todos.filter((x) => x.status !== 'completed');

  if (!running) {
    const signature = remaining.map((x) => `${x.id}:${x.title}`).join('|');
    if (remaining.length === 0 || dismissed === signature) return null;
    // MẶC ĐỊNH THU GỌN: chỉ một dòng "còn N bước"; muốn xem/chọn bước nào thì mở ra.
    // (Yêu cầu của chủ dự án: không chiếm chỗ bằng danh sách "việc còn lại" mỗi lần trợ lý dừng.)
    return (
      <section class="todo todo-choices is-collapsed" aria-label={t('todo.remaining')}>
        <div class="todo-head todo-head-static">
          <button type="button" class="todo-expand" aria-expanded={showRemaining} onClick={() => setShowRemaining((v) => !v)} title={showRemaining ? t('todo.collapse') : t('todo.expand')}>
            <Icon name="list-checks" size={15} />
            <span class="todo-title">{t('todo.remaining')}</span>
            <span class="todo-progress">{t('todo.progress', { done, total: todos.length })}</span>
            <Icon name={showRemaining ? 'chevron-down' : 'chevron-up'} size={13} />
          </button>
          <span class="todo-spacer" />
          <button type="button" class="todo-all" onClick={() => post({ type: 'send', text: t('todo.continue.all'), attachments: [] })} title={t('todo.continue.all')}>
            <Icon name="send" size={12} />
            {t('todo.runAll')}
          </button>
          <button type="button" class="icon-btn todo-dismiss" onClick={() => setDismissed(signature)} title={t('todo.dismiss')} aria-label={t('todo.dismiss')}>
            <Icon name="x" size={13} />
          </button>
        </div>
        {showRemaining && (
          <ul class="todo-list">
            {remaining.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  class={cx('todo-pick', `is-${item.status}`)}
                  title={t('todo.pick.title')}
                  aria-label={`${t('todo.pick.title')}: ${item.title}`}
                  onClick={() => post({ type: 'send', text: t('todo.continue.one', { title: item.title }), attachments: [] })}
                >
                  <span class="todo-box" aria-hidden="true" />
                  <span class="todo-text">{item.title}</span>
                  <Icon name="send" size={12} class="todo-go" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const current = todos.find((x) => x.status === 'in_progress');
  const pct = Math.round((done / todos.length) * 100);
  const toggle = () => {
    setOpen((v) => {
      saveUiState({ todoOpen: !v });
      return !v;
    });
  };

  return (
    <section class={cx('todo', done === todos.length && 'is-complete')} aria-label={t('todo.title')}>
      <button type="button" class="todo-head" aria-expanded={open} onClick={toggle} title={open ? t('todo.collapse') : t('todo.expand')}>
        <Icon name="list-checks" size={15} />
        <span class="todo-title">{t('todo.title')}</span>
        <span class="todo-progress">{t('todo.progress', { done, total: todos.length })}</span>
        {!open && current && <span class="todo-current">{t('todo.current', { title: current.title })}</span>}
        <span class="todo-spacer" />
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size={14} />
      </button>
      <div class="todo-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('todo.progress', { done, total: todos.length })}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <ul class="todo-list">
          {todos.map((item) => (
            <li key={item.id} class={cx('todo-item', `is-${item.status}`)} aria-label={`${item.title} — ${t(`todo.status.${item.status}` as 'todo.status.pending')}`}>
              <span class="todo-box" aria-hidden="true">
                {item.status === 'completed' && <Icon name="check" size={11} />}
              </span>
              <span class="todo-text">{item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
