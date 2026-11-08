/**
 * Trình bày lệnh gọi công cụ kiểu Claude Code: `● Read(src/app.ts)` rồi `  ⎿ Đọc 120 dòng`; gom nhóm các lệnh đọc liền nhau;
 * Bash cắt 4 dòng đầu/cuối; sửa tệp kèm diff; agent con kèm số liệu.
 */

import type { ToolBlock } from '../../shared/protocol';
import { t as tr } from '../i18n';
import { renderDiff } from './diff';
import { fmtDuration, fmtTokens, middleEllipsis, relPath } from './format';
import './strings';
import type { Theme } from './theme';
import { stringWidth, truncateAnsi, wrapAnsi } from './width';

export type ToolKind = 'read' | 'list' | 'glob' | 'grep' | 'edit' | 'write' | 'bash' | 'web' | 'fetch' | 'agent' | 'skill' | 'browser' | 'mcp' | 'other';

export interface ToolView {
  kind: ToolKind;
  /** Tên hiển thị (Read, Update, Bash…). */
  title: string;
  /** Đối số rút gọn trong ngoặc. */
  arg: string;
  hidden: boolean;
}

const TITLES: Record<string, [ToolKind, string]> = {
  read_file: ['read', 'Read'],
  list_dir: ['list', 'List'],
  glob: ['glob', 'Glob'],
  grep: ['grep', 'Search'],
  edit_file: ['edit', 'Update'],
  write_file: ['write', 'Write'],
  run_command: ['bash', 'Bash'],
  web_search: ['web', 'WebSearch'],
  fetch_url: ['fetch', 'Fetch'],
  agent: ['agent', 'Agent'],
  workflow_run: ['agent', 'Workflow'],
  load_skill: ['skill', 'Skill'],
  search_skills: ['skill', 'Skills'],
  create_artifact: ['other', 'Artifact'],
  update_artifact: ['other', 'Artifact'],
  scratchpad: ['other', 'Note'],
  exit_plan_mode: ['other', 'Plan'],
  show_before_after: ['other', 'Compare'],
};

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const firstLine = (x: string): string => x.split('\n').find((l) => l.trim()) ?? '';

function titleCase(name: string): string {
  return name
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

export function describeCall(name: string, args: Record<string, unknown> | undefined, cwd?: string): ToolView {
  const a = args ?? {};
  const hidden = name === 'todo_write' || name === 'offer_options';
  const known = TITLES[name];
  if (known) {
    const [kind, title] = known;
    let arg = '';
    switch (name) {
      case 'read_file':
      case 'edit_file':
      case 'write_file':
        arg = relPath(s(a.path), cwd);
        break;
      case 'list_dir':
        arg = relPath(s(a.path) || '.', cwd);
        break;
      case 'glob':
        arg = s(a.pattern) + (a.path ? ` in ${relPath(s(a.path), cwd)}` : '');
        break;
      case 'grep':
        arg = `"${s(a.pattern)}"` + (a.path || a.glob ? ` in ${relPath(s(a.path) || s(a.glob), cwd)}` : '');
        break;
      case 'run_command': {
        const c = s(a.command).trim();
        const fl = c.split('\n')[0];
        arg = fl + (c.includes('\n') ? ' …' : '');
        break;
      }
      case 'web_search':
      case 'search_skills':
        arg = s(a.query);
        break;
      case 'fetch_url':
        arg = s(a.url);
        break;
      case 'agent':
      case 'workflow_run':
        arg = s(a.description) || s(a.agent_type) || s(a.name);
        break;
      case 'load_skill':
        arg = s(a.skill_name) || s(a.skill) || s(a.name);
        break;
      case 'create_artifact':
      case 'update_artifact':
        arg = s(a.title) || s(a.artifact_id) || s(a.id);
        break;
      case 'scratchpad':
        arg = [s(a.action), s(a.key)].filter(Boolean).join(' ');
        break;
      default:
        break;
    }
    return { kind, title, arg, hidden };
  }
  if (name.startsWith('page_') || name.startsWith('tab')) {
    const action = name.replace(/^page_/, '').replace(/^tabs?_?/, 'tab ');
    const detail = s(a.url) || s(a.query) || (a.ref !== undefined ? `[${s(a.ref)}]` : '') || s(a.key);
    return { kind: 'browser', title: 'Browser', arg: [action, detail].filter(Boolean).join(' '), hidden };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const firstArg = Object.values(a).find((v) => typeof v === 'string' && v.length > 0);
  if (mcp) return { kind: 'mcp', title: `${mcp[1]}:${mcp[2]}`, arg: s(firstArg), hidden };
  return { kind: 'other', title: titleCase(name), arg: s(firstArg), hidden };
}

export interface ToolRenderOptions {
  theme: Theme;
  width: number;
  cwd?: string;
  expanded?: boolean;
  /** Ký hiệu thay cho ● khi đang chạy (khung spinner). */
  spin?: string;
  now?: number;
}

function bulletFor(b: ToolBlock, th: Theme, spin?: string): string {
  switch (b.state) {
    case 'running':
    case 'awaiting_permission':
      return th.brand(spin ?? th.g.bullet);
    case 'error':
      return th.err(th.g.bullet);
    case 'denied':
      return th.warn(th.g.bullet);
    case 'cancelled':
      return th.muted(th.g.bullet);
    default:
      return th.ok(th.g.bullet);
  }
}

/** Dòng đầu: `● Read(src/app.ts)` (cắt vừa chiều rộng). */
export function renderToolHead(b: ToolBlock, o: ToolRenderOptions): string {
  const th = o.theme;
  const v = describeCall(b.name, b.args, o.cwd);
  const lead = `${bulletFor(b, th, o.spin)} `;
  const room = Math.max(10, o.width - 2 - v.title.length - 2);
  const arg = v.arg ? middleEllipsisAware(v.arg.replace(/\s+/g, ' '), room) : '';
  const argPart = arg ? th.muted('(') + arg + th.muted(')') : '';
  let line = lead + th.bold(v.title) + argPart;
  if (b.state === 'running' || b.state === 'awaiting_permission') {
    const el = (o.now ?? Date.now()) - b.startedAt;
    if (b.state === 'awaiting_permission') line += th.warn('  ' + tr('tui.perm.waiting'));
    else if (el > 2500) line += th.muted(`  ${fmtDuration(el, undefined, true)}`);
  }
  return truncateAnsi(line, o.width);
}

function middleEllipsisAware(sv: string, room: number): string {
  if (stringWidth(sv) <= room) return sv;
  // đường dẫn: cắt giữa; còn lại cắt cuối
  if (/[\\/]/.test(sv) && !/\s/.test(sv)) return middleEllipsis(sv, room);
  return sv.slice(0, Math.max(1, room - 1)) + '…';
}

const RES_FIRST = (th: Theme): string => '  ' + th.muted(th.g.result) + ' ';
const RES_REST = '    ';

function lineCount(text: string | undefined): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Các dòng «kết quả» sau dòng đầu (đã có tiền tố ⎿). */
export function renderToolResult(b: ToolBlock, o: ToolRenderOptions): string[] {
  const th = o.theme;
  const v = describeCall(b.name, b.args, o.cwd);
  const first = RES_FIRST(th);
  const w = o.width - stringWidth(RES_REST);
  const out: string[] = [];
  const put = (text: string, style: (x: string) => string = (x) => x): void => {
    const rows = wrapAnsi(text, w);
    rows.forEach((r, i) => out.push((out.length === 0 && i === 0 ? first : RES_REST) + style(r)));
  };
  const more = (n: number): string => th.muted(tr('tui.tool.more', { n }));

  if (b.state === 'denied') {
    put(tr('tui.tool.denied'), th.warn);
    return out;
  }
  if (b.state === 'cancelled') {
    put(tr('tui.tool.cancelled'), th.muted);
    return out;
  }
  const output = (b.output ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (b.state === 'error' && v.kind !== 'bash') {
    const lines = output.split('\n').filter((l) => l.trim());
    const head = lines[0] ?? b.summary ?? tr('tui.tool.failed');
    put(`${tr('tui.tool.failed')}: ${head}`, th.err);
    const extra = lines.slice(1, o.expanded ? 40 : 4);
    for (const l of extra) put(l, th.err);
    if (!o.expanded && lines.length > 5) put(tr('tui.tool.more', { n: lines.length - 5 }), th.muted);
    return out;
  }

  switch (v.kind) {
    case 'edit':
    case 'write': {
      const d = b.diff;
      if (d) {
        const label = d.isNew ? tr('tui.tool.created', { path: relPath(d.path, o.cwd), n: d.added }) : tr('tui.tool.changes', { add: d.added, del: d.removed });
        put(label, th.plain);
        out.push(
          ...renderDiff(d, {
            width: o.width,
            theme: th,
            indent: RES_REST,
            maxLines: d.isNew ? 8 : 12,
            expanded: o.expanded,
            moreLabel: (n) => tr('tui.tool.more', { n }),
          }),
        );
        return out;
      }
      put(b.summary || tr('tui.tool.updated', { path: relPath(s(b.args.path), o.cwd) }), th.plain);
      return out;
    }
    case 'read': {
      const n = b.summary ? undefined : lineCount(output);
      put(b.summary || tr('tui.tool.read.n', { n: n ?? 0 }), th.plain);
      return out;
    }
    case 'bash': {
      const lines = output ? output.split('\n') : [];
      if (b.state === 'error') put(tr('tui.tool.failed') + (b.summary ? ` ${th.g.sep} ${b.summary}` : ''), th.err);
      if (!lines.length) {
        if (b.state !== 'error') put(b.summary || tr('tui.tool.empty'), th.muted);
        return out;
      }
      const cap = o.expanded ? lines.length : 8;
      if (lines.length <= cap) {
        lines.forEach((l) => put(l, th.plain));
      } else {
        const head = 4;
        const tail = 4;
        lines.slice(0, head).forEach((l) => out.push((out.length === 0 ? first : RES_REST) + truncateAnsi(l, w)));
        out.push(RES_REST + more(lines.length - head - tail));
        lines.slice(-tail).forEach((l) => out.push(RES_REST + truncateAnsi(l, w)));
      }
      return out.map((l, i) => (i === 0 || o.expanded ? l : truncateAnsi(l, o.width)));
    }
    case 'glob':
    case 'grep':
    case 'list':
    case 'web': {
      const n = lineCount(output);
      put(b.summary || (n ? tr('tui.tool.matches', { n }) : tr('tui.tool.nomatch')), th.plain);
      if (o.expanded && output) output.split('\n').slice(0, 60).forEach((l) => put(l, th.muted));
      return out;
    }
    case 'agent': {
      const st = b.agent;
      const parts = [tr('tui.tool.done')];
      const meta: string[] = [];
      if (st?.tools) meta.push(tr('tui.tool.calls', { n: st.tools }));
      if (st?.tokens) meta.push(`${fmtTokens(st.tokens)} token`);
      if (b.durationMs) meta.push(fmtDuration(b.durationMs));
      put(parts[0] + (meta.length ? ` (${meta.join(' ' + th.g.sep + ' ')})` : ''), th.plain);
      if (b.summary) put(b.summary, th.muted);
      return out;
    }
    default: {
      const lines = output ? output.split('\n').filter((l) => l.trim()) : [];
      if (b.summary) put(b.summary, th.plain);
      else if (lines.length) put(lines[0], th.plain);
      else put(tr('tui.tool.done'), th.muted);
      const cap = o.expanded ? 40 : 0;
      if (cap && lines.length > 1) lines.slice(1, cap).forEach((l) => put(l, th.muted));
      return out;
    }
  }
}

/** Khối hoàn chỉnh của một lệnh đã xong: đầu + kết quả. */
export function renderToolBlock(b: ToolBlock, o: ToolRenderOptions): string[] {
  const v = describeCall(b.name, b.args, o.cwd);
  if (v.hidden) return [];
  return [renderToolHead(b, o), ...renderToolResult(b, o)];
}

/** Vùng sống: lệnh đang chạy (đầu + vài dòng tiến độ cuối). */
export function renderToolLive(b: ToolBlock, o: ToolRenderOptions): string[] {
  const th = o.theme;
  const v = describeCall(b.name, b.args, o.cwd);
  if (v.hidden) return [];
  const out = [renderToolHead(b, o)];
  if (v.kind === 'agent' && b.agent) {
    const a = b.agent;
    const meta = [a.tools ? tr('tui.tool.calls', { n: a.tools }) : '', a.tokens ? `${fmtTokens(a.tokens)} token` : '', fmtDuration((o.now ?? Date.now()) - b.startedAt, undefined, true)].filter(Boolean).join(` ${th.g.sep} `);
    out.push(RES_FIRST(th) + th.muted(truncateAnsi(`${a.activity ? a.activity + '  ' : ''}(${meta})`, o.width - 4)));
    return out;
  }
  const prog = (b.output ?? '').split('\n').filter((l) => l.trim());
  const n = o.expanded ? 8 : 2;
  prog.slice(-n).forEach((l, i) => out.push((i === 0 ? RES_FIRST(th) : RES_REST) + th.muted(truncateAnsi(l.replace(/\t/g, '  '), o.width - 5))));
  return out;
}

const GROUPABLE = new Set(['read_file', 'glob', 'grep', 'list_dir', 'web_search', 'fetch_url']);

export function isGroupable(b: ToolBlock): boolean {
  return GROUPABLE.has(b.name) && b.state === 'done';
}

const MIN_GROUP = 3;

/** Gom ≥ 3 lệnh đọc/tìm liền nhau cùng loại thành một dòng. Trả null nếu không gom. */
export function renderToolGroup(blocks: ToolBlock[], o: ToolRenderOptions): string[] | null {
  if (blocks.length < MIN_GROUP || o.expanded) return null;
  const th = o.theme;
  const name = blocks[0].name;
  const key = name === 'read_file' ? 'tui.tool.read.files' : name === 'web_search' ? 'tui.tool.web.files' : name === 'fetch_url' ? 'tui.tool.fetch.files' : name === 'list_dir' ? 'tui.tool.list.files' : 'tui.tool.search.files';
  const head = `${th.ok(th.g.bullet)} ${th.bold(tr(key, { n: blocks.length }))}`;
  const items = blocks.map((b) => describeCall(b.name, b.args, o.cwd).arg).filter(Boolean);
  const maxChars = Math.max(10, o.width - 8);
  let joined = '';
  let shown = 0;
  for (const it of items) {
    const next = joined ? `${joined}, ${it}` : it;
    if (next.length > maxChars - 14 && shown > 0) break;
    joined = next;
    shown++;
  }
  const rest = items.length - shown;
  const tail = rest > 0 ? `, +${rest}` : '';
  const line = RES_FIRST(th) + th.muted(truncateAnsi(joined + tail, o.width - 5)) + th.faint('  (ctrl+o)');
  return [truncateAnsi(head, o.width), line];
}
