import { useState } from 'preact/hooks';
import type { UserItem } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { cx, memo } from '../../util';
import { post } from '../../vscode';
import { AttachmentChip } from '../Chips';
import { Icon } from '../Icons';

const CLAMP_CHARS = 900;
const CLAMP_LINES = 14;

function UserMessageView({ item, canEdit }: { item: UserItem; canEdit: boolean }) {
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
        {canEdit && (
          <button
            type="button"
            class="user-edit"
            title={t('turn.editLast')}
            aria-label={t('turn.editLast')}
            onClick={() => post({ type: 'edit_last' })}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
      </div>
    </section>
  );
}

export const UserMessage = memo(UserMessageView);
