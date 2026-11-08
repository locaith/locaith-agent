/**
 * Mô-đun 3 — tác vụ nền (server dev, watcher…). Bộ quản lý ở `core/tasks/backgroundTasks.ts` (một bộ cho mỗi ToolHost); công cụ
 * `command_output/command_stop/command_list` đã nằm trong registry khi host có `startProcess` (lõi dựng). Ở đây:
 *   • RunExtension báo model «tác vụ đã xong» đúng một lần (core/tasks/notifyExtension.ts);
 *   • status contributor `bgTasks {running,total}` của phiên hiện tại;
 *   • `/tasks` (liệt kê), `/tasks <id>` (đuôi đầu ra), `/tasks stop <id|all>`; dọn (dừng hết) khi đóng.
 */

import { backgroundNotifyExtension } from '../../../core/tasks/notifyExtension';
import { formatDuration, getTaskManager, stripAnsi, type BgTask } from '../../../core/tasks/backgroundTasks';
import type { FeatureModule } from '../contract';
import { makeTr } from './ext';

const tr = makeTr('tasks', {
  none: ['Chưa có tác vụ nền nào trong cuộc trò chuyện này.', 'No background tasks in this conversation.'],
  head: ['**Tác vụ nền** · {running} đang chạy / {total}', '**Background tasks** · {running} running / {total}'],
  running: ['đang chạy', 'running'],
  exited: ['xong (mã 0)', 'done (exit 0)'],
  killed: ['đã dừng', 'stopped'],
  failedStart: ['không khởi chạy được', 'failed to start'],
  failedExit: ['lỗi (mã {code})', 'failed (exit {code})'],
  ready: ['sẵn sàng', 'ready'],
  tip: ['`/tasks <id>` xem đầu ra · `/tasks stop <id|all>` dừng.', '`/tasks <id>` shows output · `/tasks stop <id|all>` stops.'],
  unknown: ['Không có tác vụ «{id}».', 'No task “{id}”.'],
  tailHead: ['**{id}** · {status} · {dur} — `{cmd}`', '**{id}** · {status} · {dur} — `{cmd}`'],
  empty: ['(chưa có đầu ra)', '(no output yet)'],
  stopped: ['Đã dừng {n} tác vụ.', 'Stopped {n} task(s).'],
  nothingToStop: ['Không có tác vụ nào đang chạy để dừng.', 'No running task to stop.'],
  unsupported: ['Môi trường này không hỗ trợ tác vụ nền.', 'This environment does not support background tasks.'],
});

function statusWord(t: BgTask, lang: 'vi' | 'en'): string {
  switch (t.status) {
    case 'running': return tr(lang, 'running');
    case 'exited': return tr(lang, 'exited');
    case 'killed': return tr(lang, 'killed');
    case 'failed': return t.error ? tr(lang, 'failedStart') : tr(lang, 'failedExit', { code: t.exitCode ?? '?' });
  }
}

/** Nội dung `/tasks` (markdown). */
export function tasksReport(list: readonly BgTask[], lang: 'vi' | 'en', now = Date.now()): string {
  if (!list.length) return tr(lang, 'none');
  const running = list.filter((t) => t.status === 'running').length;
  const rows = list.map((t) => {
    const dur = formatDuration((t.endedAt ?? now) - t.startedAt);
    const ready = t.ready ? ` · ${tr(lang, 'ready')}: ${t.ready}` : '';
    return `- \`${t.id}\` ${statusWord(t, lang)} · ${dur}${ready} — \`${t.command.replace(/`/g, "'").slice(0, 120)}\``;
  });
  return [tr(lang, 'head', { running, total: list.length }), ...rows, '', tr(lang, 'tip')].join('\n');
}

export const bgTasksFeature: FeatureModule = {
  name: 'bg-tasks',
  attach(ctx) {
    const mgr = getTaskManager(ctx.host);
    if (!mgr.supported) {
      // Không có startProcess: vẫn đăng ký lệnh để nói rõ lý do, nhưng không có tác vụ nào.
      ctx.slash({ name: 'tasks', description: { vi: 'Xem tác vụ nền (không hỗ trợ ở đây)', en: 'List background tasks (unsupported here)' }, needsIdle: false, run: (c) => c.output(tr(c.lang, 'unsupported'), 'plain') });
      return;
    }
    ctx.addRunExtension(backgroundNotifyExtension());

    const ref = ctx.addStatusContributor((s) => {
      const list = mgr.list(ctx.session().id);
      s.bgTasks = { running: list.filter((t) => t.status === 'running').length, total: list.length };
    });
    // Đầu ra dồn dập đã được bộ quản lý giãn (~4 lần/giây); gom thêm để giao diện không vẽ dồn.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = '';
    const off = mgr.onChange((sid) => {
      if (sid !== ctx.session().id) return;
      const key = mgr.list(sid).map((t) => `${t.id}:${t.status}`).join(',');
      if (key === lastKey) return;
      lastKey = key;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        ref.refresh();
      }, 150);
    });
    ctx.onSessionChange(() => {
      lastKey = '';
      ref.refresh();
    });

    ctx.slash({
      name: 'tasks',
      description: {
        vi: 'Xem các tác vụ nền (server dev, watcher…) — /tasks <id> xem đầu ra, /tasks stop <id|all> dừng',
        en: 'List background tasks (dev servers, watchers…) — /tasks <id> shows output, /tasks stop <id|all> stops',
      },
      argHint: '[<id>|stop <id|all>]',
      needsIdle: false,
      async run(c) {
        const sid = ctx.session().id;
        const words = c.args.trim().split(/\s+/).filter(Boolean);
        if (!words.length) return c.output(tasksReport(mgr.list(sid), c.lang));
        const verb = words[0].toLowerCase();
        if (verb === 'stop' || verb === 'kill' || verb === 'dung' || verb === 'dừng') {
          const target = (words[1] ?? 'all').toLowerCase();
          const victims = target === 'all' ? mgr.running(sid) : [mgr.get(target, sid)].filter((t): t is BgTask => !!t && t.status === 'running');
          if (target !== 'all' && !mgr.get(target, sid)) return c.output(tr(c.lang, 'unknown', { id: target }), 'error');
          if (!victims.length) return c.output(tr(c.lang, 'nothingToStop'), 'plain');
          for (const t of victims) await mgr.stop(t.id, 'user');
          return c.output(tr(c.lang, 'stopped', { n: victims.length }), 'plain');
        }
        const t = mgr.get(verb, sid);
        if (!t) return c.output(tr(c.lang, 'unknown', { id: verb }), 'error');
        const lines = t.buffer.lastLines(40).map((l) => stripAnsi(l).slice(0, 300));
        const head = tr(c.lang, 'tailHead', { id: t.id, status: statusWord(t, c.lang), dur: formatDuration((t.endedAt ?? Date.now()) - t.startedAt), cmd: t.command.replace(/`/g, "'").slice(0, 120) });
        c.output(`${head}\n\n\`\`\`\n${lines.length ? lines.join('\n') : tr(c.lang, 'empty')}\n\`\`\``);
      },
    });

    ctx.onDispose(async () => {
      off();
      if (timer) clearTimeout(timer);
      await mgr.disposeAll();
    });
  },
};
