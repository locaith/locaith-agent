/**
 * (lane:bg-tasks) Phía VS Code của tác vụ nền:
 *   - đẩy danh sách tác vụ của cuộc trò chuyện đang mở lên giao diện (ViewState.bgTasks → chip «N tác vụ nền» + Remote);
 *   - xử lý nút Dừng / Sao chép đầu ra / Xem đầy đủ (tin `bg_task` từ webview, Remote chỉ được Dừng);
 *   - lệnh `/tasks`.
 * Bộ quản lý tác vụ nằm ở core (src/core/tasks/backgroundTasks.ts), một bộ cho mỗi ToolHost (= mỗi ChatController).
 */

import * as vscode from 'vscode';
import type { Lang } from '../core/engine/strings';
import type { ToolHost } from '../core/engine/types';
import { formatDuration, getTaskManager, stripAnsi, type BgTask } from '../core/tasks/backgroundTasks';
import type { HostMessage, ViewState, WebviewMessage } from '../shared/protocol';
import type { SlashRegistry } from './slashRegistry';

export interface BgTasksBridge {
  host: ToolHost;
  sessionId(): string;
  patch(p: Partial<ViewState>): void;
  lang(): Lang;
  disposed(): boolean;
  addMirror(m: (msg: HostMessage) => void): { dispose(): void };
}

export interface BgTasksController {
  bgTasksBridge(): BgTasksBridge;
}

function statusWord(t: BgTask, lang: Lang): string {
  const vi = lang === 'vi';
  switch (t.status) {
    case 'running':
      return vi ? 'đang chạy' : 'running';
    case 'exited':
      return vi ? 'xong (mã 0)' : 'done (exit 0)';
    case 'killed':
      return vi ? 'đã dừng' : 'stopped';
    case 'failed':
      return t.error ? (vi ? 'không khởi chạy được' : 'failed to start') : vi ? `lỗi (mã ${t.exitCode ?? '?'})` : `failed (exit ${t.exitCode ?? '?'})`;
  }
}

/** Nội dung `/tasks` (markdown). */
export function tasksReport(list: readonly BgTask[], lang: Lang, now = Date.now()): string {
  const vi = lang === 'vi';
  if (!list.length) return vi ? 'Chưa có tác vụ nền nào trong cuộc trò chuyện này.' : 'No background tasks in this conversation.';
  const running = list.filter((t) => t.status === 'running').length;
  const head = vi ? `**Tác vụ nền** · ${running} đang chạy / ${list.length}` : `**Background tasks** · ${running} running / ${list.length}`;
  const rows = list.map((t) => {
    const dur = formatDuration((t.endedAt ?? now) - t.startedAt);
    const ready = t.ready ? ` · ${vi ? 'sẵn sàng' : 'ready'}: ${t.ready}` : '';
    const cmd = t.command.replace(/`/g, "'").slice(0, 120);
    return `- \`${t.id}\` ${statusWord(t, lang)} · ${dur}${ready} — \`${cmd}\``;
  });
  return [head, ...rows].join('\n');
}

/** Gắn phía host: đẩy ViewState.bgTasks khi tác vụ đổi / khi chuyển cuộc trò chuyện; đăng ký `/tasks`. */
export function registerTasksSlash(slash: SlashRegistry, controller: BgTasksController): void {
  // Controller gọi hàm này trong constructor (trước khi phiên có): mọi thứ cần phiên đều lấy trễ.
  queueMicrotask(() => {
    const b = controller.bgTasksBridge();
    const mgr = getTaskManager(b.host);
    if (!mgr.supported) return;
    let lastSent = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const push = (force = false) => {
      if (b.disposed()) return;
      const views = mgr.views(b.sessionId());
      const key = JSON.stringify(views.map((v) => [v.id, v.status, v.ready, v.tail]));
      if (!force && key === lastSent) return;
      lastSent = key;
      b.patch({ bgTasks: views.length ? views : undefined });
    };
    mgr.onChange((sid) => {
      if (sid !== b.sessionId() || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        push();
      }, 200);
    });
    // Mở/chuyển cuộc trò chuyện → controller gửi `init` với trạng thái dựng lại (không có bgTasks): bổ sung ngay sau đó.
    b.addMirror((msg) => {
      if (msg.type === 'init') queueMicrotask(() => push(true));
    });
    // Bộ đếm thời gian chạy trên chip tự tính ở webview; vẫn làm tươi "5 dòng cuối" định kỳ phòng khi đầu ra đứng yên.
  });

  slash.register({
    name: 'tasks',
    description: { vi: 'Xem các tác vụ nền (server dev, watcher…) của cuộc trò chuyện này', en: 'List background tasks (dev servers, watchers…) of this conversation' },
    needsIdle: false,
    run(ctx) {
      const b = controller.bgTasksBridge();
      ctx.info(tasksReport(getTaskManager(b.host).list(b.sessionId()), ctx.lang));
    },
  });
}

/** Tin `bg_task` từ webview / Remote. `remote` = chỉ cho Dừng. */
export async function handleBgTaskMessage(controller: BgTasksController, m: Extract<WebviewMessage, { type: 'bg_task' }>, remote = false): Promise<void> {
  const b = controller.bgTasksBridge();
  const mgr = getTaskManager(b.host);
  const task = mgr.get(String(m.id), b.sessionId());
  if (!task) return;
  switch (m.action) {
    case 'stop':
      await mgr.stop(task.id, 'user');
      return;
    case 'copy':
      if (remote) return;
      await vscode.env.clipboard.writeText(stripAnsi(task.buffer.all()));
      return;
    case 'open': {
      if (remote) return;
      const header = `# ${task.id} · ${task.command}\n# cwd: ${task.cwd}\n\n`;
      const doc = await vscode.workspace.openTextDocument({ content: header + stripAnsi(task.buffer.all()), language: 'log' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
  }
}
