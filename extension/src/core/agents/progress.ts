/**
 * Báo tiến độ sống của agent con lên giao diện mà không làm ngập luồng sự kiện.
 *
 * `createProgressReporter`: gộp theo thời gian — gửi ngay nếu đã qua `minIntervalMs` kể từ lần gửi trước, nếu không thì giữ BẢN MỚI NHẤT và hẹn
 * gửi đúng lúc hết khoảng chờ (nên số cuối cùng luôn tới nơi); không gửi lại khi chẳng có gì đổi. Đồng hồ/hẹn giờ tiêm được để test không phải chờ thật.
 *
 * `createWorkflowProgress`: một workflow chạy nhiều agent con cùng lúc nhưng giao diện chỉ có MỘT dòng cho lệnh `workflow_run`; ở đây cộng số liệu
 * của mọi agent (token/lệnh/lỗi) và nói «N agent đang chạy · <việc của agent vừa báo>».
 */

import type { AgentProgress, UiEvent } from '../../shared/protocol';
import type { Lang } from '../engine/strings';

export const PROGRESS_MIN_INTERVAL_MS = 500; // ≤ 2 lần/giây cho mỗi dòng

export interface ProgressClock {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ProgressReporter {
  /** Báo số liệu mới nhất (ảnh chụp đầy đủ, không phải số gia). */
  update(p: AgentProgress): void;
  /** Gửi ngay bản đang chờ (nếu khác bản đã gửi). Gọi trước khi agent trả kết quả để số cuối cùng không mất. */
  flush(): void;
  /** Bỏ bản đang chờ, không gửi nữa (bị hủy / lỗi). */
  dispose(): void;
}

export function sameProgress(a: AgentProgress | undefined, b: AgentProgress | undefined): boolean {
  return !!a && !!b && a.tokens === b.tokens && a.tools === b.tools && (a.failed ?? 0) === (b.failed ?? 0) && (a.activity ?? '') === (b.activity ?? '');
}

export function createProgressReporter(o: { send(p: AgentProgress): void; minIntervalMs?: number } & ProgressClock): ProgressReporter {
  const min = o.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let sent: AgentProgress | undefined;
  let sentAt = Number.NEGATIVE_INFINITY;
  let pending: AgentProgress | undefined;
  let timer: unknown;

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };
  const emitNow = (p: AgentProgress): void => {
    sent = p;
    sentAt = now();
    pending = undefined;
    o.send(p);
  };

  return {
    update(p) {
      if (sameProgress(sent, p)) {
        pending = undefined; // quay về đúng giá trị đã gửi: bản chờ không còn ý nghĩa
        return;
      }
      const wait = sentAt + min - now();
      if (wait <= 0) {
        cancelTimer();
        emitNow(p);
        return;
      }
      pending = p;
      if (timer === undefined) {
        timer = setTimer(() => {
          timer = undefined;
          if (pending && !sameProgress(sent, pending)) emitNow(pending);
          else pending = undefined;
        }, wait);
      }
    },
    flush() {
      cancelTimer();
      if (pending && !sameProgress(sent, pending)) emitNow(pending);
      pending = undefined;
    },
    dispose() {
      cancelTimer();
      pending = undefined;
    },
  };
}

/** Tổng hợp tiến độ nhiều agent con của một workflow thành một dòng cho lệnh `workflow_run`. */
export interface WorkflowProgress {
  /** Một agent báo tiến độ (key duy nhất cho mỗi agent). */
  update(key: number, p: AgentProgress): void;
  /** Agent đã xong: số liệu cuối của nó vẫn nằm trong tổng, chỉ không còn tính là "đang chạy". */
  finish(key: number): void;
  flush(): void;
  dispose(): void;
}

const RUNNING_WORD: Record<Lang, (n: number) => string> = {
  vi: (n) => `${n} agent đang chạy`,
  en: (n) => `${n} agent${n === 1 ? '' : 's'} running`,
};

export function createWorkflowProgress(o: { emit(ev: UiEvent): void; assistantId: string; callId: string; lang: Lang } & ProgressClock): WorkflowProgress {
  const agents = new Map<number, { p: AgentProgress; running: boolean }>();
  let last: string | undefined;
  const reporter = createProgressReporter({
    send: (p) => o.emit({ t: 'agent_progress', id: o.assistantId, callId: o.callId, ...p }),
    now: o.now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
  });
  const publish = (): void => {
    let tokens = 0;
    let tools = 0;
    let failed = 0;
    let running = 0;
    for (const a of agents.values()) {
      tokens += a.p.tokens;
      tools += a.p.tools;
      failed += a.p.failed ?? 0;
      if (a.running) running++;
    }
    const head = running > 0 ? (RUNNING_WORD[o.lang] ?? RUNNING_WORD.vi)(running) : '';
    const activity = [head, last].filter(Boolean).join(' · ');
    reporter.update({ tokens, tools, ...(failed ? { failed } : {}), ...(activity ? { activity } : {}) });
  };
  return {
    update(key, p) {
      agents.set(key, { p, running: agents.get(key)?.running ?? true });
      if (p.activity) last = p.activity;
      publish();
    },
    finish(key) {
      const a = agents.get(key);
      if (a) a.running = false;
      publish();
    },
    flush: () => reporter.flush(),
    dispose: () => reporter.dispose(),
  };
}
