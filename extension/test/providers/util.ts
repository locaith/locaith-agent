/** Tiện ích dùng chung cho test adapter (không phải file test). */

import type { MockServer } from '../helpers/mockServer';
import {
  userText,
  type ChatMessage,
  type LLMProvider,
  type ProviderEvent,
  type ProviderRuntimeConfig,
  type StreamRequest,
} from '../../src/core/types';

export const TEST_KEY = 'test-key-1234567890abcdef';

export function runtimeConfig(
  server: MockServer,
  partial: Partial<ProviderRuntimeConfig> & Pick<ProviderRuntimeConfig, 'kind' | 'flavor'>,
): ProviderRuntimeConfig {
  return {
    id: partial.id ?? 'p',
    label: partial.label ?? 'P',
    baseUrl: server.url,
    getApiKey: async () => TEST_KEY,
    // Thử lại nhanh để test không phải chờ thật.
    options: { retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 25 } },
    ...partial,
  };
}

export function req(over: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: 'm',
    system: 'Bạn là trợ lý.',
    messages: [userText('Xin chào')],
    tools: [],
    maxOutputTokens: 1000,
    thinking: { level: 'medium', summaries: true },
    signal: new AbortController().signal,
    ...over,
  };
}

export type DoneEvent = Extract<ProviderEvent, { type: 'done' }>;

export interface RunResult {
  events: ProviderEvent[];
  done: DoneEvent;
}

export async function run(provider: LLMProvider, request: StreamRequest): Promise<RunResult> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.stream(request)) events.push(ev);
  const done = events.find((e): e is DoneEvent => e.type === 'done');
  if (!done) throw new Error('Luồng kết thúc mà không có sự kiện done');
  return { events, done };
}

export const kinds = (events: ProviderEvent[]): string[] => events.map((e) => e.type);

export const textOfEvents = (events: ProviderEvent[]): string =>
  events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('');

export const thinkingOfEvents = (events: ProviderEvent[]): string =>
  events.map((e) => (e.type === 'thinking_delta' ? e.text : '')).join('');

export const toolSchema = {
  type: 'object',
  properties: { query: { type: 'string', description: 'Từ khoá' } },
  required: ['query'],
} as const;

export const searchTool = { name: 'web_search', description: 'Tìm trên web', inputSchema: toolSchema as unknown as Record<string, unknown> };

/** Tin nhắn assistant chứa lệnh gọi công cụ + kết quả tương ứng (để test chuyển đổi lịch sử). */
export function toolRound(opts: {
  provider: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError?: boolean;
  extraAssistant?: ChatMessage['content'];
  raw?: unknown;
}): ChatMessage[] {
  return [
    {
      role: 'assistant',
      provider: opts.provider,
      content: [
        ...(opts.extraAssistant ?? []),
        { type: 'tool_use', id: opts.id, name: opts.name, input: opts.input, provider: opts.provider, ...(opts.raw !== undefined ? { raw: opts.raw } : {}) },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: opts.id, name: opts.name, content: opts.result, isError: opts.isError }],
    },
  ];
}
