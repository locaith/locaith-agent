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

/** Provider giả chạy theo kịch bản: mỗi lần stream() lấy một bước từ hàng đợi. */
export class FakeProvider implements LLMProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly kind: ProviderKind;
  readonly flavor: ProviderFlavor = 'generic';
  readonly capabilities: ProviderCapabilities = { reasoning: 'native-visible', parallelTools: true, vision: false, toolArgStreaming: 'incremental' };
  requests: StreamRequest[] = [];
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
    this.requests.push({ ...req, messages: structuredClone(req.messages), tools: [...req.tools] });
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
