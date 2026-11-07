import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AssistantItem, NoticeItem } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { Markdown } from '../../markdown/Markdown';
import { estimateTokens } from '../../../../src/core/engine/tokens';
import type { ABlock } from '../../../../src/shared/protocol';
import { useCountUp, useElapsed } from '../../hooks';
import { activityStats, buildSegments, groupActivityRuns, latestRunningTool, needsWorkingIndicator, splitWork, turnPlainText, type NoticeBlockT, type Segment, type WorkStats } from '../../timeline';
import { latestLabel } from './latestLabel';
import { LoSpinner } from '../Brand';
import { cx, copyText, memo } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Button } from '../ui';
import { ActivitySegment } from './Activity';
import { ArtifactCard } from './ArtifactCard';
import { CollapseFoot } from './CollapseFoot';
import { PermissionCard } from './PermissionCard';
import { VerifyRow } from './VerifyRow'; // (lane:blind-verifier)

export function NoticeView({
  level,
  text,
  onRetry,
}: {
  level: 'info' | 'warn' | 'error';
  text: string;
  onRetry?: () => void;
}) {
  const { t } = useApp();
  return (
    <div class={cx('notice', `notice-${level}`)} role={level === 'error' ? 'alert' : 'status'}>
      <span class="notice-icon">
        <Icon name={level === 'info' ? 'info' : 'alert'} size={16} />
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
  return (
    <div class="turn turn-notice">
      <NoticeView level={item.level} text={item.text} onRetry={canRetry && item.level === 'error' ? () => post({ type: 'retry' }) : undefined} />
    </div>
  );
}

function WorkingIndicator({ empty, blocks }: { empty: boolean; blocks: readonly ABlock[] }) {
  const { t, lang } = useApp();
  // Token đã sinh trong lượt này (chữ trả lời + suy nghĩ), ước lượng từ nội dung đang stream; số chạy mượt, kèm số giây đã trôi.
  const tokens = useMemo(() => {
    let n = 0;
    for (const b of blocks) if (b.type === 'text' || b.type === 'thinking') n += estimateTokens(b.text);
    return n;
  }, [blocks]);
  const shown = useCountUp(tokens, true);
  const secs = useElapsed(true);
  const stat = [tokens > 0 ? t('act.thinkTokens', { n: shown.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US') }) : '', secs !== null && secs >= 1 ? `${secs} s` : ''].filter(Boolean).join(' · ');
  return (
    <div class="working working-stage" role="status">
      {/* Mascot: logo Locaith tách thành ba robot nhỏ nhún nhảy — để lúc chờ dài không thấy trống. Thuần CSS, tự dừng khi giảm chuyển động. */}
      <div class="mascot" aria-hidden="true">
        <LoSpinner size={18} />
        <span class="mascot-bots">
          <span class="mascot-bot b1" />
          <span class="mascot-bot b2" />
          <span class="mascot-bot b3" />
        </span>
      </div>
      <span>{empty ? t('turn.preparing') : t('act.working')}</span>
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

/**
 * (0.6.3) Dòng «Đã làm việc 2 phút 13 giây · 14 thao tác · sửa 3 tệp» thay cho cả quá trình của một lượt đã xong (timeline.ts → splitWork).
 * Bấm để mở lại đúng như lúc đang chạy; mặc định gấp để câu trả lời cuối không bị đẩy xuống dưới một chuỗi dài suy nghĩ / công cụ / chữ xen giữa.
 */
function WorkSummary({ stats, open, onToggle }: { stats: WorkStats; open: boolean; onToggle: () => void }) {
  const { t, lang } = useApp();
  const head = stats.durationMs ? t('work.head', { d: formatDuration(stats.durationMs, lang) }) : t('work.headPlain');
  // Màu theo loại số liệu để đọc nhanh: thao tác = trung tính, tệp đã sửa = xanh ngọc, lỗi = đỏ.
  const parts: { text: string; tone: string }[] = [];
  if (stats.calls > 0) parts.push({ text: t('work.calls', { n: formatInt(stats.calls, lang) }), tone: 'is-calls' });
  else if (stats.steps > 0) parts.push({ text: t('work.steps', { n: formatInt(stats.steps, lang) }), tone: 'is-calls' });
  if (stats.edits > 0) parts.push({ text: t('work.edits', { n: formatInt(stats.edits, lang) }), tone: 'is-edits' });
  return (
    <div class="act work-sum" role="list">
      <div class={cx('act-row', 'work-row', open && 'is-open', stats.failed > 0 && 'has-fail')} role="listitem">
        <button type="button" class="tool-head" aria-expanded={open} title={open ? t('work.collapse') : t('work.expand')} onClick={onToggle}>
          <span class={cx('act-icon', stats.failed > 0 ? 'tone-danger' : 'tone-ok')}>
            <Icon name="list-checks" size={15} />
          </span>
          <span class="tool-text">
            <span class="work-line">
              <span class="tool-label work-head">{head}</span>
              {parts.map((p) => (
                <span key={p.text} class={cx('work-part', p.tone)}>
                  {p.text}
                </span>
              ))}
              {stats.failed > 0 && <span class="work-part is-fail">{t('par.failed', { n: formatInt(stats.failed, lang) })}</span>}
            </span>
          </span>
          <span class="tool-meta">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * (0.6.28) MỘT dòng cho cả quá trình đang chạy — như Claude Code: mọi thứ (gọi công cụ, bash, test, suy nghĩ,
 * dòng trạng thái, tác vụ, sửa tệp) nằm trong một dòng; bấm ra xem đầy đủ, y như lúc chưa gộp.
 * Không bỏ thứ gì: phần thân chính là các đoạn hoạt động gốc, giữ nguyên thứ tự và cách nhóm bên trong.
 */
function ActivityRun({ segs, live, render }: { segs: Segment[]; live: boolean; render: (s: Segment, streaming: boolean, activityLive: boolean) => VNode }) {
  const { t, lang } = useApp();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => segs.flatMap((s) => (s.kind === 'activity' ? s.rows : [])), [segs]);
  const stats = useMemo(() => activityStats(rows), [rows]);
  const latest = live ? latestRunningTool(rows) : null;
  const now = latest ? latestLabel(lang, latest) : '';
  // Cùng cách đọc màu như dòng «Đã làm việc»: thao tác trung tính · tệp xanh ngọc · lỗi đỏ.
  const head = stats.calls > 0 ? t('par.calls', { n: formatInt(stats.calls, lang) }) : t('act.steps', { n: formatInt(stats.steps, lang) });

  return (
    <div class={cx('act-row', 'tool-group', 'run-group', stats.failed > 0 && 'has-fail')} role="listitem" data-testid="activity-run">
      <button type="button" class="tool-head" aria-expanded={open} title={open ? t('run.collapse') : t('run.expand')} onClick={() => setOpen((v) => !v)}>
        <span class={cx('act-icon', stats.failed > 0 ? 'tone-danger' : live ? 'tone-accent' : 'tone-ok')}>{live ? <LoSpinner size={15} /> : <Icon name="list-checks" size={15} />}</span>
        <span class="tool-text">
          <span class="work-line">
            <span class="tool-label">{head}</span>
            {stats.edits > 0 && <span class="work-part is-edits">{t('work.edits', { n: formatInt(stats.edits, lang) })}</span>}
            {stats.failed > 0 && <span class="work-part is-fail">{t('par.failed', { n: formatInt(stats.failed, lang) })}</span>}
          </span>
          {now && (
            <span class="run-now" title={now}>
              {now}
            </span>
          )}
        </span>
        <span class="tool-meta">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} class="tool-chevron" />
        </span>
      </button>
      {open && (
        <div class="tool-group-body run-body" role="list">
          {segs.map((s, i) => render(s, false, live && i === segs.length - 1))}
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
  const lastIdx = segments.length - 1;
  const vscode = platform === 'vscode';

  const runs = useMemo(() => groupActivityRuns(segments), [segments]);

  const render = (seg: Segment, streaming: boolean, activityLive: boolean) => {
    switch (seg.kind) {
      case 'activity':
        return <ActivitySegment key={seg.key} rows={seg.rows} live={activityLive} />;
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
          <WorkSummary stats={split.stats} open={workOpen} onToggle={() => setWorkOpen((v) => !v)} />
          {workOpen ? (
            <div class="work-body">
              {split.work.map((seg) => render(seg, false, false))}
              {/* Đóng tại chỗ: khối quá trình có thể dài hơn màn hình, không phải cuộn lên đầu để thu gọn. */}
              <CollapseFoot onCollapse={() => setWorkOpen(false)} label={t('work.collapse')} />
            </div>
          ) : (
            split.changes && render(split.changes, false, false)
          )}
          {split.kept.map((seg) => render(seg, false, false))}
          {split.tail.map((seg) => render(seg, false, false))}
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
      {live && needsWorkingIndicator(item.blocks) && <WorkingIndicator empty={item.blocks.length === 0} blocks={item.blocks} />}
      {item.done && <TurnFooter item={item} isLast={isLast} />}
    </section>
  );
}

export const AssistantTurn = memo(AssistantTurnView);
