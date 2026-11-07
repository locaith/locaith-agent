/**
 * (lane:bg-tasks) Báo cho model khi một tác vụ nền kết thúc mà nó chưa biết (tự thoát, chết, người dùng bấm Dừng).
 *
 * Gắn qua móc `beforeModel`: trước MỖI lần gọi model, gom mọi tác vụ đã kết thúc chưa báo của phiên thành MỘT khối chữ
 * (được lưu vào lịch sử). Không spam: mỗi tác vụ chỉ báo một lần; tác vụ do chính agent dừng (command_stop) hoặc đã được
 * đọc thấy kết thúc qua command_output thì không báo lại. Tác vụ kết thúc khi agent đang rảnh → báo ở lần chạy kế tiếp.
 */

import type { RunExtension } from '../engine/seams';
import { t, type Lang } from '../engine/strings';
import { formatDuration, getTaskManager, type BgTask } from './backgroundTasks';

const TAIL_LINES = 20;

function statusText(task: BgTask, lang: Lang): string {
  if (task.status === 'killed') return t(lang, task.stoppedBy === 'user' ? 'bgTaskKilledByUser' : 'bgTaskKilled');
  if (task.error) return t(lang, 'bgTaskFailedStart', { error: task.error.slice(0, 200) });
  return t(lang, 'bgTaskExit', { code: task.exitCode ?? '?' });
}

export function formatEndedNotice(tasks: readonly BgTask[], lang: Lang): string {
  return tasks
    .map((task) => {
      const lines = task.buffer.lastLines(TAIL_LINES).map((l) => l.slice(0, 300));
      const tail = lines.length ? t(lang, 'bgTaskTail', { n: lines.length, lines: lines.join('\n') }) : '';
      return t(lang, 'bgTaskEnded', {
        id: task.id,
        command: task.command.length > 80 ? `${task.command.slice(0, 80)}…` : task.command,
        status: statusText(task, lang),
        dur: formatDuration((task.endedAt ?? Date.now()) - task.startedAt),
        tail,
      });
    })
    .join('\n\n');
}

export function backgroundNotifyExtension(): RunExtension {
  return {
    id: 'bg-tasks',
    begin(scope) {
      if (!scope.host.startProcess) return;
      const mgr = getTaskManager(scope.host);
      return {
        beforeModel() {
          const ended = mgr.takeUnnotified(scope.session.id);
          if (!ended.length) return;
          return [formatEndedNotice(ended, scope.lang)];
        },
      };
    },
  };
}
