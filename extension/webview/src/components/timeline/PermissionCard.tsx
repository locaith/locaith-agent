import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { PermissionKind, ToolBlock } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import type { IconName } from '../../iconNames';
import { Markdown } from '../../markdown/Markdown';
import { describeCommand } from '../../permissionView';
import { cx } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Button } from '../ui';
import { DiffView } from './DiffView';

const KIND_ICON: Record<PermissionKind, IconName> = {
  edit: 'pencil',
  create: 'file-plus',
  command: 'terminal',
  network: 'globe',
  plan: 'list-checks',
  outside_workspace: 'folder',
  browser: 'globe',
  other: 'shield',
};

/** Nhãn từ host có thể chứa `mã` kiểu Markdown → dựng thành <code> (không chèn HTML). */
function withCode(text: string): ComponentChildren[] {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} class="inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export function PermissionCard({ block }: { block: ToolBlock }) {
  const { t } = useApp();
  const req = block.permission;
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  if (!req) return null;

  const cmd = req.command ? describeCommand(req.command) : null;
  // Tiêu đề và chi tiết có thể chứa chữ do bên thứ ba viết (tên phần tử trang web, tiêu đề tab, URL, văn bản sắp được gõ): phơi ra ký tự ẩn / đổi chiều chữ
  // thay vì để chúng đánh lừa người duyệt (cùng cách với lệnh shell).
  const titleView = describeCommand(req.title);
  const detailView = req.detail ? describeCommand(req.detail) : null;
  const hiddenInText = titleView.hidden + (detailView?.hidden ?? 0);
  const isPlan = req.kind === 'plan';
  const respond = (decision: 'allow' | 'allow_session' | 'deny', withNote = false) =>
    post({
      type: 'permission_response',
      id: req.id,
      decision,
      feedback: withNote && note.trim() ? note.trim() : undefined,
    });

  return (
    <div class={cx('perm-card', `perm-${req.kind}`)} role="group" aria-label={titleView.text}>
      <div class="perm-head">
        <span class="perm-icon">
          <Icon name={KIND_ICON[req.kind] ?? 'shield'} size={15} />
        </span>
        <span class="perm-kind">{t(`perm.kind.${req.kind}` as 'perm.kind.other')}</span>
      </div>

      <div class="perm-title">{titleView.text}</div>
      {detailView && (
        <div class="perm-detail" tabIndex={0}>
          {detailView.text}
        </div>
      )}
      {hiddenInText > 0 && (
        <div class="perm-warn" role="note">
          <div>{t('perm.hiddenChars', { n: hiddenInText })}</div>
        </div>
      )}
      {cmd && (cmd.long || cmd.hidden > 0) && (
        <div class="perm-warn" role="note">
          {cmd.long && <div>{t('perm.longCommand', { chars: cmd.chars.toLocaleString('vi-VN'), lines: cmd.lines })}</div>}
          {cmd.hidden > 0 && <div>{t('perm.hiddenChars', { n: cmd.hidden })}</div>}
        </div>
      )}
      {cmd && (
        <pre class="tool-pre tool-cmd perm-cmd" tabIndex={0}>
          <span class="prompt">$ </span>
          {cmd.text}
        </pre>
      )}
      {req.diff && <DiffView diff={req.diff} callId={req.callId} collapsedRows={14} />}
      {isPlan && req.planMarkdown && (
        <div class="perm-plan">
          <div class="perm-plan-title">{t('perm.planTitle')}</div>
          <Markdown text={req.planMarkdown} />
        </div>
      )}

      {showNote && (
        <div class="perm-note">
          <label class="perm-note-label" for={`note-${req.id}`}>
            {isPlan ? t('perm.planNote') : t('perm.denyNote')}
          </label>
          <textarea
            id={`note-${req.id}`}
            class="perm-note-input"
            rows={2}
            spellcheck={false}
            placeholder={t('perm.notePlaceholder')}
            value={note}
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
          />
        </div>
      )}

      <div class="perm-actions">
        {isPlan ? (
          <>
            <Button variant="primary" icon="check" onClick={() => respond('allow')}>
              {t('perm.approvePlan')}
            </Button>
            {showNote ? (
              <Button variant="outline" onClick={() => respond('deny', true)}>
                {t('perm.sendDeny')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setShowNote(true)}>
                {t('perm.keepPlanning')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="primary" icon="check" onClick={() => respond('allow')}>
              {t('perm.allow')}
            </Button>
            {req.canAllowSession && (
              <Button variant="secondary" onClick={() => respond('allow_session')} title={req.sessionLabel}>
                {withCode(req.sessionLabel ?? t('perm.allowSession'))}
              </Button>
            )}
            {showNote ? (
              <Button variant="danger" onClick={() => respond('deny', true)}>
                {t('perm.sendDeny')}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => respond('deny')}>
                  {t('perm.deny')}
                </Button>
                <button type="button" class="link-btn" onClick={() => setShowNote(true)}>
                  {t('perm.denyNote')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
