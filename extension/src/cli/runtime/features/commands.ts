/**
 * Mô-đun 6 — lệnh gạch chéo tuỳ chỉnh từ tệp Markdown (cùng định dạng `.claude/commands`): `.locaith/commands/**.md` (dự án, chỉ khi tin cậy),
 * `~/.locaith/commands`, tuỳ chọn `.claude/commands` (cài đặt `commands.includeClaude`, mặc định bật) và lệnh của plugin đang bật.
 * Khung YAML (description, argument-hint, allowed-tools, model, disable-model-invocation), `$ARGUMENTS`/`$1..$9`, `@file`, ``!`cmd` ``
 * (chạy qua host; luật `permissions.deny` luôn thắng, `allow`/`allowed-tools` cho chạy, còn lại hỏi qua `ask`; không tương tác → không chạy).
 * Đăng ký bằng `replaceSlashSource('project'|'user'|'plugin', …)`, quét lại khi đổi phiên / plugin đổi / tệp đổi (fs.watch, nếu có) / trước mỗi lần chạy.
 * Công cụ `slash_command` cho phép model tự gọi các lệnh `modelInvocable`.
 */

import * as fs from 'node:fs';
import { expandCustomCommand, loadCommandDirs, type CommandSource, type CustomCommand } from '../../../core/commands/custom';
import { createSlashCommandTool } from '../../../core/commands/slashTool';
import { loadPluginCommands } from '../../../core/plugins/loader';
import type { ToolContext, ToolDef, ToolHost } from '../../../core/engine/types';
import type { FeatureContext, FeatureModule, FeatureSlashDef, SlashRunContext } from '../contract';
import { commandDirs } from './dirs';
import { askSlash, makeTr } from './ext';
import { commandVerdict } from './permissions';
import { activePlugins, onPluginsChanged } from './plugins';

const tr = makeTr('cmds', {
  warn: ['Lệnh tuỳ chỉnh lỗi', 'Custom command problem'],
  embedded: ['Đã nhúng {n} tệp', 'Embedded {n} file(s)'],
  refused: ['{n} lệnh nhúng không chạy (chưa được phép, bị luật chặn hoặc thư mục chưa tin cậy)', '{n} embedded command(s) not run (not allowed, blocked by a rule or folder not trusted)'],
  shellAsk: ['Lệnh tuỳ chỉnh /{name} muốn chạy lệnh shell', 'Custom command /{name} wants to run a shell command'],
  allow: ['Cho chạy', 'Run it'],
  deny: ['Không chạy', 'Do not run'],
  gone: ['Lệnh /{name} không còn (tệp đã bị xoá hoặc đổi tên).', 'Command /{name} is gone (file deleted or renamed).'],
  failed: ['/{name}: {error}', '/{name}: {error}'],
  blockedByRule: ['bị luật permissions.deny chặn', 'blocked by a permissions.deny rule'],
  fromPlugin: ['Lệnh của plugin {plugin}', 'Command from plugin {plugin}'],
});

export interface CommandsState {
  commands: CustomCommand[];
  warnings: string[];
  reload(): Promise<void>;
}

const states = new WeakMap<FeatureContext, CommandsState>();
export const commandsStateOf = (ctx: FeatureContext): CommandsState | undefined => states.get(ctx);

/** Host với `runCommand` kiểm luật `permissions.deny` — lệnh nhúng trong tệp lệnh KHÔNG được vượt qua luật chặn. */
export function guardedHost(ctx: FeatureContext, host: ToolHost): ToolHost {
  const guarded = Object.create(host) as ToolHost;
  guarded.runCommand = async (o) => {
    if (commandVerdict(ctx, o.command) === 'deny') throw new Error(tr(ctx.lang, 'blockedByRule'));
    return host.runCommand(o);
  };
  return guarded;
}

export const commandsFeature: FeatureModule = {
  name: 'commands',
  async attach(ctx) {
    let signature = '';
    let chain: Promise<unknown> = Promise.resolve();
    const seenWarnings = new Set<string>();

    const confirmShell = (c: SlashRunContext, cmd: CustomCommand) => async (command: string): Promise<boolean> => {
      const verdict = commandVerdict(ctx, command);
      if (verdict === 'deny') return false;
      if (verdict === 'allow') return true;
      const ans = await askSlash(c, {
        kind: 'confirm',
        title: tr(c.lang, 'shellAsk', { name: cmd.name }),
        detail: `${command}\n${cmd.file}`,
        yes: tr(c.lang, 'allow'),
        no: tr(c.lang, 'deny'),
        defaultYes: false,
        danger: true,
      });
      return ans === true;
    };

    const toDef = (cmd: CustomCommand): FeatureSlashDef => ({
      name: cmd.name,
      description: { vi: cmd.description, en: cmd.description },
      ...(cmd.argumentHint ? { argHint: cmd.argumentHint } : {}),
      run: async (c) => {
        try {
          await state.reload(); // lấy bản mới nhất của tệp
          const fresh = state.commands.find((x) => x.name === cmd.name);
          if (!fresh) return c.output(tr(c.lang, 'gone', { name: cmd.name }), 'error');
          const ac = new AbortController();
          const r = await expandCustomCommand(fresh, c.args, {
            host: guardedHost(ctx, ctx.host),
            trusted: ctx.isTrusted(),
            signal: ac.signal,
            noShell: ctx.session().mode === 'plan',
            confirmShell: confirmShell(c, fresh),
          });
          const notes = [r.notes.embedded.length ? tr(c.lang, 'embedded', { n: r.notes.embedded.length }) : '', r.notes.refused.length ? tr(c.lang, 'refused', { n: r.notes.refused.length }) : ''].filter(Boolean);
          if (notes.length) c.toast(r.notes.refused.length ? 'warn' : 'info', notes.join(' · '));
          await c.runPrompt(r.prompt, fresh.model ? { model: fresh.model } : undefined);
        } catch (err) {
          c.output(tr(c.lang, 'failed', { name: cmd.name, error: err instanceof Error ? err.message : String(err) }), 'error');
        }
      },
    });

    const doReload = async (): Promise<void> => {
      const r = await loadCommandDirs(ctx.host, commandDirs(ctx));
      const all = [...r.commands];
      for (const p of await activePlugins(ctx)) {
        for (const pc of await loadPluginCommands(p)) {
          if (all.some((x) => x.name === pc.name)) continue;
          all.push({ name: pc.name, description: pc.description, allowedTools: [], disableModelInvocation: false, body: pc.template, source: 'plugin', file: p.dir });
        }
      }
      all.sort((a, b) => a.name.localeCompare(b.name));
      state.commands = all;
      state.warnings = r.warnings;
      for (const w of r.warnings) {
        if (seenWarnings.has(w)) continue;
        seenWarnings.add(w);
        ctx.log('warn', `${tr('vi', 'warn')}: ${w}`);
        if (seenWarnings.size <= 3) ctx.toast('warn', `${tr(ctx.lang, 'warn')}: ${w}`);
      }
      const sig = all.map((c) => `${c.source}:${c.name}:${c.description}:${c.argumentHint ?? ''}`).join('|');
      if (sig !== signature) {
        signature = sig;
        for (const source of ['project', 'user', 'plugin'] as const) {
          ctx.replaceSlashSource(source, all.filter((c) => c.source === (source as CommandSource)).map(toDef));
        }
      }
    };

    const state: CommandsState = {
      commands: [],
      warnings: [],
      reload() {
        const run = chain.then(doReload);
        chain = run.catch(() => undefined);
        return run;
      },
    };
    states.set(ctx, state);
    await state.reload();

    ctx.onSessionChange(() => void state.reload().catch(() => undefined));
    onPluginsChanged(ctx, () => void state.reload().catch(() => undefined));

    // Công cụ `slash_command`: model tự gọi lệnh tuỳ chỉnh; lệnh nhúng của nó cũng đi qua luật chặn.
    ctx.addToolContributor((add) => {
      const base = createSlashCommandTool({ commands: () => state.commands, trusted: () => ctx.isTrusted() });
      const tool: ToolDef<{ command: string; args?: string }> = {
        ...base,
        get description() {
          return base.description;
        },
        get hidden() {
          return base.hidden;
        },
        execute: (input, tctx: ToolContext) => base.execute(input, { ...tctx, host: guardedHost(ctx, tctx.host) }),
      };
      add(tool);
    });

    // Theo dõi thay đổi tệp (nếu hệ điều hành hỗ trợ): quét lại có giãn.
    const watchers: fs.FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void state.reload().catch(() => undefined), 300);
      timer.unref?.();
    };
    for (const d of commandDirs(ctx)) {
      try {
        if (!fs.existsSync(d.path)) continue;
        const w = fs.watch(d.path, { recursive: true }, kick);
        w.on('error', () => undefined);
        w.unref?.();
        watchers.push(w);
      } catch {
        /* nền tảng không hỗ trợ theo dõi đệ quy: vẫn quét khi chạy lệnh / đổi phiên */
      }
    }
    ctx.onDispose(() => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    });
  },
};
