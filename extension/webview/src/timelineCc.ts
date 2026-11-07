/**
 * (lane:cc-timeline-ui) Hàm thuần cho dòng thời gian gọn kiểu Claude Code — không JSX, không DOM, test được, và là
 * DANH SÁCH HÀM CẦN CHÉP sang trang Remote (locaith.ai, React): xem docs/TIMELINE-SPEC.md.
 *
 *  - giờ/ngày: formatClock, formatDayLabel, sameLocalDay, timelineMarks
 *  - dòng công cụ: actionName, toolDescription, writeLineCount, firstLines, countLines
 *  - suy nghĩ: thinkingDuration
 *  - nhóm: runTone, backgroundOf
 */
import type { ABlock, TItem, ToolBlock } from '../../src/shared/protocol';
import type { Lang } from './format';
import { tOpt } from './i18n';
import { AGENT_TOOLS, describeTool } from './toolLabels';
import type { ActivityRow, WorkStats } from './timeline';

// ── giờ & ngày ────────────────────────────────────────────────────────────────

const finiteTs = (ts: unknown): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && ts <= 8.64e15;

/** «17:52» (vi, 24 giờ) · «5:52 PM» (en, 12 giờ). Dấu thời gian không hợp lệ → chuỗi rỗng (ẩn, không bịa). */
export function formatClock(ts: number | undefined, lang: Lang): string {
  if (!finiteTs(ts)) return '';
  const d = new Date(ts);
  if (lang === 'vi') return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const VI_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Nhãn đường ngăn ngày: «T7, 07/11» (vi) · «Sat, Nov 7» (en). Khác năm hiện tại → thêm năm. */
export function formatDayLabel(ts: number | undefined, lang: Lang, now: number = Date.now()): string {
  if (!finiteTs(ts)) return '';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (lang === 'vi') {
    const dm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${VI_DAYS[d.getDay()]}, ${dm}${sameYear ? '' : `/${d.getFullYear()}`}`;
  }
  return `${EN_DAYS[d.getDay()]}, ${EN_MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`;
}

/** Cùng ngày theo giờ địa phương. */
export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Mốc hiển thị cho từng mục transcript. */
export interface TimelineMark {
  /** Có vẽ đường ngăn ngày TRƯỚC mục này (ngày địa phương đổi so với mục trước có dấu thời gian). */
  day?: number;
  /** Giờ hiện phía trên mục: tin người dùng → `ts`; lượt trả lời có quá trình → lúc xong (`endedAt`). */
  time?: number;
}

const timestampOf = (it: TItem): number | undefined => (finiteTs(it.ts) ? it.ts : undefined);

/** Lượt trả lời có «quá trình» (công cụ / suy nghĩ) hay không — chỉ lượt như vậy mới cần giờ riêng cho câu trả lời. */
export function hasProcess(blocks: readonly ABlock[]): boolean {
  return blocks.some((b) => b.type === 'tool' || b.type === 'thinking');
}

/**
 * Tính mốc giờ/ngày cho cả transcript, O(n). Quy tắc:
 *  - đường ngăn ngày: giữa hai mục liên tiếp có `ts` mà ngày địa phương khác nhau (mục đầu tiên KHÔNG có đường ngăn);
 *  - giờ: mọi tin người dùng; lượt trả lời đã xong, có quá trình và có `endedAt`. Thiếu dấu thời gian → không có gì.
 */
export function timelineMarks(items: readonly TItem[]): Map<string, TimelineMark> {
  const out = new Map<string, TimelineMark>();
  let prev: number | undefined;
  for (const it of items) {
    const m: TimelineMark = {};
    const ts = timestampOf(it);
    if (ts !== undefined) {
      if (prev !== undefined && !sameLocalDay(prev, ts)) m.day = ts;
      prev = ts;
    }
    if (it.kind === 'user' && ts !== undefined) m.time = ts;
    else if (it.kind === 'assistant' && it.done && finiteTs(it.endedAt) && hasProcess(it.blocks)) m.time = it.endedAt;
    if (m.day !== undefined || m.time !== undefined) out.set(it.id, m);
  }
  return out;
}

// ── dòng công cụ ──────────────────────────────────────────────────────────────

/** Khoá i18n `cc.action.*` theo tên công cụ (Bash/Read/Write/Edit/Grep/Glob/Web/Task… như Claude Code). */
const ACTION_KEY: Record<string, string> = {
  run_command: 'bash',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  grep: 'grep',
  glob: 'glob',
  list_dir: 'list',
  web_search: 'web',
  fetch_url: 'fetch',
  agent: 'agent',
  workflow_run: 'workflow',
  create_artifact: 'artifact',
  update_artifact: 'artifact',
  list_artifact_types: 'artifact',
  load_skill: 'skill',
  search_skills: 'skill',
  scratchpad: 'notes',
  todo_write: 'tasks',
  exit_plan_mode: 'plan',
  tabs_list: 'tabs',
  tab_open: 'tabs',
  tab_activate: 'tabs',
  tab_close: 'tabs',
  page_read: 'page',
  page_snapshot: 'page',
  page_screenshot: 'page',
  page_find: 'page',
  page_click: 'page',
  page_type: 'page',
  page_select: 'page',
  page_press_key: 'page',
  page_hover: 'page',
  page_scroll: 'page',
  page_wait: 'page',
  page_navigate: 'page',
};

/** TÊN HÀNH ĐỘNG in đậm đầu dòng: «Lệnh» / «Bash». Công cụ lạ (MCP…) → chính tên công cụ. */
export function actionName(lang: Lang, toolName: string): string {
  const k = ACTION_KEY[toolName];
  return (k && tOpt(lang, `cc.action.${k}`)) || toolName;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Mô tả một dòng cho dòng công cụ. Quy ước: đối số chuỗi `description` do model cung cấp luôn thắng (bất kỳ công cụ nào);
 * không có thì lấy chi tiết sẵn có của describeTool (lệnh / đường dẫn / mẫu tìm / URL).
 */
export function toolDescription(lang: Lang, block: Pick<ToolBlock, 'name' | 'args' | 'state'>): { text: string; kind: 'text' | 'path' | 'command' | 'url' | 'description' } {
  const d = str(block.args?.description);
  if (d) return { text: d.split('\n')[0], kind: 'description' };
  const desc = describeTool(lang, block.name, block.args, block.state);
  if (desc.detail) return { text: desc.detail, kind: desc.detailKind };
  return { text: '', kind: 'text' };
}

/** Đếm dòng (chuỗi rỗng = 0; «a\n» = 2 như `split('\n').length`, khớp cách host tính). */
export function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

/**
 * Số dòng của Write: ưu tiên `summary` do host gửi («58 dòng» / «58 lines» — cũng là nguồn DUY NHẤT ở Remote vì đối số bị cắt 600 ký tự);
 * không có thì đếm từ `args.content` nếu còn nguyên (chưa bị cắt «… [+N]»). Không biết → undefined.
 */
export function writeLineCount(block: Pick<ToolBlock, 'args' | 'summary'>): number | undefined {
  const m = /^(\d[\d.,]*)\s*(dòng|lines?)$/i.exec((block.summary ?? '').trim());
  if (m) {
    const n = Number(m[1].replace(/[.,]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  const c = typeof block.args?.content === 'string' ? block.args.content : '';
  if (!c || /… \[\+\d+\]$/.test(c)) return undefined;
  return countLines(c);
}

/** N dòng đầu của một đoạn chữ (khung xem trước 3–4 dòng), kèm cờ còn tiếp. */
export function firstLines(text: string, n: number): { lines: string[]; more: number } {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** Đuôi tệp → tên ngôn ngữ cho tô màu nhẹ (highlight.js), hoặc undefined. */
export function langOfPath(path: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  if (!m) return /(^|[\\/])(dockerfile|makefile)$/i.test(path) ? 'dockerfile' : undefined;
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', ps1: 'powershell', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', html: 'html', htm: 'html', css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', toml: 'ini', ini: 'ini', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', kt: 'kotlin', swift: 'swift', vue: 'html', svelte: 'html' };
  return map[ext];
}

// ── suy nghĩ ──────────────────────────────────────────────────────────────────

/** Tổng thời lượng (ms) của các khối suy nghĩ có số liệu; không khối nào có → undefined (hiện «Đã suy nghĩ» không số). */
export function thinkingDuration(blocks: readonly { durationMs?: number }[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const b of blocks) {
    if (typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) && b.durationMs >= 0) {
      sum += b.durationMs;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/** «14 giây» / «14s», «1 phút 20 giây» / «1m 20s»; dưới 1 giây → «<1 giây». Dùng cho «Đã suy nghĩ …» (không dùng chữ ms). */
export function formatSeconds(ms: number, lang: Lang): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return lang === 'vi' ? '<1 giây' : '<1s';
  if (s < 60) return lang === 'vi' ? `${s} giây` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return lang === 'vi' ? `${m} phút${r ? ` ${r} giây` : ''}` : `${m}m${r ? ` ${r}s` : ''}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return lang === 'vi' ? `${h} giờ${mm ? ` ${mm} phút` : ''}` : `${h}h${mm ? ` ${mm}m` : ''}`;
}

/** Thời lượng NGẮN cho meta bên phải dòng nhóm: dưới 1 phút → giây; từ 1 phút → chỉ phút («24 phút» / «24m»); từ 1 giờ → giờ + phút. */
export function formatDurationShort(ms: number, lang: Lang): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return formatSeconds(ms, lang);
  const m = Math.floor(s / 60);
  if (m < 60) return lang === 'vi' ? `${m} phút` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return lang === 'vi' ? `${h} giờ${mm ? ` ${mm} phút` : ''}` : `${h}h${mm ? ` ${mm}m` : ''}`;
}

/** Mốc bắt đầu của lượt đang chạy (ts của lượt trả lời chưa xong, hoặc của tin người dùng cuối khi lượt chưa mở), hoặc undefined khi không chạy. */
export function runningSince(view: { running: boolean; transcript: readonly TItem[] }): number | undefined {
  if (!view.running) return undefined;
  for (let i = view.transcript.length - 1; i >= 0; i--) {
    const it = view.transcript[i];
    if (it.kind === 'assistant') return !it.done && finiteTs(it.ts) ? it.ts : undefined;
    if (it.kind === 'user') return finiteTs(it.ts) ? it.ts : undefined;
  }
  return undefined;
}

/** Đồng hồ chip ô nhập, ngắn và không phụ thuộc ngôn ngữ như Claude Code: «48s» · «59m» · «1h 12m». */
export function formatElapsedShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

// ── nhóm ──────────────────────────────────────────────────────────────────────

export type RunTone = 'ok' | 'fail' | 'live';

/** Màu chấm của dòng nhóm: đỏ nếu có lệnh lỗi (kể cả đang chạy), xám nhấp nháy khi đang chạy, xanh khi xong sạch. */
export function runTone(stats: Pick<WorkStats, 'failed'>, live: boolean): RunTone {
  if (stats.failed > 0) return 'fail';
  return live ? 'live' : 'ok';
}

/**
 * Mọi khối agent con / workflow trong một cụm dòng (đi xuyên vào nhóm, dòng tóm tắt, việc), theo thứ tự xuất hiện.
 * Dòng nhóm GẬP vẫn hiện các dòng agent này ngay bên dưới (như Claude Code) — agent song song là thông tin sống quan trọng nhất.
 */
export function agentRowsOf(rows: readonly ActivityRow[]): ToolBlock[] {
  const out: ToolBlock[] = [];
  const seen = new Set<string>();
  const push = (b: ToolBlock) => {
    if (AGENT_TOOLS.has(b.name) && !seen.has(b.id)) {
      seen.add(b.id);
      out.push(b);
    }
  };
  for (const r of rows) {
    switch (r.kind) {
      case 'tool':
      case 'agent':
        push(r.block);
        break;
      case 'toolgroup':
      case 'editgroup':
        r.blocks.forEach(push);
        break;
      case 'toolsum':
        r.info.blocks.forEach(push);
        break;
      case 'taskgroup':
        agentRowsOf(r.rows).forEach(push);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Lệnh đang chạy nền? (đối số `run_in_background` / `background` do model đặt; thiếu = không). */
export function backgroundOf(block: Pick<ToolBlock, 'args'> | null | undefined): boolean {
  const a = block?.args;
  return !!a && (a.run_in_background === true || a.background === true);
}
