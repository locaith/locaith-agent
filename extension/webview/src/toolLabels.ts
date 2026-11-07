/**
 * Nhãn hiển thị của từng công cụ (thuần túy, test được): biến (tên tool, đối số, trạng thái)
 * thành biểu tượng + nhãn tiếng Việt/Anh + chi tiết ngắn ("Đã đọc artificialanalysis.ai").
 */
import type { ToolBlock } from '../../src/shared/protocol';
import type { IconName } from './iconNames';
import { tOpt, type Lang } from './i18n';
import { basename, hostOf, truncate } from './text';

export interface ToolDescription {
  icon: IconName;
  label: string;
  /** Chi tiết phụ: truy vấn tìm kiếm, đường dẫn, lệnh, URL… */
  detail?: string;
  detailKind: 'text' | 'path' | 'command' | 'url';
  /** Nếu có → bấm vào nhãn mở tệp. */
  file?: { path: string; line?: number };
  /** Ẩn dòng này (đã có khối riêng thể hiện: tasks / skill). */
  hidden: boolean;
}

const KNOWN = new Set([
  'todo_write',
  'load_skill',
  'search_skills',
  'web_search',
  'fetch_url',
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'edit_file',
  'write_file',
  'run_command',
  'scratchpad',
  'create_artifact',
  'update_artifact',
  'list_artifact_types',
  'exit_plan_mode',
  // bản trình duyệt
  'tabs_list',
  'page_read',
  'page_snapshot',
  'page_screenshot',
  'page_find',
  'page_click',
  'page_type',
  'page_select',
  'page_press_key',
  'page_scroll',
  'page_hover',
  'page_wait',
  'page_navigate',
  'tab_open',
  'tab_activate',
  'tab_close',
]);

export function isKnownTool(name: string): boolean {
  return KNOWN.has(name);
}

/**
 * Agent con và workflow có nhãn riêng («Agent con: <mô tả>») nhưng KHÔNG nằm trong KNOWN: KNOWN còn quyết định việc có hiện «Đối số» khi mở dòng ra
 * (người dùng cần đọc được prompt đã giao cho agent con).
 */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['agent', 'workflow_run']);

/** Các công cụ có thể gộp thành một dòng khi chạy nhiều lần liền nhau (ví dụ 5 lệnh tìm kiếm song song). */
export const GROUPABLE = new Set(['web_search', 'fetch_url', 'read_file', 'glob', 'grep', 'list_dir', 'page_read', 'page_snapshot', 'run_command']);

const ICONS: Record<string, IconName> = {
  todo_write: 'list-checks',
  load_skill: 'zap',
  search_skills: 'zap',
  web_search: 'search',
  fetch_url: 'globe',
  read_file: 'file-text',
  list_dir: 'folder',
  glob: 'search',
  grep: 'search',
  edit_file: 'pencil',
  write_file: 'file-plus',
  run_command: 'terminal',
  scratchpad: 'notebook',
  create_artifact: 'layout',
  update_artifact: 'layout',
  list_artifact_types: 'layout',
  exit_plan_mode: 'list-checks',
  tabs_list: 'globe',
  page_read: 'eye',
  page_snapshot: 'layout',
  page_screenshot: 'image',
  page_find: 'search',
  page_click: 'zap',
  page_type: 'pencil',
  page_select: 'sliders',
  page_press_key: 'wand',
  page_scroll: 'arrow-down',
  page_hover: 'eye',
  page_wait: 'refresh',
  page_navigate: 'external',
  tab_open: 'plus',
  tab_activate: 'globe',
  tab_close: 'x',
  agent: 'bot',
  workflow_run: 'network',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function describeTool(
  lang: Lang,
  name: string,
  args: Record<string, unknown> | undefined,
  state: ToolBlock['state'],
): ToolDescription {
  const a = args ?? {};
  const phase = state === 'running' || state === 'awaiting_permission' ? 'run' : 'done';

  let target = '';
  let detail: string | undefined;
  let detailKind: ToolDescription['detailKind'] = 'text';
  let file: ToolDescription['file'];

  switch (name) {
    case 'web_search':
    case 'search_skills':
      detail = str(a.query) || undefined;
      break;
    case 'fetch_url': {
      const url = str(a.url);
      target = hostOf(url);
      detail = url || undefined;
      detailKind = 'url';
      break;
    }
    case 'read_file':
    case 'edit_file':
    case 'write_file': {
      const p = str(a.path);
      target = basename(p) || p;
      detail = p || undefined;
      detailKind = 'path';
      if (p) file = { path: p, line: positiveInt(a.line) };
      break;
    }
    case 'list_dir': {
      const p = str(a.path).trim();
      target = p && p !== '.' && p !== './' ? basename(p) || p : tOpt(lang, 'tool.rootDir') ?? '.';
      detail = p || undefined;
      detailKind = 'path';
      break;
    }
    case 'glob':
      detail = str(a.pattern) || undefined;
      break;
    case 'grep': {
      const pattern = str(a.pattern);
      const where = str(a.path) || str(a.glob);
      detail = pattern ? (where ? `${pattern}  ·  ${where}` : pattern) : undefined;
      break;
    }
    case 'run_command': {
      const cmd = str(a.command).trim();
      detail = cmd ? truncate(cmd.split('\n')[0] + (cmd.includes('\n') ? ' …' : ''), 240) : undefined;
      detailKind = 'command';
      break;
    }
    case 'load_skill':
      target = str(a.skill_name) || str(a.skill) || str(a.name);
      break;
    case 'agent':
    case 'workflow_run':
      target = str(a.description) || str(a.agent_type);
      break;
    case 'scratchpad': {
      const action = str(a.action);
      const key = str(a.key);
      detail = [action, key].filter(Boolean).join(' · ') || undefined;
      break;
    }
    case 'create_artifact':
    case 'update_artifact':
      detail = str(a.title) || str(a.artifact_id) || str(a.id) || undefined;
      break;
    // ── bản trình duyệt ──
    case 'page_find':
      detail = str(a.query) || undefined;
      break;
    case 'page_click':
    case 'page_select':
    case 'page_hover':
      detail = a.ref !== undefined ? `[${str(a.ref)}]${a.label ? ` ${str(a.label)}` : ''}` : undefined;
      break;
    case 'page_type':
      // Không hiện nội dung đã gõ (có thể là dữ liệu nhạy cảm): chỉ hiện ref và độ dài.
      detail = a.ref !== undefined ? `[${str(a.ref)}] ⟨${[...str(a.text)].length}⟩` : undefined;
      break;
    case 'page_press_key':
      detail = str(a.key) || undefined;
      break;
    case 'page_wait':
      detail = str(a.text) || str(a.gone_text) || undefined;
      break;
    case 'page_navigate':
    case 'tab_open': {
      const url = str(a.url);
      detail = url || str(a.action) || undefined;
      detailKind = url ? 'url' : 'text';
      break;
    }
    default:
      break;
  }

  const base = KNOWN.has(name) || AGENT_TOOLS.has(name) ? name : 'generic';
  const label = (tOpt(lang, `tool.${base}.${phase}`, { target, name }) ?? name).replace(/\s{2,}/g, ' ').replace(/\s+…/, '…');

  return {
    icon: ICONS[name] ?? 'wand',
    label,
    detail,
    detailKind,
    file,
    // offer_options: các nút bấm CHÍNH LÀ giao diện của nó — thêm một dòng công cụ chỉ làm rối.
    hidden: (name === 'todo_write' || name === 'load_skill' || name === 'offer_options') && (state === 'running' || state === 'done'),
  };
}

/** Nhãn của dòng gộp, ví dụ "Đã tìm kiếm trên web 5 lần". */
export function groupLabel(lang: Lang, name: string, count: number): string {
  return tOpt(lang, `tool.group.${name}`, { n: count }) ?? `${name} ×${count}`;
}
