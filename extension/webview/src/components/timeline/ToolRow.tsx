/**
 * Dòng công cụ kiểu Claude Code (lane:cc-timeline-ui):
 *   [chấm trạng thái] **Tên hành động** mô tả-một-dòng (cắt …)            meta nhỏ bên phải (thời gian · «58 dòng» · +9 −3) [⌄]
 * Mô tả ưu tiên đối số `description` do model đưa; không có thì lệnh / đường dẫn / mẫu tìm. Đường dẫn tệp màu liên kết, bấm để mở.
 * Mở ra: lệnh shell → ô IN/OUT; Write → khung xem trước tệp; Edit → DiffView (nút «Mở diff trong editor»); công cụ lạ → tham số.
 * Dòng LỒNG trong một nhóm đã mở (nested) tự bày IN/OUT, xem trước, diff ngay (như ảnh mẫu) — vẫn thu lại được bằng chevron.
 */
import { useState } from 'preact/hooks';
import type { ToolBlock } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { agentStats } from '../../timeline';
import { actionName, toolDescription, writeLineCount } from '../../timelineCc';
import { describeTool, groupLabel, isKnownTool } from '../../toolLabels';
import { cx, memo } from '../../util';
import { bus } from '../../bus';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { CmdInOut } from './CmdInOut';
import { CollapseFoot } from './CollapseFoot';
import { DiffView } from './DiffView';
import { FilePreview } from './FilePreview';
import { StatusDot, type DotTone } from './RunHead';

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

/** Màu chấm + màu chữ trạng thái theo state của khối. */
export function toolTone(state: ToolBlock['state']): { dot: DotTone; cls: string } {
  switch (state) {
    case 'error':
      return { dot: 'fail', cls: 'tone-danger' };
    case 'denied':
      return { dot: 'warn', cls: 'tone-warn' };
    case 'cancelled':
      return { dot: 'muted', cls: 'tone-muted' };
    case 'awaiting_permission':
      return { dot: 'warn', cls: 'tone-accent' };
    case 'running':
      return { dot: 'live', cls: '' };
    default:
      return { dot: 'ok', cls: '' };
  }
}

function ToolRowView({ block, nested = false }: { block: ToolBlock; nested?: boolean }) {
  const { t, lang, platform } = useApp();
  const desc = describeTool(lang, block.name, block.args, block.state);
  const d = toolDescription(lang, block);
  const name = actionName(lang, block.name);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const isCmd = block.name === 'run_command';
  const isWrite = block.name === 'write_file';
  const content = isWrite && typeof block.args?.content === 'string' ? block.args.content : '';
  const lineCount = isWrite ? writeLineCount(block) : undefined;
  // (lane:cc-timeline-ui) Write tệp MỚI: host trả cả summary «N dòng» lẫn diff toàn-thêm → chỉ hiện «N dòng» + xem trước, không vẽ diff lặp nội dung. Edit / ghi đè giữ diff.
  const showDiff = block.diff && !(isWrite && block.diff.isNew && lineCount !== undefined) ? block.diff : undefined;
  const showArgs = (!isKnownTool(block.name) || block.name === 'scratchpad') && Object.keys(block.args ?? {}).length > 0;
  const fullCommand = isCmd && typeof block.args?.command === 'string' ? block.args.command : '';
  const hasOutput = block.output !== undefined && (block.output.length > 0 || block.state !== 'running');
  const expandable = Boolean(showDiff || fullCommand || showArgs || hasOutput || content || block.state === 'error');
  // Lệnh đang chạy có đầu ra → tự mở; dòng lồng trong nhóm đã mở → bày sẵn IN/OUT, xem trước, diff (một lần bấm là thấy hết, như Claude Code).
  const autoOpen = (isCmd && block.state === 'running' && Boolean(block.output)) || (nested && Boolean(fullCommand || content || showDiff));
  const open = expandable && (userOpen ?? autoOpen);

  const running = block.state === 'running';
  const { dot, cls } = toolTone(block.state);
  const stateText =
    block.state === 'error' ? t('tool.failed') : block.state === 'denied' ? t('tool.denied') : block.state === 'cancelled' ? t('tool.cancelled') : '';

  const meta: string[] = [];
  if (block.summary && !showDiff && lineCount === undefined) meta.push(block.summary);
  // (lane:perm-rules) Luật allow đã cho lệnh này qua không cần hỏi.
  if (block.rule) meta.push(t('tool.allowedByRule', { rule: block.rule }));
  // Agent con đã xong/đã dừng: số liệu cuối («461,4k token · 12 lệnh») để so sánh các agent với nhau.
  if (block.agent) {
    const s = agentStats(block);
    if (s.tokens > 0 || s.tools > 0) meta.push(`${t('par.agent.tokens', { n: formatCompact(s.tokens, lang) })} · ${t('par.agent.tools', { n: formatInt(s.tools, lang) })}`);
  }
  if (block.durationMs !== undefined && block.durationMs >= 400) meta.push(formatDuration(block.durationMs, lang));

  const openFile = desc.file && platform === 'vscode' ? () => post({ type: 'open_file', path: desc.file!.path, line: desc.file!.line }) : undefined;
  const pathLike = d.kind === 'path' && !!desc.file;
  // (lane:cc-timeline-ui) Bấm đường dẫn = mở tệp (VS Code), không gập dòng. Nằm trong nút tool-head nên dùng span role=link (không lồng <button>) + chặn nổi bọt.
  const openFileOnClick = openFile
    ? (e: Event) => {
        e.stopPropagation();
        openFile();
      }
    : undefined;
  const openFileOnKey = openFile
    ? (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openFile();
        }
      }
    : undefined;

  const head = (
    <>
      <span class="act-icon">
        <StatusDot tone={dot} />
      </span>
      <span class="tool-text">
        <span class="cc-tool-line">
          {block.step !== undefined && (
            <span class="tool-step" title={t('tool.step', { n: block.step })} aria-label={t('tool.step', { n: block.step })}>
              {block.step}
            </span>
          )}
          <b class={cx('cc-action', cls)}>{name}</b>
          {d.text &&
            (pathLike ? (
              // Đường dẫn đầy đủ màu liên kết; bấm mở tệp (VS Code). Không cắt — xuống dòng như ảnh mẫu.
              <span class="cc-desc cc-path" title={openFile ? `${t('cc.openFile')}: ${d.text}` : d.text} onClick={openFileOnClick} onKeyDown={openFileOnKey} role={openFile ? 'link' : undefined} tabIndex={openFile ? 0 : undefined}>
                {d.text}
              </span>
            ) : (
              <span class={cx('cc-desc', (d.kind === 'command' || d.kind === 'url') && 'is-code')} title={d.text}>
                {d.text}
              </span>
            ))}
          {stateText && <span class={cx('tool-state', cls)}>{stateText}</span>}
        </span>
      </span>
      <span class="tool-meta">
        {showDiff && (
          <span class="diff-stat">
            <span class="diff-stat-add">+{showDiff.added}</span>
            <span class="diff-stat-del">−{showDiff.removed}</span>
          </span>
        )}
        {lineCount !== undefined && !showDiff && <span class="tool-meta-text cc-lines">{t('cc.lines', { n: formatInt(lineCount, lang) })}</span>}
        {meta.length > 0 && <span class="tool-meta-text">{meta.join(' · ')}</span>}
        {expandable && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />}
      </span>
    </>
  );

  return (
    <div class={cx('act-row', 'tool-row', 'cc-tool', nested && 'is-nested', `state-${block.state}`, running && 'is-running')} role="listitem">
      <div class="tool-line">
        {expandable ? (
          <button type="button" class="tool-head" aria-expanded={open} onClick={() => setUserOpen(!open)}>
            {head}
          </button>
        ) : (
          <div class="tool-head is-static">{head}</div>
        )}
        {openFile && (
          <button type="button" class="tool-open" title={t('tool.openFile')} aria-label={`${t('tool.openFile')}: ${desc.file!.path}`} onClick={openFile}>
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
          {fullCommand && <CmdInOut command={fullCommand} output={block.output} error={block.state === 'error'} running={running} />}
          {content && block.state !== 'error' && <FilePreview content={content} path={desc.file?.path ?? ''} />}
          {showDiff && <DiffView diff={showDiff} callId={block.id} collapsedRows={nested ? 10 : 18} />}
          {showArgs && (
            <div class="tool-section">
              <div class="tool-section-title">{t('tool.args')}</div>
              <pre class="tool-pre">{argsJson(block.args)}</pre>
            </div>
          )}
          {hasOutput && !fullCommand && (
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

/** Nhóm cùng tên («Đã đọc 5 tệp») / nhóm sửa tệp («Đã sửa 3 tệp»): trong một nhóm NGƯỜI DÙNG VỪA MỞ (`defaultOpen`) thì bày sẵn từng dòng như Claude Code. */
function ToolGroupView({ name, blocks, defaultOpen = false }: { name: string; blocks: ToolBlock[]; defaultOpen?: boolean }) {
  const { t, lang } = useApp();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => setUserOpen(typeof v === 'function' ? v(open) : v);
  const errors = blocks.filter((b) => b.state === 'error').length;

  return (
    <div class={cx('act-row', 'tool-group', 'cc-group', errors > 0 && 'has-fail')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span class="act-icon">
          <StatusDot tone={errors > 0 ? 'fail' : 'ok'} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{groupLabel(lang, name, blocks.length)}</span>
        </span>
        <span class="tool-meta">
          {errors > 0 && <span class="tool-state tone-danger">{t('par.failed', { n: formatInt(errors, lang) })}</span>}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
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

function EditGroupView({ blocks, defaultOpen = false }: { blocks: ToolBlock[]; defaultOpen?: boolean }) {
  const { t, lang } = useApp();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => setUserOpen(typeof v === 'function' ? v(open) : v);
  const added = blocks.reduce((n, b) => n + (b.diff?.added ?? 0), 0);
  const removed = blocks.reduce((n, b) => n + (b.diff?.removed ?? 0), 0);
  const errors = blocks.filter((b) => b.state === 'error').length;
  const running = blocks.some((b) => b.state === 'running');
  return (
    <div class={cx('act-row', 'tool-group', 'tool-edits', 'cc-group', errors > 0 && 'has-fail')} role="listitem">
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t('tool.group.edits', { n: blocks.length })}>
        <span class="act-icon">
          <StatusDot tone={errors > 0 ? 'fail' : running ? 'live' : 'ok'} />
        </span>
        <span class="tool-text">
          <span class="tool-label">{t('tool.group.edits', { n: blocks.length })}</span>
        </span>
        <span class="tool-meta">
          {added > 0 && <span class="diff-stat-add">+{added}</span>}
          {removed > 0 && <span class="diff-stat-del">−{removed}</span>}
          {errors > 0 && <span class="tool-state tone-danger">{t('par.failed', { n: formatInt(errors, lang) })}</span>}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} class="tool-chevron" />
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
