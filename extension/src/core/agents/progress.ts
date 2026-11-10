/**
 * Báo tiến độ sống của agent con lên giao diện mà không làm ngập luồng sự kiện.
 *
 * `createProgressReporter`: gộp theo thời gian — gửi ngay nếu đã qua `minIntervalMs` kể từ lần gửi trước, nếu không thì giữ BẢN MỚI NHẤT và hẹn
 * gửi đúng lúc hết khoảng chờ (nên số cuối cùng luôn tới nơi); không gửi lại khi chẳng có gì đổi. Đồng hồ/hẹn giờ tiêm được để test không phải chờ thật.
 *
 * `createWorkflowProgress`: một workflow chạy nhiều agent con cùng lúc nhưng giao diện chỉ có MỘT dòng cho lệnh `workflow_run`; ở đây cộng số liệu
 * của mọi agent (token/lệnh/lỗi) và nói «N agent đang chạy · <việc của agent vừa báo>».
 */

import type { AgentProgress, AgentRunRow, UiEvent, WfProgress } from '../../shared/protocol';
import type { Lang } from '../engine/strings';
import type { WfAgentEvent } from './workflow';

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
  return !!a && !!b && a.tokens === b.tokens && a.tools === b.tools && (a.failed ?? 0) === (b.failed ?? 0) && (a.activity ?? '') === (b.activity ?? '') && (a.wf?.rev ?? -1) === (b.wf?.rev ?? -1);
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

/** Số dòng tối đa gửi kèm mỗi lần báo tiến độ workflow (phần còn lại chỉ nằm trong `counts`). */
export const WF_MAX_ROWS = 80;
const WF_MAX_RUNNING_ROWS = 40;
const WF_MAX_ERROR_ROWS = 20;
const WF_MAX_QUEUED_ROWS = 12;

/** Tổng hợp tiến độ nhiều agent con của một workflow: MỘT dòng gộp cho lệnh `workflow_run` + (0.7.7) bảng từng agent (`wf`). */
export interface WorkflowProgress {
  /** Một agent báo tiến độ (key = số thứ tự agent, duy nhất cho mỗi agent). */
  update(key: number, p: AgentProgress): void;
  /** Agent đã xong: số liệu cuối của nó vẫn nằm trong tổng, chỉ không còn tính là "đang chạy". */
  finish(key: number): void;
  /** Vòng đời của một agent (xếp hàng → chạy → xong/lỗi) với nhãn, loại, pha… */
  agent(e: WfAgentEvent): void;
  /** Script gọi phase(name). */
  setPhase(name: string): void;
  /** Giới hạn của lần chạy (để giao diện hiện «n / tối đa»). */
  setLimits(l: NonNullable<WfProgress['limits']>): void;
  /** Chạm giới hạn do người dùng/lệnh đặt. */
  limit(h: { kind: 'agents' | 'tokens'; limit: number; skipped: number }): void;
  flush(): void;
  dispose(): void;
}

const RUNNING_WORD: Record<Lang, (n: number) => string> = {
  vi: (n) => `${n} agent đang chạy`,
  en: (n) => `${n} agent${n === 1 ? '' : 's'} running`,
};

interface Row extends AgentRunRow {
  /** Số liệu của các lần thử TRƯỚC (thử lại bắt đầu đếm từ 0 lại ở agent con). */
  baseTokens: number;
  baseTools: number;
  lastTokens: number;
  lastTools: number;
}

export function createWorkflowProgress(o: { emit(ev: UiEvent): void; assistantId: string; callId: string; lang: Lang } & ProgressClock): WorkflowProgress {
  const rows = new Map<number, Row>();
  const phaseOrder: string[] = [];
  let phase: string | undefined;
  let limits: WfProgress['limits'];
  let hit: WfProgress['hit'];
  let last: string | undefined;
  let rev = 0;
  const now = o.now ?? Date.now;
  const reporter = createProgressReporter({
    send: (p) => o.emit({ t: 'agent_progress', id: o.assistantId, callId: o.callId, ...p }),
    now: o.now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
  });

  const rowOf = (key: number): Row => {
    let r = rows.get(key);
    if (!r) {
      r = { n: key, label: '', state: 'running', tokens: 0, tools: 0, baseTokens: 0, baseTools: 0, lastTokens: 0, lastTools: 0, ...(phase ? { phase } : {}), startedAt: now() };
      rows.set(key, r);
    }
    return r;
  };

  const snapshot = (): WfProgress => {
    const counts = { queued: 0, running: 0, done: 0, error: 0, stopped: 0, total: rows.size };
    for (const r of rows.values()) counts[r.state]++;
    const running: Row[] = [];
    const errors: Row[] = [];
    const queued: Row[] = [];
    const done: Row[] = [];
    for (const r of rows.values()) (r.state === 'running' ? running : r.state === 'error' || r.state === 'stopped' ? errors : r.state === 'queued' ? queued : done).push(r);
    const byN = (a: Row, b: Row): number => a.n - b.n;
    const newest = (a: Row, b: Row): number => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.n - a.n;
    // Ưu tiên: đang chạy > lỗi (mới nhất) > hàng đợi (sắp tới lượt) > xong (mới nhất) — tổng ≤ WF_MAX_ROWS.
    const pick: Row[] = [...running.sort(byN).slice(0, WF_MAX_RUNNING_ROWS), ...errors.sort(newest).slice(0, WF_MAX_ERROR_ROWS), ...queued.sort(byN).slice(0, WF_MAX_QUEUED_ROWS)];
    const room = Math.max(0, WF_MAX_ROWS - pick.length);
    pick.push(...done.sort(newest).slice(0, room));
    pick.sort(byN);
    const per = new Map<string, { name: string; total: number; done: number; error: number }>();
    for (const name of phaseOrder) per.set(name, { name, total: 0, done: 0, error: 0 });
    for (const r of rows.values()) {
      const name = r.phase ?? '';
      if (!name) continue;
      const e = per.get(name) ?? { name, total: 0, done: 0, error: 0 };
      e.total++;
      if (r.state === 'done') e.done++;
      else if (r.state === 'error' || r.state === 'stopped') e.error++;
      per.set(name, e);
    }
    return {
      rev,
      ...(phase ? { phase } : {}),
      counts,
      ...(per.size ? { phases: [...per.values()] } : {}),
      ...(limits ? { limits } : {}),
      ...(hit ? { hit } : {}),
      rows: pick.map(({ baseTokens: _a, baseTools: _b, lastTokens: _c, lastTools: _d, ...r }) => r),
    };
  };

  const publish = (): void => {
    rev++;
    let tokens = 0;
    let tools = 0;
    let failed = 0;
    let running = 0;
    for (const r of rows.values()) {
      tokens += r.tokens;
      tools += r.tools;
      failed += r.failed ?? 0;
      if (r.state === 'running') running++;
    }
    const head = running > 0 ? (RUNNING_WORD[o.lang] ?? RUNNING_WORD.vi)(running) : '';
    const activity = [head, last].filter(Boolean).join(' · ');
    reporter.update({ tokens, tools, ...(failed ? { failed } : {}), ...(activity ? { activity } : {}), wf: snapshot() });
  };

  return {
    update(key, p) {
      const r = rowOf(key);
      // Thử lại: agent con đếm lại từ 0 → cộng dồn phần của lần trước vào nền để số liệu của dòng không tụt.
      if (p.tokens < r.lastTokens) r.baseTokens += r.lastTokens;
      if (p.tools < r.lastTools) r.baseTools += r.lastTools;
      r.lastTokens = p.tokens;
      r.lastTools = p.tools;
      r.tokens = r.baseTokens + p.tokens;
      r.tools = r.baseTools + p.tools;
      if (p.failed) r.failed = p.failed;
      if (r.state === 'queued') r.state = 'running';
      if (p.activity) {
        last = p.activity;
        if (r.state === 'running') r.activity = p.activity;
      }
      publish();
    },
    finish(key) {
      const r = rows.get(key);
      if (r && (r.state === 'running' || r.state === 'queued')) {
        r.state = 'done';
        r.endedAt = now();
        delete r.activity;
      }
      publish();
    },
    agent(e) {
      const r = rowOf(e.n);
      if (e.label) r.label = e.label;
      if (e.type) r.type = e.type;
      if (e.phase) {
        r.phase = e.phase;
        if (!phaseOrder.includes(e.phase)) phaseOrder.push(e.phase);
      }
      if (e.state === 'queued') {
        r.state = 'queued';
        delete r.startedAt;
      } else if (e.state === 'running') {
        r.state = 'running';
        r.startedAt = now();
      } else {
        r.state = e.state;
        r.endedAt = now();
        delete r.activity;
        if (e.tokens !== undefined && e.tokens > r.tokens) r.tokens = e.tokens;
        if (e.model) r.model = e.model;
        if (e.error) r.error = e.error;
        if (e.preview) r.preview = e.preview;
      }
      publish();
    },
    setPhase(name) {
      phase = name;
      if (!phaseOrder.includes(name)) phaseOrder.push(name);
      publish();
    },
    setLimits(l) {
      limits = l;
      publish();
    },
    limit(h) {
      hit = h;
      publish();
    },
    flush: () => reporter.flush(),
    dispose: () => reporter.dispose(),
  };
}
