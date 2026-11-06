/**
 * Plugin: một thư mục gom kỹ năng, agent, lệnh gạch chéo và server MCP — cùng hình dạng với plugin của Claude Code.
 *
 *   <plugin>/
 *     plugin.json  (hoặc .claude-plugin/plugin.json, .locaith-plugin/plugin.json)   { "name", "version", "description", ... }
 *     skills/<kỹ-năng>/SKILL.md
 *     agents/<agent>.md
 *     commands/<lệnh>.md        (nội dung = prompt; `$ARGUMENTS` được thay bằng phần người dùng gõ sau tên lệnh)
 *     .mcp.json                 { "mcpServers": { "tên": { "command": …, "args": […] } } }
 *
 * Không có `plugin.json` nhưng có `skills/`, `agents/` hay `commands/` thì vẫn là plugin (tên = tên thư mục).
 * Đường dẫn khai báo trong manifest phải nằm TRONG thư mục plugin.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeServerConfig, type McpServerConfig } from '../mcp/client';

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  dir: string;
  skillDirs: string[];
  agentDirs: string[];
  commandDirs: string[];
  mcpServers: Record<string, McpServerConfig>;
  error?: string;
}

export interface PluginCommand {
  /** Tên dùng sau dấu `/`: `<plugin>:<lệnh>`. */
  name: string;
  description: string;
  template: string;
  plugin: string;
}

const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.locaith-plugin/plugin.json'];

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

async function readJson(p: string): Promise<any | undefined> {
  try {
    return JSON.parse((await readFile(p, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/** Đường dẫn tương đối nằm trong thư mục plugin, hoặc null nếu thoát ra ngoài. */
export function inside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep) ? abs : null;
}

const asArray = (v: unknown, fallback: string[]): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback);

export async function loadPlugin(dir: string): Promise<PluginInfo | null> {
  let manifest: any;
  for (const m of MANIFESTS) {
    manifest = await readJson(path.join(dir, m));
    if (manifest) break;
  }
  const base = path.basename(dir);
  const skills = asArray(manifest?.skills, ['skills']);
  const agents = asArray(manifest?.agents, ['agents']);
  const commands = asArray(manifest?.commands, ['commands']);
  const pick = async (rels: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const r of rels) {
      const abs = inside(dir, r);
      if (abs && (await isDir(abs))) out.push(abs);
    }
    return out;
  };
  const skillDirs = await pick(skills);
  const agentDirs = await pick(agents);
  const commandDirs = await pick(commands);
  const servers: Record<string, McpServerConfig> = {};
  const mcpRaw = typeof manifest?.mcpServers === 'string' ? await readJson(inside(dir, manifest.mcpServers) ?? '') : manifest?.mcpServers ?? (await readJson(path.join(dir, '.mcp.json')));
  const table = mcpRaw?.mcpServers ?? mcpRaw;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [k, v] of Object.entries(table)) {
      const cfg = sanitizeServerConfig(v);
      if (cfg) servers[`${(manifest?.name as string) || base}:${k}`] = withPluginRoot({ ...cfg, cwd: cfg.cwd ?? (cfg.command ? dir : undefined) }, dir);
    }
  }
  if (!manifest && skillDirs.length + agentDirs.length + commandDirs.length === 0 && Object.keys(servers).length === 0) return null;
  const name = String(manifest?.name ?? base).trim().slice(0, 64) || base;
  return {
    id: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
    name,
    version: String(manifest?.version ?? '0.0.0').slice(0, 32),
    description: String(manifest?.description ?? '').slice(0, 400),
    dir,
    skillDirs,
    agentDirs,
    commandDirs,
    mcpServers: servers,
  };
}

/** Quét các thư mục gốc (mỗi thư mục con là một plugin). */
export async function discoverPlugins(roots: string[]): Promise<PluginInfo[]> {
  const out: PluginInfo[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const dir = path.join(root, name);
      try {
        const p = await loadPlugin(dir);
        if (p && !seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
      } catch (err) {
        out.push({ id: name, name, version: '', description: '', dir, skillDirs: [], agentDirs: [], commandDirs: [], mcpServers: {}, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

export async function loadPluginCommands(p: Pick<PluginInfo, 'name' | 'commandDirs'>): Promise<PluginCommand[]> {
  const out: PluginCommand[] = [];
  for (const dir of p.commandDirs) {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => /\.md$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      let text = '';
      try {
        text = (await readFile(path.join(dir, f), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
      } catch {
        continue;
      }
      let description = '';
      let body = text;
      const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
      if (m) {
        body = text.slice(m[0].length);
        description = /^description:\s*(.*)$/m.exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
      }
      const cmd = f.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      out.push({ name: `${p.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}:${cmd}`, description: description || body.split('\n').find((l) => l.trim())?.slice(0, 120) || cmd, template: body.trim().slice(0, 20_000), plugin: p.name });
    }
  }
  return out;
}

/** Thay `${CLAUDE_PLUGIN_ROOT}` / `${LOCAITH_PLUGIN_ROOT}` bằng thư mục của plugin (plugin của Claude Code dùng biến này trong lệnh MCP). */
export function withPluginRoot(cfg: McpServerConfig, dir: string): McpServerConfig {
  const sub = (v: string): string => v.split('${CLAUDE_PLUGIN_ROOT}').join(dir).split('${LOCAITH_PLUGIN_ROOT}').join(dir);
  return {
    ...cfg,
    ...(cfg.command ? { command: sub(cfg.command) } : {}),
    ...(cfg.args ? { args: cfg.args.map(sub) } : {}),
    ...(cfg.env ? { env: Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, sub(v)])) } : {}),
    ...(cfg.cwd ? { cwd: sub(cfg.cwd) } : {}),
    ...(cfg.url ? { url: sub(cfg.url) } : {}),
  };
}

export function expandCommand(template: string, args: string): string {
  return template.includes('$ARGUMENTS') ? template.split('$ARGUMENTS').join(args) : args ? `${template}\n\n${args}` : template;
}
