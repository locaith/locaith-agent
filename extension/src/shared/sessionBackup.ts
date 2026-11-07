/**
 * Sao lưu / khôi phục lịch sử trò chuyện ra MỘT tệp JSON (định dạng riêng, đầy đủ, không mất gì): toàn bộ tin nhắn gửi cho mô hình (kể cả chữ của các tệp bối cảnh
 * người dùng đã tải lên), giao diện hội thoại, bảng tác vụ, artifact… Dùng chung cho VS Code và trình duyệt.
 *
 * Tệp sao lưu khi KHÔI PHỤC là dữ liệu không đáng tin (có thể bị sửa tay, hoặc do người khác gửi): mọi trường được kiểm lại và chuẩn hoá, quyền "cho phép cả phiên"
 * và chế độ "không hỏi gì" không bao giờ được mang theo, dung lượng bị chặn. Lịch sử nạp lại vẫn là lịch sử của mô hình — người dùng chỉ nên khôi phục tệp do chính mình tạo.
 */

import { newSession, type ArtifactRecord, type SessionState } from '../core/engine/types';
import type { ChatMessage, ContentBlock } from '../core/types';
import { DOC_KINDS, type DocKind } from './docKinds';
import { contextStatsOf } from './sessionMigrate';
import { MAX_BACKUP_BYTES, PERMISSION_MODES, THINKING_LEVELS, type AssistantItem, type AttachmentInfo, type TItem, type TodoItem } from './protocol';

export const BACKUP_FORMAT = 'ai-agent-sessions';
export const BACKUP_VERSION = 1;
const MAX_SESSIONS_PER_FILE = 5000;
const MAX_MESSAGES = 20_000;
const MAX_BLOCK_CHARS = 20_000_000;
const SAFE_ID = /^[\w-]{1,80}$/;

export interface BackupSession {
  workspace: string;
  session: SessionState;
  transcript: TItem[];
  /** Có giá trị = phiên đang nằm trong Thùng rác lúc sao lưu. */
  deletedAt?: number;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: number;
  app: { version: string; platform: 'vscode' | 'browser' };
  sessions: BackupSession[];
}

export function makeBackup(sessions: BackupSession[], app: BackupFile['app'], now = Date.now()): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    app,
    // Quyền "cho phép cả phiên" chỉ có hiệu lực trong lúc khung chat còn mở: không bao giờ nằm trong tệp sao lưu.
    sessions: sessions.map((s) => ({ ...s, session: { ...s.session, approvals: [] } })),
  };
}

/** Tên tệp tải về: locaith-ai-sao-luu-<phiên|tat-ca>-2026-10-30.json (chỉ ký tự an toàn cho mọi hệ điều hành). */
export function backupFileName(scope: 'one' | 'all', title: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const slug = (title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `locaith-ai-sao-luu-${scope === 'all' ? 'tat-ca' : slug || 'cuoc-tro-chuyen'}-${day}.json`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kiểm tra và chuẩn hoá (dữ liệu không đáng tin)
// ─────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 1_000_000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Dấu thời gian hợp lệ cho Date (0 ≤ ts ≤ 8,64e15); ngoài dải → undefined. */
const tsNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15 ? v : undefined);
const small = (v: unknown, max = 200): string => str(v, max) ?? '';

function sanitizeBlock(b: unknown): ContentBlock | null {
  if (!isObj(b)) return null;
  switch (b.type) {
    case 'text': {
      const text = str(b.text, MAX_BLOCK_CHARS);
      return text === undefined ? null : { type: 'text', text };
    }
    case 'image': {
      const data = str(b.data, MAX_BLOCK_CHARS);
      const mediaType = str(b.mediaType, 100);
      return data && mediaType && /^image\/[\w.+-]+$/.test(mediaType) ? { type: 'image', mediaType, data } : null;
    }
    case 'thinking':
      // Khối suy luận gắn chặt với lịch sử gốc (chữ ký) — không đáng giữ lại khi khôi phục từ tệp; engine sẽ tự suy luận lại.
      return null;
    case 'tool_use': {
      const id = str(b.id, 200);
      const name = str(b.name, 100);
      if (!id || !name || !isObj(b.input)) return null;
      return { type: 'tool_use', id, name, input: b.input };
    }
    case 'tool_result': {
      const toolUseId = str(b.toolUseId, 200);
      const content = str(b.content, MAX_BLOCK_CHARS);
      if (!toolUseId || content === undefined) return null;
      const images = Array.isArray(b.images) ? b.images.flatMap((i) => (sanitizeBlock(i)?.type === 'image' ? [sanitizeBlock(i) as ContentBlock & { type: 'image' }] : [])) : undefined;
      return { type: 'tool_result', toolUseId, name: small(b.name, 100), content, ...(b.isError === true ? { isError: true } : {}), ...(images?.length ? { images } : {}) };
    }
    default:
      return null;
  }
}

function sanitizeMessage(m: unknown): ChatMessage | null {
  if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.content)) return null;
  const content = m.content.map(sanitizeBlock).filter((b): b is ContentBlock => b !== null);
  if (content.length === 0) return null;
  return {
    role: m.role,
    content,
    ...(m.role === 'assistant' ? { provider: str(m.provider, 100), model: str(m.model, 200) } : {}),
    ...(m.synthetic === true ? { synthetic: true } : {}),
    ...(tsNum(m.ts) !== undefined ? { ts: tsNum(m.ts) } : {}),
  };
}

const ATTACHMENT_KINDS = ['file', 'selection', 'image', 'folder', 'tab', 'doc'];

function sanitizeAttachment(a: unknown): AttachmentInfo | null {
  if (!isObj(a) || !ATTACHMENT_KINDS.includes(a.kind as string)) return null;
  const d = isObj(a.doc) ? a.doc : undefined;
  return {
    kind: a.kind as AttachmentInfo['kind'],
    label: small(a.label),
    ...(str(a.path, 1000) !== undefined ? { path: str(a.path, 1000) } : {}),
    ...(Array.isArray(a.range) && a.range.length === 2 && a.range.every((n) => typeof n === 'number') ? { range: [a.range[0], a.range[1]] as [number, number] } : {}),
    ...(num(a.sizeBytes) !== undefined ? { sizeBytes: num(a.sizeBytes) } : {}),
    ...(str(a.thumb, 120_000) !== undefined ? { thumb: str(a.thumb, 120_000) } : {}),
    ...(str(a.imgKey, 64) !== undefined ? { imgKey: str(a.imgKey, 64) } : {}),
    // Chữ của tệp tải lên nằm trong lịch sử gửi mô hình (messages), không nhân đôi trong giao diện.
    ...(d && DOC_KINDS.includes(d.kind as DocKind)
      ? { doc: { kind: d.kind as DocKind, ...(num(d.pages) !== undefined ? { pages: num(d.pages) } : {}), ...(num(d.sheets) !== undefined ? { sheets: num(d.sheets) } : {}), ...(num(d.rows) !== undefined ? { rows: num(d.rows) } : {}), ...(d.truncated === true ? { truncated: true } : {}), ...(num(d.totalChars) !== undefined ? { totalChars: num(d.totalChars) } : {}) } }
      : {}),
  };
}

/** Giao diện chỉ cần các trường tối thiểu để dựng được; khối công cụ còn "đang chạy/chờ duyệt" thành "đã huỷ" (sau khôi phục không còn tác vụ nào chạy). */
function sanitizeTranscript(v: unknown): TItem[] {
  if (!Array.isArray(v)) return [];
  const out: TItem[] = [];
  for (const t of v.slice(0, MAX_MESSAGES)) {
    if (!isObj(t) || typeof t.id !== 'string') continue;
    if (t.kind === 'user' && typeof t.text === 'string') {
      out.push({ kind: 'user', id: t.id.slice(0, 80), text: t.text.slice(0, MAX_BLOCK_CHARS), ts: tsNum(t.ts) ?? 0, ...(t.steer === true ? { steer: true } : {}), attachments: (Array.isArray(t.attachments) ? t.attachments.slice(0, 30) : []).map(sanitizeAttachment).filter((a): a is AttachmentInfo => a !== null) });
    } else if (t.kind === 'assistant' && Array.isArray(t.blocks)) {
      const blocks = t.blocks
        .filter((b): b is Record<string, unknown> => isObj(b) && typeof b.type === 'string')
        .map((b) => (b.type === 'tool' && (b.state === 'running' || b.state === 'awaiting_permission') ? { ...b, state: 'cancelled', permission: undefined } : b));
      out.push({ ...(t as unknown as AssistantItem), ts: tsNum(t.ts) ?? 0, ...(t.endedAt !== undefined ? { endedAt: tsNum(t.endedAt) } : {}), blocks: blocks as unknown as AssistantItem['blocks'], done: true });
    } else if (t.kind === 'notice' && typeof t.text === 'string') {
      out.push({ kind: 'notice', id: t.id.slice(0, 80), level: t.level === 'warn' || t.level === 'error' ? t.level : 'info', text: t.text.slice(0, 20_000), ts: tsNum(t.ts) ?? 0 });
    }
  }
  return out;
}

function sanitizeArtifacts(v: unknown): Record<string, ArtifactRecord> {
  const out: Record<string, ArtifactRecord> = {};
  if (!isObj(v)) return out;
  for (const [id, a] of Object.entries(v).slice(0, 500)) {
    if (!SAFE_ID.test(id) || !isObj(a)) continue;
    const content = str(a.content, MAX_BLOCK_CHARS);
    if (content === undefined) continue;
    out[id] = { id, title: small(a.title), type: small(a.type, 40) || 'html', content, createdAt: num(a.createdAt) ?? 0, updatedAt: num(a.updatedAt) ?? 0, version: num(a.version) ?? 1 };
  }
  return out;
}

function sanitizeTodos(v: unknown): TodoItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).flatMap((t) => (isObj(t) && typeof t.title === 'string' ? [{ id: small(t.id, 80) || String(Math.random()), title: small(t.title, 500), status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending' } as TodoItem] : []));
}

/**
 * Chuẩn hoá một phiên đọc từ tệp sao lưu thành phiên hợp lệ của kho. Trả null khi không dùng được.
 * `workspaceKey`: khoá của kho đích (phiên khôi phục luôn thuộc kho hiện tại). Trường nhạy cảm bị đặt lại: `approvals` rỗng, `readFiles` rỗng,
 * chế độ 'bypass' → 'default', khối suy luận bỏ đi (`historyEdited`).
 */
export function sanitizeBackupSession(raw: unknown, workspaceKey: string): BackupSession | null {
  if (!isObj(raw) || !isObj(raw.session)) return null;
  const s = raw.session;
  const id = str(s.id, 80);
  if (!id || !SAFE_ID.test(id)) return null;
  const messages = (Array.isArray(s.messages) ? s.messages.slice(0, MAX_MESSAGES) : []).map(sanitizeMessage).filter((m): m is ChatMessage => m !== null);
  const transcript = sanitizeTranscript(raw.transcript);
  if (messages.length === 0 && transcript.length === 0) return null;
  const mode = (PERMISSION_MODES as readonly string[]).includes(s.mode as string) ? (s.mode as SessionState['mode']) : 'default';
  const scratch: Record<string, string> = {};
  if (isObj(s.scratchpad)) for (const [k, v] of Object.entries(s.scratchpad).slice(0, 200)) if (typeof v === 'string') scratch[k.slice(0, 200)] = v.slice(0, 2_000_000);
  const session = newSession({
    id,
    provider: small(s.provider, 100) || 'anthropic',
    model: small(s.model, 200),
    title: small(s.title) || 'Cuộc trò chuyện đã khôi phục',
    createdAt: num(s.createdAt) ?? Date.now(),
    updatedAt: num(s.updatedAt) ?? Date.now(),
    mode: mode === 'bypass' ? 'default' : mode,
    thinkingLevel: (THINKING_LEVELS as readonly string[]).includes(s.thinkingLevel as string) ? (s.thinkingLevel as SessionState['thinkingLevel']) : 'medium',
    messages,
    todos: sanitizeTodos(s.todos),
    scratchpad: scratch,
    loadedSkills: Array.isArray(s.loadedSkills) ? s.loadedSkills.filter((x): x is string => typeof x === 'string').slice(0, 100).map((x) => x.slice(0, 100)) : [],
    approvals: [],
    readFiles: {},
    artifacts: sanitizeArtifacts(s.artifacts),
    historyEdited: true,
    lastContextTokens: 0,
    ...contextStatsOf(s.contextStats), // (lane:ctx-compaction)
    usageTotals: { input: num((s.usageTotals as { input?: unknown } | undefined)?.input) ?? 0, output: num((s.usageTotals as { output?: unknown } | undefined)?.output) ?? 0 },
  });
  return { workspace: workspaceKey, session, transcript, ...(num(raw.deletedAt) !== undefined ? { deletedAt: num(raw.deletedAt) } : {}) };
}

export type ParsedBackup = { ok: true; sessions: BackupSession[]; skipped: number; exportedAt: number } | { ok: false; error: string };

/** Đọc nội dung một tệp sao lưu. Không bao giờ ném lỗi; `error` là thông điệp dùng thẳng cho người dùng. */
export function parseBackup(text: string, workspaceKey: string): ParsedBackup {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'Tệp trống.' };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: `Tệp quá lớn (tối đa ${MAX_BACKUP_BYTES / 1048576} MB).` };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'Không phải tệp sao lưu hợp lệ (không đọc được JSON).' };
  }
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, error: 'Đây không phải tệp sao lưu của trợ lý (sai định dạng).' };
  if (raw.version !== BACKUP_VERSION) return { ok: false, error: `Tệp sao lưu phiên bản ${String(raw.version)} chưa được hỗ trợ — hãy cập nhật tiện ích lên bản mới nhất.` };
  if (!Array.isArray(raw.sessions)) return { ok: false, error: 'Tệp sao lưu không có cuộc trò chuyện nào.' };
  const sessions: BackupSession[] = [];
  let skipped = 0;
  for (const entry of raw.sessions.slice(0, MAX_SESSIONS_PER_FILE)) {
    const s = sanitizeBackupSession(entry, workspaceKey);
    if (s) sessions.push(s);
    else skipped++;
  }
  skipped += Math.max(0, raw.sessions.length - MAX_SESSIONS_PER_FILE);
  if (sessions.length === 0) return { ok: false, error: skipped ? 'Không có cuộc trò chuyện nào dùng được trong tệp này.' : 'Tệp sao lưu không có cuộc trò chuyện nào.' };
  return { ok: true, sessions, skipped, exportedAt: num(raw.exportedAt) ?? 0 };
}
