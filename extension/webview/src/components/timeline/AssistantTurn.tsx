import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AssistantItem, CompactInfo, NoticeItem } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact } from '../../format';
import { Markdown } from '../../markdown/Markdown';
import { estimateTokens } from '../../../../src/core/engine/tokens';
import type { ABlock } from '../../../../src/shared/protocol';
import { useCountUp, useElapsed } from '../../hooks';
import { activityStats, buildSegments, groupActivityRuns, latestRunningTool, needsWorkingIndicator, splitWork, turnPlainText, type NoticeBlockT, type Segment, type WorkStats } from '../../timeline';
import { actionName, agentRowsOf, backgroundOf, formatSeconds } from '../../timelineCc';
import { LoSpinner } from '../Brand';
import { LoActor } from '../LoActor';
import { seedFrom } from '../../brand/actorPlan';
import { cx, copyText, memo } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Button } from '../ui';
import { ActivitySegment } from './Activity';
import { AgentRow } from './AgentRow';
import { ArtifactCard } from './ArtifactCard';
import { CollapseFoot } from './CollapseFoot';
import { CompactRow } from './CompactRow';
import { PermissionCard } from './PermissionCard';
import { RunHead, StatusDot } from './RunHead';
import { Stamp } from './TimeMarks';
import { VerifyRow } from './VerifyRow'; // (lane:blind-verifier)
import { BranchBacklink } from '../MessageBranch'; // (lane:sessions-ux)

/**
 * Thông báo (lane:cc-timeline-ui): mức info = chấm nhỏ + chữ nghiêng xám (như «Idle 1d 16h…» của Claude Code);
 * warn/error nổi hơn (chấm cam/đỏ, chữ rõ, viền trái mảnh) nhưng KHÔNG tô nền kín. Có `compact` → dòng nén ngữ cảnh mở ra được.
 */
export function NoticeView({
  level,
  text,
  compact,
  onRetry,
}: {
  level: 'info' | 'warn' | 'error';
  text: string;
  compact?: CompactInfo;
  onRetry?: () => void;
}) {
  const { t } = useApp();
  if (compact) return <CompactRow compact={compact} text={text} />;
  return (
    <div class={cx('notice', `notice-${level}`, 'cc-notice')} role={level === 'error' ? 'alert' : 'status'}>
      <span class="notice-icon">
        <StatusDot tone={level === 'info' ? 'muted' : level === 'warn' ? 'warn' : 'fail'} />
      </span>
      <div class="notice-text">{text}</div>
      {onRetry && (
        <Button small variant="secondary" icon="refresh" onClick={onRetry}>
          {t('turn.retry')}
        </Button>
      )}
    </div>
  );
}

export function StandaloneNotice({ item, canRetry }: { item: NoticeItem; canRetry: boolean }) {
  if (item.verify) return <VerifyRow verify={item.verify} standalone />; // (lane:blind-verifier) /verify
  if (item.fork) return <BranchBacklink item={item} />; // (lane:sessions-ux) dòng «Rẽ nhánh từ …»
  return (
    <div class="turn turn-notice">
      <NoticeView level={item.level} text={item.text} compact={item.compact} onRetry={canRetry && item.level === 'error' ? () => post({ type: 'retry' }) : undefined} />
    </div>
  );
}

/** Nhãn đang chạy cuối lượt (như «Actualizing…» của Claude Code): logo «Lo» nhỏ xoay nhẹ + từ trạng thái đậm, không dấu «…». */
function WorkingIndicator({ empty, blocks, turnId }: { empty: boolean; blocks: readonly ABlock[]; turnId: string }) {
  const { t, lang, settings } = useApp();
  const seed = useMemo(() => seedFrom(turnId), [turnId]); // (0.7.2) hạt giống cố định theo lượt → thứ tự nhân vật không đổi khi render lại
  // Token đã sinh trong lượt này (chữ trả lời + suy nghĩ), ước lượng từ nội dung đang stream; số chạy mượt, kèm số giây đã trôi.
  const tokens = useMemo(() => {
    let n = 0;
    for (const b of blocks) if (b.type === 'text' || b.type === 'thinking') n += estimateTokens(b.text);
    return n;
  }, [blocks]);
  const shown = useCountUp(tokens, true);
  const secs = useElapsed(true);
  const stat = [tokens > 0 ? t('act.thinkTokens', { n: shown.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US') }) : '', secs !== null && secs >= 1 ? formatSeconds(secs * 1000, lang) : ''].filter(Boolean).join(' · ');
  return (
    <div class="working cc-working" role="status">
      {settings.workingCharacters !== false && settings.liteMode !== true ? <LoActor seed={seed} /> : <LoSpinner size={15} />}
      <span class="cc-working-label">{empty ? t('turn.preparing') : t('act.working')}</span>
      {stat && <span class="work-stat">{stat}</span>}
    </div>
  );
}

function TurnFooter({ item, isLast }: { item: AssistantItem; isLast: boolean }) {
  const { t, lang } = useApp();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const text = useMemo(() => turnPlainText(item), [item.blocks]);
  const u = item.usage;
  const hasErrorNotice = item.blocks.some((b) => b.type === 'notice' && b.level === 'error');

  const doCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div class="turn-footer">
      {item.stopReason === 'aborted' && <span class="turn-note">{t('turn.stopped')}</span>}
      {item.stopReason === 'max_tokens' && <span class="turn-note is-warn">{t('turn.maxTokens')}</span>}
      <span class="turn-spacer" />
      {u && (u.inputTokens > 0 || u.outputTokens > 0) && (
        <span class="turn-usage" title={`${item.provider} · ${item.model}`}>
          {t('turn.usage', { in: formatCompact(u.inputTokens, lang), out: formatCompact(u.outputTokens, lang) })}
          {u.reasoningTokens ? ` · ${t('turn.usageThink', { n: formatCompact(u.reasoningTokens, lang) })}` : ''}
        </span>
      )}
      {text && (
        <button type="button" class="turn-action" onClick={doCopy} aria-label={t('turn.copy')} title={t('turn.copy')}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied && <span>{t('turn.copied')}</span>}
        </button>
      )}
      {isLast && !hasErrorNotice && (item.stopReason === 'aborted' || item.stopReason === 'error') && (
        <button type="button" class="turn-action" onClick={() => post({ type: 'retry' })} title={t('turn.retry')} aria-label={t('turn.retry')}>
          <Icon name="refresh" size={14} />
          <span>{t('turn.retry')}</span>
        </button>
      )}
    </div>
  );
}

/** Các dòng agent con của một cụm: luôn hiện ngay dưới dòng nhóm khi nhóm GẬP (mở ra thì chúng nằm trong thân, đúng vị trí). */
function AgentLines({ rows }: { rows: Parameters<typeof agentRowsOf>[0] }) {
  const agents = useMemo(() => agentRowsOf(rows), [rows]);
  if (agents.length === 0) return null;
  return (
    <div class="act cc-agents" role="list">
      {agents.map((b) => (
        <AgentRow key={b.id} block={b} />
      ))}
    </div>
  );
}

/**
 * (0.6.3 → lane:cc-timeline-ui) Dòng nhóm của một lượt ĐÃ XONG: «[chấm] 22 lệnh gọi công cụ · 2 lỗi · sửa 3 tệp   2 phút 13 giây ⌄».
 * Bấm để mở lại đúng như lúc đang chạy; mặc định gấp để câu trả lời cuối không bị đẩy xuống dưới một chuỗi dài suy nghĩ / công cụ / chữ xen giữa.
 */
function WorkSummary({ stats, open, onToggle, rows, live = false }: { stats: WorkStats; open: boolean; onToggle: () => void; rows: Parameters<typeof agentRowsOf>[0]; live?: boolean }) {
  const { t } = useApp();
  return (
    <div class="act work-sum" role="list">
      <div class={cx('act-row', 'work-row', 'cc-group', open && 'is-open', stats.failed > 0 && 'has-fail')} role="listitem">
        <RunHead calls={stats.calls} failed={stats.failed} edits={stats.edits} steps={stats.steps} live={live} durationMs={stats.durationMs} open={open} onToggle={onToggle} expandTitle={t('work.expand')} collapseTitle={t('work.collapse')} />
        {!open && <AgentLines rows={rows} />}
      </div>
    </div>
  );
}

/**
 * (0.6.28) MỘT dòng cho cả quá trình đang chạy — như Claude Code: mọi thứ (gọi công cụ, bash, test, suy nghĩ,
 * dòng trạng thái, tác vụ, sửa tệp) nằm trong một dòng; bấm ra xem đầy đủ, y như lúc chưa gộp.
 * Không bỏ thứ gì: phần thân chính là các đoạn hoạt động gốc, giữ nguyên thứ tự và cách nhóm bên trong.
 * Đang chạy: «Đang chạy Lệnh · 10 lệnh gọi công cụ» + «Chạy nền» khi lệnh chạy nền. Agent con luôn hiện ngay dưới dòng.
 */
function ActivityRun({ segs, live, render }: { segs: Segment[]; live: boolean; render: (s: Segment, streaming: boolean, activityLive: boolean, expanded: boolean) => VNode }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => segs.flatMap((s) => (s.kind === 'activity' ? s.rows : [])), [segs]);
  const stats = useMemo(() => activityStats(rows), [rows]);
  const latest = live ? latestRunningTool(rows) : null;

  return (
    <div class={cx('act-row', 'tool-group', 'run-group', 'cc-group', stats.failed > 0 && 'has-fail')} role="listitem" data-testid="activity-run">
      <RunHead
        calls={stats.calls}
        failed={stats.failed}
        edits={stats.edits}
        steps={stats.steps}
        live={live}
        runningTool={latest ? actionName(lang, latest.name) : undefined}
        background={backgroundOf(latest)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        expandTitle={t('run.expand')}
        collapseTitle={t('run.collapse')}
      />
      {!open && <AgentLines rows={rows} />}
      {open && (
        <div class="tool-group-body run-body" role="list">
          {segs.map((s, i) => render(s, false, live && i === segs.length - 1, true))}
          <CollapseFoot onCollapse={() => setOpen(false)} label={t('run.collapse')} />
        </div>
      )}
    </div>
  );
}

function AssistantTurnView({ item, live, isLast }: { item: AssistantItem; live: boolean; isLast: boolean }) {
  const { t, settings, platform } = useApp();
  const [workOpen, setWorkOpen] = useState(false);
  const segments = useMemo(
    () => buildSegments(item.blocks, item.done, settings.showThinking, live),
    [item.blocks, item.done, settings.showThinking, live],
  );
  const split = useMemo(() => {
    // Lượt đã xong: gấp toàn bộ phần quá trình như trước.
    if (item.done && !live) return splitWork(segments, item.blocks, item.ts, item.endedAt);
    // Lượt ĐANG chạy: cũng gấp, nhưng chỉ khi đã có từ 3 bước trở lên — ít bước thì để nguyên cho thấy tiến độ,
    // và dòng "đang làm việc" bên dưới vẫn hiện. Bấm vào dòng tóm tắt để mở lại chi tiết.
    if (live) {
      const s = splitWork(segments, item.blocks, item.ts, undefined);
      // Đếm cả `kept`: câu trả lời dài được giữ riêng (hiện ngoài khối gấp) nhưng vẫn là một phần của quá trình.
      return s && s.work.length + s.kept.length >= 3 ? s : null;
    }
    return null;
  }, [segments, item.done, live, item.blocks, item.ts, item.endedAt]);
  const workRows = useMemo(() => (split ? split.work.flatMap((s) => (s.kind === 'activity' ? s.rows : [])) : []), [split]);
  const vscode = platform === 'vscode';

  const runs = useMemo(() => groupActivityRuns(segments), [segments]);

  const render = (seg: Segment, streaming: boolean, activityLive: boolean, expanded = false) => {
    switch (seg.kind) {
      case 'activity':
        return <ActivitySegment key={seg.key} rows={seg.rows} live={activityLive} expanded={expanded} />;
      case 'text':
        return (
          <div key={seg.key} class="turn-text">
            <Markdown text={seg.block.text} streaming={streaming} media={vscode && !streaming} />
          </div>
        );
      case 'artifact':
        return <ArtifactCard key={seg.key} block={seg.block} />;
      case 'permission':
        return <PermissionCard key={seg.key} block={seg.block} />;
      case 'notice': {
        const b: NoticeBlockT = seg.block;
        if (b.verify) return <VerifyRow key={seg.key} verify={b.verify} />; // (lane:blind-verifier)
        return (
          <NoticeView
            key={seg.key}
            level={b.level}
            text={b.text}
            compact={b.compact}
            onRetry={isLast && item.done && b.level === 'error' ? () => post({ type: 'retry' }) : undefined}
          />
        );
      }
    }
  };

  return (
    <section class="turn turn-assistant" aria-label={t('turn.assistant')} aria-busy={live}>
      {split ? (
        <>
          <WorkSummary stats={split.stats} open={workOpen} onToggle={() => setWorkOpen((v) => !v)} rows={workRows} live={live} />
          {workOpen ? (
            <div class="work-body">
              {split.work.map((seg) => render(seg, false, false, true))}
              {/* Đóng tại chỗ: khối quá trình có thể dài hơn màn hình, không phải cuộn lên đầu để thu gọn. */}
              <CollapseFoot onCollapse={() => setWorkOpen(false)} label={t('work.collapse')} />
            </div>
          ) : (
            split.changes && render(split.changes, false, false)
          )}
          {split.kept.map((seg) => render(seg, false, false))}
          {/* Giờ của câu trả lời mở đầu sau một nhóm (như «6:16 PM» của Claude Code) — lấy từ lúc lượt xong; thiếu thì không vẽ. */}
          {item.done && split.tail.length > 0 && <Stamp ts={item.endedAt} />}
          {/* (lane:cc-timeline-ui) Lượt đang chạy: đoạn cuối của đuôi vẫn "sống" (đang nghĩ / đang gõ), không vẽ cứng live=false. */}
          {split.tail.map((seg, ti) => render(seg, live && ti === split.tail.length - 1 && seg.kind === 'text', live && ti === split.tail.length - 1))}
        </>
      ) : (
        // Lượt đang chạy (hoặc lượt ngắn): gom MỌI đoạn hoạt động liền nhau thành MỘT dòng.
        runs.map((run, ri) =>
          run.kind === 'run' ? (
            <ActivityRun key={run.key} segs={run.items} live={live} render={render} />
          ) : (
            render(run.seg, live && ri === runs.length - 1 && run.seg.kind === 'text', live && ri === runs.length - 1)
          ),
        )
      )}
      {live && needsWorkingIndicator(item.blocks) && <WorkingIndicator empty={item.blocks.length === 0} blocks={item.blocks} turnId={item.id} />}
      {item.done && <TurnFooter item={item} isLast={isLast} />}
    </section>
  );
}

export const AssistantTurn = memo(AssistantTurnView);
