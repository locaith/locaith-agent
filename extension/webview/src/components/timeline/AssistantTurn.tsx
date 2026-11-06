import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AssistantItem, NoticeItem } from '../../../../src/shared/protocol';
import { useApp } from '../../ctx';
import { formatCompact, formatDuration, formatInt } from '../../format';
import { Markdown } from '../../markdown/Markdown';
import { estimateTokens } from '../../../../src/core/engine/tokens';
import type { ABlock } from '../../../../src/shared/protocol';
import { useCountUp, useElapsed } from '../../hooks';
import { buildSegments, needsWorkingIndicator, splitWork, turnPlainText, type NoticeBlockT, type Segment, type WorkStats } from '../../timeline';
import { LoSpinner } from '../Brand';
import { cx, copyText, memo } from '../../util';
import { post } from '../../vscode';
import { Icon } from '../Icons';
import { Button } from '../ui';
import { ActivitySegment } from './Activity';
import { ArtifactCard } from './ArtifactCard';
import { PermissionCard } from './PermissionCard';

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
    <div class="working" role="status">
      <LoSpinner size={20} />
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
  const parts: string[] = [];
  if (stats.calls > 0) parts.push(t('work.calls', { n: formatInt(stats.calls, lang) }));
  else if (stats.steps > 0) parts.push(t('work.steps', { n: formatInt(stats.steps, lang) }));
  if (stats.edits > 0) parts.push(t('work.edits', { n: formatInt(stats.edits, lang) }));
  return (
    <div class="act work-sum" role="list">
      <div class={cx('act-row', 'work-row', open && 'is-open')} role="listitem">
        <button type="button" class="tool-head" aria-expanded={open} title={open ? t('work.collapse') : t('work.expand')} onClick={onToggle}>
          <span class="act-icon tone-ok">
            <Icon name="list-checks" size={15} />
          </span>
          <span class="tool-text">
            <span class="work-line">
              <span class="tool-label work-head">{head}</span>
              {parts.map((p) => (
                <span key={p} class="work-part">
                  {p}
                </span>
              ))}
              {stats.failed > 0 && <span class="work-part tone-danger">{t('par.failed', { n: formatInt(stats.failed, lang) })}</span>}
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
      return s && s.work.length >= 3 ? s : null;
    }
    return null;
  }, [segments, item.done, live, item.blocks, item.ts, item.endedAt]);
  const lastIdx = segments.length - 1;
  const vscode = platform === 'vscode';

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
          {workOpen ? <div class="work-body">{split.work.map((seg) => render(seg, false, false))}</div> : split.changes && render(split.changes, false, false)}
          {split.kept.map((seg) => render(seg, false, false))}
          {split.tail.map((seg) => render(seg, false, false))}
        </>
      ) : (
        segments.map((seg, i) => render(seg, live && i === lastIdx, live && i === lastIdx))
      )}
      {live && needsWorkingIndicator(item.blocks) && <WorkingIndicator empty={item.blocks.length === 0} blocks={item.blocks} />}
      {item.done && <TurnFooter item={item} isLast={isLast} />}
    </section>
  );
}

export const AssistantTurn = memo(AssistantTurnView);
