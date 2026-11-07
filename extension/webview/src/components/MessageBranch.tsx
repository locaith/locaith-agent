/**
 * (lane:sessions-ux) Rẽ nhánh cuộc trò chuyện từ một tin nhắn: mục «Rẽ nhánh từ đây» trong menu «⋯» của tin nhắn người dùng,
 * và dòng liên kết ngược «Rẽ nhánh từ …» ở đầu cuộc mới. Tách riêng để không đụng menu quay lui (rewind) của lane khác.
 */

import type { NoticeItem } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { post } from '../vscode';
import { Icon } from './Icons';

/** Một mục menu: gửi `fork_session` cho host (host tự lưu cuộc gốc, tạo cuộc mới và chuyển sang đó). */
export function BranchMenuItem({ itemId, disabled, onDone }: { itemId: string; disabled?: boolean; onDone: () => void }) {
  const { t } = useApp();
  return (
    <button
      type="button"
      role="menuitem"
      class="msg-menu-item"
      disabled={disabled}
      title={disabled ? t('sx.fork.busy') : t('sx.fork.hint')}
      onClick={() => {
        post({ type: 'fork_session', itemId });
        onDone();
      }}
    >
      <Icon name="branch" size={14} />
      <span>{t('sx.fork')}</span>
    </button>
  );
}

/** Dòng đầu cuộc nhánh: bấm để mở lại cuộc gốc (nếu còn). */
export function BranchBacklink({ item }: { item: NoticeItem }) {
  const { t } = useApp();
  const fork = item.fork;
  if (!fork) return null;
  return (
    <div class="turn turn-notice">
      <button type="button" class="branch-link" title={t('sx.fork.open')} onClick={() => post({ type: 'load_session', id: fork.fromId })}>
        <span class="branch-dot" aria-hidden="true" />
        <span class="branch-text">{t('sx.fork.from', { title: fork.fromTitle || t('app.untitled') })}</span>
      </button>
    </div>
  );
}
