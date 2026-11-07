/** (lane:bg-tasks) Bản hiển thị gọn của một tác vụ nền — dùng chung host, webview, Remote. */
export interface BgTaskView {
  /** 'bg1', 'bg2'… */
  id: string;
  command: string;
  description?: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed' | 'failed';
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** Server dev đã sẵn sàng: URL cục bộ hoặc dòng "ready". */
  ready?: string;
  /** Tối đa 5 dòng cuối đầu ra (đã bỏ mã màu). */
  tail: string[];
}

export type BgTaskAction = 'stop' | 'copy' | 'open';

/** Cắt kích thước trước khi gửi ra Remote / webview. */
export function capBgTasks(list: readonly BgTaskView[] | undefined): BgTaskView[] {
  if (!list) return [];
  return list.slice(-20).map((t) => ({
    id: String(t.id).slice(0, 16),
    command: String(t.command).slice(0, 300),
    ...(t.description ? { description: String(t.description).slice(0, 160) } : {}),
    cwd: String(t.cwd).slice(0, 200),
    status: t.status,
    startedAt: t.startedAt,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    ...(typeof t.exitCode === 'number' ? { exitCode: t.exitCode } : {}),
    ...(t.ready ? { ready: String(t.ready).slice(0, 160) } : {}),
    tail: (t.tail ?? []).slice(-5).map((l) => String(l).slice(0, 300)),
  }));
}
