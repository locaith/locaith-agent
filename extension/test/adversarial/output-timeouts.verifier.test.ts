import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_OUTPUT_TOKENS } from '../../src/core/engine/outputBudget';
import { t } from '../../src/core/engine/strings';
import {
  ProviderError,
  textOf,
  type CompleteRequest,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderFlavor,
  type ProviderKind,
  type StreamRequest,
} from '../../src/core/types';
import type { TItem } from '../../src/shared/protocol';
import { applyEvent } from '../../src/shared/transcript';
import { textTurn } from '../helpers/fakeProvider';
import { eventsOf, makeHarness } from '../helpers/harness';

/**
 * Kiểm chứng ĐỐI KHÁNG cho lane output-timeouts (H04/H05/B04/B08). Mỗi test ở đây phải ĐỎ trên mã hiện tại
 * của nhánh parity/output-timeouts — đó là bằng chứng của một lỗi thật, không phải minh hoạ.
 *
 * Chạy: npx vitest run test/adversarial/output-timeouts.verifier.test.ts
 */

const USAGE = { inputTokens: 100, outputTokens: 20 };
const cutTurn = (text: string): ProviderEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'max_tokens', usage: USAGE, message: { role: 'assistant', content: [{ type: 'text', text }] } },
];

/** Dựng lại transcript trên giao diện bằng đúng reducer dùng chung (webview / Chrome / Remote) từ các UiEvent engine đã phát. */
function uiTextOf(events: ReturnType<typeof makeHarness>['events']): string {
  let items: TItem[] = [];
  for (const ev of events) items = applyEvent(items, ev);
  return items
    .filter((it): it is Extract<TItem, { kind: 'assistant' }> => it.kind === 'assistant')
    .flatMap((a) => a.blocks)
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
}

describe('H04/H05 — nút «Continue with part N» (tiếng Anh) phải được coi là lượt viết tiếp → trần ĐẦY ĐỦ', () => {
  it('sau 3 lần bị cắt (en) hiện nút; bấm nút = gửi prompt của nút → lần gọi kế phải dùng trần đầy đủ, không phải 8k', async () => {
    const h = makeHarness(
      [() => cutTurn('Part one done. Half'), () => cutTurn('Part two done. Half'), () => cutTurn('Part three done. Half'), () => textTurn('Part four done.')],
      { settings: { language: 'en' } },
    );
    await h.run('short question');
    const option = h.session.options?.[0];
    expect(option).toMatchObject({ id: 'continue-part-4', kind: 'continue' });
    // Người dùng bấm nút trên giao diện = gửi nguyên `prompt` của nút như một tin mới (OptionsBar.tsx: post({type:'send', text: o.prompt})).
    await h.run(option!.prompt);
    expect(h.provider.requests).toHaveLength(4);
    // Lane tự khai: "Nút «Chạy tiếp phần N» gửi câu có dấu phần → cũng là viết dài" (outputBudget.ts CONTINUATION_MARK_RE).
    // Với tiếng Anh, continuePartPrompt = "Continue with part 4 from exactly where you stopped…" KHÔNG khớp regex → rơi về 8k.
    expect(h.provider.requests[3].maxOutputTokens).toBe(LONG_OUTPUT_TOKENS);
  });
});

describe('H05 — chạm trần khi CHƯA có chữ nào hiện ra (suy luận nuốt hết trần 8k)', () => {
  it('không được hiện «[tiếp phần 2]» dưới một câu trả lời rỗng; không được ra lệnh "viết tiếp phần 2, không lặp phần trước"', async () => {
    const thinkingOnlyCut = (): ProviderEvent[] => [
      { type: 'thinking_delta', text: 'đang cân nhắc…' },
      {
        type: 'done',
        stopReason: 'max_tokens',
        usage: USAGE,
        message: { role: 'assistant', content: [{ type: 'thinking', text: 'đang cân nhắc…', provider: 'fake' }] },
      },
    ];
    const h = makeHarness([thinkingOnlyCut, () => textTurn('Câu trả lời thật.')]);
    const r = await h.run('sửa lỗi ở hàm parse');
    expect(r.stopReason).toBe('end_turn');
    expect(textOf(h.session.messages.at(-1)!)).toBe('Câu trả lời thật.');
    // Giao diện: không có "phần 1" nào thì không thể có "[tiếp phần 2]".
    expect(uiTextOf(h.events)).not.toContain(t('vi', 'partMarker', { n: 2 }));
    // Chỉ dẫn gửi model: không được bảo "viết tiếp phần 2 … không lặp lại phần trước" khi chưa có phần nào.
    const synthetic = h.session.messages.filter((m) => m.synthetic).map((m) => textOf(m));
    expect(synthetic).not.toContain(t('vi', 'continuePartPrompt', { n: 2 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B04 — watchdog: chữ dở của lần treo phải được XOÁ khỏi giao diện trước khi thử lại (kể cả khi sau chữ đã có dòng trạng thái)
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

describe('B04 — treo giữa lúc ghi tệp: chữ dở của lần 1 phải biến mất khỏi giao diện khi thử lại', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('model nói một câu rồi mở write_file (dòng trạng thái «Đang soạn…» đứng SAU chữ) rồi treo → sau khi thử lại OK, giao diện chỉ còn chữ của lần 2', async () => {
    const provider = new HangProvider([
      hang([
        { type: 'text_delta', text: 'Tôi sẽ ghi tệp a.md ngay bây giờ. Nội dung đang' },
        { type: 'tool_start', id: 'c1', name: 'write_file' },
        { type: 'tool_args_delta', id: 'c1', name: 'write_file', delta: '{"path":"a.md","content":"# Tiêu đề\\n\\nDòng một' },
      ]),
      ok('Đã ghi xong a.md.'),
    ]);
    const h = makeHarness([], { engineDeps: { provider }, settings: { modelStallSeconds: 5, modelCallMaxSeconds: 600 } });
    const run = h.run('tạo a.md');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(5_100); // lần 1 treo → thử lại
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    expect(provider.requests).toHaveLength(2);
    // Lịch sử chỉ có chữ của lần thử lại…
    expect(h.session.messages.filter((m) => m.role === 'assistant').map((m) => textOf(m))).toEqual(['Đã ghi xong a.md.']);
    // …thì giao diện (reducer dùng chung cho webview/Chrome/Remote) cũng phải như vậy: chữ dở của lần treo không được còn lại / lặp đôi.
    expect(uiTextOf(h.events)).toBe('Đã ghi xong a.md.');
  });
});
