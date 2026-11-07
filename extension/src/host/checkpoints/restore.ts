/**
 * (lane:checkpoints-rewind) Khôi phục tệp từ kho checkpoint — API thuần, kiểm thử được bằng thư mục tạm.
 *
 * Quy tắc an toàn:
 *  - mọi đường dẫn phải nằm TRONG một gốc workspace (kể cả sau khi theo symlink ở thư mục cha) — còn lại bị bỏ qua với lý do 'outside';
 *  - phát hiện XUNG ĐỘT: nội dung hiện tại không phải bản trợ lý đã ghi (người dùng / lệnh shell sửa tiếp) → đánh dấu `conflict`
 *    và KHÔNG ghi đè trừ khi người gọi cho phép rõ ràng (`overwriteConflicts`);
 *  - mọi lần khôi phục trả về một nhật ký (journal) để «Làm lại» đưa các tệp về đúng trạng thái trước khi khôi phục (một lần).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckpointSkip, RewindPlanFile, RewindScope } from '../../shared/checkpoints';
import { countDiff, fileKey, sha1, type CheckpointStore, type StoredFile, type StoredTurn } from './store';

/** Đọc/ghi đĩa, thay được (host thật ghi qua WorkspaceEdit để editor đang mở cập nhật tại chỗ). */
export interface RestoreIO {
  /** null = tệp không tồn tại. */
  read(abs: string): Promise<string | null | { skipped: CheckpointSkip }>;
  write(abs: string, text: string): Promise<void>;
  remove(abs: string): Promise<void>;
}

export const fsRestoreIO: RestoreIO = {
  async read(abs) {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? null : { skipped: 'unreadable' };
    }
    if (buf.includes(0)) return { skipped: 'binary' };
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return { skipped: 'binary' };
    }
  },
  async write(abs, text) {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, text, 'utf8');
  },
  async remove(abs) {
    await fs.promises.rm(abs, { force: true });
  },
};

export interface RestoreCtx {
  store: CheckpointStore;
  sessionId: string;
  /** Các gốc workspace. */
  roots: string[];
  io?: RestoreIO;
}

export interface PlanEntry extends RewindPlanFile {
  abs: string;
  /** Nội dung sẽ ghi (null = xoá tệp). Vắng khi action = 'skip'. */
  target?: string | null;
  /** Nội dung hiện tại lúc lập kế hoạch (null = chưa có). */
  current?: string | null;
}

export interface RestorePlan {
  promptId: string;
  scope: RewindScope;
  entries: PlanEntry[];
  /** Các lượt nằm trong phạm vi (để đánh dấu «đã hoàn tác»). */
  turnIds: string[];
}

export interface JournalEntry {
  abs: string;
  rel: string;
  /** Nội dung TRƯỚC khi khôi phục (null = chưa có). */
  prev: string | null;
  /** Nội dung đã ghi khi khôi phục (null = đã xoá) — «Làm lại» chỉ ghi nếu đĩa vẫn đúng như vậy. */
  wrote: string | null;
}

export interface ApplyResult {
  restored: number;
  /** Tệp không ghi được (xung đột không được phép đè, ngoài workspace, lỗi ghi…). */
  skipped: { rel: string; reason: string }[];
  journal: JournalEntry[];
}

const ABSENT = '<absent>';
const hashOf = (s: string | null): string => (s === null ? ABSENT : sha1(s));

/** `abs` nằm trong một gốc workspace, kể cả sau khi theo symlink của thư mục cha gần nhất đang tồn tại. */
export async function insideWorkspace(abs: string, roots: readonly string[]): Promise<boolean> {
  if (!abs || abs.includes('\u0000') || !path.isAbsolute(abs)) return false;
  const resolved = path.resolve(abs);
  for (const root of roots) {
    const r = path.resolve(root);
    const rel = path.relative(r, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // Chống symlink thoát ra ngoài: thư mục cha gần nhất đang tồn tại phải nằm trong gốc thật.
    let probe = path.dirname(resolved);
    for (let i = 0; i < 64; i++) {
      try {
        const realProbe = await fs.promises.realpath(probe);
        const realRoot = await fs.promises.realpath(r);
        const back = path.relative(realRoot, realProbe);
        if (back.startsWith('..') || path.isAbsolute(back)) break;
        return true;
      } catch {
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
  }
  return false;
}

interface Group {
  key: string;
  abs: string;
  rel: string;
  first: StoredFile;
  last: StoredFile;
  expected: Set<string>;
  skipped?: CheckpointSkip;
}

function group(turns: readonly StoredTurn[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of turns) {
    for (const f of t.files) {
      const key = fileKey(f.abs);
      let g = map.get(key);
      if (!g) {
        g = { key, abs: f.abs, rel: f.rel, first: f, last: f, expected: new Set() };
        map.set(key, g);
      }
      g.last = f;
      if (f.skipped) g.skipped = g.skipped ?? f.skipped;
      g.expected.add(f.after ?? ABSENT);
      if (t.undone) g.expected.add(f.existed ? (f.before ?? ABSENT) : ABSENT);
    }
  }
  return [...map.values()];
}

/** Lập kế hoạch khôi phục: đọc đĩa hiện tại, so với bản gốc, đánh dấu xung đột. KHÔNG ghi gì. */
export async function planRestore(ctx: RestoreCtx, promptId: string, opts: { scope?: RewindScope; files?: readonly string[] } = {}): Promise<RestorePlan> {
  const scope = opts.scope ?? 'from';
  const io = ctx.io ?? fsRestoreIO;
  const all = await ctx.store.turns(ctx.sessionId);
  const idx = all.findIndex((t) => t.promptId === promptId);
  const plan: RestorePlan = { promptId, scope, entries: [], turnIds: [] };
  if (idx < 0) return plan;
  const range = scope === 'turn' ? [all[idx]] : all.slice(idx);
  plan.turnIds = range.map((t) => t.promptId);
  const only = opts.files ? new Set(opts.files.map((f) => f.replace(/\\/g, '/'))) : null;

  for (const g of group(range)) {
    if (only && !only.has(g.rel)) continue;
    const base = { abs: g.abs, rel: g.rel, added: 0, removed: 0 };
    if (!(await insideWorkspace(g.abs, ctx.roots))) {
      plan.entries.push({ ...base, action: 'skip', reason: 'outside' });
      continue;
    }
    if (g.skipped) {
      plan.entries.push({ ...base, action: 'skip', reason: g.skipped });
      continue;
    }
    let target: string | null = null;
    if (g.first.existed) {
      target = g.first.before ? await ctx.store.readBlob(ctx.sessionId, g.first.before) : null;
      if (target === null) {
        plan.entries.push({ ...base, action: 'skip', reason: 'missing_blob' });
        continue;
      }
    }
    const cur = await io.read(g.abs);
    if (cur !== null && typeof cur !== 'string') {
      plan.entries.push({ ...base, action: 'skip', reason: cur.skipped });
      continue;
    }
    if (cur === target) continue; // đã đúng như bản gốc — không có gì để làm
    const conflict = !g.expected.has(hashOf(cur));
    const d = countDiff(cur ?? '', target ?? '');
    const action: PlanEntry['action'] = target === null ? 'delete' : cur === null ? 'recreate' : 'restore';
    plan.entries.push({ ...base, action, added: d.added, removed: d.removed, ...(conflict ? { conflict: true } : {}), target, current: cur });
  }
  plan.entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return plan;
}

/** Thực hiện kế hoạch. Tệp xung đột bị BỎ QUA trừ khi `overwriteConflicts` (tất cả) hoặc `allowConflicts` (đúng các tệp người dùng đã thấy cảnh báo). Đọc lại đĩa ngay trước khi ghi để chắc kế hoạch chưa cũ. */
export async function applyPlan(ctx: RestoreCtx, plan: RestorePlan, opts: { overwriteConflicts?: boolean; allowConflicts?: ReadonlySet<string> } = {}): Promise<ApplyResult> {
  const io = ctx.io ?? fsRestoreIO;
  const out: ApplyResult = { restored: 0, skipped: [], journal: [] };
  for (const e of plan.entries) {
    if (e.action === 'skip' || e.target === undefined) {
      out.skipped.push({ rel: e.rel, reason: e.reason ?? 'skip' });
      continue;
    }
    if (!(await insideWorkspace(e.abs, ctx.roots))) {
      out.skipped.push({ rel: e.rel, reason: 'outside' });
      continue;
    }
    const now = await io.read(e.abs);
    if (now !== null && typeof now !== 'string') {
      out.skipped.push({ rel: e.rel, reason: now.skipped });
      continue;
    }
    const allowed = opts.overwriteConflicts === true || opts.allowConflicts?.has(e.rel) === true;
    if (e.conflict && !allowed) {
      out.skipped.push({ rel: e.rel, reason: 'conflict' });
      continue;
    }
    // Kế hoạch cũ: đĩa đã đổi kể từ lúc lập → coi là xung đột mới.
    if (now !== (e.current ?? null) && !allowed) {
      out.skipped.push({ rel: e.rel, reason: 'conflict' });
      continue;
    }
    try {
      if (e.target === null) await io.remove(e.abs);
      else await io.write(e.abs, e.target);
    } catch (err) {
      out.skipped.push({ rel: e.rel, reason: err instanceof Error ? err.message.slice(0, 120) : 'write_failed' });
      continue;
    }
    out.journal.push({ abs: e.abs, rel: e.rel, prev: now, wrote: e.target });
    out.restored++;
  }
  return out;
}

/** Tiện ích một bước: lập kế hoạch rồi áp dụng (xung đột bị bỏ qua trừ khi cho phép). */
export async function restoreFiles(
  ctx: RestoreCtx,
  promptId: string,
  opts: { scope?: RewindScope; files?: readonly string[]; overwriteConflicts?: boolean } = {},
): Promise<ApplyResult & { plan: RestorePlan }> {
  const plan = await planRestore(ctx, promptId, opts);
  const res = await applyPlan(ctx, plan, opts);
  return { ...res, plan };
}

/** «Làm lại»: đưa các tệp về trạng thái TRƯỚC khi khôi phục. Tệp bị sửa thêm sau khi khôi phục (đĩa ≠ `wrote`) bị bỏ qua trừ khi `overwriteConflicts`. */
export async function redoRestore(ctx: RestoreCtx, journal: readonly JournalEntry[], opts: { overwriteConflicts?: boolean } = {}): Promise<ApplyResult> {
  const io = ctx.io ?? fsRestoreIO;
  const out: ApplyResult = { restored: 0, skipped: [], journal: [] };
  for (const j of journal) {
    if (!(await insideWorkspace(j.abs, ctx.roots))) {
      out.skipped.push({ rel: j.rel, reason: 'outside' });
      continue;
    }
    const now = await io.read(j.abs);
    if (now !== null && typeof now !== 'string') {
      out.skipped.push({ rel: j.rel, reason: now.skipped });
      continue;
    }
    if (now !== j.wrote && !opts.overwriteConflicts) {
      out.skipped.push({ rel: j.rel, reason: 'conflict' });
      continue;
    }
    try {
      if (j.prev === null) await io.remove(j.abs);
      else await io.write(j.abs, j.prev);
    } catch (err) {
      out.skipped.push({ rel: j.rel, reason: err instanceof Error ? err.message.slice(0, 120) : 'write_failed' });
      continue;
    }
    out.journal.push({ abs: j.abs, rel: j.rel, prev: now, wrote: j.prev });
    out.restored++;
  }
  return out;
}

/** Bản trợ lý đã ghi (để mở diff «bản gốc ↔ hiện tại» thì cần bản gốc): trả bản gốc của MỘT tệp trong MỘT lượt. null = tệp chưa tồn tại trước lượt đó; undefined = không có/không đọc được. */
export async function turnOriginal(store: CheckpointStore, sessionId: string, promptId: string, rel: string): Promise<string | null | undefined> {
  const turn = (await store.turns(sessionId)).find((t) => t.promptId === promptId);
  const f = turn?.files.find((x) => x.rel === rel);
  if (!f || f.skipped) return undefined;
  if (!f.existed) return null;
  if (!f.before) return undefined;
  return (await store.readBlob(sessionId, f.before)) ?? undefined;
}
