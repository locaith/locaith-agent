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
import { t as cliT } from '../i18n';
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

/** Bỏ dấu và hạ chữ thường: «Đăng nhập» và «dang nhap» là một khi tìm trong tiêu đề phiên. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Kết quả của «người dùng muốn phiên nào?» (xem `matchSessions`). */
export type SessionMatch =
  | { kind: 'one'; session: SessionSummary }
  | { kind: 'many'; list: SessionSummary[] }
  | { kind: 'none'; reason: 'empty' | 'index' | 'text'; max?: number };

/**
 * Hiểu cách người dùng chỉ một phiên, theo thứ tự: mã đầy đủ → đầu mã (nếu duy nhất, hoặc duy nhất trong thư mục này) → SỐ thứ tự trong danh sách đang hiện
 * (`2` hoặc `#2`; danh sách đang hiện là phiên của thư mục này, hoặc mọi phiên khi thư mục này chưa có) → từ khoá trong tiêu đề (mọi từ đều phải có,
 * không phân biệt dấu/hoa thường). Thuần (không đụng đĩa) để kiểm thử.
 *
 * Mã phiên có dạng `cli_<giờ><ngẫu nhiên>`: các phiên tạo gần nhau CÙNG đầu mã (8 ký tự đầu thường trùng), nên chỉ đầu mã ngắn là chưa đủ để chỉ đúng một phiên.
 */
export function matchSessions(query: string, here: readonly SessionSummary[], all: readonly SessionSummary[]): SessionMatch {
  const q = query.trim();
  if (!q) return { kind: 'none', reason: 'empty' };
  const lq = q.toLowerCase();
  const exact = all.find((s) => s.id === q) ?? all.find((s) => s.id.toLowerCase() === lq);
  if (exact) return { kind: 'one', session: exact };
  if (!/\s/.test(q)) {
    const starts = all.filter((s) => s.id.toLowerCase().startsWith(lq));
    if (starts.length === 1) return { kind: 'one', session: starts[0] };
    if (starts.length > 1) {
      const local = starts.filter((s) => !s.other);
      if (local.length === 1) return { kind: 'one', session: local[0] };
      return { kind: 'many', list: starts };
    }
  }
  const num = /^#?(\d{1,3})$/.exec(q);
  if (num) {
    const listed = here.length ? here : all;
    const n = Number(num[1]);
    if (n >= 1 && n <= listed.length) return { kind: 'one', session: listed[n - 1] };
    return { kind: 'none', reason: 'index', max: listed.length };
  }
  const words = foldText(q).split(/\s+/).filter(Boolean);
  const hits = all.filter((s) => {
    const hay = foldText(s.title);
    return words.every((w) => hay.includes(w));
  });
  // Phiên của thư mục này lên trước; trong mỗi nhóm giữ thứ tự mới nhất trước.
  const ordered = [...hits.filter((s) => !s.other), ...hits.filter((s) => s.other)];
  if (ordered.length === 1) return { kind: 'one', session: ordered[0] };
  if (ordered.length > 1) return { kind: 'many', list: ordered };
  return { kind: 'none', reason: 'text' };
}

/** Câu báo khi `matchSessions` không ra đúng một phiên (không mơ hồ về điều cần làm tiếp). */
export function sessionMissMessage(query: string, m: Exclude<SessionMatch, { kind: 'one' }>): string {
  const q = query.trim();
  if (m.kind === 'many') {
    const list = m.list
      .slice(0, 5)
      .map((s) => `${s.id} (${s.title || '—'})`)
      .join('; ');
    return cliT('runtime.sessionMany', { q, n: m.list.length, list });
  }
  if (m.reason === 'index') return cliT('runtime.sessionNoIndex', { q, max: m.max ?? 0 });
  if (m.reason === 'empty') return cliT('runtime.sessionMissingId');
  return cliT('runtime.sessionNone', { q });
}

/**
 * «2 giờ trước», «hôm qua», «3 ngày trước»; từ 7 ngày trở đi dùng `abs` (ngày giờ đầy đủ). Nhìn là biết phiên nào vừa dùng — khó hơn nhiều với «21:39 8/11/26».
 * Thuần để kiểm thử (`now` truyền vào).
 */
export function formatAgo(ts: number, now: number, lang: 'vi' | 'en', abs: (ts: number) => string): string {
  const ms = Math.max(0, now - ts);
  const min = Math.floor(ms / 60_000);
  const hour = Math.floor(ms / 3_600_000);
  const day = Math.floor(ms / 86_400_000);
  const vi = lang === 'vi';
  if (min < 1) return vi ? 'vừa xong' : 'just now';
  if (min < 60) return vi ? `${min} phút trước` : `${min} min ago`;
  if (hour < 24) return vi ? `${hour} giờ trước` : `${hour} h ago`;
  if (day === 1) return vi ? 'hôm qua' : 'yesterday';
  if (day < 7) return vi ? `${day} ngày trước` : `${day} days ago`;
  return abs(ts);
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
   * Tìm một phiên theo mã, đầu mã, SỐ thứ tự (`2`, `#2`) hoặc từ khoá trong tiêu đề — xem `matchSessions`. `true` = phiên gần nhất của thư mục này.
   * Ném lỗi có thông điệp rõ (và nói cách làm tiếp) khi không thấy hoặc khớp nhiều phiên.
   */
  async find(idOrPrefix: string | true): Promise<SessionSummary> {
    const here = await this.list('cwd');
    if (idOrPrefix === true) {
      if (!here[0]) throw new Error(cliT('runtime.noSessionHere'));
      return here[0];
    }
    const all = await this.list('all');
    const m = matchSessions(idOrPrefix, here, all);
    if (m.kind === 'one') return m.session;
    throw new Error(sessionMissMessage(idOrPrefix, m));
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
