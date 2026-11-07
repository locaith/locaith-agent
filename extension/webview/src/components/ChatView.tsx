import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ViewState } from '../../../src/shared/protocol';
import { useApp } from '../ctx';
import { timelineMarks } from '../timelineCc';
import { Icon } from './Icons';
import { LocaithConsentCard } from './LocaithConsent';
import { Welcome } from './Welcome';
import { AssistantTurn, StandaloneNotice } from './timeline/AssistantTurn';
import { DayDivider, Stamp } from './timeline/TimeMarks';
import { UserMessage } from './timeline/UserMessage';

const NEAR_BOTTOM_PX = 56;

export function ChatView({ view, hasAnyKey }: { view: ViewState; hasAnyKey: boolean }) {
  const { t } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showPill, setShowPill] = useState(false);

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stick.current = near;
    setShowPill(!near);
  };

  // Theo dõi nội dung phình ra (stream) → tự cuộn xuống nếu người dùng đang ở cuối.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Tin nhắn mới của người dùng hoặc đổi cuộc trò chuyện → luôn nhảy xuống cuối.
  const last = view.transcript[view.transcript.length - 1];
  const lastIsUser = last?.kind === 'user';
  useEffect(() => {
    stick.current = true;
    scrollToBottom();
  }, [view.sessionId, view.transcript.length === 0, lastIsUser ? last?.id : undefined]);

  // (lane:cc-timeline-ui) mốc giờ/ngày — O(n) trên số mục (không phải số khối), tính lại khi transcript đổi.
  const marks = useMemo(() => timelineMarks(view.transcript), [view.transcript]);

  const lastUserIdx = (() => {
    for (let i = view.transcript.length - 1; i >= 0; i--) if (view.transcript[i].kind === 'user') return i;
    return -1;
  })();

  return (
    <div class="chat">
      <div class="timeline" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
        <div class="timeline-inner" ref={innerRef}>
          {view.transcript.length === 0 ? (
            <Welcome view={view} hasAnyKey={hasAnyKey} />
          ) : (
            view.transcript.map((item, i) => {
              const isLast = i === view.transcript.length - 1;
              // (lane:cc-timeline-ui) đường ngăn ngày khi sang ngày mới + giờ nhỏ trên mỗi tin người dùng (giờ của câu trả lời nằm trong AssistantTurn).
              const mark = marks.get(item.id);
              const before = mark && (
                <>
                  {mark.day !== undefined && <DayDivider ts={mark.day} />}
                  {item.kind === 'user' && mark.time !== undefined && <Stamp ts={mark.time} />}
                </>
              );
              if (item.kind === 'user')
                return (
                  <Fragment key={item.id}>
                    {before}
                    <UserMessage item={item} canEdit={i === lastUserIdx && !view.running} busy={view.running} />
                  </Fragment>
                );
              if (item.kind === 'assistant')
                return (
                  <Fragment key={item.id}>
                    {before}
                    <AssistantTurn item={item} live={view.running && !item.done} isLast={isLast} />
                  </Fragment>
                );
              return (
                <Fragment key={item.id}>
                  {before}
                  <StandaloneNotice item={item} canRetry={isLast && !view.running} />
                </Fragment>
              );
            })
          )}
          {/* Thông báo dữ liệu của mô hình Locaith: thẻ ở cuối cuộc trò chuyện, không phải hộp thoại. */}
          {view.locaith?.card && <LocaithConsentCard info={view.locaith} account={view.account} />}
        </div>
      </div>
      {showPill && view.transcript.length > 0 && (
        <button
          type="button"
          class="scroll-pill"
          onClick={() => {
            stick.current = true;
            scrollToBottom(true);
            setShowPill(false);
          }}
        >
          <Icon name="arrow-down" size={14} />
          {t('scroll.bottom')}
        </button>
      )}
    </div>
  );
}
