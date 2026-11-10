/**
 * Mô hình thuần của BẢNG AGENT (hộp «Agents in this turn»): từ ảnh chụp tiến độ workflow (`WfProgress`) dựng danh sách để vẽ — sắp xếp, gom theo pha, gập bớt agent đã xong,
 * lọc, và câu tóm tắt. Không đụng DOM nên test thẳng được (test/agentBoard.test.ts).
 *
 * Quy ước (giống bảng agent của Claude Code): ưu tiên cái ĐANG CHẠY rồi LỖI rồi XẾP HÀNG, agent đã xong lùi xuống và gập khi có nhiều; mỗi dòng có chấm trạng thái,
 * tên/mô tả, loại · model, đồng hồ, token, số lệnh; dòng thứ hai là việc đang làm / lý do lỗi / trích báo cáo; phía trên có tổng «3 chạy · 12 chờ · 20 xong · 2 lỗi».
 */
import type { AgentRunRow, AgentRunState, ToolBlock, ViewState, WfProgress } from '../../src/shared/protocol';
import { AGENT_TOOLS } from './toolLabels';

export type BoardFilter = 'all' | 'active' | 'error' | 'done';

/** Mọi khối agent của lượt gần nhất có agent (đang chạy hoặc vừa xong), mới nhất trước. */
export function agentsOf(view: Pick<ViewState, 'transcript'>): ToolBlock[] {
  for (let i = view.transcript.length - 1; i >= 0; i--) {
    const it = view.transcript[i];
    if (it.kind !== 'assistant') continue;
    const found = it.blocks.filter((b): b is ToolBlock => b.type === 'tool' && AGENT_TOOLS.has(b.name));
    if (found.length > 0) return found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
  return [];
}

/** Số agent ĐANG chạy trong các khối: workflow thì đếm từng agent bên trong (đang chạy + chờ), agent lẻ thì 1 nếu còn chạy. */
export function liveCount(blocks: readonly ToolBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    const live = b.state === 'running' || b.state === 'awaiting_permission';
    const wf = b.agent?.wf;
    if (wf) n += wf.counts.running + wf.counts.queued || (live ? 1 : 0);
    else if (live) n++;
  }
  return n;
}

/** Có ≤ ngần này dòng thì hiện hết, không gập gì. */
export const SHOW_ALL_UP_TO = 12;
/** Khi phải gập: giữ lại ngần này agent xong MỚI NHẤT. */
export const KEEP_DONE = 3;

const RANK: Record<AgentRunState, number> = { running: 0, error: 1, stopped: 1, queued: 2, done: 3 };

export function isActive(s: AgentRunState): boolean {
  return s === 'running' || s === 'queued';
}

/** running → lỗi → xếp hàng (theo thứ tự sắp tới lượt) → xong (mới nhất trước). */
export function sortRows(rows: readonly AgentRunRow[]): AgentRunRow[] {
  return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state] || (a.state === 'done' ? (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.n - a.n : a.n - b.n));
}

export function matchesFilter(s: AgentRunState, f: BoardFilter): boolean {
  switch (f) {
    case 'active':
      return isActive(s);
    case 'error':
      return s === 'error' || s === 'stopped';
    case 'done':
      return s === 'done';
    default:
      return true;
  }
}

export interface BoardGroup {
  /** Tên pha («» = agent không thuộc pha nào). */
  name: string;
  total: number;
  done: number;
  error: number;
  running: number;
  /** Các dòng sẽ vẽ (đã sắp, đã lọc, đã gập). */
  rows: AgentRunRow[];
  /** Số dòng xong bị gập (hiện «+N đã xong»). */
  folded: number;
}

export interface BoardModel {
  groups: BoardGroup[];
  /** Có chia pha không (≥ 2 pha, hoặc có pha mà tên khác rỗng). */
  phased: boolean;
  /** Tổng dòng sẽ vẽ / tổng dòng khớp bộ lọc. */
  shown: number;
  matched: number;
  /** Agent có trong workflow nhưng KHÔNG nằm trong số dòng gửi kèm (workflow rất lớn: chỉ có trong `counts`). */
  unlisted: number;
}

export interface BuildOptions {
  filter?: BoardFilter;
  /** true = không gập agent đã xong. */
  showDone?: boolean;
  /** Tên pha đã gập tay (chỉ còn dòng đầu nhóm). */
  collapsed?: ReadonlySet<string>;
}

export function buildBoard(wf: WfProgress, o: BuildOptions = {}): BoardModel {
  const filter = o.filter ?? 'all';
  const matched = wf.rows.filter((r) => matchesFilter(r.state, filter));
  const needFold = !o.showDone && matched.length > SHOW_ALL_UP_TO && filter !== 'done' && filter !== 'error';
  // Gom theo pha, giữ thứ tự pha theo `wf.phases` (thứ tự xuất hiện), agent không pha ở cuối.
  const order = (wf.phases ?? []).map((p) => p.name);
  const byPhase = new Map<string, AgentRunRow[]>();
  for (const r of matched) {
    const k = r.phase ?? '';
    const a = byPhase.get(k);
    if (a) a.push(r);
    else byPhase.set(k, [r]);
  }
  // Pha đã khai báo (có agent) mà chưa có dòng nào vẫn hiện tiêu đề khi xem «Tất cả»; đang lọc thì chỉ hiện pha có dòng khớp.
  const names = [...order.filter((n) => byPhase.has(n) || (filter === 'all' && wf.phases?.some((p) => p.name === n && p.total > 0))), ...[...byPhase.keys()].filter((k) => !order.includes(k))];
  const uniqueNames = [...new Set(names)];
  const phased = uniqueNames.some((n) => n !== '');
  let shown = 0;
  const groups: BoardGroup[] = uniqueNames.map((name) => {
    const all = sortRows(byPhase.get(name) ?? []);
    const meta = wf.phases?.find((p) => p.name === name);
    const running = all.filter((r) => r.state === 'running').length;
    let rows = all;
    let folded = 0;
    if (needFold) {
      const doneRows = all.filter((r) => r.state === 'done');
      if (doneRows.length > KEEP_DONE) {
        const keep = new Set(doneRows.slice(0, KEEP_DONE));
        rows = all.filter((r) => r.state !== 'done' || keep.has(r));
        folded = doneRows.length - KEEP_DONE;
      }
    }
    if (o.collapsed?.has(name)) {
      folded += rows.length;
      rows = [];
    }
    shown += rows.length;
    return {
      name,
      total: meta?.total ?? all.length,
      done: meta?.done ?? all.filter((r) => r.state === 'done').length,
      error: meta?.error ?? all.filter((r) => r.state === 'error' || r.state === 'stopped').length,
      running,
      rows,
      folded,
    };
  });
  return { groups, phased, shown, matched: matched.length, unlisted: Math.max(0, wf.counts.total - wf.rows.length) };
}

/** «3 chạy · 12 chờ · 20 xong · 2 lỗi» (bỏ vế bằng 0); rỗng → chuỗi rỗng. */
export function summarize(c: WfProgress['counts'], words: { running: string; queued: string; done: string; error: string }): string {
  const bits: string[] = [];
  if (c.running) bits.push(`${c.running} ${words.running}`);
  if (c.queued) bits.push(`${c.queued} ${words.queued}`);
  if (c.done) bits.push(`${c.done} ${words.done}`);
  if (c.error + c.stopped) bits.push(`${c.error + c.stopped} ${words.error}`);
  return bits.join(' · ');
}

/** Thời gian của một dòng (ms): đang chạy → tới `now`; xong → startedAt..endedAt; xếp hàng/chưa biết → undefined. */
export function rowElapsedMs(r: AgentRunRow, now: number): number | undefined {
  if (r.state === 'queued' || r.startedAt === undefined) return undefined;
  const end = r.state === 'running' ? now : r.endedAt;
  return end === undefined ? undefined : Math.max(0, end - r.startedAt);
}

/** Tổng token / lệnh của mọi dòng ĐANG GỬI (workflow lớn hơn 80 dòng chỉ gửi bộ phận: dùng số gộp của `AgentProgress` khi có). */
export function totals(rows: readonly AgentRunRow[]): { tokens: number; tools: number } {
  let tokens = 0;
  let tools = 0;
  for (const r of rows) {
    tokens += r.tokens;
    tools += r.tools;
  }
  return { tokens, tools };
}

/** Các đoạn của thanh tiến độ (tỉ lệ 0–1) theo trạng thái: xong · đang chạy · lỗi · chờ. Tổng = 1 (hoặc rỗng nếu chưa có agent). */
export function meterSegments(c: WfProgress['counts']): Array<{ state: 'done' | 'running' | 'error' | 'queued'; frac: number }> {
  const total = c.total || c.done + c.running + c.queued + c.error + c.stopped;
  if (total <= 0) return [];
  const seg = (state: 'done' | 'running' | 'error' | 'queued', n: number) => ({ state, frac: n / total });
  return [seg('done', c.done), seg('running', c.running), seg('error', c.error + c.stopped), seg('queued', c.queued)].filter((s) => s.frac > 0);
}
