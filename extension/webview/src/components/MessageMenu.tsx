/**
 * (lane:sessions-ux) Menu «⋯» của tin nhắn người dùng: Sao chép · Sửa và gửi lại (chỉ tin cuối) · Rẽ nhánh từ đây.
 * Một nút nhỏ hiện khi rê chuột/tiêu điểm (luôn hiện ở khung cảm ứng); mở ra là danh sách gọn, Esc/bấm ngoài để đóng.
 */

import { useRef, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { copyText, cx, useDismiss } from '../util';
import { post } from '../vscode';
import { Icon } from './Icons';
import { BranchMenuItem } from './MessageBranch';

export function MessageMenu({ itemId, text, canEdit, busy }: { itemId: string; text: string; canEdit: boolean; busy: boolean }) {
  const { t, toast } = useApp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  const close = () => setOpen(false);

  return (
    <div class={cx('msg-menu', open && 'is-open')} ref={rootRef}>
      <button type="button" class="msg-menu-btn" aria-haspopup="menu" aria-expanded={open} title={t('sx.msg.more')} aria-label={t('sx.msg.more')} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={15} />
      </button>
      {open && (
        <div class="msg-menu-pop" role="menu" aria-label={t('sx.msg.more')}>
          <button
            type="button"
            role="menuitem"
            class="msg-menu-item"
            disabled={!text}
            onClick={async () => {
              close();
              if (await copyText(text)) toast('info', t('sx.msg.copied'));
            }}
          >
            <Icon name="copy" size={14} />
            <span>{t('sx.msg.copy')}</span>
          </button>
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              class="msg-menu-item"
              onClick={() => {
                close();
                post({ type: 'edit_last' });
              }}
            >
              <Icon name="pencil" size={14} />
              <span>{t('sx.msg.edit')}</span>
            </button>
          )}
          <BranchMenuItem itemId={itemId} disabled={busy} onDone={close} />
        </div>
      )}
    </div>
  );
}
