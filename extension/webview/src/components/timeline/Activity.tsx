/** Chuỗi hoạt động của một lượt trả lời: tác vụ, kỹ năng, công cụ, dòng trạng thái, suy nghĩ — trên một đường ray dọc. */
import { useMemo, useState } from 'preact/hooks';
import { estimateTokens } from '../../../../src/core/engine/tokens';
import { useApp } from '../../ctx';
import { formatInt } from '../../format';
import { useCountUp, useElapsed } from '../../hooks';
import { CollapseFoot } from './CollapseFoot';
import type { ActivityRow, PillBlockT, SkillBlockT, TasksBlockT, ThinkingBlockT } from '../../timeline';
import { groupThinking } from '../../timeline';
import { cx, memo } from '../../util';
import { LoSpinner } from '../Brand';
import { Icon } from '../Icons';
import { AgentRow } from './AgentRow';
import { EditGroup, ToolGroup, ToolRow } from './ToolRow';
import { ToolSummary } from './ToolSummary';

function TasksRowView({ block }: { block: TasksBlockT }) {
  const { t } = useApp();
  return (
    <div class="act-row act-tasks" role="listitem">
      <span class="act-icon tone-ok">
        <Icon name="check" size={15} />
      </span>
      <div class="act-text">
        {block.added.map((title, i) => (
          <div key={i} class="act-line">
            {t('act.taskAdded', { title })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillRowView({ block }: { block: SkillBlockT }) {
  const { t } = useApp();
  return (
    <div class="act-row act-skill" role="listitem">
      <span class="act-icon tone-accent">
        <Icon name="zap" size={15} />
      </span>
      <div class="act-text">
        <div class="act-line">{t('act.skillLoaded', { skill: block.skill })}</div>
        {block.unlocked.length > 0 && (
          <div class="act-sub" title={block.unlocked.join(', ')}>
            {t('act.skillUnlocked', { tools: block.unlocked.join(', ') })}
          </div>
        )}
      </div>
    </div>
  );
}

function PillRowView({ block }: { block: PillBlockT }) {
  return (
    <div class={cx('act-row', 'act-pill', block.active && 'is-active')} role="listitem">
      <span class="act-icon">
        {block.active ? <LoSpinner size={13} /> : <span class="dot dot-done" />}
      </span>
      <div class="act-text">
        <div class="act-line pill-text">{block.text}</div>
      </div>
    </div>
  );
}

function ThinkingRowView({ block, live }: { block: ThinkingBlockT; live: boolean }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  // Ước lượng token suy nghĩ từ chữ đã stream về (số thật của hãng chỉ có khi xong lượt); số "chạy" mượt trong lúc đang nghĩ.
  const tokens = useMemo(() => estimateTokens(block.text), [block.text]);
  const shown = useCountUp(tokens, live);
  const secs = useElapsed(live);
  const num = shown.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
  return (
    <div class="act-row act-thinking" role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">{live ? <LoSpinner size={15} /> : <Icon name="lightbulb" size={15} />}</span>
        <span class="tool-text">
          <span class="tool-label">{t('act.thinking')}</span>
          {tokens > 0 && (
            <span class="think-count" title={t('act.thinkTokens.hint')}>
              {t('act.thinkTokens', { n: num })}
              {secs !== null && secs >= 1 ? ` · ${secs} s` : ''}
            </span>
          )}
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="thinking-body">
          {block.text}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

function PillRunView({ blocks }: { blocks: PillBlockT[] }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div class="act-row act-pillrun" role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <span class="dot dot-done" />
        </span>
        <span class="tool-text">
          <span class="tool-label">{t('act.steps', { n: blocks.length })}</span>
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="pillrun-body" role="list">
          {blocks.map((b) => (
            <PillRowView key={b.id} block={b} />
          ))}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

function ThinkingGroupView({ blocks, live }: { blocks: ThinkingBlockT[]; live: boolean }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const tokens = useMemo(() => blocks.reduce((n, b) => n + estimateTokens(b.text), 0), [blocks]);
  const secs = useElapsed(live);
  const num = tokens.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
  return (
    <div class="act-row act-thinking act-thinking-group" role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">{live ? <LoSpinner size={15} /> : <Icon name="lightbulb" size={15} />}</span>
        <span class="tool-text">
          <span class="tool-label">
            {blocks.length > 1 ? t('act.thinkingGroup', { n: blocks.length }) : t('act.thinking')}
          </span>
          {tokens > 0 && (
            <span class="think-count" title={t('act.thinkTokens.hint')}>
              {t('act.thinkTokens', { n: num })}
              {secs !== null && secs >= 1 ? ` · ${secs} s` : ''}
            </span>
          )}
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="thinking-group-body">
          {blocks.map((b, i) => (
            <div key={b.id} class="thinking-piece">
              {blocks.length > 1 && <div class="thinking-piece-n">{t('act.thinkingPiece', { n: i + 1 })}</div>}
              <div class="thinking-body">{b.text}</div>
            </div>
          ))}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

function TaskGroupView({ row, live }: { row: Extract<ActivityRow, { kind: 'taskgroup' }>; live: boolean }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const s = row.stats;
  const meta = [t('act.taskgroup.calls', { n: formatInt(s.calls, lang) }), s.edits > 0 ? t('act.taskgroup.edits', { n: formatInt(s.edits, lang) }) : '', s.failed > 0 ? t('tool.failed') : ''].filter(Boolean).join(' · ');
  return (
    <div class={cx('act-row', 'task-group', s.failed > 0 && 'has-fail')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon tone-ok">{live ? <LoSpinner size={14} /> : <Icon name="list-checks" size={15} />}</span>
        <span class="tool-text">
          <span class="tool-label">{row.title ? t('act.taskgroup.title', { title: row.title }) : t('act.taskgroup.plain')}</span>
        </span>
        <span class="tool-meta">
          <span class="tool-meta-text">{meta}</span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="task-group-body" role="list">
          <ActivitySegment rows={row.rows} live={live} />
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('tool.showLess')} />
        </div>
      )}
    </div>
  );
}

export const TasksRow = memo(TasksRowView);
export const SkillRow = memo(SkillRowView);
export const PillRow = memo(PillRowView);
export const ThinkingRow = memo(ThinkingRowView);
export const ThinkingGroup = memo(ThinkingGroupView);
export const PillRun = memo(PillRunView);
export const TaskGroup = memo(TaskGroupView);

/** Một mục trong chuỗi: hoặc một dòng đơn, hoặc MỘT NHÓM các khối «Suy nghĩ» liền nhau. */
export function ActivitySegment({ rows, live }: { rows: ActivityRow[]; live: boolean }) {
  const items = useMemo(() => groupThinking(rows, live), [rows, live]);
  return (
    <div class="act" role="list">
      {items.map((it) => {
        if (it.thinking) return <ThinkingGroup key={it.key} blocks={it.thinking} live={it.live} />;
        const row = it.row!;
        switch (row.kind) {
          case 'tasks':
            return <TasksRow key={row.key} block={row.block} />;
          case 'skill':
            return <SkillRow key={row.key} block={row.block} />;
          case 'pill':
            return <PillRow key={row.key} block={row.block} />;
          case 'pillrun':
            return <PillRun key={row.key} blocks={row.blocks} />;
          case 'thinking':
            return <ThinkingRow key={row.key} block={row.block} live={it.live} />;
          case 'tool':
            return <ToolRow key={row.key} block={row.block} />;
          case 'toolgroup':
            return <ToolGroup key={row.key} name={row.name} blocks={row.blocks} />;
          case 'taskgroup':
            return <TaskGroup key={row.key} row={row} live={it.live} />;
          case 'editgroup':
            return <EditGroup key={row.key} blocks={row.blocks} />;
          case 'toolsum':
            return <ToolSummary key={row.key} info={row.info} />;
          case 'agent':
            return <AgentRow key={row.key} block={row.block} />;
        }
      })}
    </div>
  );
}
