/**
 * Stream Interceptor — Tầng 2 của kiến trúc.
 *
 * Nhận luồng sự kiện đã chuẩn hoá của một lần gọi model và định tuyến theo thời gian thực:
 *   - suy nghĩ  → khối "Suy nghĩ" trên giao diện + bộ đệm trượt cho bộ tóm tắt nền;
 *   - mã/nội dung dài trong đối số công cụ → bộ đệm trượt "đang viết…";
 *   - chữ thường → giao diện (sau khi tách thẻ <think> nếu model không có kênh suy luận riêng);
 *   - mỗi cụm ~700 ký tự (hoặc 1,5 giây) → gọi bộ tóm tắt KHÔNG chặn, kết quả thành "dòng trạng thái" (pill).
 */

import type { ProviderEvent } from '../types';
import type { PillKind, UiEvent } from '../../shared/protocol';
import { ThinkTagSplitter } from './thinkTags';
import { Summarizer, unescapeJsonFragment } from './summarizer';
import { t, type Lang } from './strings';

/** Bộ đếm dùng chung cho cả lượt trả lời (nhiều lần gọi model nối tiếp nhau). */
export interface PillBudget {
  seq: number;
  count: number;
}

export interface InterceptorOptions {
  assistantId: string;
  emit(ev: UiEvent): void;
  summarizer: Summarizer | null;
  /** Tách thẻ <think> trong dòng chữ (model không có kênh suy luận riêng). */
  thinkTags: boolean;
  toolInfo(name: string): { streamsContent: boolean; contentField?: string } | undefined;
  signal: AbortSignal;
  language: Lang;
  flushChars: number;
  flushMs: number;
  maxPills: number;
  budget: PillBudget;
  /** Sau bao lâu im lặng thì hiện "Đang suy nghĩ…" tạm thời. 0 = tắt. */
  waitIndicatorMs?: number;
  now?: () => number;
}

type Channel = 'thinking' | 'writing';

interface CallTrack {
  name: string;
  args: string;
  hint?: string;
}

export class StreamInterceptor {
  private readonly splitter: ThinkTagSplitter | null;
  private channel: Channel | null = null;
  private buf = '';
  private hint: string | undefined;
  private lastFlushAt: number;
  private inflight: Promise<void> | null = null;
  private phaseToken = 0;
  private currentPillId: string | null = null;
  private lastPillText = '';
  private readonly calls = new Map<string, CallTrack>();
  private activeWritingCall: string | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  /** Đã có chữ trả lời hiển thị cho người dùng trong lần gọi này chưa. */
  sawText = false;

  constructor(private readonly o: InterceptorOptions) {
    this.splitter = o.thinkTags ? new ThinkTagSplitter() : null;
    this.lastFlushAt = this.now();
    const wait = o.waitIndicatorMs ?? 700;
    if (wait > 0) {
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        if (this.finished || this.o.signal.aborted) return;
        this.o.emit({
          t: 'pill',
          id: this.o.assistantId,
          pillId: `${this.o.assistantId}:w${++this.o.budget.seq}`,
          text: t(this.o.language, 'thinking'),
          kind: 'working',
        });
      }, wait);
    }
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private clearWait(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  onEvent(ev: ProviderEvent): void {
    if (this.finished) return;
    if (ev.type !== 'usage' && ev.type !== 'retry' && ev.type !== 'queue') this.clearWait();

    switch (ev.type) {
      case 'thinking_delta':
        this.onThinking(ev.text);
        break;

      case 'text_delta':
        if (this.splitter) {
          for (const seg of this.splitter.push(ev.text)) {
            if (seg.kind === 'thinking') this.onThinking(seg.text);
            else this.onVisibleText(seg.text);
          }
        } else {
          this.onVisibleText(ev.text);
        }
        break;

      case 'tool_start': {
        this.endPhase();
        this.calls.set(ev.id, { name: ev.name, args: '' });
        if (this.o.toolInfo(ev.name)?.streamsContent) {
          this.activeWritingCall = ev.id;
          this.startPhase('writing');
        }
        break;
      }

      case 'tool_args_delta': {
        const call = this.calls.get(ev.id);
        if (!call || this.activeWritingCall !== ev.id) break;
        if (call.args.length < 6000) call.args += ev.delta;
        if (!call.hint) {
          call.hint = extractHint(call.args);
          if (call.hint) {
            this.hint = call.hint;
            this.retitleGenericPill();
          }
        }
        this.addToBuffer(unescapeJsonFragment(ev.delta));
        break;
      }

      case 'tool_end':
        if (this.activeWritingCall === ev.id) {
          this.endPhase();
          this.activeWritingCall = null;
        }
        break;

      case 'retry':
        this.o.emit({
          t: 'pill',
          id: this.o.assistantId,
          pillId: `${this.o.assistantId}:r${++this.o.budget.seq}`,
          text: t(this.o.language, 'retrying', {
            sec: Math.max(1, Math.round(ev.delayMs / 1000)),
            n: ev.attempt,
            max: ev.maxAttempts,
          }),
          kind: 'working',
        });
        break;

      // Hàng chờ của cổng Locaith: cùng một dòng trạng thái (cùng pillId) được cập nhật vị trí mỗi lần hỏi lại; đếm ngược từng giây nằm ở dải phía trên ô nhập.
      case 'queue':
        this.o.emit({
          t: 'pill',
          id: this.o.assistantId,
          pillId: `${this.o.assistantId}:queue`,
          text: t(this.o.language, 'queueing', { pos: ev.position }),
          kind: 'working',
        });
        break;

      case 'usage':
      case 'done':
        break;
    }
  }

  /** Hết luồng (thành công hoặc lỗi): xả phần dở dang và đợi tóm tắt đang bay (tối đa 1,5 giây). */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.clearWait();
    if (this.splitter) {
      for (const seg of this.splitter.flush()) {
        if (seg.kind === 'thinking') this.onThinking(seg.text);
        else this.onVisibleText(seg.text);
      }
    }
    this.finished = true;
    this.endPhase();
    if (this.inflight) {
      await Promise.race([this.inflight, new Promise<void>((r) => setTimeout(r, 1500))]);
    }
  }

  // ── nội bộ ────────────────────────────────────────────────────────────────

  private onThinking(text: string): void {
    if (!text) return;
    // (lane:cc-timeline-ui) đóng dấu lúc phát để giao diện tính «Đã suy nghĩ N giây» (chung cho VS Code, Chrome, CLI).
    this.o.emit({ t: 'thinking', id: this.o.assistantId, delta: text, ts: Date.now() });
    if (this.channel !== 'thinking') {
      this.endPhase();
      this.startPhase('thinking');
    }
    this.addToBuffer(text);
  }

  private onVisibleText(text: string): void {
    if (!text) return;
    if (this.channel) this.endPhase();
    this.sawText = true;
    this.o.emit({ t: 'text', id: this.o.assistantId, delta: text });
  }

  private startPhase(kind: Channel): void {
    this.channel = kind;
    this.buf = '';
    this.phaseToken++;
    this.lastFlushAt = this.now();
    this.hint = kind === 'writing' && this.activeWritingCall ? this.calls.get(this.activeWritingCall)?.hint : undefined;
    this.openGenericPill(kind);
  }

  private endPhase(): void {
    this.phaseToken++;
    this.channel = null;
    this.buf = '';
    this.currentPillId = null;
    this.hint = undefined;
  }

  private newPillId(): string {
    return `${this.o.assistantId}:p${++this.o.budget.seq}`;
  }

  private genericText(kind: Channel): string {
    if (kind === 'thinking') return t(this.o.language, 'thinking');
    return this.hint ? t(this.o.language, 'writingTo', { target: this.hint }) : t(this.o.language, 'writing');
  }

  private openGenericPill(kind: Channel): void {
    if (this.o.budget.count >= this.o.maxPills) {
      this.currentPillId = null;
      return;
    }
    this.o.budget.count++;
    const id = this.newPillId();
    this.currentPillId = id;
    const text = this.genericText(kind);
    this.lastPillText = text;
    this.o.emit({ t: 'pill', id: this.o.assistantId, pillId: id, text, kind: kind as PillKind });
  }

  /** Khi đã biết tên tệp/tiêu đề đang viết, cập nhật dòng "Đang soạn nội dung…" tại chỗ. */
  private retitleGenericPill(): void {
    if (this.channel !== 'writing' || !this.currentPillId) return;
    const text = this.genericText('writing');
    if (text === this.lastPillText) return;
    this.lastPillText = text;
    this.o.emit({ t: 'pill', id: this.o.assistantId, pillId: this.currentPillId, text, kind: 'writing' });
  }

  private addToBuffer(text: string): void {
    if (!this.channel) return;
    this.buf += text;
    this.maybeFlush();
  }

  private maybeFlush(): void {
    const s = this.o.summarizer;
    if (!s || !s.available || this.inflight || !this.channel || this.finished) return;
    if (this.o.budget.count >= this.o.maxPills && !this.currentPillId) return;
    const len = this.buf.length;
    if (len >= this.o.flushChars || (len >= 80 && this.now() - this.lastFlushAt >= this.o.flushMs)) {
      this.startFlush();
    }
  }

  private startFlush(): void {
    const summarizer = this.o.summarizer;
    if (!summarizer || !this.channel) return;
    const chunk = this.buf;
    const kind = this.channel;
    const hint = this.hint;
    const token = this.phaseToken;
    this.buf = '';
    this.lastFlushAt = this.now();

    this.inflight = (async () => {
      const text = await summarizer.summarize(chunk, kind, hint, this.o.signal);
      // Giai đoạn đã kết thúc (chữ trả lời/tool đã bắt đầu) → bỏ, tránh dòng trạng thái lạc ra sau câu trả lời.
      if (!text || token !== this.phaseToken || this.o.signal.aborted || this.finished) return;
      if (text === this.lastPillText) return;
      let id = this.currentPillId;
      if (!id) {
        if (this.o.budget.count >= this.o.maxPills) return;
        this.o.budget.count++;
        id = this.newPillId();
      }
      this.lastPillText = text;
      this.currentPillId = null; // lần tóm tắt tiếp theo sẽ mở dòng mới
      this.o.emit({ t: 'pill', id: this.o.assistantId, pillId: id, text, kind: kind as PillKind });
    })().finally(() => {
      this.inflight = null;
      this.maybeFlush();
    });
  }
}

/** Lấy gợi ý "đang viết gì" (đường dẫn/tiêu đề) từ JSON đối số đang chảy dở. */
export function extractHint(partialJson: string): string | undefined {
  const m = /"(?:path|file_path|title|filename|name)"\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(partialJson);
  if (!m) return undefined;
  return unescapeJsonFragment(m[1]);
}
