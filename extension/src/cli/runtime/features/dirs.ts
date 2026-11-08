/**
 * Thư mục kỹ năng / agent / lệnh theo thứ tự ưu tiên (trùng tên: thư mục đứng trước thắng). Dự án chỉ khi thư mục làm việc đã tin cậy.
 * Cài đặt `commands.includeClaude` (mặc định BẬT, như extension): đọc thêm `.claude/{skills,agents,commands}` ở cả dự án lẫn `~`.
 */

import * as path from 'node:path';
import type { AgentDirSpec } from '../../../core/agents/definitions';
import type { CommandDirSpec } from '../../../core/commands/custom';
import type { SkillDirSpec } from '../../../core/skills/registry';
import type { PluginInfo } from '../../../core/plugins/loader';
import type { FeatureContext } from '../contract';
import { strList } from './settingsFile';

export const includeClaude = (ctx: FeatureContext): boolean => ctx.settings.get<boolean>('commands.includeClaude', true) !== false;

const expandHome = (ctx: FeatureContext, p: string): string => p.trim().replace(/^~(?=$|[\\/])/, ctx.home);

export function skillDirs(ctx: FeatureContext, plugins: readonly PluginInfo[]): SkillDirSpec[] {
  const out: SkillDirSpec[] = [];
  const claude = includeClaude(ctx);
  if (ctx.isTrusted()) {
    out.push({ path: path.join(ctx.cwd, '.locaith', 'skills'), source: 'workspace' });
    if (claude) out.push({ path: path.join(ctx.cwd, '.claude', 'skills'), source: 'workspace' });
  }
  out.push({ path: path.join(ctx.home, '.locaith', 'skills'), source: 'user' });
  if (claude) out.push({ path: path.join(ctx.home, '.claude', 'skills'), source: 'user' });
  for (const p of strList(ctx.settings.get<unknown>('skills.paths', []))) if (p.trim()) out.push({ path: expandHome(ctx, p), source: 'user' });
  for (const pl of plugins) for (const d of pl.skillDirs) out.push({ path: d, source: 'user' });
  return out;
}

export function agentDirs(ctx: FeatureContext, plugins: readonly PluginInfo[]): AgentDirSpec[] {
  const out: AgentDirSpec[] = [];
  const claude = includeClaude(ctx);
  if (ctx.isTrusted()) {
    out.push({ path: path.join(ctx.cwd, '.locaith', 'agents'), source: 'workspace' });
    if (claude) out.push({ path: path.join(ctx.cwd, '.claude', 'agents'), source: 'workspace' });
  }
  out.push({ path: path.join(ctx.home, '.locaith', 'agents'), source: 'user' });
  if (claude) out.push({ path: path.join(ctx.home, '.claude', 'agents'), source: 'user' });
  for (const pl of plugins) for (const d of pl.agentDirs) out.push({ path: d, source: 'plugin' });
  return out;
}

export function commandDirs(ctx: FeatureContext): CommandDirSpec[] {
  const out: CommandDirSpec[] = [];
  const claude = includeClaude(ctx);
  if (ctx.isTrusted()) {
    out.push({ path: path.join(ctx.cwd, '.locaith', 'commands'), source: 'project' });
    if (claude) out.push({ path: path.join(ctx.cwd, '.claude', 'commands'), source: 'project' });
  }
  out.push({ path: path.join(ctx.home, '.locaith', 'commands'), source: 'user' });
  if (claude) out.push({ path: path.join(ctx.home, '.claude', 'commands'), source: 'user' });
  return out;
}

/** Thư mục ngoài workspace cần cho phép ĐỌC (kỹ năng/agent/lệnh ở `~` và của plugin). */
export function extraReadDirs(ctx: FeatureContext, plugins: readonly PluginInfo[]): string[] {
  const out = [path.join(ctx.home, '.locaith'), ...(includeClaude(ctx) ? [path.join(ctx.home, '.claude')] : [])];
  for (const p of strList(ctx.settings.get<unknown>('skills.paths', []))) if (p.trim()) out.push(expandHome(ctx, p));
  for (const pl of plugins) out.push(pl.dir);
  return out;
}
