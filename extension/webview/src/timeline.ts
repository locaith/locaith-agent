/**
 * Chia các khối của một lượt trả lời thành các "đoạn" hiển thị (thuần túy, test được):
 *  - activity   : chuỗi liền nhau gồm tác vụ / kỹ năng / công cụ / dòng trạng thái / suy nghĩ (có đường ray dọc)
 *  - text       : văn bản Markdown
 *  - artifact   : thẻ artifact
 *  - permission : thẻ xin quyền (nổi bật, nằm ngoài đường ray)
 *  - notice     : thông báo / lỗi
 *
 * Gọn khi nhiều việc chạy cùng lúc (0.6.0): một chuỗi ≥ 3 lệnh gọi công cụ liền nhau — đang chạy hay đã xong, tên nào cũng được — thành MỘT dòng tóm tắt
 * thu gọn («89 lệnh gọi công cụ · 1 lỗi», đang chạy thì kèm việc mới nhất); agent con đang chạy luôn có dòng riêng với số liệu sống.
 * Khi lượt đã xong, các dòng giống nhau liền kề cũng được gộp lại (5 lệnh tìm kiếm → 1 dòng mở rộng được).
 */
import type { ABlock, ToolBlock } from '../../src/shared/protocol';
import { AGENT_TOOLS, GROUPABLE, describeTool } from './toolLabels';

type Pick<T extends ABlock['type']> = Extract<ABlock, { type: T }>;
export type TextBlockT = Pick<'text'>;
export type ThinkingBlockT = Pick<'thinking'>;
export type PillBlockT = Pick<'pill'>;
export type TasksBlockT = Pick<'tasks'>;
export type SkillBlockT = Pick<'skill'>;
export type ArtifactBlockT = Pick<'artifact'>;
export type NoticeBlockT = Pick<'notice'>;

/** Số liệu của dòng «N lệnh gọi công cụ». */
export interface ToolSummaryInfo {
  /** Các lệnh hiện ra khi mở rộng (không gồm agent con đang chạy: chúng có dòng riêng ngay bên dưới). */
  blocks: ToolBlock[];
  /** Tổng lệnh gọi, TÍNH CẢ lệnh bên trong agent con (như «89 tool calls» của Claude Code): số khối + số lệnh agent con báo về. */
  total: number;
  /** Lệnh lỗi: khối lỗi + lệnh lỗi bên trong agent con. */
  failed: number;
  /** Còn lệnh nào đang chạy trong `blocks` không (đang chạy → hiện vòng quay + việc mới nhất). */
  running: boolean;
  /** Lệnh đang chạy mới nhất (để hiện «Đang đọc src/a.ts…» ngay trên dòng tóm tắt). */
  latest?: ToolBlock;
}

export interface WorkStats {
  /** Lệnh gọi công cụ (tính cả lệnh bên trong agent con). */
  calls: number;
  failed: number;
  /** Lệnh sửa / tạo tệp. */
  edits: number;
  /** Dòng không phải công cụ: suy nghĩ, trạng thái, tác vụ, kỹ năng. */
  steps: number;
  /** Từ lúc bắt đầu lượt tới lúc xong (hoặc tới lệnh công cụ cuối, với phiên cũ không ghi lúc xong). */
  durationMs?: number;
}

export type ActivityRow =
  | { kind: 'tasks'; key: string; block: TasksBlockT }
  | { kind: 'skill'; key: string; block: SkillBlockT }
  | { kind: 'thinking'; key: string; block: ThinkingBlockT }
  | { kind: 'pill'; key: string; block: PillBlockT }
  | { kind: 'tool'; key: string; block: ToolBlock }
  | { kind: 'toolgroup'; key: string; name: string; blocks: ToolBlock[] }
  | { kind: 'toolsum'; key: string; info: ToolSummaryInfo }
  | { kind: 'agent'; key: string; block: ToolBlock }
  /** ≥ 2 lần sửa/tạo tệp liền nhau đã xong → một dòng «Đã sửa N tệp» (mở ra xem từng tệp, đủ diff). */
  | { kind: 'editgroup'; key: string; blocks: ToolBlock[] }
  /** Cả một «việc» (khối tasks + mọi thao tác sau nó tới việc kế tiếp) gộp thành một dòng. */
  | { kind: 'taskgroup'; key: string; title: string; rows: ActivityRow[]; stats: WorkStats }
  | { kind: 'pillrun'; key: string; blocks: PillBlockT[] };

export type Segment =
  | { kind: 'activity'; key: string; rows: ActivityRow[] }
  | { kind: 'text'; key: string; block: TextBlockT }
  | { kind: 'artifact'; key: string; block: ArtifactBlockT }
  | { kind: 'permission'; key: string; block: ToolBlock }
  | { kind: 'notice'; key: string; block: NoticeBlockT };

const MIN_GROUP = 3;

const SETTLED: ReadonlySet<ToolBlock['state']> = new Set(['done', 'error', 'denied', 'cancelled']);

/** Agent con / workflow ĐANG chạy: có dòng riêng với số liệu sống thay vì lẫn trong dòng tóm tắt. */
export function isLiveAgent(b: ToolBlock): boolean {
  return AGENT_TOOLS.has(b.name) && b.state === 'running';
}

/** Số liệu agent của một khối, đã làm sạch (dữ liệu khôi phục từ tệp sao lưu có thể sai kiểu — không bao giờ để NaN lọt lên màn hình). */
export function agentStats(b: ToolBlock): { tokens: number; tools: number; failed: number; activity: string } {
  const a = b.agent as Partial<NonNullable<ToolBlock['agent']>> | undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { tokens: n(a?.tokens), tools: n(a?.tools), failed: n(a?.failed), activity: typeof a?.activity === 'string' ? a.activity : '' };
}

/** Tóm tắt một chuỗi lệnh: `rest` là các lệnh sẽ nằm trong dòng tóm tắt, `live` là agent đang chạy (chỉ để cộng vào tổng). */
export function summarizeTools(rest: readonly ToolBlock[], live: readonly ToolBlock[] = [], turnLive = true): ToolSummaryInfo {
  const all = [...rest, ...live];
  let subTools = 0;
  let subFailed = 0;
  for (const b of all) {
    const a = agentStats(b);
    subTools += a.tools;
    subFailed += a.failed;
  }
  // Lượt không còn chạy (phiên lưu giữa chừng): khối còn ghi 'running' là dữ liệu cũ — không vòng quay, không «đang làm».
  const running = turnLive ? rest.filter((b) => b.state === 'running') : [];
  return {
    blocks: rest.slice(),
    total: all.length + subTools,
    failed: all.filter((b) => b.state === 'error').length + subFailed,
    running: running.length > 0,
    latest: running[running.length - 1],
  };
}

/** Lệnh sửa tệp (có diff): luôn hiện từng dòng riêng với số dòng thêm/bớt — thay đổi trên tệp là kết quả quan trọng nhất, không gấp vào dòng tóm tắt (và tách các chuỗi lệnh ở hai bên thành hai dòng tóm tắt). */
export function isFileChange(b: ToolBlock): boolean {
  return !!b.diff || b.name === 'edit_file' || b.name === 'write_file';
}

const toolRowOf = (b: ToolBlock): ActivityRow => ({ kind: 'tool', key: b.id, block: b });
const agentRowOf = (b: ToolBlock): ActivityRow => ({ kind: 'agent', key: `agent:${b.id}`, block: b });

/** Gộp các dòng công cụ liền kề CÙNG TÊN gộp được và đã xong (≥ 3) thành một dòng «Đã đọc 5 tệp». */
function groupSameName(rows: ActivityRow[]): ActivityRow[] {
  const out: ActivityRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'tool' && GROUPABLE.has(row.block.name)) {
      let j = i;
      while (
        j < rows.length &&
        rows[j].kind === 'tool' &&
        (rows[j] as { block: ToolBlock }).block.name === row.block.name &&
        SETTLED.has((rows[j] as { block: ToolBlock }).block.state)
      )
        j++;
      if (j - i >= MIN_GROUP) {
        const blocks = rows.slice(i, j).map((r) => (r as { block: ToolBlock }).block);
        out.push({ kind: 'toolgroup', key: `group:${blocks[0].id}`, name: row.block.name, blocks });
        i = j;
        continue;
      }
    }
    out.push(row);
    i++;
  }
  return out;
}

/** Các dòng hiện ra khi mở rộng dòng tóm tắt: từng lệnh, và những chuỗi cùng tên đã xong vẫn gộp như trước. */
export function nestedRows(blocks: readonly ToolBlock[]): ActivityRow[] {
  return groupSameName(blocks.map(toolRowOf));
}

/** Một chuỗi lệnh liền nhau (không có thẻ xin phép chen giữa) → các dòng hiển thị. */
function condenseRun(run: ToolBlock[], turnDone: boolean, turnLive: boolean): ActivityRow[] {
  const isLive = (b: ToolBlock): boolean => turnLive && isLiveAgent(b);
  const live = run.filter(isLive);
  const rest = run.filter((b) => !isLive(b));
  if (rest.length >= MIN_GROUP) {
    // Cả chuỗi cùng một công cụ gộp được và đã xong, lượt đã kết thúc: giữ dòng cũ «Đã đọc 5 tệp» (nhãn cụ thể hơn «5 lệnh gọi công cụ»).
    const homogeneous = turnDone && live.length === 0 && rest.every((b) => b.name === rest[0].name && GROUPABLE.has(b.name) && SETTLED.has(b.state));
    const head: ActivityRow = homogeneous
      ? { kind: 'toolgroup', key: `group:${rest[0].id}`, name: rest[0].name, blocks: rest }
      : { kind: 'toolsum', key: `sum:${rest[0].id}`, info: summarizeTools(rest, live, turnLive) };
    return [head, ...live.map(agentRowOf)];
  }
  // Dưới ngưỡng: giữ nguyên thứ tự, nhưng agent đang chạy vẫn là dòng sống.
  return run.map((b) => (isLive(b) ? agentRowOf(b) : toolRowOf(b)));
}

/**
 * Các dòng giống nhau liền kề → một dòng. Công cụ: luôn (kể cả đang chạy); dòng trạng thái đã xong: chỉ khi lượt đã xong
 * (lúc đang chạy vẫn thấy từng dòng hiện ra).
 */
const COUNTABLE = new Set<ActivityRow['kind']>(['tool', 'toolgroup', 'toolsum', 'editgroup', 'agent', 'pill', 'pillrun', 'thinking', 'skill']);

/** Thống kê nhanh số lệnh của một cụm dòng. */
function statsOf(rows: readonly ActivityRow[]): WorkStats {
  const s: WorkStats = { calls: 0, failed: 0, edits: 0, steps: 0 };
  for (const r of rows) rowStats(r, s);
  return s;
}

/**
 * Một khối `tasks` mở ra một «việc»: mọi dòng hoạt động sau nó (tới việc kế tiếp) thuộc việc đó. Khi việc có ≥ 2 lệnh gọi công cụ,
 * gộp cả cụm thành MỘT dòng «Việc: …» (mở ra vẫn đủ từng dòng như cũ) — như Claude Code. Việc lẻ một lệnh thì để nguyên.
 */
function groupByTask(rows: ActivityRow[]): ActivityRow[] {
  const out: ActivityRow[] = [];
  let cur: Extract<ActivityRow, { kind: 'taskgroup' }> | null = null;
  const close = () => {
    if (!cur) return;
    const tools = statsOf(cur.rows.slice(1));
    if (tools.calls >= 2) out.push({ ...cur, stats: tools });
    else out.push(...cur.rows);
    cur = null;
  };
  for (const r of rows) {
    if (r.kind === 'tasks') {
      close();
      cur = { kind: 'taskgroup', key: `task:${r.block.id}`, title: r.block.added[r.block.added.length - 1] ?? '', rows: [r], stats: { calls: 0, failed: 0, edits: 0, steps: 0 } };
      continue;
    }
    if (cur && COUNTABLE.has(r.kind)) {
      cur.rows.push(r);
      continue;
    }
    close();
    out.push(r);
  }
  close();
  return out;
}

function condense(rows: ActivityRow[], turnDone: boolean, turnLive: boolean): ActivityRow[] {
  const out: ActivityRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'tool' && row.block.state !== 'awaiting_permission' && !isFileChange(row.block)) {
      const run: ToolBlock[] = [];
      let j = i;
      while (j < rows.length) {
        const r = rows[j];
        if (r.kind !== 'tool' || r.block.state === 'awaiting_permission' || isFileChange(r.block)) break; // thẻ chờ duyệt và lệnh sửa tệp luôn nằm ngoài chuỗi
        run.push(r.block);
        j++;
      }
      out.push(...condenseRun(run, turnDone, turnLive));
      i = j;
      continue;
    }
    // Cụm sửa tệp liền nhau: đang chạy thì tách riêng để vẫn thấy tiến độ, phần đã xong ≥ 2 thì gộp một dòng.
    if (row.kind === 'tool' && isFileChange(row.block)) {
      let j = i;
      while (j < rows.length && rows[j].kind === 'tool' && isFileChange((rows[j] as { block: ToolBlock }).block)) j++;
      const blocks = rows.slice(i, j).map((r) => (r as { block: ToolBlock }).block);
      const settled = blocks.filter((b) => SETTLED.has(b.state));
      const live = blocks.filter((b) => !SETTLED.has(b.state));
      if (settled.length >= 2) out.push({ kind: 'editgroup', key: `edits:${settled[0].id}`, blocks: settled });
      else for (const b of settled) out.push(toolRowOf(b));
      for (const b of live) out.push(toolRowOf(b));
      i = j;
      continue;
    }
    if (turnDone && row.kind === 'pill') {
      let j = i;
      while (j < rows.length && rows[j].kind === 'pill' && !(rows[j] as { block: PillBlockT }).block.active) j++;
      if (j - i >= MIN_GROUP) {
        const blocks = rows.slice(i, j).map((r) => (r as { block: PillBlockT }).block);
        out.push({ kind: 'pillrun', key: `pills:${blocks[0].id}`, blocks });
        i = j;
        continue;
      }
    }
    out.push(row);
    i++;
  }
  return groupByTask(out);
}

/**
 * `turnLive`: lượt này đang thật sự chạy (mặc định = chưa xong). Khi sai, khối agent còn ghi 'running' là dữ liệu cũ và không được thành dòng sống.
 */
export function buildSegments(blocks: readonly ABlock[], turnDone: boolean, showThinking: boolean, turnLive: boolean = !turnDone): Segment[] {
  const segments: Segment[] = [];
  let rows: ActivityRow[] = [];

  const flush = () => {
    if (rows.length === 0) return;
    // Khoá đoạn lấy từ dòng NGUỒN đầu tiên (không phải dòng sau khi gộp): chuỗi lệnh đổi từ «từng dòng» sang «dòng tóm tắt» khi đủ 3 lệnh thì cả đoạn
    // không bị dựng lại (mất trạng thái mở/đóng của các dòng suy nghĩ trong đó).
    const firstKey = rows[0].key;
    const final = condense(rows, turnDone, turnLive);
    segments.push({ kind: 'activity', key: `act:${firstKey}`, rows: final });
    rows = [];
  };

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        flush();
        segments.push({ kind: 'text', key: b.id, block: b });
        break;
      case 'artifact':
        flush();
        segments.push({ kind: 'artifact', key: b.id, block: b });
        break;
      case 'notice':
        flush();
        segments.push({ kind: 'notice', key: b.id, block: b });
        break;
      case 'tasks':
        rows.push({ kind: 'tasks', key: b.id, block: b });
        break;
      case 'skill':
        rows.push({ kind: 'skill', key: b.id, block: b });
        break;
      case 'pill':
        rows.push({ kind: 'pill', key: b.id, block: b });
        break;
      case 'thinking':
        if (showThinking && b.text.trim()) rows.push({ kind: 'thinking', key: b.id, block: b });
        break;
      case 'tool': {
        if (b.state === 'awaiting_permission' && b.permission) {
          flush();
          segments.push({ kind: 'permission', key: `perm:${b.id}`, block: b });
        } else if (!describeTool('vi', b.name, b.args, b.state).hidden) {
          rows.push({ kind: 'tool', key: b.id, block: b });
        }
        break;
      }
    }
  }
  flush();
  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// (0.6.3) Lượt đã xong: gấp «quá trình làm việc» thành một dòng
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkSplit {
  /** Các đoạn được gấp, đúng thứ tự gốc: dòng hoạt động, đoạn chữ xen giữa, thông báo thường. */
  work: Segment[];
  /** Kết quả nằm giữa quá trình nhưng KHÔNG gấp: thẻ artifact, thẻ xin phép, thông báo lỗi/cảnh báo. */
  kept: Segment[];
  /** Câu trả lời cuối: **dãy** đoạn chữ ở cuối lượt (kèm artifact/thông báo thường xen trong dãy), không chỉ đoạn chữ cuối. */
  tail: Segment[];
  stats: WorkStats;
  /**
   * Tệp đã sửa / tạo thành công (dòng có diff, bấm để xem thay đổi) — cũng là KẾT QUẢ nên vẫn hiện ngay dưới dòng tóm tắt khi đang gấp.
   * null khi không sửa tệp nào hoặc sửa quá nhiều (> MAX_CHANGE_ROWS: chỉ còn con số «sửa N tệp» trên dòng tóm tắt).
   */
  changes: Segment | null;
}

/** Quá số dòng sửa tệp này thì không bày ra ngoài dòng tóm tắt nữa. */
export const MAX_CHANGE_ROWS = 6;

function rowStats(r: ActivityRow, s: WorkStats): void {
  switch (r.kind) {
    case 'tool':
      s.calls++;
      if (r.block.state === 'error') s.failed++;
      if (isFileChange(r.block)) s.edits++;
      return;
    case 'toolgroup':
      s.calls += r.blocks.length;
      s.failed += r.blocks.filter((b) => b.state === 'error').length;
      s.edits += r.blocks.filter(isFileChange).length;
      return;
    case 'toolsum':
      s.calls += r.info.total;
      s.failed += r.info.failed;
      s.edits += r.info.blocks.filter(isFileChange).length;
      return;
    case 'agent': {
      const a = agentStats(r.block);
      s.calls += 1 + a.tools;
      s.failed += (r.block.state === 'error' ? 1 : 0) + a.failed;
      return;
    }
    case 'editgroup':
      s.calls += r.blocks.length;
      s.edits += r.blocks.length;
      s.failed += r.blocks.filter((b) => b.state === 'error').length;
      return;
    case 'taskgroup':
      for (const x of r.rows) rowStats(x, s);
      return;
    case 'pillrun':
      s.steps += r.blocks.length;
      return;
    default:
      s.steps++;
  }
}

/** Thời gian làm việc: lúc xong nếu có, không thì lúc lệnh công cụ cuối xong. Dữ liệu vô lý (đồng hồ lệch, khối cũ startedAt = 0) → bỏ. */
export function workDuration(blocks: readonly ABlock[], startedAt: number, endedAt?: number): number | undefined {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  let end = typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : 0;
  if (!end) {
    for (const b of blocks) {
      if (b.type !== 'tool' || !Number.isFinite(b.startedAt) || b.startedAt < startedAt - 2000 || b.startedAt - startedAt > 12 * 3600_000) continue;
      end = Math.max(end, b.startedAt + Math.max(0, Number(b.durationMs) || 0));
    }
  }
  const d = end - startedAt;
  return d >= 1000 && d < 24 * 3600_000 ? d : undefined;
}

/**
 * Gấp phần quá trình của một lượt ĐÃ XONG (như «Worked for 2m 13s» của Codex): mọi thứ trước VÙNG CÂU TRẢ LỜI —
 * dòng hoạt động, suy nghĩ, đoạn chữ xen giữa — thành MỘT dòng bấm để mở lại. Không gấp: câu trả lời cuối, thẻ artifact,
 * thẻ xin phép, thông báo lỗi/cảnh báo.
 *
 * VÙNG CÂU TRẢ LỜI = **DÃY đoạn chữ ở cuối lượt**, không phải "đoạn chữ cuối cùng". Model rất hay viết câu trả lời đầy đủ
 * rồi thêm một câu chốt ngắn («Anh xem giúp em nhé.»). Nếu cắt ở đoạn chữ cuối thì câu chốt hiện lên còn TOÀN BỘ câu trả lời
 * bị gấp vào «Worked for» — người dùng chỉ đọc được câu chốt và tưởng đó là kết quả. Vì vậy chỉ gấp phần đứng TRƯỚC
 * dãy chữ cuối cùng; mọi đoạn chữ liền nhau ở cuối lượt đều hiện ra.
 *
 * null = không có gì đáng gấp (không có câu trả lời chữ, hay chỉ có một dòng hoạt động và không có đoạn chữ xen giữa).
 */
export function splitWork(segments: readonly Segment[], blocks: readonly ABlock[] = [], startedAt = 0, endedAt?: number): WorkSplit | null {
  // Duyệt ngược gom DÃY đoạn cuối lượt: chữ, artifact, thông báo thường. Gặp hoạt động / xin phép / thông báo lỗi
  // thì dừng — đó là ranh giới «hết quá trình, bắt đầu câu trả lời».
  let answer = segments.length;
  let hasText = false;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.kind === 'text') {
      if (s.block.text.trim()) hasText = true;
      answer = i; // đoạn chữ RỖNG vẫn thuộc dãy: không được cắt nó ra khỏi câu trả lời
      continue;
    }
    if (s.kind === 'artifact') {
      answer = i;
      continue;
    }
    if (s.kind === 'notice' && s.block.level === 'info') {
      answer = i;
      continue;
    }
    break;
  }
  // Không có chữ ở CUỐI lượt (lượt kết thúc bằng hoạt động): lùi về quy tắc cũ — đoạn chữ cuối cùng là câu trả lời,
  // mọi thứ sau nó (kể cả hoạt động chạy sau câu trả lời) vẫn hiện trong phần đuôi.
  if (!hasText) {
    answer = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s.kind === 'text' && s.block.text.trim()) {
        answer = i;
        break;
      }
    }
  }
  // Không có câu trả lời chữ, hoặc cả lượt chỉ là câu trả lời (không có quá trình đứng trước) → không gấp gì.
  if (answer <= 0) return null;
  const work: Segment[] = [];
  const kept: Segment[] = [];
  for (const s of segments.slice(0, answer)) {
    if (s.kind === 'artifact' || s.kind === 'permission' || (s.kind === 'notice' && s.block.level !== 'info')) kept.push(s);
    else work.push(s);
  }
  const rows = work.flatMap((s) => (s.kind === 'activity' ? s.rows : []));
  const interim = work.some((s) => s.kind === 'text' && s.block.text.trim().length > 0);
  if (rows.length === 0) return null;
  const stats: WorkStats = { calls: 0, failed: 0, edits: 0, steps: 0 };
  for (const r of rows) rowStats(r, stats);
  // Một dòng hoạt động đơn độc, không có chữ xen giữa → chưa đáng gấp (giữ như thiết kế 0.6.3).
  if (!interim && rows.length < 2 && stats.calls < 2) return null;
  stats.durationMs = workDuration(blocks, startedAt, endedAt);
  // Cụm sửa tệp đã gộp vẫn hiện preview thay đổi (bấm xem diff từng tệp) khi không quá nhiều.
  const flat = rows.flatMap((r): ActivityRow[] => (r.kind === 'taskgroup' ? r.rows : [r]));
  const changeRows = flat.flatMap((r) =>
    r.kind === 'tool' && r.block.state === 'done' && isFileChange(r.block)
      ? [r]
      : r.kind === 'editgroup'
        ? r.blocks.filter((b) => b.state === 'done').map((b) => ({ kind: 'tool' as const, key: b.id, block: b }))
        : [],
  );
  const changes: Segment | null =
    changeRows.length > 0 && changeRows.length <= MAX_CHANGE_ROWS && stats.edits <= MAX_CHANGE_ROWS ? { kind: 'activity', key: `changes:${changeRows[0].key}`, rows: changeRows } : null;
  return { work, kept, tail: segments.slice(answer), stats, changes };
}

/** Toàn bộ văn bản trả lời (để nút "Chép câu trả lời"). */
export function turnPlainText(item: { blocks: readonly ABlock[] }): string {
  return item.blocks
    .filter((b): b is TextBlockT => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Lượt đang chạy mà chưa có gì đang hoạt động → cần chỉ báo "đang xử lý" ở cuối. */
export function needsWorkingIndicator(blocks: readonly ABlock[]): boolean {
  const last = blocks[blocks.length - 1];
  if (!last) return true;
  if (last.type === 'pill' && last.active) return false;
  if (last.type === 'tool' && (last.state === 'running' || last.state === 'awaiting_permission')) return false;
  if (last.type === 'artifact' && last.state === 'writing') return false;
  if (last.type === 'thinking') return false;
  return true;
}

/** Một mục trong chuỗi hoạt động: một dòng đơn, hoặc MỘT NHÓM các khối «Suy nghĩ» liền nhau. */
export interface ActItem {
  key: string;
  live: boolean;
  thinking?: ThinkingBlockT[];
  row?: ActivityRow;
}

/**
 * Gộp các khối «Suy nghĩ» LIỀN NHAU thành một mục. Trước đây mỗi khối là một dòng riêng
 * («Thinking · 1 tokens», «Thinking · 517 tokens · 3 s»…), sáu khối liền nhau chiếm gần hết màn hình.
 * Một thao tác chen giữa thì tách nhóm (đó là hai quãng suy nghĩ khác nhau).
 */
export function groupThinking(rows: readonly ActivityRow[], live: boolean): ActItem[] {
  const out: ActItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const itemLive = live && i === rows.length - 1;
    if (r.kind === 'thinking') {
      const last = out[out.length - 1];
      if (last?.thinking) {
        last.thinking.push(r.block);
        last.live = itemLive;
      } else {
        out.push({ key: `think:${r.key}`, live: itemLive, thinking: [r.block] });
      }
      continue;
    }
    out.push({ key: r.key, live: itemLive, row: r });
  }
  return out;
}
