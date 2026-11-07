/**
 * (lane:bg-tasks) Quản lý tác vụ nền: `run_command background:true`, `command_output`, `command_stop`, `command_list`.
 *
 * Dùng chung mọi bề mặt (không import `vscode`/`node:*`): tiến trình thật do `ToolHost.startProcess` khởi. Host nào không có
 * `startProcess` (bản trình duyệt) thì không có tác vụ nền.
 *
 * Vòng đời:
 *   - mỗi tác vụ gắn với MỘT phiên (cuộc trò chuyện): chuyển sang cuộc trò chuyện khác vẫn chạy tiếp; xoá phiên / đóng cửa sổ /
 *     tắt extension → `disposeSession` / `disposeAll` giết cả cây tiến trình;
 *   - tối đa `MAX_RUNNING` tác vụ ĐANG CHẠY mỗi phiên; giữ tối đa `MAX_KEPT` tác vụ (cũ đã xong bị bỏ trước);
 *   - bộ đệm mỗi tác vụ: giữ phần ĐẦU (thông báo khởi động, lỗi cấu hình) + phần ĐUÔI (trạng thái mới nhất), tổng ≤ ~1 MB.
 *   - kết thúc ngoài ý muốn của agent (tự thoát, chết, người dùng bấm Dừng) → xếp một thông báo cho model, nạp vào lịch sử
 *     ở lần gọi model kế tiếp (RunExtension `beforeModel`, xem notifyExtension.ts), gộp nhiều tác vụ vào một tin.
 */

import type { ToolHost, ProcessHandle } from '../engine/types';
import type { BgTaskView } from '../../shared/bgTasks';

export type BgStatus = 'running' | 'exited' | 'killed' | 'failed';

/** Ký tự (UTF-16 = 2 byte) — đầu + đuôi ≈ 1 MB bộ nhớ. */
export const HEAD_CHARS = 64 * 1024;
export const TAIL_CHARS = 448 * 1024;
export const MAX_RUNNING = 8;
export const MAX_KEPT = 20;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Bộ đệm giữ đầu + đuôi; con trỏ = số ký tự đã ghi từ đầu (không đổi khi phần giữa bị lược). */
export class OutputBuffer {
  private head = '';
  private tail = '';
  /** Số ký tự ở giữa đã bị bỏ. */
  dropped = 0;
  constructor(
    private readonly headMax = HEAD_CHARS,
    private readonly tailMax = TAIL_CHARS,
  ) {}

  get total(): number {
    return this.head.length + this.dropped + this.tail.length;
  }

  push(text: string): void {
    if (!text) return;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
      if (!text) return;
    }
    this.tail += text;
    if (this.tail.length > this.tailMax) {
      const cut = this.tail.length - this.tailMax;
      this.tail = this.tail.slice(cut);
      this.dropped += cut;
    }
  }

  /** Đọc từ con trỏ `since` tới hết. `gap` = số ký tự đã bị lược nằm sau `since`. */
  read(since = 0): { text: string; next: number; gap: number } {
    const s = Math.max(0, Math.min(since, this.total));
    const tailStart = this.head.length + this.dropped;
    let text = '';
    let gap = 0;
    if (s < this.head.length) text += this.head.slice(s);
    if (s < tailStart && this.dropped > 0) {
      gap = tailStart - Math.max(s, this.head.length);
      text += `\n[… đã lược ${gap} ký tự ở giữa …]\n`;
    }
    text += this.tail.slice(Math.max(0, s - tailStart));
    return { text, next: this.total, gap };
  }

  /** `n` dòng cuối (không tính dòng trống ở cuối). */
  lastLines(n: number): string[] {
    const src = (this.tail || this.head).replace(/\r\n?/g, '\n');
    // Thanh tiến trình kiểu `\r` đè dòng: chỉ giữ phần sau `\r` cuối của mỗi dòng (đã đổi ở trên) — đủ cho hiển thị.
    const lines = stripAnsi(src).split('\n');
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    return lines.slice(-n);
  }

  all(): string {
    return this.read(0).text;
  }
}

/** Mẫu "server đã sẵn sàng": URL cục bộ có cổng, hoặc câu chữ quen thuộc của Vite/Next/webpack/Express/uvicorn… */
const READY_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*):\d{2,5}(?:\/[^\s'"<>)\]]*)?/i;
const READY_TEXT = /\b(ready in|ready on|listening on|listening at|server (?:is )?(?:running|started|listening)|compiled successfully|started server on|application startup complete|watching for file changes)\b/i;

export function detectReady(chunk: string): string | undefined {
  const text = stripAnsi(chunk);
  const url = READY_URL.exec(text);
  if (url) return url[0].replace(/0\.0\.0\.0/, 'localhost');
  const m = READY_TEXT.exec(text);
  if (m) {
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1).split('\n')[0]!.trim();
    return line.slice(0, 160);
  }
  return undefined;
}

export interface BgTask {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  /** Đường dẫn tương đối (hiển thị). */
  readonly cwd: string;
  readonly description?: string;
  readonly startedAt: number;
  endedAt?: number;
  status: BgStatus;
  exitCode: number | null;
  error?: string;
  ready?: string;
  readonly buffer: OutputBuffer;
  /** Ai dừng: agent (command_stop) thì không cần báo lại cho model. */
  stoppedBy?: 'agent' | 'user' | 'session';
  /** Đã báo kết thúc cho model chưa. */
  notified: boolean;
  handle?: ProcessHandle;
}

export interface StartResult {
  ok: true;
  task: BgTask;
}
export interface StartError {
  ok: false;
  error: string;
}

type Listener = (sessionId: string) => void;

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BgTask>();
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly host: ToolHost) {}

  get supported(): boolean {
    return typeof this.host.startProcess === 'function';
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed(t: BgTask): void {
    for (const w of this.waiters.get(t.id) ?? []) w();
    this.waiters.delete(t.id);
    for (const l of this.listeners) {
      try {
        l(t.sessionId);
      } catch {
        /* bên nghe lỗi không làm hỏng tác vụ */
      }
    }
  }

  get(id: string, sessionId?: string): BgTask | undefined {
    const t = this.tasks.get(id.trim().toLowerCase());
    if (!t || (sessionId !== undefined && t.sessionId !== sessionId)) return undefined;
    return t;
  }

  list(sessionId?: string): BgTask[] {
    return [...this.tasks.values()].filter((t) => sessionId === undefined || t.sessionId === sessionId);
  }

  running(sessionId?: string): BgTask[] {
    return this.list(sessionId).filter((t) => t.status === 'running');
  }

  start(o: { sessionId: string; command: string; cwdAbs: string; cwdRel: string; description?: string }): StartResult | StartError {
    if (!this.host.startProcess) return { ok: false, error: 'Môi trường này không hỗ trợ tác vụ nền.' };
    if (this.running(o.sessionId).length >= MAX_RUNNING)
      return {
        ok: false,
        error: `Đã có ${MAX_RUNNING} tác vụ nền đang chạy trong cuộc trò chuyện này (tối đa ${MAX_RUNNING}). Dừng bớt bằng command_stop (xem command_list) rồi thử lại.`,
      };
    this.prune(o.sessionId);
    const id = `bg${++this.seq}`;
    const task: BgTask = {
      id,
      sessionId: o.sessionId,
      command: o.command,
      cwd: o.cwdRel || '.',
      description: o.description?.trim() || undefined,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      buffer: new OutputBuffer(),
      notified: false,
    };
    this.tasks.set(id, task);
    let lastEmit = 0;
    let emitTimer: ReturnType<typeof setTimeout> | undefined;
    const emitSoon = () => {
      // Đầu ra dồn dập (watcher, test) → báo giao diện tối đa ~4 lần/giây.
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        this.changed(task);
      } else if (!emitTimer) {
        emitTimer = setTimeout(() => {
          emitTimer = undefined;
          lastEmit = Date.now();
          this.changed(task);
        }, 250);
      }
    };
    task.handle = this.host.startProcess({
      command: o.command,
      cwd: o.cwdAbs,
      onData: (chunk) => {
        task.buffer.push(chunk);
        if (!task.ready) task.ready = detectReady(chunk);
        emitSoon();
      },
      onExit: (info) => {
        if (emitTimer) clearTimeout(emitTimer);
        task.endedAt = Date.now();
        task.exitCode = info.exitCode;
        if (info.error) task.error = info.error;
        if (task.stoppedBy) task.status = 'killed';
        else if (info.error) task.status = 'failed';
        else task.status = info.exitCode === 0 ? 'exited' : info.signal || info.exitCode === null ? 'killed' : 'failed';
        if (task.stoppedBy === 'agent' || task.stoppedBy === 'session') task.notified = true;
        this.changed(task);
      },
    });
    this.changed(task);
    return { ok: true, task };
  }

  /** Bỏ bớt tác vụ ĐÃ XONG cũ nhất khi vượt `MAX_KEPT`. */
  private prune(sessionId: string): void {
    const done = this.list(sessionId).filter((t) => t.status !== 'running');
    const over = this.list(sessionId).length + 1 - MAX_KEPT;
    for (const t of done.slice(0, Math.max(0, over))) this.tasks.delete(t.id);
  }

  /** Chờ tới khi có đầu ra mới / tác vụ kết thúc, hoặc hết `ms`, hoặc bị huỷ. */
  waitForChange(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running' || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.get(id)?.delete(done);
        resolve();
      };
      timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(done);
    });
  }

  /** Chờ tác vụ kết thúc (tối đa `ms`). */
  async waitForExit(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.tasks.get(id)?.status === 'running' && Date.now() < deadline && !signal?.aborted) {
      await this.waitForChange(id, deadline - Date.now(), signal);
    }
  }

  async stop(id: string, by: 'agent' | 'user' | 'session'): Promise<BgTask | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status !== 'running') return t;
    t.stoppedBy = by;
    await t.handle?.kill();
    // Chờ sự kiện thoát để trạng thái/đầu ra cuối chính xác (tối đa 5 s — tiến trình cứng đầu vẫn bị coi là đã dừng).
    await this.waitForExit(id, 5000);
    if (t.status === 'running') {
      t.status = 'killed';
      t.endedAt = Date.now();
      if (by !== 'user') t.notified = true;
      this.changed(t);
    }
    return t;
  }

  /** Huỷ phiên: dừng mọi tác vụ của phiên và quên chúng. */
  async disposeSession(sessionId: string): Promise<void> {
    const list = this.list(sessionId);
    await Promise.all(list.map((t) => this.stop(t.id, 'session')));
    for (const t of list) this.tasks.delete(t.id);
    if (list.length) for (const l of this.listeners) l(sessionId);
  }

  async disposeAll(): Promise<void> {
    const sessions = new Set([...this.tasks.values()].map((t) => t.sessionId));
    await Promise.all([...sessions].map((s) => this.disposeSession(s)));
  }

  /** Tác vụ đã kết thúc mà model chưa được báo (theo phiên); đánh dấu đã báo. */
  takeUnnotified(sessionId: string): BgTask[] {
    const out = this.list(sessionId).filter((t) => t.status !== 'running' && !t.notified);
    for (const t of out) t.notified = true;
    return out;
  }

  /** Bản hiển thị gọn cho giao diện (ViewState.bgTasks). */
  views(sessionId: string): BgTaskView[] {
    return this.list(sessionId).map((t) => toView(t));
  }
}

export function toView(t: BgTask): BgTaskView {
  return {
    id: t.id,
    command: t.command.slice(0, 300),
    ...(t.description ? { description: t.description.slice(0, 160) } : {}),
    cwd: t.cwd.slice(0, 200),
    status: t.status,
    startedAt: t.startedAt,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}),
    ...(t.ready ? { ready: t.ready.slice(0, 160) } : {}),
    tail: t.buffer.lastLines(5).map((l) => l.slice(0, 300)),
  };
}

const managers = new WeakMap<ToolHost, BackgroundTaskManager>();

/** Một bộ quản lý cho mỗi host (VS Code: một cửa sổ = một host). */
export function getTaskManager(host: ToolHost): BackgroundTaskManager {
  let m = managers.get(host);
  if (!m) managers.set(host, (m = new BackgroundTaskManager(host)));
  return m;
}

export function statusLabel(t: BgTask): string {
  switch (t.status) {
    case 'running':
      return 'đang chạy';
    case 'exited':
      return 'đã thoát, mã 0';
    case 'killed':
      return t.stoppedBy === 'user' ? 'người dùng đã dừng' : 'đã bị dừng';
    case 'failed':
      return t.error ? `không chạy được: ${t.error}` : `thoát lỗi, mã ${t.exitCode ?? '?'}`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
