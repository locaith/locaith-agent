/**
 * Reducer dùng chung cho host và webview: biến luồng `UiEvent` thành transcript để hiển thị/lưu.
 * Thuần tuý, bất biến (không sửa mảng đầu vào), không phụ thuộc môi trường chạy.
 */

import type { ABlock, AgentProgress, AssistantItem, NoticeItem, TItem, ToolBlock, UiEvent, ViewState } from './protocol';
import { UI_TOOL_OUTPUT_LIMIT } from './protocol';

function findLastIndex<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function capTail(text: string, limit: number): string {
  return text.length <= limit ? text : '…' + text.slice(text.length - limit + 1);
}

/**
 * Chuyển mọi dòng trạng thái đang chạy sang trạng thái xong (chấm cam → chấm xám).
 * Dòng kind='working' là chỉ báo tạm ("Đang suy nghĩ…" khi chờ token đầu, "thử lại sau 4 giây…")
 * nên bị gỡ hẳn khi có nội dung thật thay thế, thay vì để lại một dòng xám thừa.
 */
function deactivatePills(blocks: ABlock[]): ABlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'pill' && b.active) {
      if (b.kind === 'working') blocks.splice(i, 1);
      else blocks[i] = { ...b, active: false };
    }
  }
  return blocks;
}

function updateAssistant(
  items: readonly TItem[],
  id: string,
  fn: (item: AssistantItem) => AssistantItem,
): TItem[] {
  const idx = findLastIndex(items, (it) => it.kind === 'assistant' && it.id === id);
  if (idx < 0) return items as TItem[];
  const prev = items[idx] as AssistantItem;
  const next = fn(prev);
  if (next === prev) return items as TItem[];
  const copy = items.slice();
  copy[idx] = next;
  return copy;
}

function blockId(a: AssistantItem, blocks: ABlock[], tag: string): string {
  return `${a.id}:${tag}${blocks.length}`;
}

function appendStreamText(a: AssistantItem, type: 'text' | 'thinking', delta: string, clearPills: boolean, ts?: number): AssistantItem {
  if (!delta) return a;
  const blocks = a.blocks.slice();
  if (clearPills) deactivatePills(blocks);
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    blocks[blocks.length - 1] = { ...last, text: last.text + delta, ...thinkingTiming(last, ts) };
  } else {
    blocks.push({ type, id: blockId(a, blocks, type === 'text' ? 't' : 'k'), text: delta, ...thinkingTiming(undefined, ts) });
  }
  return { ...a, blocks };
}

/**
 * (lane:cc-timeline-ui) Thời lượng suy nghĩ từ dấu thời gian của từng delta: khối mới lấy `startedAt` = ts delta đầu; mỗi delta sau
 * cập nhật `durationMs` = ts − startedAt. Không có ts (phiên cũ, nhà cung cấp không đóng dấu) → không thêm trường nào.
 */
function thinkingTiming(prev: ABlock | undefined, ts: number | undefined): { startedAt?: number; durationMs?: number } {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return {};
  if (!prev || prev.type !== 'thinking') return { startedAt: ts };
  const start = prev.startedAt;
  if (typeof start !== 'number' || !Number.isFinite(start) || start <= 0) return { startedAt: ts };
  return { startedAt: start, durationMs: Math.max(0, ts - start) };
}

/** (lane:output-timeouts) Bỏ `n` ký tự cuối của khối văn bản cuối (harness lùi câu trả lời bị cắt về ranh giới câu). Không có khối văn bản cuối → giữ nguyên. */
function trimTailText(a: AssistantItem, n: number | undefined): AssistantItem {
  if (!n || n <= 0) return a;
  // Đi ngược từ cuối, BỎ QUA dòng trạng thái / khối suy luận đứng sau chữ (vd. «Đang soạn…» của write_file bị treo), cắt `n` ký tự
  // từ các khối chữ gần nhất; khối chữ cạn hết thì bỏ khối. Gặp khối khác (công cụ…) là dừng — không bao giờ xoá phần của lượt trước.
  let remaining = Math.floor(n);
  const blocks = a.blocks.slice();
  let changed = false;
  for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
    const b = blocks[i];
    if (b.type === 'pill' || b.type === 'thinking' || b.type === 'notice') continue;
    if (b.type !== 'text') break;
    const cut = Math.min(remaining, b.text.length);
    remaining -= cut;
    changed = true;
    // Khối cạn mà còn phải cắt tiếp ở khối trước → bỏ khối; khối cuối cùng được cắt giữ lại (có thể rỗng như trước đây).
    if (cut >= b.text.length && remaining > 0) blocks.splice(i, 1);
    else blocks[i] = { ...b, text: b.text.slice(0, b.text.length - cut) };
  }
  if (!changed) return a;
  // Dòng trạng thái đang hoạt động («Đang soạn…», «Đang suy nghĩ…») đứng cuối là của lần stream bị bỏ: gỡ luôn để không treo mãi.
  while (blocks.length > 0) {
    const tail = blocks[blocks.length - 1];
    if (tail.type === 'pill' && tail.active) blocks.pop();
    else break;
  }
  return { ...a, blocks };
}

function patchTool(blocks: ABlock[], callId: string, patch: (t: ToolBlock) => ToolBlock): ABlock[] | null {
  const idx = findLastIndex(blocks, (b) => b.type === 'tool' && b.id === callId);
  if (idx < 0) return null;
  const copy = blocks.slice();
  copy[idx] = patch(blocks[idx] as ToolBlock);
  return copy;
}

/** Rút phần tiến độ ra khỏi sự kiện `agent_progress` (bỏ trường rỗng để so sánh/lưu cho gọn). */
export function agentProgressOf(ev: AgentProgress): AgentProgress {
  return { tokens: ev.tokens, tools: ev.tools, ...(ev.failed ? { failed: ev.failed } : {}), ...(ev.activity ? { activity: ev.activity } : {}), ...(ev.wf ? { wf: ev.wf } : {}) };
}

export function sameAgentProgress(a: AgentProgress | undefined, b: AgentProgress): boolean {
  return !!a && a.tokens === b.tokens && a.tools === b.tools && (a.failed ?? 0) === (b.failed ?? 0) && (a.activity ?? '') === (b.activity ?? '') && (a.wf?.rev ?? -1) === (b.wf?.rev ?? -1);
}

/** Áp một sự kiện lên danh sách transcript. Trả về mảng mới (hoặc chính mảng cũ nếu không có gì đổi). */
export function applyEvent(items: readonly TItem[], ev: UiEvent): TItem[] {
  switch (ev.t) {
    case 'user':
      return [...items, { kind: 'user', id: ev.id, text: ev.text, attachments: ev.attachments, ts: ev.ts, ...(ev.steer ? { steer: true } : {}) }];

    case 'assistant_start':
      return [
        ...items,
        { kind: 'assistant', id: ev.id, provider: ev.provider, model: ev.model, ts: ev.ts, blocks: [], done: false },
      ];

    case 'text':
      return updateAssistant(items, ev.id, (a) => appendStreamText(trimTailText(a, ev.trimTail), 'text', ev.delta, true));

    case 'thinking':
      return updateAssistant(items, ev.id, (a) => appendStreamText(a, 'thinking', ev.delta, false, ev.ts));

    case 'pill':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = a.blocks.slice();
        const idx = findLastIndex(blocks, (b) => b.type === 'pill' && b.id === ev.pillId);
        const existing = idx >= 0 ? blocks[idx] : undefined;
        if (existing && existing.type === 'pill' && existing.active) {
          blocks[idx] = { ...existing, text: ev.text, kind: ev.kind };
        } else {
          deactivatePills(blocks);
          blocks.push({ type: 'pill', id: ev.pillId, text: ev.text, kind: ev.kind, active: true });
        }
        return { ...a, blocks };
      });

    case 'tasks':
      if (ev.added.length === 0) return items as TItem[];
      return updateAssistant(items, ev.id, (a) => {
        const blocks = deactivatePills(a.blocks.slice());
        blocks.push({ type: 'tasks', id: blockId(a, blocks, 'task'), added: ev.added });
        return { ...a, blocks };
      });

    case 'skill':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = deactivatePills(a.blocks.slice());
        blocks.push({ type: 'skill', id: blockId(a, blocks, 'skill'), skill: ev.skill, unlocked: ev.unlocked });
        return { ...a, blocks };
      });

    case 'tool_start':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = deactivatePills(a.blocks.slice());
        const fresh: ToolBlock = {
          type: 'tool',
          id: ev.callId,
          name: ev.name,
          args: ev.args,
          state: 'running',
          startedAt: Date.now(),
          // (lane:perm-rules) luật allow đã cho qua (tuỳ chọn)
          ...(ev.rule ? { rule: ev.rule } : {}),
        };
        const idx = findLastIndex(blocks, (b) => b.type === 'tool' && b.id === ev.callId);
        // Gửi lại tool_start cho cùng callId (sau khi người dùng duyệt) đưa dòng về trạng thái đang chạy.
        if (idx >= 0) {
          blocks[idx] = { ...(blocks[idx] as ToolBlock), name: ev.name, args: ev.args, state: 'running', permission: undefined, ...(ev.rule ? { rule: ev.rule } : {}) };
        } else blocks.push(fresh);
        return { ...a, blocks };
      });

    case 'tool_progress':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = patchTool(a.blocks, ev.callId, (t) => ({
          ...t,
          output: capTail((t.output ?? '') + ev.output, UI_TOOL_OUTPUT_LIMIT),
        }));
        return blocks ? { ...a, blocks } : a;
      });

    case 'agent_progress':
      return updateAssistant(items, ev.id, (a) => {
        const idx = findLastIndex(a.blocks, (b) => b.type === 'tool' && b.id === ev.callId);
        if (idx < 0) return a;
        const cur = a.blocks[idx] as ToolBlock;
        const next = agentProgressOf(ev);
        if (sameAgentProgress(cur.agent, next)) return a; // không đổi gì → không dựng lại cả lượt
        const blocks = a.blocks.slice();
        blocks[idx] = { ...cur, agent: next };
        return { ...a, blocks };
      });

    case 'tool_permission':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = patchTool(a.blocks, ev.callId, (t) => ({
          ...t,
          state: 'awaiting_permission',
          permission: ev.request,
        }));
        return blocks ? { ...a, blocks } : a;
      });

    case 'tool_end':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = patchTool(a.blocks, ev.callId, (t) => ({
          ...t,
          state: ev.state,
          summary: ev.summary ?? t.summary,
          output: ev.output !== undefined ? capTail(ev.output, UI_TOOL_OUTPUT_LIMIT) : t.output,
          diff: ev.diff ?? t.diff,
          images: ev.images ?? t.images,
          step: ev.step ?? t.step,
          permission: undefined,
          durationMs: ev.durationMs,
        }));
        return blocks ? { ...a, blocks } : a;
      });

    case 'artifact':
      return updateAssistant(items, ev.id, (a) => {
        const blocks = a.blocks.slice();
        const bid = `artifact:${ev.artifactId}`;
        const idx = findLastIndex(blocks, (b) => b.type === 'artifact' && b.id === bid);
        const next: ABlock = {
          type: 'artifact',
          id: bid,
          artifactId: ev.artifactId,
          title: ev.title,
          artifactType: ev.artifactType,
          state: ev.state,
          sizeChars: ev.sizeChars,
        };
        if (idx >= 0) blocks[idx] = next;
        else {
          deactivatePills(blocks);
          blocks.push(next);
        }
        return { ...a, blocks };
      });

    case 'usage':
      return updateAssistant(items, ev.id, (a) => ({
        ...a,
        usage: {
          inputTokens: (a.usage?.inputTokens ?? 0) + ev.usage.inputTokens,
          outputTokens: (a.usage?.outputTokens ?? 0) + ev.usage.outputTokens,
          cacheReadTokens: (a.usage?.cacheReadTokens ?? 0) + (ev.usage.cacheReadTokens ?? 0),
          cacheWriteTokens: (a.usage?.cacheWriteTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0),
          reasoningTokens: (a.usage?.reasoningTokens ?? 0) + (ev.usage.reasoningTokens ?? 0),
        },
      }));

    case 'assistant_end':
      return updateAssistant(items, ev.id, (a) => ({
        ...a,
        done: true,
        stopReason: ev.stopReason,
        endedAt: a.endedAt ?? Date.now(),
        blocks: deactivatePills(a.blocks.slice()),
      }));

    case 'notice': {
      if (ev.id) {
        const targetId = ev.id;
        const idx = findLastIndex(items, (it) => it.kind === 'assistant' && it.id === targetId);
        if (idx >= 0) {
          return updateAssistant(items, targetId, (a) => {
            const blocks = deactivatePills(a.blocks.slice());
            // (lane:blind-verifier) Kiểm tra độc lập: cùng `verify.key` trong cùng lượt → cập nhật TẠI CHỖ (đang chạy → kết quả), không thêm dòng mới.
            const vk = ev.verify?.key;
            const prev = vk ? findLastIndex(blocks, (b) => b.type === 'notice' && b.verify?.key === vk) : -1;
            const block = { type: 'notice' as const, id: prev >= 0 ? blocks[prev].id : blockId(a, blocks, 'n'), level: ev.level, text: ev.text, ...(ev.compact ? { compact: ev.compact } : {}), ...(ev.verify ? { verify: ev.verify } : {}) };
            if (prev >= 0) blocks[prev] = block;
            else blocks.push(block);
            return { ...a, blocks };
          });
        }
      }
      // (lane:blind-verifier) Thông báo độc lập mang `verify` cùng khoá (lệnh /verify): thay tại chỗ.
      const vk = ev.verify?.key;
      const prev = vk ? findLastIndex(items, (it) => it.kind === 'notice' && it.verify?.key === vk) : -1;
      if (prev >= 0) {
        const old = items[prev] as NoticeItem;
        const next = items.slice();
        next[prev] = { ...old, level: ev.level, text: ev.text, verify: ev.verify };
        return next;
      }
      return [
        ...items,
        { kind: 'notice', id: `notice:${items.length}:${Date.now()}`, level: ev.level, text: ev.text, ts: Date.now(), ...(ev.compact ? { compact: ev.compact } : {}), ...(ev.verify ? { verify: ev.verify } : {}) },
      ];
    }

    case 'run_state':
    case 'mode':
    case 'todos':
    case 'options':
      return items as TItem[];
  }
}

/** Áp một sự kiện lên toàn bộ ViewState (transcript + các trường trạng thái đi kèm). */
export function reduceView(state: ViewState, ev: UiEvent): ViewState {
  switch (ev.t) {
    case 'run_state':
      return state.running === ev.running ? state : { ...state, running: ev.running };
    case 'mode':
      return state.mode === ev.mode ? state : { ...state, mode: ev.mode };
    case 'todos':
      return { ...state, todos: ev.todos };
    case 'options':
      return { ...state, options: ev.options };
    case 'tasks':
      return { ...state, todos: ev.todos, transcript: applyEvent(state.transcript, ev) };
    default: {
      const transcript = applyEvent(state.transcript, ev);
      return transcript === state.transcript ? state : { ...state, transcript };
    }
  }
}

/**
 * (0.7.2) Trần ảnh khi LƯU transcript (đơn vị: ký tự base64). Mỗi ảnh vốn nằm HAI lần trên đĩa: lịch sử gửi model (`session.messages`)
 * và transcript hiển thị — nên transcript chỉ giữ bản xem trước nhỏ:
 *  - ảnh đính kèm của người dùng: chỉ `thumb` (≤ ~60 KB); mọi `data` đầy đủ lọt vào đây đều bị bỏ;
 *  - ảnh do công cụ trả về (ảnh chụp màn hình…): ảnh nào vượt `toolImageMaxChars` thì bỏ khỏi bản lưu (thẻ «Trước | Sau» tra lại ảnh theo
 *    đường dẫn trong đối số khi mở phiên; ảnh gốc của model vẫn nằm trong lịch sử gửi model cho tới khi bị lược/xoá).
 */
export interface StorageImageLimits {
  toolImageMaxChars: number;
  attachThumbMaxChars: number;
}
export const DEFAULT_STORAGE_IMAGE_LIMITS: StorageImageLimits = { toolImageMaxChars: 400_000, attachThumbMaxChars: 80_000 };
/** Chế độ nhẹ: không lưu ảnh công cụ trong transcript, xem trước ảnh đính kèm nhỏ hơn. */
export const LITE_STORAGE_IMAGE_LIMITS: StorageImageLimits = { toolImageMaxChars: 0, attachThumbMaxChars: 40_000 };

/** Gọn lại transcript trước khi ghi ra đĩa: cắt kết quả tool quá dài, và giữ ảnh trong trần (xem StorageImageLimits). */
export function trimTranscriptForStorage(items: readonly TItem[], outputLimit = 4000, imageLimits: StorageImageLimits = DEFAULT_STORAGE_IMAGE_LIMITS): TItem[] {
  return items.map((it) => {
    if (it.kind === 'user') {
      let touched = false;
      const attachments = it.attachments.map((a) => {
        if (a.kind !== 'image') return a;
        const dropData = typeof a.data === 'string';
        const dropThumb = typeof a.thumb === 'string' && a.thumb.length > imageLimits.attachThumbMaxChars;
        if (!dropData && !dropThumb) return a;
        touched = true;
        const { data: _d, thumb: _t, ...rest } = a;
        return dropThumb || a.thumb === undefined ? rest : { ...rest, thumb: a.thumb };
      });
      return touched ? { ...it, attachments } : it;
    }
    if (it.kind !== 'assistant') return it;
    let changed = false;
    const blocks = it.blocks.map((b) => {
      if (b.type === 'tool' && b.images && b.images.length > 0) {
        const kept = b.images.filter((im) => typeof im?.data === 'string' && im.data.length <= imageLimits.toolImageMaxChars);
        if (kept.length !== b.images.length) {
          changed = true;
          const { images: _i, ...rest } = b;
          b = kept.length > 0 ? { ...rest, images: kept } : (rest as typeof b);
        }
      }
      if (b.type === 'tool' && b.output && b.output.length > outputLimit) {
        changed = true;
        return { ...b, output: capTail(b.output, outputLimit) };
      }
      // Văn bản suy luận thô có thể rất dài và ít giá trị khi xem lại: giữ phần cuối.
      if (b.type === 'thinking' && b.text.length > outputLimit * 2) {
        changed = true;
        return { ...b, text: capTail(b.text, outputLimit * 2) };
      }
      return b;
    });
    return changed ? { ...it, blocks } : it;
  });
}

let idCounter = 0;
/** id ngắn, duy nhất trong tiến trình; đủ cho khoá React/Preact và id lượt trả lời. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
