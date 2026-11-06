/**
 * Giao thức "Điều khiển từ xa" (Remote): extension mở một máy chủ HTTP cục bộ, một trang web đã ghép đôi (ví dụ tab Remote trên
 * locaith.ai) xem được hội thoại của khung chat VS Code theo thời gian thực và gửi lệnh về.
 *
 * Không import `vscode` — dùng chung cho máy chủ (core/remote/server.ts), phần nối với ChatController (host/remote.ts) và kiểm thử.
 * Trang web giữ một bản sao các kiểu này (locaith-ai-v2/src/screens/remote/remoteTypes.ts); đổi ở đây thì đổi cả bên đó và tăng REMOTE_API_VERSION.
 *
 * Nguyên tắc: host là nguồn sự thật. Máy khách nhận `snapshot` (ảnh chụp đầy đủ) rồi các `events` tăng dần — cùng kiểu `UiEvent` mà
 * webview trong VS Code dùng, nên áp bằng cùng một reducer (shared/transcript.ts). Mất kết nối thì xin lại từ `seq` đã nhận; quá cũ thì nhận snapshot mới.
 */

import type { AttachmentInfo, PermissionMode, QueuedInfo, SessionSummary, ThinkingLevel, TItem, TodoItem, UiEvent, WebviewMessage } from '../../shared/protocol';
import { PERMISSION_MODES, THINKING_LEVELS } from '../../shared/protocol';

export const REMOTE_API_VERSION = 1;
/** Cổng thử lần lượt (cửa sổ VS Code thứ hai tự lấy cổng kế tiếp). Trang web dò đúng dải này. */
export const REMOTE_PORTS: readonly number[] = [47630, 47631, 47632, 47633, 47634, 47635, 47636, 47637, 47638, 47639];

export interface RemoteHostInfo {
  /** Tên máy (hostname). */
  name: string;
  /** Tên thư mục làm việc đang mở trong cửa sổ VS Code này (nếu có). */
  workspace?: string;
  vscode: string;
  ext: string;
  platform: string;
}

export interface RemoteModel {
  id: string;
  label: string;
  tier?: 'top' | 'balanced' | 'fast';
}

export interface RemoteProvider {
  id: string;
  label: string;
  models: RemoteModel[];
}

/** Ảnh chụp trạng thái hội thoại, đã rút gọn cho đường truyền (không có ảnh thô, tệp đính kèm thô, cài đặt, khoá). */
export interface RemoteState {
  v: typeof REMOTE_API_VERSION;
  host: RemoteHostInfo;
  sessionId: string;
  title: string;
  transcript: TItem[];
  /** Số mục cũ hơn đã bị cắt khỏi `transcript` để nhẹ đường truyền. */
  omitted: number;
  todos: TodoItem[];
  running: boolean;
  queued: QueuedInfo[];
  provider: string;
  model: string;
  mode: PermissionMode;
  thinkingLevel: ThinkingLevel;
  swarm?: boolean;
  providers: RemoteProvider[];
  sessions: SessionSummary[];
  context: { usedTokens: number; limitTokens: number } | null;
  /** Người dùng đã bật chế độ "bỏ qua mọi xác nhận" trong cài đặt VS Code (chỉ để hiển thị cảnh báo). */
  allowBypass: boolean;
  /** Trang từ xa có được phép tự chuyển sang chế độ bypass không (mặc định không). */
  remoteCanBypass: boolean;
}

export type RemoteStreamMsg =
  | { type: 'snapshot'; seq: number; state: RemoteState }
  | { type: 'events'; seq: number; events: UiEvent[] }
  | { type: 'patch'; seq: number; patch: Partial<Omit<RemoteState, 'v' | 'host'>> }
  | { type: 'toast'; seq: number; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'image'; seq: number; key: string; mediaType: string; data: string }
  /** Báo máy khách vừa nối lại và nhận bù từ `from` (không cần snapshot mới). */
  | { type: 'resume'; seq: number; from: number }
  | { type: 'bye'; seq: number; reason: string };

/** Các lệnh trang từ xa được phép gửi — tập con của WebviewMessage. Mọi thứ khác (xoá lịch sử, khoá API, MCP, mở tệp…) chỉ làm được trong VS Code. */
export type RemoteCommand = Extract<
  WebviewMessage,
  { type: 'send' | 'stop' | 'retry' | 'compact' | 'new_session' | 'load_session' | 'rename_session' | 'queue_remove' | 'set_model' | 'set_mode' | 'set_thinking' | 'set_swarm' | 'permission_response' | 'get_image' }
>;

export const MAX_TEXT_CHARS = 50_000;
export const MAX_IMAGES = 4;
/** Độ dài tối đa của chuỗi base64 một ảnh (~1,5 MB nhị phân). Trang web tự thu nhỏ ảnh trước khi gửi. */
export const MAX_IMAGE_B64 = 2_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ID = /^[\w.:\-]{1,200}$/;

export type ParseResult = { ok: true; cmd: RemoteCommand } | { ok: false; error: string };

const bad = (error: string): ParseResult => ({ ok: false, error });

/** Kiểm tra và chuẩn hoá một lệnh từ xa. Không tin bất cứ trường nào: kiểu, độ dài, giá trị đều được kiểm. */
export function parseCommand(raw: unknown, opts: { canBypass: boolean }): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('bad_request');
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case 'send': {
      const text = typeof o.text === 'string' ? o.text : '';
      if (text.length > MAX_TEXT_CHARS) return bad('text_too_long');
      const list = o.attachments === undefined ? [] : o.attachments;
      if (!Array.isArray(list) || list.length > MAX_IMAGES) return bad('too_many_attachments');
      const attachments: AttachmentInfo[] = [];
      for (const a of list) {
        if (!a || typeof a !== 'object') return bad('bad_attachment');
        const x = a as Record<string, unknown>;
        if (x.kind !== 'image' || typeof x.mediaType !== 'string' || !IMAGE_TYPES.has(x.mediaType)) return bad('bad_attachment');
        if (typeof x.data !== 'string' || x.data.length === 0 || x.data.length > MAX_IMAGE_B64 || !B64.test(x.data)) return bad('bad_attachment');
        const label = typeof x.label === 'string' ? x.label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : 'image';
        attachments.push({ kind: 'image', label: label || 'image', mediaType: x.mediaType, data: x.data });
      }
      if (!text.trim() && attachments.length === 0) return bad('empty');
      return { ok: true, cmd: { type: 'send', text, attachments } };
    }
    case 'stop':
    case 'retry':
    case 'compact':
    case 'new_session':
      return { ok: true, cmd: { type: o.type } };
    case 'load_session': {
      if (typeof o.id !== 'string' || !ID.test(o.id)) return bad('bad_id');
      return { ok: true, cmd: { type: 'load_session', id: o.id } };
    }
    case 'rename_session': {
      if (typeof o.id !== 'string' || !ID.test(o.id)) return bad('bad_id');
      const title = typeof o.title === 'string' ? o.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
      if (!title) return bad('bad_title');
      return { ok: true, cmd: { type: 'rename_session', id: o.id, title } };
    }
    case 'queue_remove': {
      if (typeof o.id !== 'string' || !ID.test(o.id)) return bad('bad_id');
      // `edit: true` đẩy nội dung về ô nhập của khung chat trong VS Code — không dành cho máy khách từ xa.
      return { ok: true, cmd: { type: 'queue_remove', id: o.id, edit: false } };
    }
    case 'set_model': {
      if (typeof o.provider !== 'string' || !ID.test(o.provider) || typeof o.model !== 'string' || o.model.length === 0 || o.model.length > 200) return bad('bad_model');
      return { ok: true, cmd: { type: 'set_model', provider: o.provider, model: o.model } };
    }
    case 'set_mode': {
      if (typeof o.mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(o.mode)) return bad('bad_mode');
      if (o.mode === 'bypass' && !opts.canBypass) return bad('bypass_not_allowed');
      return { ok: true, cmd: { type: 'set_mode', mode: o.mode as PermissionMode } };
    }
    case 'set_swarm':
      if (typeof o.on !== 'boolean') return bad('bad_swarm');
      return { ok: true, cmd: { type: 'set_swarm', on: o.on } };
    case 'set_thinking': {
      if (typeof o.level !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(o.level)) return bad('bad_level');
      return { ok: true, cmd: { type: 'set_thinking', level: o.level as ThinkingLevel } };
    }
    case 'permission_response': {
      if (typeof o.id !== 'string' || !ID.test(o.id)) return bad('bad_id');
      if (o.decision !== 'allow' && o.decision !== 'allow_session' && o.decision !== 'deny') return bad('bad_decision');
      const feedback = typeof o.feedback === 'string' && o.feedback.trim() ? o.feedback.slice(0, 2000) : undefined;
      return { ok: true, cmd: { type: 'permission_response', id: o.id, decision: o.decision, ...(feedback ? { feedback } : {}) } };
    }
    case 'get_image': {
      if (typeof o.key !== 'string' || o.key.length === 0 || o.key.length > 200) return bad('bad_key');
      return { ok: true, cmd: { type: 'get_image', key: o.key } };
    }
    default:
      return bad('unknown_command');
  }
}
