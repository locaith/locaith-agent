/** Chuỗi hoạt động của một lượt trả lời: tác vụ, kỹ năng, công cụ, dòng trạng thái, suy nghĩ — trên một đường ray dọc.
 *  (lane:cc-timeline-ui) Mỗi dòng = chấm trạng thái + chữ xám nhạt, không biểu tượng; «Đã suy nghĩ 14 giây» / «Đang suy nghĩ» (shimmer). */
import { useMemo, useState } from 'preact/hooks';
import { estimateTokens } from '../../../../src/core/engine/tokens';
import { useApp } from '../../ctx';
import { formatInt } from '../../format';
import { useCountUp, useElapsed } from '../../hooks';
import { CollapseFoot } from './CollapseFoot';
import type { ActItem, ActivityRow, PillBlockT, SkillBlockT, TasksBlockT, ThinkingBlockT } from '../../timeline';
import { groupThinking } from '../../timeline';
import { formatSeconds, thinkingDuration } from '../../timelineCc';
import { cx, memo } from '../../util';
import { Icon } from '../Icons';
import { AgentRow } from './AgentRow';
import { StatusDot } from './RunHead';
import { EditGroup, ToolGroup, ToolRow } from './ToolRow';
import { ToolSummary } from './ToolSummary';

function TasksRowView({ block }: { block: TasksBlockT }) {
  const { t } = useApp();
  return (
    <div class="act-row act-tasks" role="listitem">
      <span class="act-icon">
        <StatusDot tone="ok" />
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
      <span class="act-icon">
        <StatusDot tone="ok" />
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
        <StatusDot tone={block.active ? 'live' : 'muted'} />
      </span>
      <div class="act-text">
        <div class={cx('act-line', 'pill-text', block.active && 'cc-shimmer')}>{block.text}</div>
      </div>
    </div>
  );
}

/**
 * Nhãn dòng suy nghĩ: đang nghĩ → «Đang suy nghĩ» (shimmer, kèm giây đã trôi); xong → «Đã suy nghĩ 14 giây» (từ durationMs của khối)
 * hoặc «Đã suy nghĩ» khi phiên cũ không có số. Ước lượng token chỉ còn ở tooltip.
 */
function useThinkingLabel(blocks: readonly ThinkingBlockT[], live: boolean): { label: string; title: string } {
  const { t, lang } = useApp();
  const tokens = useMemo(() => blocks.reduce((n, b) => n + estimateTokens(b.text), 0), [blocks]);
  const shown = useCountUp(tokens, live);
  const secs = useElapsed(live);
  const dur = useMemo(() => thinkingDuration(blocks), [blocks]);
  const num = shown.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
  const title = tokens > 0 ? `${t('act.thinkTokens', { n: num })} — ${t('act.thinkTokens.hint')}` : t('act.thinkingOpen');
  if (live) return { label: secs !== null && secs >= 1 ? `${t('cc.thinking')} · ${formatSeconds(secs * 1000, lang)}` : t('cc.thinking'), title };
  return { label: dur !== undefined ? t('cc.thought', { d: formatSeconds(dur, lang) }) : t('cc.thoughtPlain'), title };
}

function ThinkingRowView({ block, live }: { block: ThinkingBlockT; live: boolean }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const blocks = useMemo(() => [block], [block]);
  const { label, title } = useThinkingLabel(blocks, live);
  return (
    <div class={cx('act-row', 'act-thinking', live && 'is-live')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} title={title} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <StatusDot tone={live ? 'live' : 'muted'} />
        </span>
        <span class="tool-text">
          <span class={cx('tool-label', 'cc-think', live && 'cc-shimmer')}>{label}</span>
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
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
          <StatusDot tone="muted" />
        </span>
        <span class="tool-text">
          <span class="tool-label">{t('act.steps', { n: blocks.length })}</span>
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
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
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const { label, title } = useThinkingLabel(blocks, live);
  return (
    <div class={cx('act-row', 'act-thinking', 'act-thinking-group', live && 'is-live')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} title={title} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <StatusDot tone={live ? 'live' : 'muted'} />
        </span>
        <span class="tool-text">
          <span class={cx('tool-label', 'cc-think', live && 'cc-shimmer')}>{label}</span>
          {blocks.length > 1 && <span class="think-count">{t('cc.parts', { n: blocks.length })}</span>}
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
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

function TaskGroupView({ row, live, expanded }: { row: Extract<ActivityRow, { kind: 'taskgroup' }>; live: boolean; expanded?: boolean }) {
  const { t, lang } = useApp();
  // Trong nhóm người dùng vừa mở: việc cũng mở sẵn (một lần bấm là thấy từng bước); vẫn thu lại được bằng chevron.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !!expanded;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => setUserOpen(typeof v === 'function' ? v(open) : v);
  const s = row.stats;
  const meta = [t('act.taskgroup.calls', { n: formatInt(s.calls, lang) }), s.edits > 0 ? t('act.taskgroup.edits', { n: formatInt(s.edits, lang) }) : '', s.failed > 0 ? t('par.failed', { n: formatInt(s.failed, lang) }) : ''].filter(Boolean).join(' · ');
  return (
    <div class={cx('act-row', 'task-group', 'cc-group', s.failed > 0 && 'has-fail')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <StatusDot tone={s.failed > 0 ? 'fail' : live ? 'live' : 'ok'} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{row.title ? t('act.taskgroup.title', { title: row.title }) : t('act.taskgroup.plain')}</span>
        </span>
        <span class="tool-meta">
          <span class="tool-meta-text">{meta}</span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="task-group-body" role="list">
          <ActivitySegment rows={row.rows} live={live} expanded={expanded} />
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

/**
 * Một mục trong chuỗi: hoặc một dòng đơn, hoặc MỘT NHÓM các khối «Suy nghĩ» liền nhau.
 * `expanded`: đoạn này nằm trong một nhóm NGƯỜI DÙNG VỪA MỞ → dòng tóm tắt bên trong tự bày từng lệnh (một lần bấm là thấy hết).
 */
export function ActivitySegment({ rows, live, expanded = false }: { rows: ActivityRow[]; live: boolean; expanded?: boolean }) {
  // Trong nhóm đã mở: từng khối suy nghĩ đứng đúng chỗ («Đã suy nghĩ 14 giây» rồi Lệnh rồi «Đã suy nghĩ 3 giây», như Claude Code);
  // ngoài nhóm (lượt ngắn) vẫn gom mọi suy nghĩ vào một dòng cho gọn.
  const items = useMemo<ActItem[]>(() => (expanded ? rows.map((r, i) => ({ key: r.key, live: live && i === rows.length - 1, row: r })) : groupThinking(rows, live)), [rows, live, expanded]);
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
            return <ToolRow key={row.key} block={row.block} nested={expanded} />;
          case 'toolgroup':
            return <ToolGroup key={row.key} name={row.name} blocks={row.blocks} defaultOpen={expanded} />;
          case 'taskgroup':
            return <TaskGroup key={row.key} row={row} live={it.live} expanded={expanded} />;
          case 'editgroup':
            return <EditGroup key={row.key} blocks={row.blocks} defaultOpen={expanded} />;
          case 'toolsum':
            return <ToolSummary key={row.key} info={row.info} flat={expanded} />;
          case 'agent':
            return <AgentRow key={row.key} block={row.block} />;
        }
      })}
    </div>
  );
}
