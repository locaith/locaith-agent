/**
 * Công cụ `slash_command`: cho model tự gọi một lệnh tuỳ chỉnh (giống SlashCommand của Claude Code).
 *
 * • Chỉ các lệnh `modelInvocable` (không `disable-model-invocation: true`; lệnh của dự án chỉ khi workspace đã tin cậy).
 * • Mô tả công cụ liệt kê lệnh (có trần) và được đọc lại mỗi lượt; không có lệnh nào → công cụ ẩn.
 * • Lệnh nhúng `!\`…\`` vẫn qua cổng: khớp `allowed-tools` hoặc người dùng cho phép qua thẻ xin phép; chế độ lập kế hoạch thì không chạy.
 */

import type { ToolDef } from '../engine/types';
import { expandCustomCommand, modelInvocable, type CustomCommand } from './custom';

export const SLASH_TOOL_NAME = 'slash_command';
const MAX_LISTED = 40;
const MAX_LIST_CHARS = 4000;

export interface SlashToolSource {
  commands(): readonly CustomCommand[];
  trusted(): boolean;
}

export function invocableCommands(src: SlashToolSource): CustomCommand[] {
  const trusted = src.trusted();
  return src.commands().filter((c) => modelInvocable(c, trusted));
}

export function slashToolDescription(cmds: readonly CustomCommand[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const c of cmds.slice(0, MAX_LISTED)) {
    const line = `- /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}: ${c.description.slice(0, 160)}`;
    if (size + line.length > MAX_LIST_CHARS) break;
    size += line.length + 1;
    lines.push(line);
  }
  const more = cmds.length - lines.length;
  return (
    'Run one of the user\'s custom slash commands (their saved prompts/workflows). The result is the expanded instructions of that command: ' +
    'follow them as if the user had typed the command. Only use a command when it clearly matches what the user asked for.\n' +
    `Available commands:\n${lines.join('\n')}${more > 0 ? `\n(+${more} more not listed)` : ''}`
  );
}

export function createSlashCommandTool(src: SlashToolSource): ToolDef<{ command: string; args?: string }> {
  return {
    name: SLASH_TOOL_NAME,
    get description() {
      return slashToolDescription(invocableCommands(src));
    },
    get hidden() {
      return invocableCommands(src).length === 0;
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name, with or without the leading "/", e.g. "frontend:component".' },
        args: { type: 'string', description: 'Arguments for the command ($ARGUMENTS).' },
      },
      required: ['command'],
    },
    risk: 'meta',
    concurrencySafe: false,
    async execute(input, ctx) {
      const name = String(input.command ?? '').trim().replace(/^\//, '').toLowerCase();
      const cmd = invocableCommands(src).find((c) => c.name === name);
      if (!cmd) {
        const known = src.commands().some((c) => c.name === name);
        return {
          content: known ? `/${name} cannot be invoked by the assistant (disabled by its author or the workspace is not trusted). Ask the user to run it.` : `Unknown command /${name}.`,
          isError: true,
        };
      }
      const r = await expandCustomCommand(cmd, String(input.args ?? ''), {
        host: ctx.host,
        trusted: src.trusted(),
        signal: ctx.signal,
        noShell: ctx.session.mode === 'plan',
        confirmShell: async (command) => {
          const d = await ctx.host.requestPermission(
            {
              id: `${ctx.callId}:sh`,
              callId: ctx.callId,
              tool: 'run_command',
              kind: 'command',
              title: `/${cmd.name}`,
              detail: cmd.file,
              command,
              canAllowSession: false,
            },
            ctx.signal,
          );
          return d.decision !== 'deny';
        },
      });
      return {
        content: `<command name="/${cmd.name}" source="${cmd.source}">\n${r.prompt}\n</command>`,
        summary: `/${cmd.name}`,
        display: r.prompt.slice(0, 2000),
      };
    },
  };
}
