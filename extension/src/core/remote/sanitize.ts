/**
 * Rút gọn trạng thái / sự kiện của khung chat trước khi gửi ra ngoài máy: bỏ ảnh thô, nội dung tệp tải lên, cài đặt, khoá; cắt các chuỗi dài
 * (kết quả công cụ, đối số, diff, suy luận). Thuần tuý, không import `vscode`.
 */

import type { ABlock, AgentProgress, AttachmentInfo, CompactInfo, ContextInfo, DiffInfo, PermissionRequest, QueuedInfo, SuggestionOption, TItem, TodoItem, ToolBlock, UiEvent, VerifyInfo, ViewState } from '../../shared/protocol';
import type { RemoteHostInfo, RemoteProvider, RemoteState } from './protocol';
import { REMOTE_API_VERSION } from './protocol';

/** Số mục transcript gửi trong snapshot (mục cũ hơn bị cắt, kèm `omitted`). */
export const MAX_ITEMS = 150;
const MAX_SESSIONS = 80;
const MAX_MODELS = 80;
const OUT_CAP = 2000;
const THINK_CAP = 4000;
const ARG_CAP = 600;
const DIFF_LINES_CAP = 160;
const THUMB_CAP = 24_000;

const cap = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}… [+${s.length - n}]`);
const capTail = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(s.length - n + 1)}`);

/** Đối số công cụ: chuỗi dài bị cắt, đối tượng/mảng chuyển thành JSON ngắn (ví dụ `write_file` mang cả nội dung tệp). */
export function capArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(args ?? {})) {
    if (++n > 24) break;
    if (typeof v === 'string') out[k] = cap(v, ARG_CAP);
    else if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else {
      let s: string;
      try {
        s = JSON.stringify(v) ?? '';
      } catch {
        s = String(v);
      }
      out[k] = cap(s, ARG_CAP);
    }
  }
  return out;
}

export function capDiff(d: DiffInfo): DiffInfo {
  let budget = DIFF_LINES_CAP;
  let truncated = d.truncated ?? false;
  const hunks: DiffInfo['hunks'] = [];
  for (const h of d.hunks) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let lines = h.lines;
    if (lines.length > budget) {
      lines = lines.slice(0, budget);
      truncated = true;
    }
    budget -= lines.length;
    hunks.push({ ...h, lines: lines.map((l) => ({ t: l.t, s: cap(l.s, 300) })) });
  }
  return { ...d, hunks, ...(truncated ? { truncated: true } : {}) };
}

function sanitizePermission(p: PermissionRequest): PermissionRequest {
  return {
    ...p,
    title: cap(p.title, 300),
    ...(p.detail ? { detail: cap(p.detail, 1000) } : {}),
    ...(p.command ? { command: cap(p.command, 2000) } : {}),
    ...(p.planMarkdown ? { planMarkdown: cap(p.planMarkdown, 20_000) } : {}),
    ...(p.diff ? { diff: capDiff(p.diff) } : {}),
  };
}

export type RemoteToolBlock = Omit<ToolBlock, 'images'> & { imageCount?: number };

const AGENT_ACTIVITY_CAP = 120;
const wholeNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1e12, Math.max(0, Math.floor(v))) : 0);
/** (lane:cc-timeline-ui) Số nguyên không âm hợp lệ, hoặc undefined để bỏ trường (không bịa 0 cho dấu thời gian). */
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1e13, Math.floor(v)) : undefined);

/** Tiến độ agent con: chỉ số nguyên không âm và một dòng chữ ngắn (dữ liệu từ máy khách/tệp sao lưu không được tin). */
export function sanitizeAgent(a: AgentProgress): AgentProgress {
  const failed = wholeNumber(a.failed);
  // eslint-disable-next-line no-control-regex
  const activity = typeof a.activity === 'string' ? a.activity.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return {
    tokens: wholeNumber(a.tokens),
    tools: wholeNumber(a.tools),
    ...(failed ? { failed } : {}),
    ...(activity ? { activity: activity.length > AGENT_ACTIVITY_CAP ? `${activity.slice(0, AGENT_ACTIVITY_CAP - 1)}…` : activity } : {}),
  };
}

const COMPACT_SUMMARY_CAP = 1500;

/** Số liệu nén ngữ cảnh gửi ra Remote: chỉ chế độ hợp lệ, số nguyên không âm và bản tóm tắt đã cắt (dữ liệu từ máy khách/tệp sao lưu không được tin). */
export function sanitizeCompact(c: CompactInfo): CompactInfo {
  const mode = c && (c.mode === 'auto' || c.mode === 'manual' || c.mode === 'overflow') ? c.mode : 'auto';
  const out: CompactInfo = { mode };
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? wholeNumber(v) : undefined);
  const freed = n(c?.tokensFreed);
  const sum = n(c?.summarizedMessages);
  const cleared = n(c?.clearedResults);
  if (freed !== undefined) out.tokensFreed = freed;
  if (sum !== undefined) out.summarizedMessages = sum;
  if (cleared !== undefined) out.clearedResults = cleared;
  if (typeof c?.summary === 'string' && c.summary) out.summary = cap(c.summary, COMPACT_SUMMARY_CAP);
  return out;
}

/** (lane:ctx-compaction) Thanh đo ngữ cảnh gửi ra Remote: chỉ các trường đã liệt kê, số nguyên không âm; trường tuỳ chọn chỉ gửi khi có. */
export function sanitizeContext(c: ContextInfo | null | undefined): ContextInfo | null {
  if (!c || typeof c !== 'object') return null;
  const out: ContextInfo = { usedTokens: wholeNumber(c.usedTokens), limitTokens: wholeNumber(c.limitTokens) };
  const opt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? wholeNumber(v) : undefined);
  const percent = opt(c.percent);
  const cleared = opt(c.clearedResults);
  const compactions = opt(c.compactions);
  if (percent !== undefined) out.percent = Math.min(999, percent);
  if (cleared !== undefined) out.clearedResults = cleared;
  if (compactions !== undefined) out.compactions = compactions;
  return out;
}

// ── (lane:blind-verifier) kết quả kiểm tra độc lập: chỉ trạng thái hợp lệ, số nguyên, danh sách và chữ đã cắt ──
const VERIFY_LIST_CAP = 12;
const VERIFY_ITEM_CAP = 400;
const VERIFY_STATES = new Set<VerifyInfo['state']>(['running', 'pass', 'fail', 'uncertain', 'skipped']);

export function sanitizeVerify(v: VerifyInfo): VerifyInfo {
  const list = (x: unknown): string[] | undefined => {
    if (!Array.isArray(x)) return undefined;
    const out = x.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, VERIFY_LIST_CAP).map((s) => cap(s.replace(/\s+/g, ' ').trim(), VERIFY_ITEM_CAP));
    return out.length ? out : undefined;
  };
  const out: VerifyInfo = {
    key: typeof v?.key === 'string' ? v.key.slice(0, 40) : 'v',
    state: v && VERIFY_STATES.has(v.state) ? v.state : 'skipped',
    round: Math.max(1, wholeNumber(v?.round) || 1),
    maxRounds: Math.max(1, wholeNumber(v?.maxRounds) || 1),
  };
  const missing = list(v?.missing);
  const defects = list(v?.defects);
  const unverified = list(v?.unverifiedClaims);
  if (missing) out.missing = missing;
  if (defects) out.defects = defects;
  if (unverified) out.unverifiedClaims = unverified;
  if (v?.outstanding === true) out.outstanding = true;
  if (typeof v?.reason === 'string' && v.reason) out.reason = cap(v.reason, VERIFY_ITEM_CAP);
  if (typeof v?.durationMs === 'number' && Number.isFinite(v.durationMs)) out.durationMs = wholeNumber(v.durationMs);
  if (typeof v?.model === 'string' && v.model) out.model = cap(v.model, 80);
  if (typeof v?.tokens === 'number' && Number.isFinite(v.tokens)) out.tokens = wholeNumber(v.tokens);
  return out;
}

function sanitizeTool(b: ToolBlock): RemoteToolBlock {
  const { images, agent, ...rest } = b;
  return {
    ...rest,
    ...(agent && typeof agent === 'object' ? { agent: sanitizeAgent(agent) } : {}),
    args: capArgs(b.args),
    ...(b.output !== undefined ? { output: capTail(b.output, OUT_CAP) } : {}),
    ...(b.diff ? { diff: capDiff(b.diff) } : {}),
    ...(b.permission ? { permission: sanitizePermission(b.permission) } : {}),
    ...(images && images.length ? { imageCount: images.length } : {}),
  };
}

export function sanitizeAttachment(a: AttachmentInfo): AttachmentInfo {
  const { data: _data, doc, thumb, ...rest } = a;
  void _data;
  return {
    ...rest,
    ...(thumb && thumb.length <= THUMB_CAP ? { thumb } : {}),
    ...(doc ? { doc: { kind: doc.kind, ...(doc.pages !== undefined ? { pages: doc.pages } : {}), ...(doc.sheets !== undefined ? { sheets: doc.sheets } : {}), ...(doc.rows !== undefined ? { rows: doc.rows } : {}), ...(doc.truncated ? { truncated: true } : {}), ...(doc.totalChars !== undefined ? { totalChars: doc.totalChars } : {}) } } : {}),
  };
}

function sanitizeBlock(b: ABlock): ABlock {
  switch (b.type) {
    case 'tool':
      return sanitizeTool(b) as unknown as ABlock;
    case 'thinking': {
      // (lane:cc-timeline-ui) mốc/thời lượng suy nghĩ là số nguyên không âm; giá trị lạ bị bỏ (trang Remote cũ không có trường này vẫn chạy).
      const { startedAt, durationMs, ...rest } = b;
      const timing = { ...(whole(startedAt) !== undefined ? { startedAt: whole(startedAt) } : {}), ...(whole(durationMs) !== undefined ? { durationMs: whole(durationMs) } : {}) };
      return { ...rest, ...timing, text: b.text.length > THINK_CAP ? capTail(b.text, THINK_CAP) : b.text };
    }
    case 'notice':
      return b.compact || b.verify ? { ...b, ...(b.compact ? { compact: sanitizeCompact(b.compact) } : {}), ...(b.verify ? { verify: sanitizeVerify(b.verify) } : {}) } : b;
    default:
      return b;
  }
}

export function sanitizeItem(it: TItem): TItem {
  if (it.kind === 'user') return { ...it, attachments: it.attachments.map(sanitizeAttachment) };
  if (it.kind === 'assistant') return { ...it, blocks: it.blocks.map(sanitizeBlock) };
  if (it.kind === 'notice' && (it.compact || it.verify)) return { ...it, ...(it.compact ? { compact: sanitizeCompact(it.compact) } : {}), ...(it.verify ? { verify: sanitizeVerify(it.verify) } : {}) };
  return it;
}

export function sanitizeTranscript(items: readonly TItem[]): { transcript: TItem[]; omitted: number } {
  const omitted = Math.max(0, items.length - MAX_ITEMS);
  return { transcript: items.slice(omitted).map(sanitizeItem), omitted };
}

/**
 * (lane:loop-guards) Danh sách việc gửi ra Remote: trạng thái 'blocked' là MỚI — trang locaith.ai (có thể là bản cũ đã lưu đệm) chỉ biết
 * pending / in_progress / completed, nên hạ cấp về 'pending' và đưa lý do vào tiêu đề để người dùng vẫn thấy; `note` được cắt.
 */
export function sanitizeTodos(todos: readonly TodoItem[] | undefined): TodoItem[] {
  return (todos ?? []).slice(0, 200).map((x) => {
    if (x.status !== 'blocked') return { id: x.id, title: cap(x.title, 500), status: x.status };
    const note = typeof x.note === 'string' && x.note ? cap(x.note, 200) : '';
    return { id: x.id, title: cap(`${x.title}${note ? ` — ${note}` : ''}`, 500), status: 'pending' };
  });
}

function sanitizeQueued(q: readonly QueuedInfo[] | undefined): QueuedInfo[] {
  return (q ?? []).map((m) => ({ ...m, attachments: m.attachments.map(sanitizeAttachment) }));
}

const MAX_OPTIONS = 6;
const OPTION_LABEL_CAP = 60;
const OPTION_PROMPT_CAP = 2000;
const OPTION_DETAIL_CAP = 160;

/** (lane:output-timeouts) Nút lựa chọn gửi ra Remote: tối đa 6 nút, chuỗi cắt gọn, chỉ giữ `kind` hợp lệ. */
export function sanitizeOptions(list: readonly SuggestionOption[] | undefined): SuggestionOption[] {
  return (list ?? [])
    .filter((o) => o && typeof o.id === 'string' && typeof o.label === 'string' && typeof o.prompt === 'string')
    .slice(0, MAX_OPTIONS)
    .map((o) => ({
      id: o.id.slice(0, 80),
      label: cap(o.label, OPTION_LABEL_CAP),
      prompt: cap(o.prompt, OPTION_PROMPT_CAP),
      ...(o.detail ? { detail: cap(o.detail, OPTION_DETAIL_CAP) } : {}),
      ...(o.kind === 'continue' ? { kind: 'continue' as const } : {}),
    }));
}

export function remoteProviders(list: ViewState['providers'] | undefined, currentId: string): RemoteProvider[] {
  return (list ?? [])
    .filter((p) => p.hasKey || p.id === currentId)
    .map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models.slice(0, MAX_MODELS).map((m) => ({ id: m.id, label: m.label, ...(m.tier ? { tier: m.tier } : {}) })),
    }));
}

export function toRemoteState(view: ViewState, host: RemoteHostInfo, opts: { canBypass: boolean }): RemoteState {
  const { transcript, omitted } = sanitizeTranscript(view.transcript);
  return {
    v: REMOTE_API_VERSION,
    host,
    sessionId: view.sessionId,
    title: view.title,
    transcript,
    omitted,
    todos: sanitizeTodos(view.todos),
    running: view.running,
    queued: sanitizeQueued(view.queued),
    provider: view.provider,
    model: view.model,
    mode: view.mode,
    thinkingLevel: view.thinkingLevel,
    swarm: view.swarm === true || view.thinkingLevel === 'swarm',
    providers: remoteProviders(view.providers, view.provider),
    sessions: (view.sessions ?? []).slice(0, MAX_SESSIONS),
    context: sanitizeContext(view.context),
    allowBypass: view.allowBypass,
    remoteCanBypass: opts.canBypass,
    ...(view.options?.length ? { options: sanitizeOptions(view.options) } : {}),
  };
}

/** Lọc một bản vá `ViewState` của webview thành bản vá cho máy khách từ xa; `null` nếu không có trường nào máy khách cần. */
export function sanitizePatch(p: Partial<ViewState>): Partial<Omit<RemoteState, 'v' | 'host'>> | null {
  const out: Partial<Omit<RemoteState, 'v' | 'host'>> = {};
  if (p.sessionId !== undefined) out.sessionId = p.sessionId;
  if (p.title !== undefined) out.title = p.title;
  if (p.todos !== undefined) out.todos = sanitizeTodos(p.todos);
  if (p.running !== undefined) out.running = p.running;
  if (p.queued !== undefined) out.queued = sanitizeQueued(p.queued);
  if (p.provider !== undefined) out.provider = p.provider;
  if (p.model !== undefined) out.model = p.model;
  if (p.mode !== undefined) out.mode = p.mode;
  if (p.thinkingLevel !== undefined) out.thinkingLevel = p.thinkingLevel;
  if (p.swarm !== undefined) out.swarm = p.swarm;
  if (p.providers !== undefined) out.providers = remoteProviders(p.providers, p.provider ?? '');
  if (p.sessions !== undefined) out.sessions = p.sessions.slice(0, MAX_SESSIONS);
  if (p.context !== undefined) out.context = sanitizeContext(p.context);
  if (p.allowBypass !== undefined) out.allowBypass = p.allowBypass;
  if (p.transcript !== undefined) Object.assign(out, sanitizeTranscript(p.transcript));
  if (p.options !== undefined) out.options = sanitizeOptions(p.options); // (lane:output-timeouts) rỗng = thu hồi nút
  return Object.keys(out).length ? out : null;
}

export function sanitizeEvent(ev: UiEvent): UiEvent {
  switch (ev.t) {
    case 'user':
      return { ...ev, attachments: ev.attachments.map(sanitizeAttachment) };
    case 'tool_start':
      return { ...ev, args: capArgs(ev.args) };
    case 'tool_progress':
      return ev.output.length > 4000 ? { ...ev, output: capTail(ev.output, 4000) } : ev;
    case 'thinking': {
      // (lane:cc-timeline-ui) giữ `ts` nếu là số hợp lệ, bỏ nếu lạ; không có ts thì trả nguyên sự kiện.
      if (ev.ts === undefined) return ev;
      const ts = whole(ev.ts);
      if (ts === ev.ts) return ev;
      const { ts: _drop, ...rest } = ev;
      void _drop;
      return ts === undefined ? rest : { ...rest, ts };
    }
    case 'agent_progress':
      return { ...ev, ...sanitizeAgent(ev) };
    case 'tool_permission':
      return { ...ev, request: sanitizePermission(ev.request) };
    case 'notice':
      return ev.compact || ev.verify ? { ...ev, ...(ev.compact ? { compact: sanitizeCompact(ev.compact) } : {}), ...(ev.verify ? { verify: sanitizeVerify(ev.verify) } : {}) } : ev;
    case 'options':
      return { ...ev, options: sanitizeOptions(ev.options) }; // (lane:output-timeouts)
    case 'text':
      // (lane:output-timeouts) `trimTail` phải là số nguyên không âm (bản cũ bỏ qua trường này).
      return ev.trimTail !== undefined ? { ...ev, trimTail: wholeNumber(ev.trimTail) } : ev;
    // (lane:loop-guards) trạng thái 'blocked' hạ cấp cho máy khách cũ
    case 'tasks':
      return { ...ev, todos: sanitizeTodos(ev.todos) };
    case 'todos':
      return { ...ev, todos: sanitizeTodos(ev.todos) };
    case 'tool_end': {
      const { images, ...rest } = ev;
      return {
        ...rest,
        ...(ev.output !== undefined ? { output: capTail(ev.output, OUT_CAP) } : {}),
        ...(ev.diff ? { diff: capDiff(ev.diff) } : {}),
        ...(images && images.length ? { imageCount: images.length } : {}),
      } as UiEvent;
    }
    default:
      return ev;
  }
}

/**
 * Lọc + rút gọn một loạt sự kiện trước khi gửi máy khách từ xa. `agent_progress` bị BỎ: máy khách Remote (trang locaith.ai, có thể là bản cũ đã được
 * lưu đệm) áp sự kiện bằng một bộ giảm trạng thái có `switch` kín — gặp loại sự kiện lạ nó trả về `undefined` và làm hỏng cả transcript. Số liệu agent
 * vẫn tới máy khách qua ảnh chụp trạng thái (`toRemoteState`) vì khối công cụ mang trường `agent` đã được làm sạch.
 */
export function sanitizeEvents(events: readonly UiEvent[]): UiEvent[] {
  return events.filter((e) => e.t !== 'agent_progress').map(sanitizeEvent);
}
