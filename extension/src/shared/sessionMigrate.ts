/**
 * Nâng cấp trạng thái phiên khi đọc từ kho lưu trữ.
 *
 * Vì sao cần: `SessionState` được lưu NGUYÊN khối JSON. Không có bước chuẩn hoá thì một cuộc trò chuyện
 * tạo bằng bản cũ sẽ mang mãi hình dạng cũ — trường thêm sau này là `undefined`, giá trị mặc định của bản mới
 * không bao giờ tới được phiên cũ, và khối suy luận đã ký dưới một system prompt cũ vẫn nằm trong lịch sử.
 * Người dùng chỉ thấy thay đổi của bản mới khi mở một cuộc trò chuyện MỚI.
 *
 * Nguyên tắc:
 *  - Chỉ điền/chuẩn hoá TRƯỜNG BAO QUANH; nội dung tin nhắn giữ nguyên (trừ tin nhắc tổng hợp của bản cũ).
 *  - Không bao giờ đụng tới lựa chọn của người dùng (provider/model/mode/thinking) trừ khi giá trị không còn hợp lệ.
 *  - Đổi phiên bản ứng dụng = system prompt + bộ công cụ có thể đã đổi → bỏ dấu vân tay cũ và đánh dấu lịch sử đã sửa,
 *    để khối suy luận cũ không bị gửi lại kèm một tiền tố khác (Anthropic từ chối) và lượt kế tiếp tự sinh suy luận mới.
 *
 * Hàm thuần, không phụ thuộc môi trường → dùng chung cho VS Code, trình duyệt và CLI, và test được.
 */

import type { ContentBlock, ChatMessage } from '../core/types';
import { newSession, type ArtifactRecord, type SessionState } from '../core/engine/types';
import { PERMISSION_MODES, THINKING_LEVELS, type SuggestionOption, type TodoItem } from './protocol';

/** Phiên bản hình dạng phiên. Tăng khi cách hiểu một trường đổi nghĩa (không chỉ khi thêm trường). */
export const SESSION_SCHEMA = 2;

/** Thẻ mở đầu tin tổng hợp sau khi nén — tin tổng hợp DUY NHẤT được giữ lại khi dọn tin nhắc cũ. */
const SUMMARY_TAG = '<tom_tat_hoi_thoai_truoc_do>';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown, maxItems = 200, maxLen = 200): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];
const strRecord = (v: unknown, maxItems = 500, maxLen = 2_000_000): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, maxItems)) if (typeof val === 'string') out[k.slice(0, 200)] = val.slice(0, maxLen);
  return out;
};

function sanitizeTodos(v: unknown): TodoItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).flatMap((t) =>
    isObj(t) && typeof t.title === 'string'
      ? [{ id: text(t.id, 80) || `t${Math.random().toString(36).slice(2, 8)}`, title: t.title.slice(0, 500), status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending' } as TodoItem]
      : [],
  );
}

function sanitizeOptions(v: unknown): SuggestionOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SuggestionOption[] = [];
  for (const [i, o] of v.slice(0, 4).entries()) {
    if (!isObj(o)) continue;
    const label = text(o.label, 80)?.trim();
    const prompt = text(o.prompt, 600)?.trim();
    if (!label || !prompt) continue;
    const detail = text(o.detail, 160)?.trim();
    out.push({ id: text(o.id, 40) || `o${i + 1}`, label, prompt, ...(detail ? { detail } : {}) });
  }
  return out.length ? out : undefined;
}

function sanitizeArtifacts(v: unknown): Record<string, ArtifactRecord> {
  const out: Record<string, ArtifactRecord> = {};
  if (!isObj(v)) return out;
  for (const [id, a] of Object.entries(v).slice(0, 500)) {
    if (!/^[\w-]{1,80}$/.test(id) || !isObj(a)) continue;
    const content = text(a.content, 20_000_000);
    if (content === undefined) continue;
    out[id] = {
      id,
      title: text(a.title, 200) ?? '',
      type: text(a.type, 40) ?? 'html',
      content,
      createdAt: num(a.createdAt) ?? 0,
      updatedAt: num(a.updatedAt) ?? 0,
      version: num(a.version) ?? 1,
    };
  }
  return out;
}

/** Giữ nguyên nội dung khối (kể cả `thinking` — chỉ bản thân engine được phép xoá), chỉ bỏ khối không đọc được. */
function keepBlocks(v: unknown): ContentBlock[] {
  if (!Array.isArray(v)) return [];
  return v.filter((b): b is ContentBlock => isObj(b) && typeof b.type === 'string' && ['text', 'image', 'thinking', 'tool_use', 'tool_result'].includes(b.type));
}

function sanitizeMessages(v: unknown): ChatMessage[] {
  if (!Array.isArray(v)) return [];
  const out: ChatMessage[] = [];
  for (const m of v.slice(0, 20_000)) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = keepBlocks(m.content);
    if (content.length === 0) continue;
    out.push({
      role: m.role,
      content,
      ...(m.role === 'assistant' ? { provider: text(m.provider, 100), model: text(m.model, 200) } : {}),
      ...(m.synthetic === true ? { synthetic: true } : {}),
      ...(num(m.ts) !== undefined ? { ts: num(m.ts) } : {}),
    });
  }
  return out;
}

/** Chữ của một tin nhắn (để nhận ra tin nhắc tổng hợp). */
function textOf(m: ChatMessage): string {
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/**
 * Bỏ các tin nhắc TỔNG HỢP do harness chèn ở bản cũ (nhắc todo, "viết tiếp", "hết vòng lặp"…).
 * Chúng không phải lời người dùng, không hiện trên giao diện, nhưng vẫn được gửi lại mô hình ở mọi lượt sau —
 * giữ lại thì phiên cũ tiếp tục bị điều khiển bằng câu chữ của bản cũ. Tin tổng hợp sau khi nén được GIỮ.
 * Tin tổng hợp mang `tool_result` (kết quả "đã huỷ" mà engine vá cho lệnh mồ côi sau khi Dừng) cũng được GIỮ: nó là một nửa cặp
 * tool_use/tool_result chứ không phải lời nhắc — xoá nó làm lệnh mồ côi sống lại ở lần mở phiên sau.
 */
function dropLegacyNudges(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => {
    if (m.role !== 'user' || m.synthetic !== true) return true;
    if (m.content.some((b) => b.type === 'tool_result')) return true;
    return textOf(m).includes(SUMMARY_TAG); // giữ tin tổng hợp sau khi nén, bỏ mọi tin nhắc
  });
}

export interface MigrateOptions {
  /** Phiên bản ứng dụng đã GHI tệp này (không biết = tệp của bản cũ). */
  storedAppVersion?: string;
  /** Phiên bản ứng dụng đang chạy. */
  appVersion?: string;
  /** Mặc định cho trường thiếu (mode/thinking của phiên mới). Không truyền = giữ mặc định của engine. */
  defaults?: { mode?: SessionState['mode']; thinkingLevel?: SessionState['thinkingLevel'] };
}

export interface MigrateResult {
  session: SessionState;
  /** Có ít nhất một trường bị thay đổi so với dữ liệu đọc từ đĩa. */
  changed: boolean;
  /** Phiên được ghi bởi bản ứng dụng KHÁC bản đang chạy. */
  fromOtherVersion: boolean;
  /** Số tin nhắc tổng hợp của bản cũ đã bỏ. */
  droppedNudges: number;
  /** Số trường mới được điền mặc định (trường thiếu trong tệp cũ). */
  filledFields: number;
}

/** Phiên không dùng được (không phải object, thiếu id) → null. */
export function migrateSession(raw: unknown, o: MigrateOptions = {}): MigrateResult | null {
  if (!isObj(raw)) return null;
  const id = text(raw.id, 80);
  if (!id || !/^[\w-]+$/.test(id)) return null;

  const mode = (PERMISSION_MODES as readonly string[]).includes(raw.mode as string) ? (raw.mode as SessionState['mode']) : (o.defaults?.mode ?? 'default');
  const level = (THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel as string) ? (raw.thinkingLevel as SessionState['thinkingLevel']) : (o.defaults?.thinkingLevel ?? 'medium');

  const messages = sanitizeMessages(raw.messages);
  const cleaned = dropLegacyNudges(messages);

  const fromOtherVersion = !!o.appVersion && o.storedAppVersion !== o.appVersion;

  // Trường mới mà bản cũ chưa có → đếm để báo cho người dùng biết phiên đã được nâng cấp.
  let filledFields = 0;
  for (const key of ['todos', 'scratchpad', 'loadedSkills', 'approvals', 'readFiles', 'artifacts', 'usageTotals', 'lastContextTokens'] as const) {
    if (raw[key] === undefined) filledFields++;
  }
  if (raw.swarm === undefined && raw.thinkingLevel === 'swarm') filledFields++;

  // 'swarm' từng là một mức suy luận; nay là cờ riêng + mức 'max' (engine vẫn đọc được cả hai kiểu).
  const swarm = raw.swarm === true || raw.thinkingLevel === 'swarm';
  const thinkingLevel: SessionState['thinkingLevel'] = raw.thinkingLevel === 'swarm' ? 'max' : level;

  const base = newSession({
    id,
    provider: text(raw.provider, 100) || 'anthropic',
    model: text(raw.model, 200) ?? '',
    title: text(raw.title, 200) || 'Cuộc trò chuyện',
    createdAt: num(raw.createdAt) ?? Date.now(),
    updatedAt: num(raw.updatedAt) ?? Date.now(),
    mode,
    thinkingLevel,
    ...(swarm ? { swarm: true } : {}),
    messages: cleaned,
    todos: sanitizeTodos(raw.todos),
    ...(sanitizeOptions(raw.options) ? { options: sanitizeOptions(raw.options) } : {}),
    scratchpad: strRecord(raw.scratchpad, 200),
    loadedSkills: strList(raw.loadedSkills, 100, 100),
    approvals: strList(raw.approvals, 500, 300),
    readFiles: strRecord(raw.readFiles, 2000, 200),
    artifacts: sanitizeArtifacts(raw.artifacts),
    historyEdited: raw.historyEdited === true,
    lastContextTokens: num(raw.lastContextTokens) ?? 0,
    usageTotals: {
      input: num((raw.usageTotals as { input?: unknown } | undefined)?.input) ?? 0,
      output: num((raw.usageTotals as { output?: unknown } | undefined)?.output) ?? 0,
    },
  });
  const fingerprint = text(raw.promptFingerprint, 200);
  if (fingerprint && !fromOtherVersion) base.promptFingerprint = fingerprint;

  // Bản mới = system prompt + bộ công cụ mới. Khối suy luận đã ký dưới tiền tố cũ không còn hợp lệ:
  // bỏ vân tay (lượt sau tự tính lại) và đánh dấu lịch sử đã sửa để adapter không gửi lại chúng.
  if (fromOtherVersion) base.historyEdited = true;

  const changed =
    fromOtherVersion ||
    cleaned.length !== messages.length ||
    filledFields > 0 ||
    base.swarm !== raw.swarm ||
    base.thinkingLevel !== raw.thinkingLevel ||
    base.mode !== raw.mode;

  return { session: base, changed, fromOtherVersion, droppedNudges: messages.length - cleaned.length, filledFields };
}
