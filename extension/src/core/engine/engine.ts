/**
 * Agentic Orchestration Engine — Trụ cột 1: MỘT vòng lặp `while` duy nhất.
 *
 * Không có đồ thị DAG hay `if (user_asks_benchmark) …` nào. LLM đóng vai máy trạng thái và bộ lập lịch:
 * mỗi vòng nó suy nghĩ (đan xen giữa các lần gọi công cụ), có thể phát NHIỀU lệnh gọi công cụ cùng lúc,
 * nhận kết quả quan sát, rồi quyết định làm tiếp hay dừng. Engine chỉ làm phần cơ khí:
 *   dựng ngữ cảnh → gọi model (stream qua Interceptor) → chạy công cụ (Dispatcher) → nối kết quả → lặp.
 */

import {
  ProviderError,
  textOf,
  toolUsesOf,
  userText,
  type ChatMessage,
  type ContentBlock,
  type LLMProvider,
  type ProviderEvent,
  type QueueEvent,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from '../types';
import type { AttachmentInfo, TodoItem, UiEvent } from '../../shared/protocol';
import { newId } from '../../shared/transcript';
import type { SkillRegistry } from '../skills/registry';
import { sha1 } from '../tools/textUtil';
import { compactIfNeeded, compactNoticeOf, stripThinking } from './compaction';
import { compactTuningFrom } from './compactTuning'; // (lane:ctx-compaction)
import type { CompactInfo } from '../../shared/protocol'; // (lane:ctx-compaction)
import { turnBudgetNote, withBudgetNote } from './completion';
import { coreRunExtensions } from './extensions';
import { beginExtensions, newTrace, type ActiveExtension, type FinalizeContext, type FinalizeDecision, type RunExtension, type RunScope, type RunTrace, type TraceCall, type TurnInfo } from './seams';
import { buildSystemPrompt } from './context';
import { formatMemoryBlock } from './memory';
import { ToolDispatcher } from './dispatcher';
import { StreamInterceptor, type PillBudget } from './interceptor';
import { t, type Lang } from './strings';
// (lane:output-timeouts) trần đầu ra thích ứng · cắt đúng ranh giới + nối tiếp · watchdog im lặng · tổng kết ba phần khi bị buộc dừng
import { forcedStopSummary, stopFacts, wrapUpPrompt } from './forcedStop';
import { pickOutputBudget } from './outputBudget';
import { StallError, resolveStallPolicy, watchStream } from './stallWatchdog';
import { continuationMarker, continuePartOption, continueWorkOption, trimAssistantTail, trimToBoundary } from './truncation';
import { Summarizer } from './summarizer';
import { splitThinkTags } from './thinkTags';
import type { ToolRegistry } from './toolRegistry';
import type { EngineSettings, SessionState, ToolHost } from './types';

/** Tin nhắn người dùng gửi thêm lúc agent đang chạy; nội dung đã dựng sẵn để gửi model. */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Bản hiển thị của tệp đính kèm (không có dữ liệu thô). */
  display: AttachmentInfo[];
  content: ContentBlock[];
  ts: number;
}

/** Trạng thái đứng trong hàng chờ của cổng Locaith (sự kiện `queue` của nhà cung cấp, bỏ trường `type`). */
export type QueueState = Omit<QueueEvent, 'type'>;

export interface EngineDeps {
  provider: LLMProvider;
  /** Model chính (mỗi phiên có thể đổi giữa các lượt → truyền qua RunInput). */
  summarizer: Summarizer | null;
  /** Dùng để nén lịch sử; mặc định dùng chính model chính. */
  compactor?: { provider: LLMProvider; model: string };
  registry: ToolRegistry;
  skills: SkillRegistry;
  host: ToolHost;
  settings: EngineSettings;
  emit(ev: UiEvent): void;
  /** Model phát thẻ <think> trong dòng chữ (không có kênh suy luận riêng): tách thẻ và nhắc suy nghĩ qua prompt. */
  thinkTags?: boolean;
  now?: () => Date;
  /** Đọc tệp hướng dẫn dự án (LOCAITH.md…). Không có → không nạp (bản trình duyệt không có workspace). */
  loadInstructions?(names: string[]): Promise<{ file: string; text: string } | null>;
  /** Đọc lại ký ức bền (`.locaith/memory/MEMORY.md` của dự án + của người dùng) ở mỗi lượt. */
  loadMemory?(): Promise<import('./memory').MemorySnapshot | null>;
  /** Hồ sơ prompt: 'ide' (mặc định, VS Code) hoặc 'browser' (trợ lý trong Chrome/Edge). Thông tin hay đổi (tab đang mở) KHÔNG vào system prompt. */
  profile?: 'ide' | 'browser';
  /**
   * Lấy (và rút khỏi hàng đợi) các tin người dùng gửi thêm lúc agent đang chạy. Engine gọi ở RANH GIỚI giữa hai lần gọi model:
   *  1. ngay sau khi chạy xong một lượt công cụ → tin đi CHUNG tin nhắn kết quả công cụ, model đổi hướng được ngay (steering);
   *  2. khi model trả lời xong mà không gọi công cụ → tin trở thành lượt kế tiếp của CÙNG lần chạy.
   * Không khai báo = không có hàng đợi (agent con, bản trình duyệt).
   */
  takeQueued?(): QueuedMessage[];
  /** Chỉ dẫn do các server MCP đang chạy cung cấp (đưa vào system prompt kèm nhãn nguồn). */
  mcpInstructions?(): { server: string; text: string }[];
  /** Gọi sau khi một lần nén ngữ cảnh thành công, kèm bản tóm tắt (ví dụ để lưu vào bộ nhớ dài hạn). Lỗi của hook không làm hỏng lượt chạy. */
  onCompacted?(info: { session: SessionState; summary: string }): void | Promise<void>;
  /**
   * Cổng Locaith đầy người dùng: có `state` = đang đứng trong hàng (vị trí, mốc thử lại để đếm ngược); `null` = đã được nhận / bị dừng / hết lượt.
   * Hiển thị ngay trong khung chat (không dùng thông báo hệ thống). Không khai báo (agent con, bản trình duyệt) = chỉ có dòng trạng thái trong lượt trả lời.
   */
  onQueue?(state: QueueState | null): void;
  /** Cổng Locaith từ chối vì tài khoản chưa đồng ý (phiên bản) thông báo dữ liệu: host mở lại thẻ thông báo trong khung chat. */
  onConsentRequired?(): void;
  /** Cổng Locaith báo token đăng nhập không còn hợp lệ (401): host kiểm tra lại tài khoản (bị thu hồi thì khoá extension và đòi đăng nhập lại). */
  onAccountInvalid?(): void;
  /**
   * Các tính năng gắn quanh vòng lặp (cổng hoàn thành, kiểm tra độc lập, hook…) — xem `seams.ts`. Không khai báo = chỉ các extension dùng chung
   * (`coreRunExtensions()`, hiện là cổng hoàn thành). Host VS Code truyền `[...coreRunExtensions(), ...hostRunExtensions(...)]`.
   */
  extensions?: RunExtension[];
}

export interface RunInput {
  session: SessionState;
  /** Nội dung tin nhắn người dùng (đã gồm tệp đính kèm, ngữ cảnh IDE, ảnh). */
  content: ContentBlock[];
  signal: AbortSignal;
  assistantId?: string;
}

export interface RunResult {
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'aborted' | 'refusal';
  turns: number;
  assistantId: string;
}

/** Công cụ mà việc gọi lặp lại là bình thường (cập nhật trạng thái). */
const REPEAT_EXEMPT = new Set(['todo_write', 'scratchpad', 'load_skill', 'search_skills', 'offer_options']);

/** Công cụ tạo/sửa artifact: đầu ra là tài liệu, không phải mã nguồn — không kích hoạt cổng "phải chạy kiểm chứng". */
const ARTIFACT_TOOLS = new Set(['create_artifact', 'update_artifact', 'list_artifact_types']);

/** Dấu vân tay của phần "tiền tố" mà khối suy luận ký vào: system prompt và định nghĩa công cụ (thứ tự công cụ không quan trọng). */
function promptFingerprint(system: string, specs: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>): string {
  const tools = [...specs].sort((a, b) => a.name.localeCompare(b.name)).map((s) => [s.name, s.description, s.inputSchema]);
  return sha1(`${system}\u0000${JSON.stringify(tools)}`);
}

/** Id công cụ chưa từng xuất hiện trong lịch sử phiên: giữ nguyên nếu duy nhất, ngược lại thêm hậu tố `_r2`, `_r3`… */
function freshToolId(session: SessionState, providerId: string): string {
  const used = new Set<string>();
  for (const m of session.messages) for (const b of m.content) if (b.type === 'tool_use') used.add(b.id);
  if (!used.has(providerId)) return providerId;
  for (let n = 2; ; n++) {
    const candidate = `${providerId}_r${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Lượt bị DỪNG giữa vòng công cụ để lại tin assistant có `tool_use` mà không có `tool_result`.
 * Lịch sử đó không hợp lệ với mọi hãng (Anthropic trả 400; số khác lặng lẽ phát lại lệnh cũ), và chính nó làm
 * tin "tiếp tục" chạy lại đúng những lệnh của tin trước. Vá bằng `tool_result` đánh dấu đã huỷ — không chạy lại gì.
 * Idempotent; trả về số lệnh đã vá.
 *
 * Quy tắc chèn (quan trọng): kết quả huỷ nằm trong MỘT TIN TỔNG HỢP RIÊNG đặt ngay sau tin assistant. Chỉ khi tin user kế tiếp
 * VỐN LÀ tin kết quả (đã có tool_result, thiếu một phần do dừng giữa lúc chạy song song) mới bổ sung vào chính tin đó. KHÔNG gộp
 * vào một tin người dùng thật: nó sẽ mất tư cách "điểm bắt đầu lượt" (`isTurnStart`), "Thử lại / Sửa tin cuối" nhắm sai chỗ và
 * transcript dựng lại sẽ hiện nó như tin chen giữa.
 */
export function repairOrphanToolCalls(session: SessionState, lang: Lang = 'vi'): number {
  const msgs = session.messages;
  let repaired = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) continue;
    const next = msgs[i + 1];
    const existing: ToolResultBlock[] = next && next.role === 'user' ? next.content.filter((b): b is ToolResultBlock => b.type === 'tool_result') : [];
    const byId = new Map(existing.map((r) => [r.toolUseId, r] as const));
    const missing = uses.filter((u) => !byId.has(u.id));
    if (missing.length === 0) continue;
    const cancelled = (u: ToolUseBlock): ToolResultBlock => ({ type: 'tool_result', toolUseId: u.id, name: u.name, content: t(lang, 'toolInterrupted'), isError: true });
    repaired += missing.length;
    if (next && next.role === 'user' && existing.length > 0) {
      // Tin kết quả có sẵn nhưng thiếu một phần → bổ sung ngay trong đó, tool_result theo đúng thứ tự gọi và luôn đứng trước phần còn lại.
      const ids = new Set(uses.map((u) => u.id));
      const rest = next.content.filter((b) => !(b.type === 'tool_result' && ids.has(b.toolUseId)));
      msgs[i + 1] = { ...next, content: [...uses.map((u) => byId.get(u.id) ?? cancelled(u)), ...rest] };
    } else {
      msgs.splice(i + 1, 0, { role: 'user', content: missing.map(cancelled), synthetic: true, ts: Date.now() });
    }
  }
  if (repaired > 0) session.historyEdited = true;
  return repaired;
}

export class AgentEngine {
  private readonly dispatcher: ToolDispatcher;
  private readonly extensions: RunExtension[];

  constructor(private readonly d: EngineDeps) {
    this.extensions = d.extensions ?? coreRunExtensions();
    this.dispatcher = new ToolDispatcher({
      registry: d.registry,
      host: d.host,
      emit: d.emit,
      language: d.settings.language,
      parallel: d.settings.parallelToolCalls,
    });
  }

  async run(input: RunInput): Promise<RunResult> {
    const { session, signal } = input;
    const { settings, emit } = this.d;
    const lang: Lang = settings.language;
    let id = input.assistantId ?? newId('a');
    const providerLabel = this.d.provider.label;

    emit({ t: 'assistant_start', id, provider: this.d.provider.id, model: session.model, ts: Date.now() });
    // Lượt trước bị DỪNG giữa vòng công cụ có thể để lại `tool_use` không có `tool_result`. Lịch sử đó không hợp lệ:
    // hãng sẽ từ chối, hoặc tệ hơn — lần chạy sau phát lại đúng các lệnh cũ ("chạy ở cả hai chỗ"). Vá ngay ở đây,
    // bằng cách đánh dấu chúng là đã huỷ, TRƯỚC khi thêm tin mới.
    repairOrphanToolCalls(session, lang);
    session.messages.push({ role: 'user', content: input.content, ts: Date.now() });
    session.updatedAt = Date.now();
    // Lựa chọn của lượt trước chỉ có nghĩa với lượt đó: người dùng đã gửi việc mới thì thu hồi các nút cũ.
    if (session.options?.length) {
      session.options = undefined;
      emit({ t: 'options', options: [] });
    }

    const budget: PillBudget = { seq: 0, count: 0 };
    const recentSigs: string[] = [];
    let turns = 0;
    let continuations = 0;
    /** Những gì lượt chạy này đã THỰC SỰ làm — căn cứ để biết "xong" có bằng chứng hay không (cổng hoàn thành, kiểm tra độc lập…). */
    const trace = newTrace();
    let emptyNudges = 0;
    let wrapUp = false;
    let compactedForOverflow = false;
    let result: RunResult['stopReason'] = 'end_turn';
    let lastWasToolResults = false;
    // (lane:output-timeouts) trạng thái cho trần đầu ra thích ứng + watchdog: chữ người dùng gõ, đã thấy công cụ ghi nội dung dài,
    // lần gọi trước bị cắt vì trần, đã thử lại sau khi model treo, chữ đã hiện trong lần gọi đang chạy.
    const userInputText = input.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    let longWriteSeen = false;
    let lastCallHitMax = false;
    let emptyCutRetried = false; // (lane:output-timeouts) đã thử lại một lần khi max_tokens mà chưa có chữ
    let stallRetried = false;
    let partialText = '';
    /** Chữ của lần gọi bị treo thứ nhất (đã xoá khỏi giao diện để thử lại) — dùng lại nếu lần thử lại cũng treo mà không sinh gì. */
    let erasedPartial = '';

    const notice = (level: 'info' | 'warn' | 'error', text: string) => emit({ t: 'notice', id, level, text });

    // Các extension gắn quanh vòng lặp (xem seams.ts): mỗi cái nhận phạm vi của lần chạy này và trả về bộ móc riêng.
    const scope: RunScope = {
      session,
      settings,
      lang,
      host: this.d.host,
      provider: this.d.provider,
      signal,
      input: input.content,
      trace,
      emit,
      notice,
      assistantId: () => id,
    };
    const active = beginExtensions(this.extensions, scope);
    const hostLog = (level: 'warn', message: string) => this.d.host.log(level, message);

    /**
     * Tin người dùng gửi trong lúc trợ lý đang làm = VIỆC MỚI. Ghi ngay vào danh sách tác vụ của phiên
     * (trạng thái chờ) để không bị bỏ quên, hiện ở bảng «Việc cần làm», rồi mới chèn nội dung vào lượt kế tiếp.
     * Việc đang dở vẫn xong trước; các việc mới chạy lần lượt theo đúng thứ tự gửi.
     */
    const addQueuedTasks = (queued: QueuedMessage[]): void => {
      const next: TodoItem[] = [...session.todos];
      const used = new Set(next.map((x) => x.id));
      const added: string[] = [];
      for (const q of queued) {
        const title = (q.text || t(lang, 'queuedImageTask')).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!title) continue;
        if (next.some((x) => x.status !== 'completed' && x.title === title)) continue;
        let n = next.length + 1;
        while (used.has(`t${n}`)) n++;
        used.add(`t${n}`);
        next.push({ id: `t${n}`, title, status: 'pending' });
        added.push(title);
      }
      if (added.length === 0) return;
      session.todos = next;
      emit({ t: 'tasks', id, todos: next, added });
    };

    /**
     * Chèn các tin người dùng đang chờ ở ranh giới vòng lặp. Trả về khối nội dung để gắn vào tin nhắn user kế tiếp (rỗng nếu không có gì).
     * Giao diện: đóng đoạn trả lời hiện tại, hiện tin của người dùng, mở đoạn mới — vẫn CÙNG một lần chạy (`run_state` không đổi).
     */
    const takeQueued = (steer: boolean): ContentBlock[] => {
      if (wrapUp || !this.d.takeQueued) return [];
      let queued: QueuedMessage[] = [];
      try {
        queued = this.d.takeQueued();
      } catch (err) {
        this.d.host.log('warn', `Không lấy được hàng đợi tin nhắn: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (queued.length === 0) return [];
      emit({ t: 'assistant_end', id, stopReason: 'end_turn' });
      for (const q of queued) emit({ t: 'user', id: q.id, text: q.text, attachments: q.display, ts: q.ts, ...(steer ? { steer: true } : {}) });
      id = newId('a');
      emit({ t: 'assistant_start', id, provider: this.d.provider.id, model: session.model, ts: Date.now() });
      if (steer) addQueuedTasks(queued);
      const blocks: ContentBlock[] = steer ? [{ type: 'text', text: t(lang, 'steerHeader', { n: queued.length }) }] : [];
      for (let i = 0; i < queued.length; i++) {
        if (steer && queued.length > 1) blocks.push({ type: 'text', text: `[${t(lang, 'steerItem')} ${i + 1}/${queued.length}]` });
        blocks.push(...queued[i].content);
      }
      return blocks;
    };

    try {
      while (true) {
        if (signal.aborted) {
          result = 'aborted';
          break;
        }
        if (turns >= settings.maxTurns && !wrapUp) {
          wrapUp = true;
          notice('warn', t(lang, 'maxTurns', { n: settings.maxTurns }));
          // (lane:output-timeouts · B08) lời nhắc tổng kết đòi ĐÚNG BA PHẦN và đính kèm vết thật (tệp đã ghi, lệnh đã chạy, việc dở) để model không bịa "đã xong".
          session.messages.push(userText(wrapUpPrompt(lang, stopFacts({ reason: 'max_turns', turns, trace, session })), { synthetic: true }));
        } else if (wrapUp && turns >= settings.maxTurns + 1) {
          result = 'max_turns';
          break;
        }
        turns++;
        trace.turns = turns;
        const turnInfo: TurnInfo = { turn: turns, maxTurns: settings.maxTurns, turnsLeft: Math.max(0, settings.maxTurns - turns), wrapUp };

        await this.compact(session, signal, id, false);
        await this.runBeforeModel(active, turnInfo, session, hostLog);

        const unlocked = this.d.skills.unlockedTools(session.loadedSkills, session.provider);
      // Swarm: công cụ workflow luôn sẵn sàng (không cần nạp kỹ năng multi-agent trước).
      if (session.swarm || session.thinkingLevel === 'swarm') unlocked.add('workflow_run');
        // Lượt tổng kết cuối vẫn gửi ĐỦ định nghĩa công cụ (Anthropic trả 400 nếu lịch sử có tool_use/tool_result mà không
        // có `tools`, và danh sách công cụ đổi cũng làm hỏng khối suy luận đã ký) nhưng cấm gọi bằng `toolChoice: 'none'`.
        const specs = this.d.registry.specs(session, unlocked);
        const available = new Set(specs.map((s) => s.name));
        const instructions = this.d.loadInstructions ? await this.d.loadInstructions(settings.instructionFiles) : null;
        // Ký ức đọc lại từ đĩa mỗi lượt: không phụ thuộc lịch sử, nên nén ngữ cảnh bao nhiêu lần cũng còn.
        const memory = this.d.loadMemory ? formatMemoryBlock(await this.d.loadMemory().catch(() => null), lang) : null;
        const promptedThinking = !!this.d.thinkTags && session.thinkingLevel !== 'off';
        const system = buildSystemPrompt({
          host: this.d.host,
          model: session.model,
          providerLabel,
          mode: session.mode,
          language: lang,
          projectInstructions: instructions,
          memory,
          promptedThinking,
          swarm: session.swarm === true || session.thinkingLevel === 'swarm',
          now: this.d.now?.(),
          profile: this.d.profile,
          mcpInstructions: this.d.mcpInstructions?.(),
          providerId: session.provider,
        });

        partialText = '';
        const interceptor = new StreamInterceptor({
          assistantId: id,
          // (lane:output-timeouts) ghi lại chữ đã hiện trong lần gọi này — để giữ lại khi model treo giữa chừng.
          emit: (ev) => {
            if (ev.t === 'text' && ev.id === id) partialText += ev.delta;
            emit(ev);
          },
          summarizer: this.d.summarizer,
          thinkTags: !!this.d.thinkTags,
          toolInfo: (name) => {
            const def = this.d.registry.get(name);
            return def ? { streamsContent: !!def.streamsContent, contentField: def.contentField } : undefined;
          },
          signal,
          language: lang,
          flushChars: settings.summarizeEveryChars,
          flushMs: settings.summarizeEveryMs,
          maxPills: settings.maxPillsPerReply,
          budget,
        });

        // Khối suy luận chỉ hợp lệ khi system + công cụ + lịch sử phía trước không đổi. Nếu system/công cụ vừa đổi
        // (duyệt kế hoạch, nạp kỹ năng, sang ngày mới) hoặc lịch sử vừa bị sửa, xoá suy luận cũ KHỎI LỊCH SỬ ĐÃ LƯU:
        // suy luận mới sẽ được sinh ra khi không có chúng, nên lượt sau cũng không được phát lại chúng.
        // Chỉ làm ở RANH GIỚI lượt (tin nhắn cuối là chữ của người dùng): giữa một vòng công cụ, tin nhắn assistant cuối
        // (đang chờ kết quả tool_use) phải giữ khối suy luận của nó — tài liệu Anthropic: "không bao giờ xoá giữa vòng công cụ".
        // Khi đó giữ nguyên vân tay cũ để ranh giới kế tiếp phát hiện ra chênh lệch và xoá một lần.
        const fingerprint = promptFingerprint(system, specs);
        const last = session.messages[session.messages.length - 1];
        // Tin user vừa có tool_result vừa có chữ (người dùng chen vào giữa vòng công cụ) KHÔNG phải ranh giới lượt: suy luận của tin assistant ngay trước nó vẫn phải giữ.
        const atBoundary =
          !!last && last.role === 'user' && last.content.some((b) => b.type === 'text' || b.type === 'image') && !last.content.some((b) => b.type === 'tool_result');
        const boundToPrefix = !!this.d.provider.capabilities.thinkingBoundToPrefix;
        const prefixChanged = boundToPrefix && !!session.promptFingerprint && session.promptFingerprint !== fingerprint;
        if (prefixChanged && atBoundary) session.historyEdited = true;
        if (session.historyEdited) stripThinking(session, !atBoundary); // (lane:ctx-compaction) giữa vòng công cụ vẫn giữ suy luận của tin assistant đang chờ kết quả

        // Id công cụ của một số máy chủ tương thích (`call_0`, `call_1`…) lặp lại giữa các lượt → đổi tên để mỗi lệnh gọi là duy nhất.
        const idMap = new Map<string, string>();
        const uniqueId = (providerId: string): string => {
          let u = idMap.get(providerId);
          if (!u) {
            u = freshToolId(session, providerId);
            idMap.set(providerId, u);
          }
          return u;
        };

        let done: Extract<ProviderEvent, { type: 'done' }> | null = null;
        let queued = false;
        // (0.6.31) Dòng ngân sách vòng: model không thể biết còn bao nhiêu lượt nếu harness không nói.
        // Gắn vào ĐUÔI tin nhắn cuối của payload (không sửa lịch sử đã lưu) → tiền tố nguyên vẹn cho prompt-cache.
        const payload = withBudgetNote(session.messages, turnBudgetNote(turns, settings.maxTurns, lang));
        // (lane:output-timeouts) Trần đầu ra theo loại việc (kẹp theo cài đặt và trần thật của model) + watchdog im lặng theo bậc.
        // Lần gọi có AbortController RIÊNG: watchdog huỷ đúng lần stream này; người dùng bấm Dừng vẫn đi qua `signal` ngoài (phân biệt được).
        const outputBudget = pickOutputBudget({
          userText: userInputText,
          maxSetting: settings.maxOutputTokens,
          modelCap: settings.modelMaxOutputTokens,
          longWriteSeen,
          continuation: lastCallHitMax,
          adaptive: settings.adaptiveOutputTokens !== false,
          thinkingLevel: session.thinkingLevel,
        });
        const call = new AbortController();
        const onOuterAbort = () => call.abort();
        if (signal.aborted) call.abort();
        else signal.addEventListener('abort', onOuterAbort, { once: true });
        const stallPolicy = resolveStallPolicy(settings, session);
        const watchdog: { stall: StallError | null } = { stall: null };
        try {
          const source = this.d.provider.stream({
            model: session.model,
            system,
            messages: payload,
            tools: specs,
            toolChoice: wrapUp ? 'none' : undefined,
            maxOutputTokens: outputBudget.tokens,
            thinking: { level: session.thinkingLevel === 'swarm' ? 'max' : session.thinkingLevel, summaries: true },
            signal: call.signal,
            parallelToolCalls: settings.parallelToolCalls,
            historyEdited: session.historyEdited,
            sessionKey: session.id,
          });
          const watched = stallPolicy
            ? watchStream(source, stallPolicy, {
                onTimeout: (e) => {
                  watchdog.stall = e;
                  call.abort();
                },
              })
            : source;
          for await (const raw of watched) {
            const ev: ProviderEvent =
              raw.type === 'tool_start' || raw.type === 'tool_args_delta' || raw.type === 'tool_end'
                ? { ...raw, id: uniqueId(raw.id) }
                : raw.type === 'done'
                  ? { ...raw, message: { ...raw.message, content: raw.message.content.map((b) => (b.type === 'tool_use' ? { ...b, id: uniqueId(b.id) } : b)) } }
                  : raw;
            // Hàng chờ của cổng Locaith: báo cho host (dải đếm ngược trong khung chat); sự kiện đầu tiên KHÁC `queue` (retry không tính) = đã được nhận.
            if (ev.type === 'queue') {
              queued = true;
              this.d.onQueue?.({ position: ev.position, ahead: ev.ahead, attempt: ev.attempt, waitMs: ev.waitMs, retryAt: ev.retryAt, limit: ev.limit, active: ev.active, waiting: ev.waiting });
            } else if (queued && ev.type !== 'retry') {
              queued = false;
              this.d.onQueue?.(null);
            }
            interceptor.onEvent(ev);
            if (ev.type === 'done') done = ev;
          }
        } catch (err) {
          await interceptor.finish();
          // (lane:output-timeouts) Watchdog ngắt (KHÔNG phải người dùng bấm Dừng): thử lại đúng một lần với cùng lịch sử; lần hai thì chốt
          // lượt bằng phần đã có + nút «Chạy tiếp» + thông báo nói rõ nguyên nhân.
          if (watchdog.stall && !signal.aborted) {
            const sec = Math.round(watchdog.stall.limitMs / 1000);
            if (!stallRetried) {
              stallRetried = true;
              erasedPartial = partialText;
              if (partialText) emit({ t: 'text', id, delta: '', trimTail: partialText.length });
              notice('warn', t(lang, 'stallRetry', { sec }));
              turns--; // lần thử lại không tính vào ngân sách vòng
              trace.turns = turns;
              continue;
            }
            this.finishAfterStall({ session, id, lang, turns, trace, partialText, erasedPartial, sec, emit, notice });
            result = 'end_turn';
            break;
          }
          const outcome = await this.handleProviderError(err, { session, signal, id, lang, providerLabel, compactedForOverflow, notice });
          if (outcome === 'retry') {
            compactedForOverflow = true;
            continue;
          }
          result = outcome;
          break;
        } finally {
          signal.removeEventListener('abort', onOuterAbort);
          // Lỗi / dừng khi đang xếp hàng: dải đếm ngược phải biến mất.
          if (queued) this.d.onQueue?.(null);
        }
        await interceptor.finish();
        stallRetried = false;
        erasedPartial = '';

        if (!done) {
          notice('error', t(lang, 'providerError', { provider: providerLabel, detail: 'luồng kết thúc đột ngột' }));
          result = 'error';
          break;
        }
        session.historyEdited = false;
        if (!prefixChanged || atBoundary) session.promptFingerprint = fingerprint;
        // Adapter đã phải bỏ suy luận cũ để API chấp nhận yêu cầu: lịch sử đã lưu phải khớp với những gì thực sự được gửi.
        if (done.droppedReplayedThinking) stripThinking(session);

        const message = this.normalizeAssistant(done.message, session);
        session.messages.push(message);
        this.recordUsage(session, done.usage, id);

        const calls = toolUsesOf(message);
        const stop: StopReason = done.stopReason;
        // (lane:output-timeouts) dữ liệu cho trần đầu ra của lần gọi kế: vừa bị cắt vì trần? đã gọi công cụ ghi nội dung dài?
        lastCallHitMax = stop === 'max_tokens';
        if (calls.some((c) => this.d.registry.get(c.name)?.streamsContent)) longWriteSeen = true;

        if (stop === 'refusal') {
          notice('warn', t(lang, 'refusal'));
          result = 'refusal';
          break;
        }
        if (stop === 'content_filter' && calls.length === 0) {
          notice('warn', t(lang, 'contentFilter'));
          result = 'refusal';
          break;
        }

        // ── Có lệnh gọi công cụ → chạy rồi quay lại vòng lặp ─────────────────────
        if (calls.length > 0 && !wrapUp) {
          if (stop === 'max_tokens') {
            // Lệnh cuối có thể đã bị cắt giữa chừng nhưng vẫn parse được: không bao giờ chạy trên đối số cụt.
            const last = calls[calls.length - 1];
            if (!last.parseError) last.parseError = 'đầu ra bị cắt do chạm giới hạn độ dài';
          }
          const results = await this.runTools(calls, session, id, signal, available, recentSigs, lang, trace, active, turns);
          // Tin người dùng gửi lúc công cụ đang chạy đi CHUNG tin nhắn kết quả (mỗi tin assistant chỉ được theo sau bởi MỘT tin user: giữ xen kẽ vai trò ở mọi hãng); tool_result luôn đứng trước.
          const steered = signal.aborted ? [] : takeQueued(true);
          session.messages.push({ role: 'user', content: [...results, ...steered], ts: Date.now() });
          // `offer_options` là câu hỏi LÀM RÕ ở đầu việc: dừng lượt ngay để người dùng chọn, không tự làm tiếp
          // theo một cách hiểu mà họ chưa chọn. (Người dùng vừa gửi thêm tin thì coi như đã trả lời → chạy tiếp.
          // Chỉ dừng khi lựa chọn THỰC SỰ được tạo — bị chặn vì đã sửa tệp thì vẫn phải làm nốt.)
          if (steered.length === 0 && !!session.options?.length && calls.some((c) => c.name === 'offer_options' && !c.parseError)) {
            result = 'end_turn';
            break;
          }
          lastWasToolResults = true;
          continuations = 0;
          continue;
        }

        // ── Không có công cụ ─────────────────────────────────────────────────────
        // Model dừng mà không gọi công cụ nhưng người dùng đã xếp hàng tin mới → đó là lượt kế tiếp của CÙNG lần chạy.
        if (stop !== 'pause_turn' && !signal.aborted) {
          const next = takeQueued(false);
          if (next.length > 0) {
            session.messages.push({ role: 'user', content: next, ts: Date.now() });
            lastWasToolResults = false;
            continuations = 0;
            emptyNudges = 0;
            for (const ext of active) this.safeCall(ext, 'queuedTurn', () => ext.hooks.queuedTurn?.(), hostLog);
            continue;
          }
        }
        if (stop === 'max_tokens' && !wrapUp && !textOf(message).trim()) {
          // (lane:output-timeouts) Chạm trần mà CHƯA có chữ nào (suy luận nuốt hết trần): không có «phần 1» để nối tiếp. Bỏ tin rỗng khỏi lịch sử
          // (Anthropic/Gemini từ chối content rỗng) và thử lại đúng một lần với trần đầy đủ; vẫn rỗng thì dừng kèm thông báo rõ nguyên nhân.
          session.messages.pop();
          const fullTokens = pickOutputBudget({ userText: userInputText, maxSetting: settings.maxOutputTokens, modelCap: settings.modelMaxOutputTokens, longWriteSeen, continuation: true, adaptive: true, thinkingLevel: session.thinkingLevel }).tokens;
          if (!emptyCutRetried && fullTokens > outputBudget.tokens) {
            emptyCutRetried = true;
            notice('warn', t(lang, 'maxTokensEmptyRetry'));
            continue;
          }
          notice('warn', t(lang, 'maxTokensEmptyStop'));
          break;
        }
        if (stop === 'max_tokens' && !wrapUp) {
          // (lane:output-timeouts) Cắt về ranh giới câu/mục (đóng khối mã dở), hiện «[tiếp phần N]», rồi tự nối tiếp tối đa 2 lần;
          // hết lượt tự nối thì HIỆN NÚT «Chạy tiếp phần N» thay vì dừng im lặng. Lịch sử lưu bản đã cắt (không có dòng đánh dấu).
          const cut = trimAssistantTail(message);
          const nextPart = continuations + 2;
          emit({ t: 'text', id, delta: `${cut?.appended ?? ''}\n\n${continuationMarker(lang, nextPart)}\n\n`, ...(cut?.removed ? { trimTail: cut.removed } : {}) });
          if (continuations < 2) {
            continuations++;
            notice('info', t(lang, 'maxTokensContinue'));
            session.messages.push(userText(t(lang, 'continuePartPrompt', { n: nextPart }), { synthetic: true }));
            continue;
          }
          const option = continuePartOption(lang, nextPart);
          session.options = [option];
          emit({ t: 'options', id, options: [option] });
          notice('info', t(lang, 'maxTokensButton', { n: nextPart }));
          break;
        }
        if (stop === 'pause_turn') continue;

        const text = textOf(message).trim();
        if (!text && lastWasToolResults && emptyNudges < 1 && !wrapUp) {
          emptyNudges++;
          session.messages.push(userText(t(lang, 'emptyReplyNudge'), { synthetic: true }));
          continue;
        }
        // Chế độ lập kế hoạch: các bước trong danh sách là KẾ HOẠCH chờ người dùng duyệt (chưa được phép làm) — chưa xong là điều đương nhiên,
        // không nhắc và không báo "còn việc dở". Duyệt kế hoạch (`exit_plan_mode`) đổi chế độ, từ đó cổng làm việc bình thường.
        const pendingTodos = session.mode === 'plan' ? [] : session.todos.filter((x) => x.status !== 'completed');
        // Cổng hoàn thành, kiểm tra độc lập, hook Stop… đều là extension (xem seams.ts) — engine chỉ hỏi: chấp nhận, buộc làm tiếp, hay dừng.
        const verdict = await this.runFinalize(active, { turn: turnInfo, message, text, stop, pendingTodos, aborted: signal.aborted }, hostLog);
        if (verdict.action === 'continue') {
          session.messages.push(userText(verdict.message, { synthetic: true }));
          continue;
        }
        if (verdict.action === 'halt' && verdict.notice) notice(verdict.notice.level, verdict.notice.text);
        break;
      }
    } finally {
      session.updatedAt = Date.now();
      for (const ext of active) await this.safeCallAsync(ext, 'end', () => ext.hooks.end?.({ stopReason: result, turns }), hostLog);
      emit({ t: 'assistant_end', id, stopReason: result });
    }
    return { stopReason: result, turns, assistantId: id };
  }

  /**
   * (lane:output-timeouts) Model treo lần thứ hai liên tiếp: giữ phần chữ đã sinh (cắt về ranh giới câu, đóng khối mã dở) làm tin assistant,
   * bỏ lệnh gọi công cụ dở dang (không có `done` nên không có tool_use nào được lưu), rồi thông báo ba phần + nút «Chạy tiếp».
   */
  private finishAfterStall(i: {
    session: SessionState;
    id: string;
    lang: Lang;
    turns: number;
    trace: RunTrace;
    partialText: string;
    erasedPartial: string;
    sec: number;
    emit(ev: UiEvent): void;
    notice(level: 'info' | 'warn' | 'error', text: string): void;
  }): void {
    // Lần thử lại không sinh gì → dùng lại chữ của lần đầu (đã xoá khỏi giao diện) và hiện lại nó.
    const reuse = !i.partialText.trim() && !!i.erasedPartial.trim();
    const kept = trimToBoundary(reuse ? i.erasedPartial : i.partialText);
    if (kept.text.trim()) {
      i.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: kept.text }], provider: this.d.provider.id, model: i.session.model, ts: Date.now() });
      if (reuse) i.emit({ t: 'text', id: i.id, delta: kept.text });
      else if (kept.removed || kept.appended) i.emit({ t: 'text', id: i.id, delta: kept.appended, ...(kept.removed ? { trimTail: kept.removed } : {}) });
    }
    const facts = stopFacts({ reason: 'stall', turns: i.turns, trace: i.trace, session: i.session });
    i.notice('warn', `${t(i.lang, 'stallGiveUp', { sec: i.sec })}\n${forcedStopSummary(i.lang, facts)}`);
    const option = continueWorkOption(i.lang);
    i.session.options = [option];
    i.emit({ t: 'options', id: i.id, options: [option] });
  }

  // ── seams: gọi móc của extension (ngoại lệ không làm hỏng lần chạy) ─────────────────────────────────────────

  private safeCall(ext: ActiveExtension, hook: string, fn: () => unknown, log: (level: 'warn', message: string) => void): void {
    try {
      fn();
    } catch (err) {
      log('warn', `Extension "${ext.id}" lỗi ở móc ${hook}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async safeCallAsync(ext: ActiveExtension, hook: string, fn: () => unknown, log: (level: 'warn', message: string) => void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log('warn', `Extension "${ext.id}" lỗi ở móc ${hook}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Móc `beforeModel`: chữ các extension trả về được NỐI vào lịch sử (và lưu). Nếu tin cuối là tin người dùng mang kết quả công cụ thì gộp vào chính nó
   * (giữ vai trò xen kẽ ở mọi hãng); ngược lại thành một tin synthetic riêng.
   */
  private async runBeforeModel(active: readonly ActiveExtension[], turn: TurnInfo, session: SessionState, log: (level: 'warn', message: string) => void): Promise<void> {
    const texts: string[] = [];
    for (const ext of active) {
      if (!ext.hooks.beforeModel) continue;
      try {
        const r = await ext.hooks.beforeModel(turn);
        if (Array.isArray(r)) for (const x of r) if (typeof x === 'string' && x.trim()) texts.push(x);
      } catch (err) {
        log('warn', `Extension "${ext.id}" lỗi ở móc beforeModel: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (texts.length === 0) return;
    const blocks: ContentBlock[] = texts.map((text) => ({ type: 'text', text }));
    const last = session.messages[session.messages.length - 1];
    if (last && last.role === 'user' && last.content.some((b) => b.type === 'tool_result')) {
      session.messages[session.messages.length - 1] = { ...last, content: [...last.content, ...blocks] };
    } else {
      session.messages.push({ role: 'user', content: blocks, synthetic: true, ts: Date.now() });
    }
  }

  /** Móc `finalize`: extension đầu tiên trả về khác 'accept' thắng; không extension nào can thiệp → chấp nhận. */
  private async runFinalize(active: readonly ActiveExtension[], ctx: FinalizeContext, log: (level: 'warn', message: string) => void): Promise<FinalizeDecision> {
    for (const ext of active) {
      if (!ext.hooks.finalize) continue;
      try {
        const d = await ext.hooks.finalize(ctx);
        if (d && d.action !== 'accept') return d;
      } catch (err) {
        log('warn', `Extension "${ext.id}" lỗi ở móc finalize: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { action: 'accept' };
  }

  /** Nén thủ công (/compact) hoặc khi lỗi tràn ngữ cảnh. Chỉ trả dòng chữ; cần số liệu cho giao diện thì dùng `compactWith`. */
  async compactNow(session: SessionState, signal: AbortSignal, opts: { instructions?: string } = {}): Promise<string | null> {
    return (await this.compactWith(session, signal, opts))?.text ?? null;
  }

  /** (lane:ctx-compaction) Nén thủ công kèm chỉ dẫn tuỳ chọn của người dùng; trả dòng thông báo + số liệu `CompactInfo` (null = không có gì để nén). */
  async compactWith(session: SessionState, signal: AbortSignal, opts: { instructions?: string } = {}): Promise<{ text: string; compact: CompactInfo } | null> {
    const lang = this.d.settings.language;
    const c = this.d.compactor ?? { provider: this.d.provider, model: session.model };
    const r = await compactIfNeeded({
      session,
      provider: c.provider,
      model: c.model,
      language: lang,
      signal,
      contextWindow: this.d.settings.contextWindow,
      compactAt: this.d.settings.compactAt,
      tuning: compactTuningFrom(this.d.settings),
      instructions: opts.instructions,
      force: true,
      mode: 'manual',
    });
    // Người dùng chủ động bấm nén: nếu model tóm tắt lỗi (sai khoá, mất mạng…) phải nói thật, không báo "không có gì để nén".
    if (r.error && r.summarizedMessages === 0 && r.pruned === 0) throw new Error(`Không nén được hội thoại: ${r.error}`);
    if (r.summarizedMessages > 0) this.fireCompacted(session);
    return compactNoticeOf(lang, r);
  }

  // ── nội bộ ────────────────────────────────────────────────────────────────────

  /** Bản tóm tắt nằm ở tin tổng hợp đầu tiên (`<tom_tat_hoi_thoai_truoc_do>`): chuyển cho hook mà không chặn lượt chạy. */
  private fireCompacted(session: SessionState): void {
    const hook = this.d.onCompacted;
    if (!hook) return;
    const head = session.messages[0];
    const text = head?.content.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text ?? '';
    const summary = (/<tom_tat_hoi_thoai_truoc_do>\n?([\s\S]*?)\n?<\/tom_tat_hoi_thoai_truoc_do>/.exec(text)?.[1] ?? '').trim();
    if (!summary) return;
    void Promise.resolve()
      .then(() => hook({ session, summary }))
      .catch((err) => this.d.host.log('warn', `Hook sau khi nén ngữ cảnh lỗi: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async compact(session: SessionState, signal: AbortSignal, id: string, force: boolean): Promise<boolean> {
    if (!this.d.settings.autoCompact && !force) return false;
    const lang = this.d.settings.language;
    const c = this.d.compactor ?? { provider: this.d.provider, model: session.model };
    const r = await compactIfNeeded({
      session,
      provider: c.provider,
      model: c.model,
      language: lang,
      signal,
      contextWindow: this.d.settings.contextWindow,
      compactAt: this.d.settings.compactAt,
      tuning: compactTuningFrom(this.d.settings), // (lane:ctx-compaction)
      force,
      mode: force ? 'overflow' : 'auto', // (lane:ctx-compaction)
      onStart: () =>
        this.d.emit({ t: 'pill', id, pillId: `${id}:compact`, text: t(lang, 'compacting'), kind: 'working' }),
    });
    if (r.error) this.d.host.log('warn', `Nén ngữ cảnh: không tóm tắt được (${r.error})`);
    if (r.summarizedMessages > 0) this.fireCompacted(session);
    const msg = compactNoticeOf(lang, r); // (lane:ctx-compaction) dòng chữ + số liệu thật (tokensFreed, clearedResults, summary)
    if (msg) this.d.emit({ t: 'notice', id, level: 'info', text: msg.text, compact: msg.compact });
    return r.pruned > 0 || r.summarizedMessages > 0;
  }

  private async handleProviderError(
    err: unknown,
    ctx: {
      session: SessionState;
      signal: AbortSignal;
      id: string;
      lang: Lang;
      providerLabel: string;
      compactedForOverflow: boolean;
      notice(level: 'info' | 'warn' | 'error', text: string): void;
    },
  ): Promise<'retry' | 'aborted' | 'error'> {
    const { lang, providerLabel } = ctx;
    if (ctx.signal.aborted || (err instanceof ProviderError && err.kind === 'aborted')) return 'aborted';

    if (!(err instanceof ProviderError)) {
      const detail = err instanceof Error ? err.message : String(err);
      this.d.host.log('error', `Lỗi không mong đợi khi gọi model: ${err instanceof Error ? err.stack ?? detail : detail}`);
      ctx.notice('error', t(lang, 'providerError', { provider: providerLabel, detail }));
      return 'error';
    }

    this.d.host.log('warn', `ProviderError(${err.kind}${err.status ? ' ' + err.status : ''}): ${err.message}${err.details ? ' — ' + err.details : ''}`);
    // Token tài khoản Locaith hỏng (401 của cổng): đây KHÔNG phải khoá API — nhờ host kiểm tra lại tài khoản thay vì bảo người dùng nhập khoá.
    if (err.accountAuth) {
      this.d.onAccountInvalid?.();
      ctx.notice('error', t(lang, 'accountInvalid'));
      return 'error';
    }
    // Câu tiếng Việt do máy chủ soạn sẵn (hết hạn mức ngày, quá nhiều lượt, bảo trì, model không tồn tại…): hiện nguyên văn, không thay bằng câu chung "chạm giới hạn tốc độ… chờ N phút".
    if (err.verbatim && err.message) {
      ctx.notice('error', err.message);
      return 'error';
    }
    switch (err.kind) {
      case 'context_length':
        if (!ctx.compactedForOverflow && (await this.compact(ctx.session, ctx.signal, ctx.id, true))) return 'retry';
        ctx.notice('error', t(lang, 'contextTooLong'));
        return 'error';
      case 'auth':
        ctx.notice('error', t(lang, 'authError', { provider: providerLabel }));
        return 'error';
      case 'consent_required':
        // Cổng Locaith chưa có bản ghi đồng ý của tài khoản (hoặc đã đổi phiên bản thông báo): mở lại thẻ trong khung chat; sau khi đồng ý, nút «Thử lại» chạy lại.
        this.d.onConsentRequired?.();
        ctx.notice('error', t(lang, 'consentRequired', { provider: providerLabel }));
        return 'error';
      case 'rate_limit':
        ctx.notice('error', t(lang, 'rateLimit', { provider: providerLabel }));
        return 'error';
      case 'queued':
      case 'overloaded':
        ctx.notice('error', t(lang, 'overloaded', { provider: providerLabel }));
        return 'error';
      case 'network':
      case 'timeout':
        ctx.notice('error', t(lang, 'networkError', { provider: providerLabel, detail: err.message }));
        return 'error';
      default:
        ctx.notice('error', t(lang, 'providerError', { provider: providerLabel, detail: err.message }));
        return 'error';
    }
  }

  /** Gắn nhãn nguồn, tách thẻ <think> khỏi chữ (nếu cần), bỏ khối chữ rỗng. */
  private normalizeAssistant(message: ChatMessage, session: SessionState): ChatMessage {
    const out: ContentBlock[] = [];
    for (const b of message.content) {
      if (b.type === 'text' && this.d.thinkTags) {
        const { thinking, text } = splitThinkTags(b.text);
        if (thinking) out.push({ type: 'thinking', text: thinking, provider: this.d.provider.id });
        if (text.trim()) out.push({ ...b, text });
      } else if (b.type === 'text' && !b.text.trim()) {
        continue;
      } else {
        out.push(b);
      }
    }
    return {
      ...message,
      role: 'assistant',
      content: out,
      provider: message.provider ?? this.d.provider.id,
      model: message.model ?? session.model,
      ts: message.ts ?? Date.now(),
    };
  }

  private recordUsage(session: SessionState, usage: Usage, id: string): void {
    // Quy ước của lớp provider: inputTokens = TỔNG token đầu vào (đã gồm phần đọc/ghi cache) → chính là cỡ ngữ cảnh.
    const fresh = usage.inputTokens;
    session.lastContextTokens = fresh;
    session.usageTotals.input += usage.inputTokens;
    session.usageTotals.output += usage.outputTokens;
    this.d.emit({ t: 'usage', id, usage, contextTokens: fresh });
  }

  private async runTools(
    calls: ToolUseBlock[],
    session: SessionState,
    id: string,
    signal: AbortSignal,
    available: ReadonlySet<string>,
    recentSigs: string[],
    lang: Lang,
    trace: RunTrace,
    active: readonly ActiveExtension[],
    turn: number,
  ): Promise<ToolResultBlock[]> {
    // Chặn vòng lặp vô ích: cùng một lệnh với cùng đối số lặp lại ≥ 3 lần.
    const blocked = new Map<string, ToolResultBlock>();
    const toRun: ToolUseBlock[] = [];
    for (const c of calls) {
      const sig = `${c.name}|${JSON.stringify(c.input)}`;
      const repeats = recentSigs.filter((s) => s === sig).length;
      const exempt = REPEAT_EXEMPT.has(c.name) || this.d.registry.get(c.name)?.repeatExempt === true;
      // Hỏi lại sau khi ĐÃ làm là sai ý người dùng: nếu lượt này đã sửa/ghi tệp thì `offer_options` bị chặn và
      // mô hình được yêu cầu hoàn tất + báo kết quả. (Cần duyệt giữa việc thì dùng cơ chế xin phép, không dùng nút.)
      const lateAsk = c.name === 'offer_options' && trace.wrote && !c.parseError;
      if (lateAsk) {
        const content =
          lang === 'en'
            ? 'You already changed files in this run, so the work is not ambiguous any more: do not ask the user to pick a direction now. Finish the remaining work, verify it, and report the result with evidence.'
            : 'Bạn đã sửa tệp trong lượt này rồi nên việc không còn mơ hồ nữa: đừng hỏi người dùng chọn hướng lúc này. Hãy làm nốt phần còn lại, kiểm chứng rồi báo kết quả kèm bằng chứng.';
        this.d.emit({ t: 'tool_start', id, callId: c.id, name: c.name, args: c.input });
        this.d.emit({ t: 'tool_end', id, callId: c.id, state: 'error', output: content, durationMs: 0 });
        blocked.set(c.id, { type: 'tool_result', toolUseId: c.id, name: c.name, content, isError: true });
        continue;
      }
      if (!exempt && repeats >= 2 && !c.parseError) {
        // Lệnh bị chặn KHÔNG được nạp lại vào cửa sổ, nếu không việc chặn sẽ kéo dài mãi.
        const content =
          lang === 'en'
            ? 'You already made this exact call several times with the same arguments. Change your approach (different arguments or another tool), or stop and explain the blocker to the user.'
            : 'Bạn đã gọi lệnh này với đúng các đối số đó nhiều lần rồi. Hãy đổi cách tiếp cận (đối số khác hoặc công cụ khác), hoặc dừng lại và báo cho người dùng biết vướng mắc ở đâu.';
        this.d.emit({ t: 'tool_start', id, callId: c.id, name: c.name, args: c.input });
        this.d.emit({ t: 'tool_end', id, callId: c.id, state: 'error', output: content, durationMs: 0 });
        blocked.set(c.id, { type: 'tool_result', toolUseId: c.id, name: c.name, content, isError: true });
      } else {
        recentSigs.push(sig);
        if (recentSigs.length > 14) recentSigs.shift();
        toRun.push(c);
      }
    }
    const ran = toRun.length ? await this.dispatcher.runBatch({ calls: toRun, session, assistantId: id, signal, available, hooks: active }) : [];
    const resultOf = new Map(ran.map((r) => [r.toolUseId, r]));
    // Ghi lại việc ĐÃ THẬT SỰ chạy (không phải việc mô hình nói đã làm): căn cứ cho cổng hoàn thành ở cuối lượt.
    // Artifact (báo cáo, dashboard) không phải mã nguồn phải chạy test — chỉ ghi tệp trong workspace mới cần kiểm chứng.
    for (const c of toRun) {
      const risk = this.d.registry.get(c.name)?.risk;
      const res = resultOf.get(c.id);
      const ok = !!res && !res.isError;
      const entry: TraceCall = { callId: c.id, name: c.name, risk: risk ?? 'unknown', input: (c.input ?? {}) as Record<string, unknown>, turn, ts: Date.now(), ok, resultHead: (res?.content ?? '').slice(0, 200) };
      trace.calls.push(entry);
      if (risk === 'write' && !ARTIFACT_TOOLS.has(c.name)) trace.wrote = true;
      else if (risk === 'exec') trace.execs++;
    }
    // Sau khi sửa/ghi tệp hay thao tác lên trang web, thế giới đã đổi: đọc lại tệp, chạy lại `npm test`, chụp lại trang (page_snapshot) là việc chính đáng, không phải vòng lặp.
    if (toRun.some((c) => { const risk = this.d.registry.get(c.name)?.risk; return risk === 'write' || risk === 'act'; })) recentSigs.length = 0;
    const byId = new Map(ran.map((r) => [r.toolUseId, r]));
    return calls.map((c) => blocked.get(c.id) ?? byId.get(c.id)!);
  }
}
