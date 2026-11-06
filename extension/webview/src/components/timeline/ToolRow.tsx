import { useState } from 'preact/hooks';
import type { ToolBlock } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import type { IconName } from '../../iconNames';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { agentStats } from '../../timeline';
import { describeTool, groupLabel, isKnownTool } from '../../toolLabels';
import { cx, memo } from '../../util';
import { bus } from '../../bus';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Spinner } from '../ui';
import { DiffView } from './DiffView';
import { CollapseFoot } from './CollapseFoot';

const ARGS_LIMIT = 2400;

function argsJson(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args, null, 2);
  } catch {
    s = String(args);
  }
  return s.length > ARGS_LIMIT ? s.slice(0, ARGS_LIMIT) + '\n…' : s;
}

function stateIcon(block: ToolBlock, base: IconName): { icon: IconName; tone: string } {
  switch (block.state) {
    case 'error':
      return { icon: 'alert', tone: 'tone-danger' };
    case 'denied':
      return { icon: 'x', tone: 'tone-warn' };
    case 'cancelled':
      return { icon: 'x', tone: 'tone-muted' };
    case 'awaiting_permission':
      return { icon: 'shield', tone: 'tone-accent' };
    default:
      return { icon: base, tone: '' };
  }
}

function ToolRowView({ block, nested = false }: { block: ToolBlock; nested?: boolean }) {
  const { t, lang } = useApp();
  const desc = describeTool(lang, block.name, block.args, block.state);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const showArgs = (!isKnownTool(block.name) || block.name === 'scratchpad') && Object.keys(block.args ?? {}).length > 0;
  const fullCommand = block.name === 'run_command' && typeof block.args?.command === 'string' ? block.args.command : '';
  const hasOutput = block.output !== undefined && (block.output.length > 0 || block.state !== 'running');
  const expandable = Boolean(block.diff || fullCommand || showArgs || hasOutput || block.state === 'error');
  const autoOpen = block.name === 'run_command' && block.state === 'running' && Boolean(block.output);
  const open = expandable && (userOpen ?? autoOpen);

  const running = block.state === 'running';
  const { icon, tone } = stateIcon(block, desc.icon);
  const stateText =
    block.state === 'error' ? t('tool.failed') : block.state === 'denied' ? t('tool.denied') : block.state === 'cancelled' ? t('tool.cancelled') : '';

  const meta: string[] = [];
  if (block.summary && !block.diff) meta.push(block.summary);
  // Agent con đã xong/đã dừng: số liệu cuối («461,4k token · 12 lệnh») để so sánh các agent với nhau.
  if (block.agent) {
    const s = agentStats(block);
    if (s.tokens > 0 || s.tools > 0) meta.push(`${t('par.agent.tokens', { n: formatCompact(s.tokens, lang) })} · ${t('par.agent.tools', { n: formatInt(s.tools, lang) })}`);
  }
  if (block.durationMs !== undefined && block.durationMs >= 400) meta.push(formatDuration(block.durationMs, lang));

  const head = (
    <>
      <span class={cx('act-icon', tone)}>{running ? <Spinner size={14} /> : <Icon name={icon} size={15} />}</span>
      <span class="tool-text">
        <span class="tool-label">
          {block.step !== undefined && (
            <span class="tool-step" title={t('tool.step', { n: block.step })} aria-label={t('tool.step', { n: block.step })}>
              {block.step}
            </span>
          )}
          {desc.label}
          {stateText && <span class={cx('tool-state', tone)}>{stateText}</span>}
        </span>
        {desc.detail && !(open && fullCommand) && (
          <span class={cx('tool-detail', `detail-${desc.detailKind}`)}>
            {desc.detailKind === 'command' && <span class="prompt">$ </span>}
            {desc.detailKind === 'text' ? `“${desc.detail}”` : desc.detail}
          </span>
        )}
      </span>
      <span class="tool-meta">
        {block.diff && (
          <span class="diff-stat">
            <span class="diff-stat-add">+{block.diff.added}</span>
            <span class="diff-stat-del">−{block.diff.removed}</span>
          </span>
        )}
        {meta.length > 0 && <span class="tool-meta-text">{meta.join(' · ')}</span>}
        {expandable && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />}
      </span>
    </>
  );

  return (
    <div class={cx('act-row', 'tool-row', nested && 'is-nested', `state-${block.state}`)} role="listitem">
      <div class="tool-line">
        {expandable ? (
          <button type="button" class="tool-head" aria-expanded={open} onClick={() => setUserOpen(!open)}>
            {head}
          </button>
        ) : (
          <div class="tool-head is-static">{head}</div>
        )}
        {desc.file && (
          <button
            type="button"
            class="tool-open"
            title={t('tool.openFile')}
            aria-label={`${t('tool.openFile')}: ${desc.file.path}`}
            onClick={() => post({ type: 'open_file', path: desc.file!.path, line: desc.file!.line })}
          >
            <Icon name="external" size={13} />
          </button>
        )}
      </div>
      {block.images && block.images.length > 0 && (
        <div class="tool-shots">
          {block.images.map((img, i) => {
            const src = `data:${img.mediaType};base64,${img.data}`;
            return (
              <button key={i} type="button" class="tool-shot" title={t('tool.shot.view')} aria-label={t('tool.shot.view')} onClick={() => bus.lightbox.emit({ src, label: desc.label })}>
                <img src={src} alt={t('tool.shot.alt')} />
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <div class="tool-body">
          {fullCommand && (
            <pre class="tool-pre tool-cmd">
              <span class="prompt">$ </span>
              {fullCommand}
            </pre>
          )}
          {block.diff && <DiffView diff={block.diff} callId={block.id} />}
          {showArgs && (
            <div class="tool-section">
              <div class="tool-section-title">{t('tool.args')}</div>
              <pre class="tool-pre">{argsJson(block.args)}</pre>
            </div>
          )}
          {hasOutput && (
            <div class="tool-section">
              <div class="tool-section-title">{t('tool.output')}</div>
              <pre class={cx('tool-pre', block.state === 'error' && 'is-error')}>{block.output || t('tool.noOutput')}</pre>
            </div>
          )}
          <CollapseFoot onCollapse={() => setUserOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

export const ToolRow = memo(ToolRowView);

function ToolGroupView({ name, blocks }: { name: string; blocks: ToolBlock[] }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const errors = blocks.filter((b) => b.state === 'error').length;
  const icon = describeTool(lang, name, {}, 'done').icon;

  return (
    <div class={cx('act-row', 'tool-group')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <Icon name={icon} size={15} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{groupLabel(lang, name, blocks.length)}</span>
        </span>
        <span class="tool-meta">
          {errors > 0 && <span class="tool-state tone-danger">{t('tool.failed')} ×{errors}</span>}
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="tool-group-body" role="list">
          {blocks.map((b) => (
            <ToolRow key={b.id} block={b} nested />
          ))}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

function EditGroupView({ blocks }: { blocks: ToolBlock[] }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const added = blocks.reduce((n, b) => n + (b.diff?.added ?? 0), 0);
  const removed = blocks.reduce((n, b) => n + (b.diff?.removed ?? 0), 0);
  const errors = blocks.filter((b) => b.state === 'error').length;
  const running = blocks.some((b) => b.state === 'running');
  return (
    <div class={cx('act-row', 'tool-group', 'tool-edits')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t('tool.group.edits', { n: blocks.length })}>
        <span class="act-icon">{running ? <Spinner size={14} /> : <Icon name="pencil" size={15} />}</span>
        <span class="tool-text">
          <span class="tool-label">{t('tool.group.edits', { n: blocks.length })}</span>
        </span>
        <span class="tool-meta">
          {added > 0 && <span class="diff-stat-add">+{added}</span>}
          {removed > 0 && <span class="diff-stat-del">−{removed}</span>}
          {errors > 0 && <span class="tool-state tone-danger">{t('tool.failed')} ×{errors}</span>}
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="tool-group-body" role="list">
          {blocks.map((b) => (
            <ToolRow key={b.id} block={b} nested />
          ))}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

export const ToolGroup = memo(ToolGroupView);
export const EditGroup = memo(EditGroupView);
