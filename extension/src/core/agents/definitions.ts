/**
 * Định nghĩa agent con (subagent) — cùng ý tưởng với `.claude/agents/*.md` của Claude Code:
 * mỗi agent có vai trò (prompt) riêng, tập công cụ riêng và hạng model riêng; chạy trong phiên độc lập
 * (ngữ cảnh riêng, trạng thái riêng) và chỉ trả về báo cáo cuối cho luồng chính.
 *
 * Định dạng tệp:  <thư mục agents>/<tên>.md
 *   ---
 *   name: reviewer
 *   description: Phản biện nghiêm khắc một giải pháp
 *   tools: read_file, grep, glob          # hoặc: readonly | all  (chấp nhận cả tên Claude Code: Read, Grep, Bash…)
 *   model: top                            # top | balanced | fast | inherit | nhà-cung-cấp:model  (opus|sonnet|haiku cũng được)
 *   maxTurns: 12
 *   thinking: high
 *   ---
 *   (nội dung = vai trò / chỉ dẫn của agent)
 */

import type { ToolHost } from '../engine/types';
import { isTier, type Tier } from '../orchestration/tiers';
import { parseSkillMarkdown, slugifyName } from '../skills/registry';
import type { ThinkingLevel } from '../types';

export type AgentTier = Tier | 'inherit';
export type AgentSource = 'builtin' | 'workspace' | 'user' | 'plugin';

export interface AgentDef {
  name: string;
  description: string;
  tier: AgentTier;
  /** `nhà-cung-cấp:model` cố định (ưu tiên hơn `tier`). */
  model?: string;
  /** readonly = chỉ đọc + web; all = mọi công cụ của luồng chính (trừ agent/workflow); hoặc danh sách tên (hỗ trợ `mcp__*`). */
  tools: 'readonly' | 'all' | string[];
  maxTurns: number;
  thinking: ThinkingLevel;
  prompt: string;
  source: AgentSource;
  dir?: string;
  /** (lane:commands-agents) Màu nhãn trong giao diện (frontmatter `color`, như Claude Code). */
  color?: string;
  /** (lane:commands-agents) Tệp định nghĩa (agent từ tệp). */
  file?: string;
}

export const READONLY_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'fetch_url', 'load_skill', 'search_skills', 'scratchpad'];
/** Agent con không được tự sinh agent con, không đụng danh sách tác vụ của người dùng, không tự duyệt kế hoạch. */
/** (`chrome`: điều khiển trình duyệt thật của người dùng — chỉ luồng chính, có người dùng giám sát.) */
export const NEVER_FOR_SUB = new Set(['agent', 'workflow_run', 'exit_plan_mode', 'todo_write', 'chrome']);

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  read: 'read_file',
  grep: 'grep',
  glob: 'glob',
  ls: 'list_dir',
  websearch: 'web_search',
  webfetch: 'fetch_url',
  bash: 'run_command',
  edit: 'edit_file',
  multiedit: 'edit_file',
  write: 'write_file',
  task: 'agent',
};

const THINKING: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export function builtinAgents(): AgentDef[] {
  return [
    {
      name: 'explore',
      description: 'Do thám nhanh, chỉ đọc: tìm tệp/ký hiệu/sự kiện trong workspace hoặc trên web rồi báo lại kèm bằng chứng. Dùng cho tìm kiếm rộng để luồng chính không bị nhồi dữ liệu.',
      tier: 'fast',
      tools: 'readonly',
      maxTurns: 12,
      thinking: 'low',
      prompt:
        'You are an exploration specialist. Search broadly but economically: glob/grep first, then read only the relevant ranges. Never modify anything. ' +
        'Report concrete findings with file:line references or URLs, and say clearly what you could not find.',
      source: 'builtin',
    },
    {
      name: 'plan',
      description: 'Kiến trúc sư: khảo sát mã rồi trả về kế hoạch từng bước (tệp cần sửa, thứ tự, rủi ro, cách kiểm chứng). Không sửa gì.',
      tier: 'top',
      tools: 'readonly',
      maxTurns: 10,
      thinking: 'high',
      prompt:
        'You are a software architect. Investigate the code that matters, then return a concrete, ordered plan: files to change, what changes, risks, and how to verify each step. ' +
        'Do not modify anything. Prefer the smallest change that solves the problem.',
      source: 'builtin',
    },
    {
      name: 'researcher',
      description: 'Nghiên cứu web có đối chiếu nguồn: tìm, đọc nguồn gốc, kiểm tra số liệu, trả về kết quả kèm URL và mức tin cậy.',
      tier: 'balanced',
      tools: 'readonly',
      maxTurns: 14,
      thinking: 'medium',
      prompt:
        'Research the question with web_search and fetch_url. Prefer primary sources, cross-check figures and dates across at least two sources, and flag conflicts. ' +
        'Return findings with source URLs and an honest confidence note.',
      source: 'builtin',
    },
    {
      name: 'reviewer',
      description: 'Phản biện nghiêm khắc: cố bác bỏ một kết luận/giải pháp (tìm lỗi, lỗ hổng, bằng chứng mâu thuẫn) rồi kết luận đạt / không đạt / chưa chắc.',
      tier: 'top',
      tools: 'readonly',
      maxTurns: 12,
      thinking: 'high',
      prompt:
        'You are a critical reviewer. Try hard to falsify the claim or solution you are given: look for bugs, missing cases, contradicting evidence. ' +
        'Return a verdict (pass / fail / uncertain) followed by the evidence for it. Do not modify anything.',
      source: 'builtin',
    },
    // (lane:commands-agents) chạy kiểm thử như một việc trọn gói: tìm đúng lệnh, chạy, đọc lỗi, báo cáo — không sửa mã.
    {
      name: 'test-runner',
      description: 'Chạy kiểm thử/kiểm tra kiểu/build của dự án, đọc lỗi rồi báo đúng con số (đạt/đỏ, tệp:dòng, nguyên nhân khả dĩ). Không sửa mã. Mỗi lệnh vẫn xin phép người dùng.',
      tier: 'fast',
      tools: ['read_file', 'list_dir', 'glob', 'grep', 'run_command'],
      maxTurns: 12,
      thinking: 'low',
      prompt:
        'You run the project\'s checks and report results. First find the right commands (package.json scripts, Makefile, pyproject, CI config); prefer the narrowest command that answers the question. ' +
        'Run them, read the failures, and report: the exact command, totals (passed/failed/skipped), each failure with file:line and the key error line, and the most likely cause. ' +
        'Never edit files, never "fix" tests, never claim success you did not observe. If a command cannot run, say why.',
      source: 'builtin',
    },
    {
      name: 'general',
      description: 'Kỹ sư đa năng cho một việc trọn gói: đọc, sửa, chạy lệnh, kiểm chứng rồi báo đúng những gì đã làm. Mọi thao tác ghi/chạy lệnh vẫn xin phép người dùng như luồng chính.',
      tier: 'balanced',
      tools: 'all',
      maxTurns: 20,
      thinking: 'medium',
      prompt:
        'You are a capable engineer working on one self-contained task. Do the work end to end, verify it (run the relevant checks), then report exactly what you changed or found.',
      source: 'builtin',
    },
  ];
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : v.split(/[,\n]/);
  return raw.map((s) => s.trim()).filter(Boolean);
}

export function parseAgentTools(v: string | string[] | undefined): AgentDef['tools'] {
  const list = asList(v);
  if (list.length === 0) return 'readonly';
  if (list.length === 1) {
    const one = list[0].toLowerCase();
    if (one === 'all' || one === '*') return 'all';
    if (one === 'readonly' || one === 'read-only' || one === 'read_only') return 'readonly';
  }
  return list.map((n) => CLAUDE_TOOL_NAMES[n.toLowerCase()] ?? n);
}

export function parseAgentModel(v: string | string[] | undefined): { tier: AgentTier; model?: string } {
  const raw = (Array.isArray(v) ? v[0] : v ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'inherit') return { tier: 'inherit' };
  if (isTier(lower)) return { tier: lower };
  if (lower === 'opus') return { tier: 'top' };
  if (lower === 'sonnet') return { tier: 'balanced' };
  if (lower === 'haiku') return { tier: 'fast' };
  if (raw.includes(':')) return { tier: 'inherit', model: raw };
  return { tier: 'inherit' };
}

export function agentFromMarkdown(text: string, fallbackName: string, source: AgentSource, dir?: string): AgentDef | null {
  const { meta, body } = parseSkillMarkdown(text);
  const name = slugifyName(String(meta.name ?? fallbackName));
  if (!name) return null;
  const description = String(meta.description ?? '').replace(/\s+/g, ' ').trim() || body.split('\n').find((l) => l.trim()) || name;
  const m = parseAgentModel(meta.model);
  const turns = Number(meta.maxturns ?? meta['max-turns'] ?? meta.max_turns);
  const thinking = String(meta.thinking ?? '').toLowerCase() as ThinkingLevel;
  return {
    name,
    description: description.slice(0, 400),
    tier: m.tier,
    model: m.model,
    tools: parseAgentTools(meta.tools),
    maxTurns: Number.isFinite(turns) && turns > 0 ? Math.min(40, Math.floor(turns)) : 15,
    thinking: THINKING.includes(thinking) ? thinking : 'medium',
    prompt: body.slice(0, 20_000),
    source,
    dir,
    ...(/^[a-z]{3,12}$|^#[0-9a-f]{3,8}$/i.test(String(meta.color ?? '').trim()) ? { color: String(meta.color).trim().toLowerCase() } : {}),
  };
}

export interface AgentDirSpec {
  path: string;
  source: Exclude<AgentSource, 'builtin'>;
}

export class AgentRegistry {
  private readonly map = new Map<string, AgentDef>();

  constructor(private readonly builtin: AgentDef[] = builtinAgents()) {
    for (const a of builtin) this.map.set(a.name, a);
  }

  /** Quét lại thư mục agent (workspace/người dùng/plugin); agent ngoài ghi đè agent dựng sẵn trùng tên. */
  async loadDirs(host: ToolHost, dirs: AgentDirSpec[]): Promise<{ loaded: number; errors: string[] }> {
    this.map.clear();
    for (const a of this.builtin) this.map.set(a.name, a);
    let loaded = 0;
    const errors: string[] = [];
    for (const d of dirs) {
      let entries;
      try {
        if (!(await host.stat(d.path))?.isDirectory) continue;
        entries = await host.readDir(d.path);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory || !/\.md$/i.test(e.name)) continue;
        const file = `${d.path}${d.path.endsWith('/') || d.path.endsWith('\\') ? '' : d.path.includes('\\') && !d.path.includes('/') ? '\\' : '/'}${e.name}`;
        try {
          const text = await host.readText(file);
          if (text == null) continue;
          const def = agentFromMarkdown(text, e.name.replace(/\.md$/i, ''), d.source, d.path);
          if (def) {
            def.file = file; // (lane:commands-agents)
            this.map.set(def.name, def);
            loaded++;
          }
        } catch (err) {
          errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { loaded, errors };
  }

  list(): AgentDef[] {
    return [...this.map.values()];
  }

  get(name: string): AgentDef | undefined {
    return this.map.get(name) ?? this.map.get(slugifyName(name));
  }

  /** Danh mục ngắn đưa vào mô tả công cụ `agent`. */
  catalog(): string {
    return this.list()
      .map((a) => `- ${a.name} (${a.model ?? a.tier}, ${Array.isArray(a.tools) ? a.tools.join('/') : a.tools}): ${a.description}`)
      .join('\n');
  }
}
