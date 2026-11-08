/**
 * Phiên của CLI: `~/.locaith/sessions/<id>.json` bằng `BaseSessionStore` của extension (cùng định dạng `{session, transcript,…}`,
 * chỉ mục, thùng rác, hàn gắn), ghi nguyên tử, quyền 600. ĐỌC được định dạng cũ của CLI 0.3.x (`{id,title,model,cwd,messages}`) và
 * chuyển lên định dạng mới ở lần liệt kê/mở đầu tiên (bản gốc giữ lại ở `<id>.legacy.json`, không lộ ra danh sách).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { newSession, type SessionState } from '../../core/engine/types';
import type { ChatMessage } from '../../core/types';
import type { SessionSummary, TItem } from '../../shared/protocol';
import { BaseSessionStore, type PersistedSession, type StoreIO } from '../../shared/sessionStore';
import { rebuildTranscript, reconcileTranscript } from '../../shared/transcriptRebuild';
import { LOCAITH_PROVIDER_ID } from '../../core/providers/locaithGateway';
import { pathKey, writeFileAtomicAsync } from './util';

export function sessionsDir(home: string): string {
  return path.join(home, '.locaith', 'sessions');
}

/** Lớp vào/ra thư mục phẳng cho `BaseSessionStore` (Node thuần). */
export function fsStoreIO(dir: string): StoreIO {
  return {
    read: async (name) => fs.promises.readFile(path.join(dir, name)),
    write: (name, data) => writeFileAtomicAsync(path.join(dir, name), data, 0o600),
    remove: async (name) => {
      await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
    },
    names: async () => {
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

/** Khoá thư mục làm việc của phiên (so sánh không phân biệt hoa/thường trên Windows/macOS). */
export function workspaceKeyOf(cwd: string): string {
  return pathKey(cwd);
}

interface LegacySession {
  id: string;
  title?: string;
  model?: string;
  cwd?: string;
  updatedAt?: number;
  messages: ChatMessage[];
  usage?: { input?: number; output?: number };
}

function isLegacy(j: unknown): j is LegacySession {
  if (!j || typeof j !== 'object') return false;
  const o = j as Record<string, unknown>;
  return typeof o.id === 'string' && /^[\w-]+$/.test(o.id) && Array.isArray(o.messages) && o.version === undefined && o.session === undefined;
}

export interface LoadedSession {
  session: SessionState;
  transcript: TItem[];
  workspace: string;
  /** Mở từ thư mục khác thư mục hiện tại. */
  other: boolean;
}

export class SessionRepo {
  private readonly dir: string;
  private readonly io: StoreIO;
  private readonly store: BaseSessionStore;
  private migrated: Promise<void> | null = null;

  constructor(
    home: string,
    private readonly cwd: string,
    appVersion: string,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void = () => undefined,
  ) {
    this.dir = sessionsDir(home);
    this.io = fsStoreIO(this.dir);
    this.store = new BaseSessionStore(this.io, workspaceKeyOf(cwd), path.basename(cwd) || cwd, appVersion);
  }

  /** Chuyển các tệp phiên CLI 0.3.x lên định dạng mới (một lần mỗi runtime; lỗi từng tệp không chặn gì). */
  private ensureMigrated(): Promise<void> {
    this.migrated ??= (async () => {
      const names = await this.io.names();
      for (const n of names) {
        if (!/^[\w-]+\.json$/.test(n) || n === 'index.json') continue;
        let raw: Uint8Array;
        let j: unknown;
        try {
          raw = await this.io.read(n);
          j = JSON.parse(Buffer.from(raw).toString('utf8'));
        } catch {
          continue;
        }
        if (!isLegacy(j)) continue;
        try {
          const upd = typeof j.updatedAt === 'number' && Number.isFinite(j.updatedAt) ? j.updatedAt : Date.now();
          const session = newSession({
            id: j.id,
            provider: LOCAITH_PROVIDER_ID,
            model: typeof j.model === 'string' && j.model ? j.model : 'locaith-v5-flash',
            title: (j.title ?? '').trim() || 'Cuộc trò chuyện',
            createdAt: upd,
            updatedAt: upd,
            messages: j.messages,
            usageTotals: { input: Number(j.usage?.input) || 0, output: Number(j.usage?.output) || 0 },
            historyEdited: true,
          });
          const payload: PersistedSession = {
            version: 1,
            workspace: workspaceKeyOf(typeof j.cwd === 'string' && j.cwd ? j.cwd : this.cwd),
            ...(j.cwd ? { workspaceName: path.basename(j.cwd) } : {}),
            session,
            transcript: rebuildTranscript(j.messages),
          };
          await this.io.write(`${j.id}.legacy.json`, raw);
          await this.io.write(n, new TextEncoder().encode(JSON.stringify(payload)));
          this.log('info', `Đã chuyển phiên CLI cũ ${j.id} lên định dạng mới.`);
        } catch (err) {
          this.log('warn', `Không chuyển được phiên cũ ${n}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return this.migrated;
  }

  async list(scope: 'cwd' | 'all' = 'cwd'): Promise<SessionSummary[]> {
    await this.ensureMigrated();
    return scope === 'all' ? this.store.listAll() : this.store.list();
  }

  /**
   * Tìm một phiên theo id/tiền tố (ưu tiên thư mục hiện tại khi tiền tố trùng nhiều). `true` = phiên gần nhất của thư mục này.
   * Ném lỗi có thông điệp rõ khi không thấy/mơ hồ.
   */
  async find(idOrPrefix: string | true): Promise<SessionSummary> {
    const here = await this.list('cwd');
    if (idOrPrefix === true) {
      if (!here[0]) throw new Error('Chưa có phiên nào được lưu ở thư mục này.');
      return here[0];
    }
    const q = idOrPrefix.trim();
    if (!q) throw new Error('Thiếu mã phiên.');
    const all = await this.list('all');
    const exact = all.find((s) => s.id === q);
    if (exact) return exact;
    const starts = all.filter((s) => s.id.startsWith(q));
    if (starts.length === 1) return starts[0];
    if (starts.length > 1) {
      const local = starts.filter((s) => !s.other);
      if (local.length === 1) return local[0];
      throw new Error(`Mã «${q}» khớp ${starts.length} phiên — gõ dài hơn (${starts.slice(0, 3).map((s) => s.id).join(', ')}…).`);
    }
    throw new Error(`Không thấy phiên «${q}».`);
  }

  async load(id: string): Promise<LoadedSession | null> {
    await this.ensureMigrated();
    const p = await this.store.load(id);
    if (!p) return null;
    const rec = reconcileTranscript(p.session.messages, p.transcript);
    return { session: p.session, transcript: rec.items, workspace: p.workspace, other: p.workspace !== workspaceKeyOf(this.cwd) };
  }

  async save(session: SessionState, transcript: TItem[]): Promise<void> {
    await this.ensureMigrated();
    await this.store.save(session, transcript);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.store.rename(id, title);
  }
}
