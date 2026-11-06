/**
 * Kho lưu hội thoại dùng chung cho mọi bề mặt (VS Code: tệp JSON trong thư mục lưu trữ; trình duyệt: IndexedDB).
 * Chỉ phụ thuộc `StoreIO` — một lớp vào/ra tối thiểu kiểu "thư mục phẳng gồm các tệp có tên".
 *
 * Nhiều cửa sổ/phiên bản cùng dùng CHUNG kho này, nên chỉ mục không được giữ trong bộ nhớ rồi ghi đè nguyên bản (cửa sổ này
 * sẽ xoá mất mục do cửa sổ kia thêm). Mỗi thao tác đọc chỉ mục MỚI rồi hợp nhất với các tệp phiên thật sự có: tệp mồ côi
 * được thêm lại, mục của tệp đã mất bị bỏ, chỉ mục hỏng được dựng lại từ các tệp — nên mọi cuộc đua ghi đồng thời rồi cũng
 * tự lành ở lần liệt kê kế tiếp.
 *
 * Lịch sử trò chuyện là dữ liệu quan trọng của người dùng nên KHÔNG BAO GIỜ tự biến mất:
 *  - không giới hạn số cuộc trò chuyện (trước đây kho âm thầm xoá các cuộc cũ nhất khi quá 200);
 *  - xoá một cuộc = chuyển vào THÙNG RÁC (`trash.<id>.json`), giữ TRASH_DAYS ngày, khôi phục được; chỉ "Xoá vĩnh viễn" / "Dọn thùng rác" / hết hạn mới mất thật;
 *  - sao lưu ra tệp và khôi phục từ tệp (xem sessionBackup.ts): `exportSessions` / `importSessions`.
 */

import type { SessionState } from '../core/engine/types';
import { TRASH_DAYS, type SessionSummary, type TItem, type TrashSummary } from './protocol';
import { SESSION_SCHEMA, migrateSession } from './sessionMigrate';
import { parseBackup, type BackupSession } from './sessionBackup';
import { trimTranscriptForStorage } from './transcript';

export interface PersistedSession {
  version: 1;
  /** Hình dạng `SessionState` lúc ghi (xem `SESSION_SCHEMA`). Thiếu = tệp của bản cũ. */
  schema?: number;
  /** Phiên bản ứng dụng đã ghi tệp: khác bản đang chạy nghĩa là prompt/bộ công cụ có thể đã đổi. */
  appVersion?: string;
  workspace: string;
  /** Tên thư mục làm việc lúc lưu (chỉ để hiển thị khi xem cuộc trò chuyện từ thư mục khác). */
  workspaceName?: string;
  session: SessionState;
  transcript: TItem[];
  /** Chỉ có trong bộ nhớ: lần đọc này đã nâng cấp phiên từ bản cũ. Không được ghi xuống đĩa. */
  migrated?: boolean;
}

interface IndexEntry extends SessionSummary {
  workspace: string;
  workspaceName?: string;
}

interface TrashEntry extends IndexEntry {
  deletedAt: number;
}

type PersistedTrash = PersistedSession & { deletedAt: number };

export { TRASH_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX = 'index.json';
const TRASH_INDEX = 'trash.index.json';
const SESSION_FILE = /^[\w-]+\.json$/;
const TRASH_FILE = /^trash\.([\w-]+)\.json$/;
const SAFE_ID = /^[\w-]+$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Lớp vào/ra tối thiểu của kho lưu trữ (tách ra để test được bằng bộ nhớ). */
export interface StoreIO {
  read(name: string): Promise<Uint8Array>;
  /** Ghi NGUYÊN TỬ (tệp tạm rồi đổi tên / một giao dịch): mất điện/đóng cửa sổ giữa chừng không làm hỏng dữ liệu. */
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  /** Tên các tệp trong kho; rỗng nếu kho chưa có gì. */
  names(): Promise<string[]>;
}

export interface ImportSummary {
  /** Cuộc trò chuyện mới được thêm. */
  imported: number;
  /** Đã có sẵn bản y hệt/mới hơn → bỏ qua. */
  unchanged: number;
  /** Đã có bản khác cùng mã → thêm thành bản sao "(bản khôi phục)" để không ghi đè. */
  copies: number;
  /** Cuộc trò chuyện vốn nằm trong Thùng rác lúc sao lưu → quay về Thùng rác (hạn giữ tính lại từ hôm nay). */
  trashed: number;
}

export class BaseSessionStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: StoreIO,
    private readonly workspaceKey: string,
    private readonly workspaceName?: string,
    /** Phiên bản ứng dụng đang chạy. Có = phiên ghi bởi bản khác được nâng cấp ngay khi đọc. */
    private readonly appVersion?: string,
  ) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Đọc + NÂNG CẤP một phiên. Đây là chỗ duy nhất mọi đường đọc đi qua (mở phiên, danh sách, sao lưu, khôi phục),
   * nên phiên của bản cũ luôn được chuẩn hoá theo bản đang chạy — không cần tạo cuộc trò chuyện mới.
   */
  private async readPersisted(id: string): Promise<PersistedSession | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const p = JSON.parse(dec.decode(await this.io.read(`${id}.json`))) as PersistedSession;
      if (p.version !== 1) return null;
      const m = migrateSession(p.session, { storedAppVersion: p.appVersion, appVersion: this.appVersion });
      if (!m) return null;
      return { ...p, session: m.session, schema: SESSION_SCHEMA, ...(m.changed ? { migrated: true } : {}) };
    } catch {
      return null;
    }
  }

  private async readTrashed(id: string): Promise<PersistedTrash | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const p = JSON.parse(dec.decode(await this.io.read(`trash.${id}.json`))) as PersistedTrash;
      if (p.version !== 1 || !p.session) return null;
      const m = migrateSession(p.session, { storedAppVersion: p.appVersion, appVersion: this.appVersion });
      if (!m) return null;
      return { ...p, session: m.session, schema: SESSION_SCHEMA, deletedAt: typeof p.deletedAt === 'number' ? p.deletedAt : Date.now() };
    } catch {
      return null;
    }
  }

  private entryOf(p: PersistedSession): IndexEntry {
    const s = p.session;
    return {
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      provider: s.provider,
      model: s.model,
      messageCount: s.messages.filter((m) => !m.synthetic).length,
      workspace: p.workspace,
      ...(p.workspaceName ? { workspaceName: p.workspaceName } : {}),
    };
  }

  /** Đọc chỉ mục MỚI rồi hợp nhất với tệp phiên có thật. `changed` = cần ghi lại. */
  private async syncIndex(): Promise<{ idx: IndexEntry[]; changed: boolean }> {
    let idx: IndexEntry[] = [];
    let changed = false;
    try {
      const parsed = JSON.parse(dec.decode(await this.io.read(INDEX)));
      if (Array.isArray(parsed)) idx = parsed.filter((e): e is IndexEntry => !!e && typeof e.id === 'string');
      else changed = true;
    } catch {
      changed = true; // thiếu hoặc hỏng → dựng lại từ các tệp phiên
    }

    const ids = (await this.io.names()).filter((n) => SESSION_FILE.test(n) && n !== INDEX).map((n) => n.slice(0, -'.json'.length));
    const onDisk = new Set(ids);
    const known = new Set(idx.map((e) => e.id));
    for (const id of ids) {
      if (known.has(id)) continue;
      const p = await this.readPersisted(id);
      if (p) {
        idx.push(this.entryOf(p));
        changed = true;
      }
    }
    const kept = idx.filter((e) => onDisk.has(e.id));
    if (kept.length !== idx.length) changed = true;
    return { idx: kept, changed };
  }

  private writeIndex(idx: IndexEntry[]): Promise<void> {
    return this.io.write(INDEX, enc.encode(JSON.stringify(idx)));
  }

  /**
   * Chỉ mục Thùng rác, hợp nhất với tệp thật như `syncIndex` và dọn: mục quá hạn bị xoá hẳn; mục có bản "đang sống" cùng mã (khôi phục/chuyển dở dang do đóng cửa sổ
   * giữa chừng) thì bản sống thắng — nên gián đoạn ở bất cứ bước nào cũng không làm mất cuộc trò chuyện.
   */
  private async syncTrash(now: number): Promise<{ idx: TrashEntry[]; changed: boolean }> {
    let idx: TrashEntry[] = [];
    let changed = false;
    try {
      const parsed = JSON.parse(dec.decode(await this.io.read(TRASH_INDEX)));
      if (Array.isArray(parsed)) idx = parsed.filter((e): e is TrashEntry => !!e && typeof e.id === 'string' && typeof e.deletedAt === 'number');
      else changed = true;
    } catch {
      changed = true;
    }
    const names = await this.io.names();
    const trashIds = new Set(names.map((n) => TRASH_FILE.exec(n)?.[1]).filter((x): x is string => !!x));
    const live = new Set(names.filter((n) => SESSION_FILE.test(n) && n !== INDEX).map((n) => n.slice(0, -'.json'.length)));
    const known = new Set(idx.map((e) => e.id));
    for (const id of trashIds) {
      if (known.has(id)) continue;
      const p = await this.readTrashed(id);
      if (p) {
        idx.push({ ...this.entryOf(p), deletedAt: p.deletedAt });
        changed = true;
      }
    }
    const kept: TrashEntry[] = [];
    for (const e of idx) {
      if (!trashIds.has(e.id)) {
        changed = true; // tệp đã mất
      } else if (live.has(e.id) || now - e.deletedAt > TRASH_DAYS * DAY_MS) {
        await this.io.remove(`trash.${e.id}.json`);
        changed = true;
      } else kept.push(e);
    }
    return { idx: kept, changed };
  }

  private writeTrashIndex(idx: TrashEntry[]): Promise<void> {
    return this.io.write(TRASH_INDEX, enc.encode(JSON.stringify(idx)));
  }

  /** Đồng bộ rồi ghi lại chỉ mục Thùng rác nếu cần. */
  private async refreshTrash(now = Date.now()): Promise<TrashEntry[]> {
    const { idx, changed } = await this.syncTrash(now);
    if (changed) await this.writeTrashIndex(idx);
    return idx;
  }

  list(): Promise<SessionSummary[]> {
    return this.enqueue(async () => {
      const { idx, changed } = await this.syncIndex();
      if (changed) await this.writeIndex(idx);
      return idx
        .filter((e) => e.workspace === this.workspaceKey)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ workspace: _w, ...rest }) => rest);
    });
  }

  /** MỌI cuộc trò chuyện của người dùng, kể cả tạo ở thư mục làm việc khác (đánh dấu `other`). Mới nhất lên đầu. */
  listAll(): Promise<SessionSummary[]> {
    return this.enqueue(async () => {
      const { idx, changed } = await this.syncIndex();
      if (changed) await this.writeIndex(idx);
      return [...idx]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ workspace, workspaceName, ...rest }) => (workspace === this.workspaceKey ? rest : { ...rest, other: true, ...(workspaceName ? { workspaceName } : {}) }));
    });
  }

  /** Giữ bản gốc của một cuộc trò chuyện (`<id>.healbak.json`, MỘT lần, không lộ ra danh sách) trước khi ghi đè bằng bản đã hàn gắn. */
  backupRaw(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(id)) return;
      const bak = `${id}.healbak.json`;
      if ((await this.io.names()).includes(bak)) return;
      try {
        await this.io.write(bak, await this.io.read(`${id}.json`));
      } catch {
        /* chưa có tệp gốc: không có gì để giữ */
      }
    });
  }

  async load(id: string): Promise<PersistedSession | null> {
    return this.readPersisted(id);
  }

  save(session: SessionState, transcript: TItem[]): Promise<void> {
    return this.enqueue(async () => {
      if (session.messages.length === 0 && transcript.length === 0) return; // không lưu hội thoại rỗng
      const payload: PersistedSession = {
        version: 1,
        schema: SESSION_SCHEMA,
        ...(this.appVersion ? { appVersion: this.appVersion } : {}),
        workspace: this.workspaceKey,
        ...(this.workspaceName ? { workspaceName: this.workspaceName } : {}),
        session,
        transcript: trimTranscriptForStorage(transcript),
      };
      await this.io.write(`${session.id}.json`, enc.encode(JSON.stringify(payload)));

      const { idx } = await this.syncIndex();
      const entry = this.entryOf(payload);
      const i = idx.findIndex((e) => e.id === session.id);
      if (i >= 0) idx[i] = entry;
      else idx.push(entry);
      await this.writeIndex(idx);
    });
  }

  /** Xoá VĨNH VIỄN một cuộc trò chuyện đang có (không qua Thùng rác). Giao diện dùng `moveToTrash`. */
  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(id)) return;
      await this.io.remove(`${id}.json`);
      const { idx } = await this.syncIndex();
      await this.writeIndex(idx.filter((e) => e.id !== id));
    });
  }

  async rename(id: string, title: string): Promise<void> {
    const p = await this.load(id);
    if (!p) return;
    p.session.title = title;
    await this.save(p.session, p.transcript);
  }

  // ───────────────────────────── Thùng rác ─────────────────────────────

  /**
   * Chuyển một cuộc trò chuyện vào Thùng rác (giữ nguyên toàn bộ nội dung, kể cả tệp bối cảnh). Ghi bản trong thùng TRƯỚC rồi mới gỡ bản đang sống:
   * gián đoạn giữa hai bước chỉ để lại hai bản (bản sống thắng ở lần dọn kế tiếp), không bao giờ làm mất.
   */
  moveToTrash(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(id)) return false;
      const p = await this.readPersisted(id);
      if (!p) {
        // Tệp không đọc được (hỏng): không còn gì để giữ lại — gỡ khỏi danh sách như trước đây.
        await this.io.remove(`${id}.json`);
        const { idx } = await this.syncIndex();
        await this.writeIndex(idx.filter((e) => e.id !== id));
        return false;
      }
      const deletedAt = Date.now();
      await this.io.write(`trash.${id}.json`, enc.encode(JSON.stringify({ ...p, deletedAt } satisfies PersistedTrash)));
      await this.io.remove(`${id}.json`);
      const { idx } = await this.syncIndex();
      await this.writeIndex(idx.filter((e) => e.id !== id));
      const trash = await this.refreshTrash(deletedAt);
      if (!trash.some((e) => e.id === id)) await this.writeTrashIndex([...trash, { ...this.entryOf(p), deletedAt }]);
      return true;
    });
  }

  listTrash(): Promise<TrashSummary[]> {
    return this.enqueue(async () => {
      const idx = await this.refreshTrash();
      return idx
        .filter((e) => e.workspace === this.workspaceKey)
        .sort((a, b) => b.deletedAt - a.deletedAt)
        .map(({ workspace: _w, ...rest }) => rest);
    });
  }

  /** Đưa một cuộc trò chuyện từ Thùng rác trở lại danh sách. */
  restore(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const p = await this.readTrashed(id);
      if (!p) return false;
      const { deletedAt: _d, migrated: _m, ...live } = p;
      await this.io.write(`${id}.json`, enc.encode(JSON.stringify({ ...live, schema: SESSION_SCHEMA, ...(this.appVersion ? { appVersion: this.appVersion } : {}) } satisfies PersistedSession)));
      await this.io.remove(`trash.${id}.json`);
      const { idx } = await this.syncIndex();
      const entry = this.entryOf(live);
      const i = idx.findIndex((e) => e.id === id);
      if (i >= 0) idx[i] = entry;
      else idx.push(entry);
      await this.writeIndex(idx);
      await this.refreshTrash();
      return true;
    });
  }

  /** Xoá vĩnh viễn một cuộc trò chuyện trong Thùng rác. */
  purge(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(id)) return;
      await this.io.remove(`trash.${id}.json`);
      await this.refreshTrash();
    });
  }

  /** Dọn sạch Thùng rác (chỉ các cuộc của workspace hiện tại). Trả về số cuộc đã xoá. */
  emptyTrash(): Promise<number> {
    return this.enqueue(async () => {
      const idx = await this.refreshTrash();
      const mine = idx.filter((e) => e.workspace === this.workspaceKey);
      for (const e of mine) await this.io.remove(`trash.${e.id}.json`);
      await this.refreshTrash();
      return mine.length;
    });
  }

  // ─────────────────────── Sao lưu / khôi phục ───────────────────────

  /** Đọc các cuộc trò chuyện (đang có, và tuỳ chọn cả trong Thùng rác) của workspace hiện tại để ghi vào tệp sao lưu. `ids` = chỉ các cuộc này. */
  exportSessions(opts: { ids?: string[]; includeTrash?: boolean } = {}): Promise<BackupSession[]> {
    return this.enqueue(async () => {
      const want = opts.ids ? new Set(opts.ids) : null;
      const out: BackupSession[] = [];
      const { idx } = await this.syncIndex();
      for (const e of idx) {
        if (want && !want.has(e.id)) continue; // sao lưu = MỌI cuộc trò chuyện của người dùng, không chỉ của thư mục đang mở
        const p = await this.readPersisted(e.id);
        if (p) out.push({ workspace: p.workspace, session: p.session, transcript: p.transcript });
      }
      if (opts.includeTrash) {
        for (const e of await this.refreshTrash()) {
          if (want && !want.has(e.id)) continue;
          const p = await this.readTrashed(e.id);
          if (p) out.push({ workspace: p.workspace, session: p.session, transcript: p.transcript, deletedAt: p.deletedAt });
        }
      }
      return out;
    });
  }

  /** Khôi phục từ NỘI DUNG một tệp sao lưu: kiểm tra và chuẩn hoá (parseBackup) rồi `importSessions`. Không bao giờ ném lỗi. */
  async importBackupText(text: string): Promise<{ ok: true; summary: ImportSummary; skipped: number } | { ok: false; error: string }> {
    const parsed = parseBackup(text, this.workspaceKey);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, summary: await this.importSessions(parsed.sessions), skipped: parsed.skipped };
    } catch (err) {
      return { ok: false, error: `Không ghi được vào kho lưu trữ (${err instanceof Error ? err.message : String(err)}).` };
    }
  }

  /**
   * Đưa các cuộc trò chuyện từ tệp sao lưu (ĐÃ qua `parseBackup`) vào kho. Không bao giờ ghi đè: cuộc đã có bản y hệt/mới hơn thì bỏ qua; đã có bản KHÁC cùng mã
   * thì thêm thành bản sao; cuộc đang nằm trong Thùng rác mà tệp sao lưu có bản sống thì được đưa trở lại danh sách.
   */
  importSessions(items: BackupSession[]): Promise<ImportSummary> {
    return this.enqueue(async () => {
      const r: ImportSummary = { imported: 0, unchanged: 0, copies: 0, trashed: 0 };
      const now = Date.now();
      const writeLive = async (session: SessionState, transcript: TItem[]) => {
        const payload: PersistedSession = { version: 1, workspace: this.workspaceKey, session, transcript };
        await this.io.write(`${session.id}.json`, enc.encode(JSON.stringify(payload)));
      };
      for (const it of items) {
        const id = it.session.id;
        if (!SAFE_ID.test(id)) continue;
        const existing = await this.readPersisted(id);
        const trashed = await this.readTrashed(id);
        if (it.deletedAt !== undefined) {
          // Bản sao lưu ghi nhận cuộc này đang ở Thùng rác: đưa về Thùng rác (không làm đầy danh sách), trừ khi đã có sẵn.
          if (existing || trashed) {
            r.unchanged++;
            continue;
          }
          const payload: PersistedTrash = { version: 1, workspace: this.workspaceKey, session: it.session, transcript: it.transcript, deletedAt: now };
          await this.io.write(`trash.${id}.json`, enc.encode(JSON.stringify(payload)));
          r.trashed++;
          continue;
        }
        if (!existing) {
          if (trashed) await this.io.remove(`trash.${id}.json`); // người dùng chủ động khôi phục từ tệp → bản sống thay bản trong thùng
          await writeLive(it.session, it.transcript);
          r.imported++;
        } else if (existing.session.updatedAt >= it.session.updatedAt && existing.session.messages.length >= it.session.messages.length) {
          r.unchanged++;
        } else {
          const copyId = `${id.slice(0, 60)}-r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          await writeLive({ ...it.session, id: copyId, title: `${it.session.title} (bản khôi phục)` }, it.transcript);
          r.copies++;
        }
      }
      const { idx } = await this.syncIndex(); // hợp nhất các tệp vừa thêm vào chỉ mục (tệp chưa có trong chỉ mục được dựng lại)
      await this.writeIndex(idx);
      await this.refreshTrash(now);
      return r;
    });
  }
}
