/**
 * Plugin (core/plugins/loader.ts): một thư mục gom kỹ năng, agent, lệnh và server MCP. Tìm ở `~/.locaith/plugins`, `<cwd>/.locaith/plugins`
 * (chỉ khi thư mục đã tin cậy) và các đường dẫn ở cài đặt `plugins.paths`. Giống extension: plugin mới tìm thấy mặc định TẮT; bật bằng
 * `/plugins enable <id>` (nhớ ở `~/.locaith/plugins.json`). Các mô-đun skills/agents/commands/mcp lấy phần đóng góp qua `activePlugins`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverPlugins, type PluginInfo } from '../../../core/plugins/loader';
import type { FeatureContext, FeatureModule } from '../contract';
import { makeTr } from './ext';
import { readJsonFile, strList } from './settingsFile';

const tr = makeTr('plugins', {
  none: ['Chưa có plugin nào. Đặt thư mục plugin vào `~/.locaith/plugins` (hoặc `.locaith/plugins` của dự án).', 'No plugins yet. Put plugin folders in `~/.locaith/plugins` (or the project’s `.locaith/plugins`).'],
  head: ['**Plugin** ({n})', '**Plugins** ({n})'],
  on: ['bật', 'on'],
  off: ['tắt', 'off'],
  parts: ['{skills} kỹ năng · {agents} agent · {commands} lệnh · {mcp} MCP', '{skills} skills · {agents} agents · {commands} commands · {mcp} MCP'],
  unknown: ['Không có plugin «{id}».', 'No plugin “{id}”.'],
  set: ['Plugin `{id}` đã {state}.', 'Plugin `{id}` is now {state}.'],
  tip: ['`/plugins enable <id>` · `/plugins disable <id>`', '`/plugins enable <id>` · `/plugins disable <id>`'],
});

export function pluginsStateFile(home: string): string {
  return path.join(home, '.locaith', 'plugins.json');
}

export function enabledPluginIds(home: string): Set<string> {
  return new Set(strList(readJsonFile(pluginsStateFile(home))?.enabled));
}

function setEnabled(home: string, id: string, on: boolean): void {
  const set = enabledPluginIds(home);
  if (on) set.add(id);
  else set.delete(id);
  const file = pluginsStateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled: [...set] }, null, 2), 'utf8');
}

export function pluginRoots(ctx: FeatureContext): string[] {
  const out = [path.join(ctx.home, '.locaith', 'plugins')];
  if (ctx.isTrusted()) out.push(path.join(ctx.cwd, '.locaith', 'plugins'));
  for (const p of strList(ctx.settings.get<unknown>('plugins.paths', []))) out.push(p.replace(/^~(?=$|[\\/])/, ctx.home));
  return out;
}

export async function allPlugins(ctx: FeatureContext): Promise<PluginInfo[]> {
  return discoverPlugins(pluginRoots(ctx));
}

/** Plugin đang bật và không lỗi. */
export async function activePlugins(ctx: FeatureContext): Promise<PluginInfo[]> {
  const enabled = enabledPluginIds(ctx.home);
  return (await allPlugins(ctx)).filter((p) => enabled.has(p.id) && !p.error);
}

type Listener = () => void;
const listeners = new WeakMap<FeatureContext, Set<Listener>>();
export function onPluginsChanged(ctx: FeatureContext, fn: Listener): void {
  let set = listeners.get(ctx);
  if (!set) listeners.set(ctx, (set = new Set()));
  set.add(fn);
}

export const pluginsFeature: FeatureModule = {
  name: 'plugins',
  attach(ctx) {
    ctx.slash({
      name: 'plugins',
      description: { vi: 'Plugin (kỹ năng, agent, lệnh, MCP đóng gói) — /plugins enable|disable <id>', en: 'Plugins (packaged skills, agents, commands, MCP) — /plugins enable|disable <id>' },
      argHint: '[enable|disable <id>]',
      needsIdle: false,
      async run(c) {
        const [verb, id] = c.args.trim().split(/\s+/);
        const all = await allPlugins(ctx);
        if (verb === 'enable' || verb === 'disable') {
          const p = all.find((x) => x.id === (id ?? '').toLowerCase() || x.name === id);
          if (!p) return c.output(tr(c.lang, 'unknown', { id: id ?? '' }), 'error');
          setEnabled(ctx.home, p.id, verb === 'enable');
          for (const fn of listeners.get(ctx) ?? []) fn();
          return c.output(tr(c.lang, 'set', { id: p.id, state: tr(c.lang, verb === 'enable' ? 'on' : 'off') }), 'plain');
        }
        if (!all.length) return c.output(tr(c.lang, 'none'), 'plain');
        const enabled = enabledPluginIds(ctx.home);
        const rows = all.map((p) => {
          const parts = tr(c.lang, 'parts', { skills: p.skillDirs.length, agents: p.agentDirs.length, commands: p.commandDirs.length, mcp: Object.keys(p.mcpServers).length });
          return `- \`${p.id}\` ${enabled.has(p.id) ? tr(c.lang, 'on') : tr(c.lang, 'off')} · v${p.version}${p.error ? ` · ⚠ ${p.error}` : ''} — ${p.description || parts}\n  ${parts}`;
        });
        c.output([tr(c.lang, 'head', { n: all.length }), ...rows, '', tr(c.lang, 'tip')].join('\n'));
      },
    });
  },
};
