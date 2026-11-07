/**
 * (lane:checkpoints-rewind) Kho checkpoint: bản gốc của mỗi tệp TRƯỚC khi trợ lý ghi lần đầu trong một lượt.
 *
 * Thuần Node (fs/promises, path, crypto) — không `vscode`, kiểm thử được bằng thư mục tạm.
 *
 * Bố cục trên đĩa (`root` = globalStorage/checkpoints):
 *   <root>/<sessionKey>/turns.json      — mảng StoredTurn theo thứ tự thời gian
 *   <root>/<sessionKey>/blobs/<sha1>    — nội dung tệp (địa chỉ theo nội dung: cùng nội dung chỉ lưu một lần)
 *
 * Giới hạn: tệp > 2 MB hoặc nhị phân (có byte NUL / không phải UTF-8) KHÔNG được chụp — vẫn ghi nhận với `skipped` để giao diện nói rõ.
 * Giữ 30 lượt gần nhất mỗi phiên và 14 ngày; blob không còn lượt nào tham chiếu bị xoá khi dọn. Xoá phiên → xoá cả thư mục.
 * Tệp do LỆNH SHELL sửa (run_command) không đi qua ToolHost.writeText nên không được theo dõi (giống Claude Code).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { structuredPatch } from 'diff';
import { CHECKPOINT_KEEP_DAYS, CHECKPOINT_KEEP_TURNS, CHECKPOINT_MAX_FILE_BYTES, type CheckpointSkip, type CheckpointTurn } from '../../shared/checkpoints';
import type { TodoItem } from '../../shared/protocol';

export interface StoredFile {
  abs: string;
  rel: string;
  /** Tệp đã tồn tại trước lượt này. */
  existed: boolean;
  /** sha1 của bản gốc (chỉ khi `existed` và chụp được). */
  before?: string;
  /** sha1 của bản cuối trợ lý ghi trong lượt (để phát hiện người dùng sửa tiếp). */
  after?: string;
  added: number;
  removed: number;
  skipped?: CheckpointSkip;
}

export interface StoredTurn {
  promptId: string;
  startedAt: number;
  /** Danh sách tác vụ lúc BẮT ĐẦU lượt — khôi phục hội thoại đặt lại đúng trạng thái này. */
  todos?: TodoItem[];
  files: StoredFile[];
  undone?: boolean;
}

export interface StoreOptions {
  now?: () => number;
  keepTurns?: number;
  keepDays?: number;
  maxBytes?: number;
}

/** Nội dung đưa vào kho: chữ, `null` = tệp chưa tồn tại, hoặc lý do không đọc được. */
export type Snapshot = string | null | { skipped: CheckpointSkip };

export const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

/** Đếm dòng thêm/bớt (không giữ hunk) — đủ cho thanh «N tệp đã đổi (+X −Y)». */
export function countDiff(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const h of structuredPatch('a', 'a', before, after, '', '', { context: 0 }).hunks) {
    for (const l of h.lines) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
  }
  return { added, removed };
}

/** Tên thư mục an toàn cho id phiên (id lạ từ tệp sao lưu → băm). */
export function sessionKey(sessionId: string): string {
  return /^[\w.-]{1,80}$/.test(sessionId) ? sessionId : `h-${sha1(sessionId).slice(0, 24)}`;
}

function isBinaryText(s: string): boolean {
  return s.includes('\u0000');
}

export class CheckpointStore {
  private readonly cache = new Map<string, StoredTurn[]>();
  private readonly now: () => number;
  private readonly keepTurns: number;
  private readonly keepDays: number;
  private readonly maxBytes: number;
  /** Ghi tuần tự theo phiên để hai lần ghi liên tiếp không chồng nhau. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    readonly root: string,
    opts: StoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.keepTurns = opts.keepTurns ?? CHECKPOINT_KEEP_TURNS;
    this.keepDays = opts.keepDays ?? CHECKPOINT_KEEP_DAYS;
    this.maxBytes = opts.maxBytes ?? CHECKPOINT_MAX_FILE_BYTES;
  }

  private dir(sessionId: string): string {
    return path.join(this.root, sessionKey(sessionId));
  }

  private blobPath(sessionId: string, hash: string): string {
    return path.join(this.dir(sessionId), 'blobs', hash);
  }

  /** Chạy `fn` sau mọi thao tác ghi trước đó của cùng phiên. */
  private locked<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** Các lượt của phiên (theo thứ tự thời gian). Đọc đĩa lần đầu, sau đó dùng bản trong bộ nhớ. */
  async turns(sessionId: string): Promise<StoredTurn[]> {
    const hit = this.cache.get(sessionId);
    if (hit) return hit;
    let turns: StoredTurn[] = [];
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(this.dir(sessionId), 'turns.json'), 'utf8')) as unknown;
      if (Array.isArray(raw)) turns = raw.filter(isStoredTurn);
    } catch {
      /* chưa có / hỏng → coi như rỗng */
    }
    this.cache.set(sessionId, turns);
    return turns;
  }

  /** Bản đã nạp trong bộ nhớ (không đọc đĩa) — cho `baseView` đồng bộ. */
  cached(sessionId: string): StoredTurn[] | undefined {
    return this.cache.get(sessionId);
  }

  /** Mở một lượt mới (không làm gì nếu đã có). Gọi khi lượt bắt đầu để chụp `todos`. */
  beginTurn(sessionId: string, promptId: string, todos: readonly TodoItem[] = []): Promise<void> {
    return this.locked(sessionId, async () => {
      const turns = await this.turns(sessionId);
      if (turns.some((t) => t.promptId === promptId)) return;
      turns.push({ promptId, startedAt: this.now(), todos: todos.map((t) => ({ ...t })), files: [] });
      await this.prune(sessionId, turns);
      await this.save(sessionId, turns);
    });
  }

  /**
   * Ghi nhận MỘT lần ghi tệp trong lượt `promptId`: lần đầu với `abs` → chụp `before`; các lần sau chỉ cập nhật `after` và số dòng.
   * `before` là nội dung TRƯỚC khi ghi (null = chưa tồn tại); `after` là nội dung sắp ghi.
   */
  record(sessionId: string, promptId: string, file: { abs: string; rel: string; before: Snapshot; after: Snapshot }): Promise<StoredFile> {
    return this.locked(sessionId, async () => {
      const turns = await this.turns(sessionId);
      let turn = turns.find((t) => t.promptId === promptId);
      if (!turn) {
        turn = { promptId, startedAt: this.now(), files: [] };
        turns.push(turn);
      }
      const key = fileKey(file.abs);
      let rec = turn.files.find((f) => fileKey(f.abs) === key);
      const after = this.classify(file.after);
      if (!rec) {
        const before = this.classify(file.before);
        rec = { abs: file.abs, rel: file.rel, existed: file.before !== null, added: 0, removed: 0 };
        if (before.skipped) rec.skipped = before.skipped;
        else if (before.text !== null) {
          rec.before = sha1(before.text);
          await this.writeBlob(sessionId, rec.before, before.text);
        }
        turn.files.push(rec);
      }
      if (after.skipped) rec.skipped = rec.skipped ?? after.skipped;
      else if (after.text !== null) {
        rec.after = sha1(after.text);
        await this.writeBlob(sessionId, rec.after, after.text);
        if (!rec.skipped) {
          const base = rec.before ? await this.readBlob(sessionId, rec.before) : '';
          const d = countDiff(base ?? '', after.text);
          rec.added = d.added;
          rec.removed = d.removed;
        }
      }
      await this.save(sessionId, turns);
      return rec;
    });
  }

  private classify(s: Snapshot): { text: string | null; skipped?: CheckpointSkip } {
    if (s === null) return { text: null };
    if (typeof s !== 'string') return { text: null, skipped: s.skipped };
    if (Buffer.byteLength(s, 'utf8') > this.maxBytes) return { text: null, skipped: 'too_large' };
    if (isBinaryText(s)) return { text: null, skipped: 'binary' };
    return { text: s };
  }

  async readBlob(sessionId: string, hash: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    try {
      return await fs.promises.readFile(this.blobPath(sessionId, hash), 'utf8');
    } catch {
      return null;
    }
  }

  private async writeBlob(sessionId: string, hash: string, text: string): Promise<void> {
    const p = this.blobPath(sessionId, hash);
    try {
      await fs.promises.access(p);
      return; // đã có (cùng nội dung)
    } catch {
      /* chưa có */
    }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await atomicWrite(p, text);
  }

  /** Bỏ lượt `promptId` và mọi lượt SAU nó (khôi phục hội thoại cắt tới trước tin đó). */
  dropFrom(sessionId: string, promptId: string): Promise<void> {
    return this.locked(sessionId, async () => {
      const turns = await this.turns(sessionId);
      const i = turns.findIndex((t) => t.promptId === promptId);
      if (i < 0) return;
      turns.splice(i);
      await this.gcBlobs(sessionId, turns);
      await this.save(sessionId, turns);
    });
  }

  markUndone(sessionId: string, promptIds: readonly string[], undone: boolean): Promise<void> {
    return this.locked(sessionId, async () => {
      const turns = await this.turns(sessionId);
      let changed = false;
      for (const t of turns) {
        if (!promptIds.includes(t.promptId)) continue;
        if (undone) t.undone = true;
        else delete t.undone;
        changed = true;
      }
      if (changed) await this.save(sessionId, turns);
    });
  }

  /** Xoá toàn bộ dữ liệu của một phiên (khi xoá hẳn cuộc trò chuyện). */
  removeSession(sessionId: string): Promise<void> {
    return this.locked(sessionId, async () => {
      this.cache.delete(sessionId);
      await fs.promises.rm(this.dir(sessionId), { recursive: true, force: true });
    });
  }

  /** Dọn các phiên không còn lượt nào trong hạn (gọi khi khởi động, rẻ: mỗi phiên một tệp JSON nhỏ). */
  async gc(): Promise<number> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return 0;
    }
    const limit = this.now() - this.keepDays * 86_400_000;
    let removed = 0;
    for (const name of names) {
      const file = path.join(this.root, name, 'turns.json');
      let fresh = false;
      try {
        const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
        fresh = Array.isArray(raw) && raw.some((t) => isStoredTurn(t) && t.startedAt >= limit);
      } catch {
        fresh = false;
      }
      if (fresh) continue;
      await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /** Tóm tắt cho giao diện (không mang đường dẫn tuyệt đối, không mang hash). */
  summarize(turns: readonly StoredTurn[]): CheckpointTurn[] {
    return turns.map((t) => ({
      promptId: t.promptId,
      files: t.files.map((f) => ({
        rel: f.rel,
        kind: f.existed ? ('edit' as const) : ('create' as const),
        added: f.added,
        removed: f.removed,
        ...(f.skipped ? { skipped: f.skipped } : {}),
      })),
      ...(t.undone ? { undone: true } : {}),
    }));
  }

  private async prune(sessionId: string, turns: StoredTurn[]): Promise<void> {
    const limit = this.now() - this.keepDays * 86_400_000;
    let i = 0;
    while (i < turns.length && (turns[i].startedAt < limit || turns.length - i > this.keepTurns)) i++;
    if (i === 0) return;
    turns.splice(0, i);
    await this.gcBlobs(sessionId, turns);
  }

  private async gcBlobs(sessionId: string, turns: readonly StoredTurn[]): Promise<void> {
    const keep = new Set<string>();
    for (const t of turns) for (const f of t.files) {
      if (f.before) keep.add(f.before);
      if (f.after) keep.add(f.after);
    }
    const dir = path.join(this.dir(sessionId), 'blobs');
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) if (!keep.has(n)) await fs.promises.rm(path.join(dir, n), { force: true });
  }

  private async save(sessionId: string, turns: StoredTurn[]): Promise<void> {
    this.cache.set(sessionId, turns);
    const dir = this.dir(sessionId);
    await fs.promises.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, 'turns.json'), JSON.stringify(turns));
  }
}

export function fileKey(abs: string): string {
  const n = path.resolve(abs);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function isStoredTurn(v: unknown): v is StoredTurn {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.promptId === 'string' && typeof t.startedAt === 'number' && Array.isArray(t.files);
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  try {
    await fs.promises.rename(tmp, file);
  } catch {
    // Windows: rename đè có thể lỗi khi tệp đích đang bị giữ → ghi thẳng rồi dọn tmp.
    await fs.promises.writeFile(file, data, 'utf8');
    await fs.promises.rm(tmp, { force: true });
  }
}
