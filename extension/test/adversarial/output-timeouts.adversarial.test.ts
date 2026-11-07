import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLongFormRequest, pickOutputBudget, SHORT_OUTPUT_TOKENS } from '../../src/core/engine/outputBudget';
import { StallError, watchStream } from '../../src/core/engine/stallWatchdog';
import { trimToBoundary } from '../../src/core/engine/truncation';
import { buildThinkingParams } from '../../src/core/providers/anthropic';
import { buildThinkingConfig } from '../../src/core/providers/gemini';
import { applyEvent } from '../../src/shared/transcript';
import type { AssistantItem, TItem } from '../../src/shared/protocol';
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
} from '../../src/core/types';
import { textTurn } from '../helpers/fakeProvider';
import { eventsOf, makeHarness } from '../helpers/harness';

/**
 * Kiểm chứng ĐỐI KHÁNG cho lane output-timeouts. Mỗi test ở đây phải ĐỎ trên mã hiện tại và chỉ ra một lỗi thật.
 * Chạy: cd C:\locaith-agent-wt\output-timeouts\extension && npx vitest run test/adversarial/output-timeouts.adversarial.test.ts
 */

const USAGE = { inputTokens: 100, outputTokens: 20 };

describe('ADV-1 · heuristic viết dài không có ranh giới từ → câu lệnh sửa mã bình thường bị coi là "báo cáo/tài liệu"', () => {
  it.each([
    'fix the code and run the tests', // 'de an' (đề án không dấu) khớp giữa "co(de an)d"
    'I made an edit to parse.ts, please review', // 'de an' trong "ma(de an)"
    'sửa chính sách CORS trong server.ts', // 'sách' khớp trong "chính sách"
    'check document.getElementById in app.js', // 'document' = mọi câu hỏi DOM
    'rename the contractor variable', // 'contract' trong "contractor"
    'the parenthesis is unbalanced on line 3', // 'thesis' trong "paren(thesis)"
  ])('không phải yêu cầu viết dài: %s', (s) => {
    expect(isLongFormRequest(s)).toBe(false);
    expect(pickOutputBudget({ userText: s, maxSetting: 32_000, longWriteSeen: false, continuation: false, adaptive: true }).tokens).toBe(SHORT_OUTPUT_TOKENS);
  });
});

describe('ADV-2 · cắt về ranh giới làm HỞ khối mã đã đóng', () => {
  it('trả lời bị cắt ngay sau dấu đóng ``` (không có xuống dòng cuối) → phải giữ nguyên, không được xoá dấu đóng', () => {
    const text = 'Mã:\n```ts\nconst a = 1;\n```';
    const r = trimToBoundary(text);
    // Hiện tại: lùi về xuống dòng gần nhất → xoá "```" → khối mã mở lại; dòng «[tiếp phần 2]» và phần nối tiếp sẽ nằm TRONG khối mã.
    expect(r.removed).toBe(0);
    expect(r.text).toBe(text);
  });

  it('cũng vậy với ~~~ và với khối mã có chữ sau đó rồi bị cắt đúng sau fence', () => {
    const text = 'Ví dụ.\n\n~~~bash\nnpm test\n~~~';
    const r = trimToBoundary(text);
    expect(r.text.endsWith('~~~')).toBe(true);
    expect(r.removed).toBe(0);
  });
});

describe('ADV-3 · stopReason=max_tokens mà model KHÔNG sinh chữ nào (suy luận nuốt hết trần 8k) → vẫn hiện «[tiếp phần 2]»', () => {
  it('không có phần 1 thì không được công bố "tiếp phần 2" và không được bảo model "không lặp lại phần trước"', async () => {
    const h = makeHarness([
      () => [{ type: 'done', stopReason: 'max_tokens', usage: USAGE, message: { role: 'assistant', content: [] } }],
      () => textTurn('Trả lời thật.'),
    ]);
    const r = await h.run('hỏi ngắn');
    expect(r.stopReason).toBe('end_turn');
    const texts = eventsOf(h.events, 'text').map((e) => e.delta).join('');
    expect(texts).not.toContain('[tiếp phần');
    // lịch sử không được chứa tin assistant RỖNG (Anthropic/Gemini từ chối content rỗng ở lần gọi kế)
    expect(h.session.messages.filter((m) => m.role === 'assistant' && m.content.length === 0)).toHaveLength(0);
  });
});

describe('ADV-4 · trần 8k thích ứng không trừ ngân sách suy luận của adapter', () => {
  it('Gemini 2.5 mức medium: thinkingBudget 8192 ≥ maxOutputTokens 8000 → suy luận một mình đã có thể nuốt hết trần', () => {
    const cap = pickOutputBudget({ userText: 'sửa lỗi hàm parse', maxSetting: 32_000, modelCap: 65_536, longWriteSeen: false, continuation: false, adaptive: true }).tokens;
    const cfg = buildThinkingConfig('gemini-2.5-pro', 'medium', true, { noThinkingConfig: false, levelOverride: undefined }) as { thinkingBudget: number };
    expect(cfg.thinkingBudget).toBeLessThan(cap);
  });

  it('Claude 4.x (kiểu budget) mức high: budget_tokens bị kéo từ 24576 xuống 7999 vì max_tokens=8000', () => {
    const cap = pickOutputBudget({ userText: 'sửa lỗi hàm parse', maxSetting: 32_000, modelCap: 64_000, longWriteSeen: false, continuation: false, adaptive: true }).tokens;
    const p = buildThinkingParams('claude-sonnet-4-5', 'high', true, cap);
    expect((p.thinking as { budget_tokens: number }).budget_tokens).toBe(24_576);
  });
});

describe('ADV-5 · sau một sự kiện retry/queue mà rồi im hẳn, watchdog KHÔNG BAO GIỜ kêu', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('retry(delayMs 2 s) rồi im lặng 10 phút → phải có StallError (sau delayMs + stallMs), nhưng hiện tại chờ vô hạn', async () => {
    const ac = new AbortController();
    async function* src(): AsyncGenerator<ProviderEvent> {
      yield { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 2_000, reason: 'busy' };
      await new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    let timedOut: StallError | null = null;
    const run = (async () => {
      for await (const _ of watchStream(src(), { stallMs: 5_000, totalMs: 60_000 }, { onTimeout: (e) => { timedOut = e; ac.abort(); } })) void _;
    })();
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(timedOut).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADV-6 · engine: model treo SAU khi đã in chữ rồi mở công cụ ghi tệp → giao diện giữ lại câu dở của lần treo
// ─────────────────────────────────────────────────────────────────────────────

type HangStep = (req: StreamRequest) => AsyncGenerator<ProviderEvent, void, void>;
class HangProvider implements LLMProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly kind: ProviderKind = 'openai-chat';
  readonly flavor: ProviderFlavor = 'generic';
  readonly capabilities: ProviderCapabilities = { reasoning: 'native-visible', parallelTools: true, vision: false, toolArgStreaming: 'incremental' };
  requests: StreamRequest[] = [];
  constructor(private readonly steps: HangStep[]) {}
  stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = this.steps.shift();
    if (!step) throw new Error('HangProvider: hết kịch bản');
    return step(req);
  }
  async complete(_req: CompleteRequest): Promise<string> {
    return '';
  }
  async fetchModels(): Promise<ModelInfo[]> {
    return [{ id: 'fake-1', label: 'Fake 1' }];
  }
  async ping(): Promise<void> {}
}
const hang =
  (pre: ProviderEvent[] = []): HangStep =>
  async function* (req) {
    for (const ev of pre) yield ev;
    await new Promise<never>((_, reject) => {
      const fail = () => reject(new ProviderError('aborted', { kind: 'aborted', providerId: 'fake' }));
      if (req.signal.aborted) fail();
      else req.signal.addEventListener('abort', fail, { once: true });
    });
  };
const ok = (text: string): HangStep =>
  async function* () {
    for (const ev of textTurn(text)) yield ev;
  };
const tick = () => new Promise<void>((r) => setImmediate(r));
async function untilRequests(p: HangProvider, n: number): Promise<void> {
  for (let i = 0; i < 5000 && p.requests.length < n; i++) await tick();
  for (let i = 0; i < 20; i++) await tick();
}

describe('ADV-6 · xoá chữ dở trên giao diện khi thử lại chỉ đúng nếu khối CUỐI là chữ', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('treo lúc đang mở write_file (sau câu dở) → lần thử lại chạy tốt → transcript KHÔNG được còn câu dở của lần treo', async () => {
    const provider = new HangProvider([
      hang([{ type: 'text_delta', text: 'Đã xong câu một. Câu hai đang viết dở thì' }, { type: 'tool_start', id: 'c1', name: 'write_file' }]),
      ok('Xong rồi.'),
    ]);
    const h = makeHarness([], { engineDeps: { provider }, settings: { modelStallSeconds: 5, modelCallMaxSeconds: 600 } });
    const run = h.run('tạo tệp a.md');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(5_100);
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    // Lịch sử đúng: chỉ còn câu trả lời của lần thử lại.
    expect(h.session.messages.filter((m) => m.role === 'assistant').map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(''))).toEqual(['Xong rồi.']);
    // Giao diện (reducer dùng chung VS Code/Remote/Chrome): gộp mọi sự kiện → chữ hiển thị phải khớp lịch sử.
    let items: TItem[] = [];
    for (const ev of h.events) items = applyEvent(items, ev);
    const shown = items
      .filter((it): it is AssistantItem => it.kind === 'assistant')
      .flatMap((a) => a.blocks)
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(shown).not.toContain('Câu hai đang viết dở');
    expect(shown).toBe('Xong rồi.');
  });
});
