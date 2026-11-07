import {
  ProviderError,
  type CompleteRequest,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderFlavor,
  type ProviderKind,
  type StreamRequest,
  type Usage,
} from '../../src/core/types';

export type Step = (req: StreamRequest) => ProviderEvent[] | Promise<ProviderEvent[]>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type PayloadMessage = StreamRequest['messages'][number];

/** Dạng chữ của dòng ngân sách: "[vòng 3/200 · còn 197 vòng]" (vi) hoặc "[turn 3/200 · 197 turns left]" (en). */
const BUDGET_NOTE_RE = /^\[(?:vòng|turn) \d+\/\d+/;

/**
 * Dòng nhắc ngân sách vòng lặp `[vòng 3/200 · còn 197 vòng]` / `[turn 3/200 …]` mà harness gắn vào CUỐI payload của mỗi lần gọi:
 * một khối chữ `volatile` ở cuối tin NGƯỜI DÙNG cuối cùng (sau mọi tool_result). Trả về chữ của nó, hoặc undefined nếu payload không có.
 */
export function budgetNoteOf(messages: readonly PayloadMessage[]): string | undefined {
  const last = messages[messages.length - 1];
  const tail = last && last.role === 'user' ? last.content[last.content.length - 1] : undefined;
  return tail && tail.type === 'text' && tail.volatile === true && BUDGET_NOTE_RE.test(tail.text) ? tail.text : undefined;
}

/** Payload không kèm dòng ngân sách (đúng phần thuộc về cuộc trò chuyện). Không sửa mảng/tin đầu vào. */
export function stripBudgetNote(messages: readonly PayloadMessage[]): PayloadMessage[] {
  if (budgetNoteOf(messages) === undefined) return [...messages];
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, content: last.content.slice(0, -1) }];
}

/** Provider giả chạy theo kịch bản: mỗi lần stream() lấy một bước từ hàng đợi. */
export class FakeProvider implements LLMProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly kind: ProviderKind;
  readonly flavor: ProviderFlavor = 'generic';
  readonly capabilities: ProviderCapabilities = { reasoning: 'native-visible', parallelTools: true, vision: false, toolArgStreaming: 'incremental' };
  /**
   * Mỗi yêu cầu đã gửi, nhưng KHÔNG kèm dòng nhắc ngân sách `[vòng N/M …]` của harness (khối `volatile` cuối tin user cuối): test so sánh lịch sử nguyên văn chỉ quan tâm
   * những gì thuộc về cuộc trò chuyện (tin người dùng, kết quả công cụ, tin nhắc hoàn thành…). Hành vi của dòng ngân sách tự nó được
   * kiểm ở `rawRequests` (xem test/budgetNote.test.ts).
   */
  requests: StreamRequest[] = [];
  /** Cùng các yêu cầu đó nhưng NGUYÊN VĂN — đúng những gì adapter thật sẽ nhận (gồm cả dòng ngân sách ở cuối). */
  rawRequests: StreamRequest[] = [];
  completes: CompleteRequest[] = [];
  completeImpl?: (req: CompleteRequest) => Promise<string>;

  constructor(
    private readonly script: Step[],
    opts: { kind?: ProviderKind; eventDelayMs?: number } = {},
  ) {
    this.kind = opts.kind ?? 'openai-chat';
    this.eventDelayMs = opts.eventDelayMs ?? 0;
  }
  private readonly eventDelayMs: number;

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    // Chụp lại để test kiểm tra đúng những gì được gửi đi tại thời điểm đó.
    // `requests`: bỏ khối NHẮC NGÂN SÁCH do harness gắn vào cuối tin user cuối (khối `volatile` dạng "[vòng …]"): đó là chuyện của
    // engine, không phải nội dung người dùng gửi, nên không làm nhiễu phép so sánh lịch sử.
    // `rawRequests`: giữ nguyên văn để test chứng minh dòng ngân sách có mặt, đúng chỗ, đúng số.
    const cloned = structuredClone(req.messages);
    this.rawRequests.push({ ...req, messages: cloned, tools: [...req.tools] });
    this.requests.push({ ...req, messages: stripBudgetNote(structuredClone(req.messages)), tools: [...req.tools] });
    const step = this.script.shift();
    if (!step) throw new Error('FakeProvider: hết kịch bản');
    const events = await step(req);
    for (const ev of events) {
      if (req.signal.aborted) throw new ProviderError('aborted', { kind: 'aborted', providerId: this.id });
      yield ev;
      if (this.eventDelayMs) await sleep(this.eventDelayMs);
    }
  }

  async complete(req: CompleteRequest): Promise<string> {
    this.completes.push(req);
    return this.completeImpl ? this.completeImpl(req) : 'Đang đối chiếu dữ liệu giữa các nguồn';
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return [{ id: 'fake-1', label: 'Fake 1' }];
  }
  async ping(): Promise<void> {}
}

const USAGE: Usage = { inputTokens: 100, outputTokens: 20 };

export function textTurn(text: string, usage: Usage = USAGE): ProviderEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', usage, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ];
}

export interface FakeCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Ghi đè chuỗi đối số thô (để mô phỏng JSON hỏng/cụt). */
  rawArgs?: string;
}

export function toolTurn(
  calls: FakeCall[],
  opts: { pre?: ProviderEvent[]; text?: string; stopReason?: 'tool_use' | 'max_tokens'; usage?: Usage } = {},
): ProviderEvent[] {
  const events: ProviderEvent[] = [...(opts.pre ?? [])];
  const content: any[] = [];
  if (opts.text) {
    events.push({ type: 'text_delta', text: opts.text });
    content.push({ type: 'text', text: opts.text });
  }
  calls.forEach((c, i) => {
    const id = c.id ?? `call_${i + 1}`;
    const json = c.rawArgs ?? JSON.stringify(c.input);
    events.push({ type: 'tool_start', id, name: c.name });
    const mid = Math.max(1, Math.floor(json.length / 2));
    events.push({ type: 'tool_args_delta', id, name: c.name, delta: json.slice(0, mid) });
    events.push({ type: 'tool_args_delta', id, name: c.name, delta: json.slice(mid) });
    events.push({ type: 'tool_end', id, name: c.name });
    let parseError: string | undefined;
    let input = c.input;
    if (c.rawArgs !== undefined) {
      try {
        input = JSON.parse(c.rawArgs);
      } catch (e) {
        parseError = e instanceof Error ? e.message : 'json';
        input = {};
      }
    }
    content.push({ type: 'tool_use', id, name: c.name, input, ...(parseError ? { parseError, rawArgs: c.rawArgs } : {}) });
  });
  events.push({ type: 'done', stopReason: opts.stopReason ?? 'tool_use', usage: opts.usage ?? USAGE, message: { role: 'assistant', content } });
  return events;
}
