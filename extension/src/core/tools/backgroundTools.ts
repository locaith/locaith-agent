/**
 * (lane:bg-tasks) Công cụ tác vụ nền: nhánh `background:true` của run_command + command_output / command_stop / command_list.
 * Quyền: KHỞI CHẠY đi qua đúng cổng quyền của run_command (cùng `permission()`); đọc/dừng/liệt kê chỉ chạm tới tác vụ của
 * chính cuộc trò chuyện này nên không cần hỏi.
 */

import type { ToolContext, ToolDef, ToolResult } from '../engine/types';
import { formatDuration, getTaskManager, statusLabel, stripAnsi, type BgTask } from '../tasks/backgroundTasks';

/** Đợi tối đa chừng này sau khi khởi chạy để bắt lỗi khởi động sớm (sai lệnh, cổng bận…). */
export const STARTUP_WAIT_MS = 1500;
const MAX_READ_CHARS = 30_000;
const MAX_WAIT_MS = 120_000;

function header(t: BgTask): string {
  const dur = formatDuration((t.endedAt ?? Date.now()) - t.startedAt);
  const ready = t.ready ? ` · sẵn sàng: ${t.ready}` : '';
  return `Tác vụ nền ${t.id} — ${statusLabel(t)} · ${dur}${ready}`;
}

/** Nhánh `run_command` với `background: true`. `cwd` đã được kiểm tra (nằm trong workspace hoặc đã được duyệt). */
export async function startBackgroundCommand(
  input: { command: string; description?: string },
  cwd: { abs: string; rel: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const mgr = getTaskManager(ctx.host);
  const res = mgr.start({ sessionId: ctx.session.id, command: input.command, cwdAbs: cwd.abs, cwdRel: cwd.rel, description: input.description });
  if (!res.ok) return { content: res.error, isError: true, summary: 'không khởi chạy' };
  const t = res.task;
  await mgr.waitForExit(t.id, STARTUP_WAIT_MS, ctx.signal);
  // Đọc xong trong cửa sổ khởi động → model đã thấy; command_output tiếp từ đây.
  const first = t.buffer.read(0);
  const out = stripAnsi(first.text).trimEnd();
  const shown = out.length > 4000 ? `…${out.slice(-4000)}` : out;
  if (t.status !== 'running') {
    t.notified = true; // đã báo ngay trong kết quả này
    const ok = t.status === 'exited';
    return {
      content: `${header(t)}\nLệnh đã kết thúc ngay khi khởi động.\n${shown || '(không có đầu ra)'}`,
      isError: !ok,
      summary: ok ? 'đã xong' : `mã ${t.exitCode ?? '?'}`,
      display: shown.slice(-3000),
    };
  }
  return {
    content:
      `Đã chạy nền: ${t.id} (đang chạy${t.ready ? `, sẵn sàng: ${t.ready}` : ''}).\n` +
      `Đầu ra ban đầu:\n${shown || '(chưa có)'}\n` +
      `Dùng command_output {"id":"${t.id}","since":${first.next}} để đọc tiếp, command_stop {"id":"${t.id}"} để dừng. ` +
      'Bạn sẽ được báo khi tác vụ kết thúc.',
    summary: t.ready ? `nền ${t.id} · sẵn sàng` : `nền ${t.id}`,
    display: shown.slice(-3000),
  };
}

interface OutputInput {
  id: string;
  since?: number;
  wait_ms?: number;
  filter?: string;
}

function compileFilter(f: string | undefined): RegExp | undefined | Error {
  if (!f) return undefined;
  if (f.length > 200) return new Error('Mẫu lọc quá dài (tối đa 200 ký tự).');
  // Chặn mẫu có lượng từ lồng nhau (`(a+)+`) — dễ backtrack theo hàm mũ trên đầu ra lớn.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(f)) return new Error('Mẫu lọc có lượng từ lồng nhau, hãy viết đơn giản hơn.');
  try {
    return new RegExp(f, 'i');
  } catch (err) {
    return new Error(`Mẫu lọc không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const commandOutputTool: ToolDef<OutputInput> = {
  name: 'command_output',
  description:
    'Read NEW output of a background task started with run_command background:true, plus its status (running / exit code). ' +
    'Pass `since` = the cursor returned last time to get only new output; `wait_ms` waits up to that long for new output or exit (max 120000); ' +
    '`filter` keeps only lines matching a case-insensitive regex.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task id, e.g. "bg1".' },
      since: { type: 'integer', minimum: 0, description: 'Cursor from the previous read (default 0 = from the start).' },
      wait_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, description: 'Wait up to this many ms for new output or exit.' },
      filter: { type: 'string', description: 'Optional regex; only matching lines are returned.' },
    },
    required: ['id'],
  },
  risk: 'read',
  concurrencySafe: true,
  repeatExempt: true,
  async execute(input, ctx) {
    const mgr = getTaskManager(ctx.host);
    const t = mgr.get(input.id, ctx.session.id);
    if (!t) return { content: `Không có tác vụ nền "${input.id}" trong cuộc trò chuyện này. Xem command_list.`, isError: true };
    const re = compileFilter(input.filter);
    if (re instanceof Error) return { content: re.message, isError: true };
    const since = input.since ?? 0;
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, input.wait_ms ?? 0));
    if (wait > 0 && t.status === 'running' && t.buffer.total <= since) await mgr.waitForChange(t.id, wait, ctx.signal);
    const r = t.buffer.read(since);
    let text = stripAnsi(r.text);
    if (re) text = text.split(/\r?\n/).filter((l) => re.test(l)).join('\n');
    let cut = '';
    if (text.length > MAX_READ_CHARS) {
      cut = `[… đã bỏ ${text.length - MAX_READ_CHARS} ký tự đầu của phần mới — dùng filter hoặc since lớn hơn …]\n`;
      text = text.slice(-MAX_READ_CHARS);
    }
    if (t.status !== 'running') t.notified = true; // model vừa tự đọc thấy kết quả
    const body = text.trimEnd() ? `${cut}${text.trimEnd()}` : '(không có đầu ra mới)';
    return {
      content: `${header(t)}\ncursor: ${r.next}\n${body}`,
      summary: t.status === 'running' ? 'đang chạy' : statusLabel(t),
      display: body.slice(-3000),
    };
  },
};

export const commandStopTool: ToolDef<{ id: string }> = {
  name: 'command_stop',
  description: 'Stop a background task and its whole process tree (by PID). Use when a dev server/watcher is no longer needed.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Task id, e.g. "bg1".' } }, required: ['id'] },
  risk: 'read',
  concurrencySafe: false,
  async execute(input, ctx) {
    const mgr = getTaskManager(ctx.host);
    const t = mgr.get(input.id, ctx.session.id);
    if (!t) return { content: `Không có tác vụ nền "${input.id}" trong cuộc trò chuyện này.`, isError: true };
    if (t.status !== 'running') {
      t.notified = true;
      return { content: `${header(t)}\nTác vụ đã kết thúc trước đó.`, summary: statusLabel(t) };
    }
    await mgr.stop(t.id, 'agent');
    const tail = t.buffer.lastLines(10).join('\n');
    return { content: `${header(t)}\nĐã dừng cả cây tiến trình.${tail ? `\n10 dòng cuối:\n${tail}` : ''}`, summary: 'đã dừng' };
  },
};

export const commandListTool: ToolDef<Record<string, never>> = {
  name: 'command_list',
  description: 'List background tasks of this conversation with status, runtime and readiness.',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  concurrencySafe: true,
  repeatExempt: true,
  async execute(_input, ctx) {
    const list = getTaskManager(ctx.host).list(ctx.session.id);
    if (!list.length) return { content: 'Chưa có tác vụ nền nào trong cuộc trò chuyện này.', summary: '0 tác vụ' };
    const lines = list.map((t) => `- ${header(t)}\n  lệnh: ${t.command.slice(0, 200)} (cwd: ${t.cwd})`);
    const running = list.filter((t) => t.status === 'running').length;
    return { content: lines.join('\n'), summary: `${running}/${list.length} đang chạy` };
  },
};

export const backgroundTools = [commandOutputTool, commandStopTool, commandListTool];
