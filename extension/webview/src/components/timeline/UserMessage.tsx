import { useState } from 'preact/hooks';
import type { UserItem } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { cx, memo } from '../../util';
import { AttachmentChip } from '../Chips';
import { Icon } from '../Icons';
import { MessageActionSlot } from './MessageActionSlot'; // (lane:cc-timeline-ui)
import { MessageMenu } from '../MessageMenu'; // (lane:sessions-ux)

const CLAMP_CHARS = 900;
const CLAMP_LINES = 14;

function UserMessageView({ item, canEdit, busy = false }: { item: UserItem; canEdit: boolean; busy?: boolean }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const long = item.text.length > CLAMP_CHARS || item.text.split('\n').length > CLAMP_LINES;

  return (
    <section class="turn turn-user" aria-label={t('turn.you')}>
      <div class="user-bubble">
        {item.steer && (
          <div class="user-steer">
            <Icon name="queue" size={12} />
            {t('turn.steered')}
          </div>
        )}
        {item.attachments.length > 0 && (
          <div class="chip-row">
            {item.attachments.map((a, i) => (
              <AttachmentChip key={i} a={a} />
            ))}
          </div>
        )}
        {item.text && <div class={cx('user-text', long && !expanded && 'is-clamped')}>{item.text}</div>}
        {long && (
          <button type="button" class="link-btn user-more" onClick={() => setExpanded((v) => !v)}>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
            {expanded ? t('tool.showLess') : t('act.expand')}
          </button>
        )}
        {/* (lane:cc-timeline-ui) ô thao tác góc trên-phải; (lane:sessions-ux) menu ⋯: Sao chép · Sửa và gửi lại · Rẽ nhánh từ đây (thay nút bút chì đơn lẻ); lane checkpoints-rewind gắn thêm biểu tượng quay lại vào đây. */}
        <MessageActionSlot>{!item.steer && <MessageMenu itemId={item.id} text={item.text} canEdit={canEdit} busy={busy} />}</MessageActionSlot>
      </div>
    </section>
  );
}

export const UserMessage = memo(UserMessageView);
