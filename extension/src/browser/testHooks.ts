/**
 * CHỈ có trong bản build kiểm thử (`--test`): cho kiểm thử tự động cài một nhà cung cấp theo kịch bản vào khung chat thật, để chạy
 * trọn đường engine → công cụ → trang web thật mà không cần khoá API. Không bao giờ có trong bản phát hành (cờ __ND_TEST__ = false).
 *
 * Mỗi lượt kịch bản: { text } (trả lời xong) hoặc { calls: [{ name, input }] } (gọi công cụ). Trong `input`, chuỗi `@ref:vai trò|tên|lần`
 * được thay bằng số ref tìm thấy trong kết quả page_snapshot gần nhất, ví dụ `@ref:button|Thêm vào giỏ|1`.
 */

import {
  ProviderError,
  type CompleteRequest,
  type ContentBlock,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type StreamRequest,
  type Usage,
} from '../core/types';
import type { ProviderService } from '../core/providers/service';
import type { BrowserController } from './controller';

export interface ScriptTurn {
  text?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
}

const USAGE: Usage = { inputTokens: 120, outputTokens: 30 };

function latestSnapshot(req: StreamRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== 'user') continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'tool_result' && b.name === 'page_snapshot') return b.content;
    }
  }
  return '';
}

function resolveRefs(value: unknown, snap: string): unknown {
  if (typeof value === 'string' && value.startsWith('@ref:')) {
    const [role, name, nth] = value.slice(5).split('|');
    const re = new RegExp(`^\\[(\\d+)\\] ${role} "([^"]*)"`, 'gm');
    const found: number[] = [];
    for (let m = re.exec(snap); m; m = re.exec(snap)) if (m[2].includes(name)) found.push(Number(m[1]));
    const n = Number(nth || 1);
    if (!found[n - 1]) throw new Error(`Kịch bản: không thấy ref cho ${value} trong snapshot`);
    return found[n - 1];
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, snap));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, snap)]));
  return value;
}

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly label = 'Scripted';
  readonly kind = 'openai-chat' as const;
  readonly flavor = 'generic' as const;
  readonly capabilities: ProviderCapabilities = { reasoning: 'native-visible', parallelTools: true, vision: true, toolArgStreaming: 'incremental' };
  requests: { tools: string[]; system: string; lastUser: string; images: number; results: { name: string; content: string }[] }[] = [];

  constructor(private readonly turns: ScriptTurn[]) {}

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const lastUser = req.messages.at(-1)?.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${b.name}: ${b.content.slice(0, 200)}]` : '')).join('\n') ?? '';
    const images = (req.messages.at(-1)?.content ?? []).reduce((n, b) => n + (b.type === 'image' ? 1 : b.type === 'tool_result' ? (b.images?.length ?? 0) : 0), 0);
    const results = (req.messages.at(-1)?.content ?? []).flatMap((b) => (b.type === 'tool_result' ? [{ name: b.name ?? '', content: b.content }] : []));
    this.requests.push({ tools: req.tools.map((t) => t.name), system: req.system, lastUser, images, results });
    const turn = this.turns.shift();
    if (!turn) throw new ProviderError('Kịch bản đã hết', { kind: 'unknown', providerId: this.id, retryable: false });
    const snap = latestSnapshot(req);
    if (turn.calls?.length) {
      const content: ContentBlock[] = [];
      for (const [i, c] of turn.calls.entries()) {
        const id = `call_${this.requests.length}_${i}`;
        const input = resolveRefs(c.input, snap) as Record<string, unknown>;
        const json = JSON.stringify(input);
        yield { type: 'tool_start', id, name: c.name };
        yield { type: 'tool_args_delta', id, name: c.name, delta: json };
        yield { type: 'tool_end', id, name: c.name };
        content.push({ type: 'tool_use', id, name: c.name, input });
      }
      yield { type: 'done', stopReason: 'tool_use', usage: USAGE, message: { role: 'assistant', content } };
      return;
    }
    const text = turn.text ?? 'Xong.';
    yield { type: 'text_delta', text };
    yield { type: 'done', stopReason: 'end_turn', usage: USAGE, message: { role: 'assistant', content: [{ type: 'text', text }] } };
  }

  async complete(_req: CompleteRequest): Promise<string> {
    return 'Đang xử lý dữ liệu';
  }
  async fetchModels(): Promise<ModelInfo[]> {
    return [{ id: 'scripted-1', label: 'Scripted 1' }];
  }
  async ping(): Promise<void> {}
}

export function installTestHooks(nd: { providers: ProviderService; controller: BrowserController }): void {
  (globalThis as unknown as { __ndTest: unknown }).__ndTest = {
    /** Cài kịch bản và chọn nó làm model hiện tại. Trả về hàm đọc các yêu cầu đã gửi. */
    async script(turns: ScriptTurn[]) {
      const provider = new ScriptedProvider(turns);
      nd.providers.registry.addExtraProvider(provider, [{ id: 'scripted-1', label: 'Scripted 1' }]);
      await nd.controller.setModel('scripted', 'scripted-1');
      (globalThis as unknown as { __ndScripted: ScriptedProvider }).__ndScripted = provider;
    },
    requests: () => (globalThis as unknown as { __ndScripted?: ScriptedProvider }).__ndScripted?.requests ?? [],
  };
}
