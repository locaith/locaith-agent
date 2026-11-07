import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_OUTPUT_TOKENS, SHORT_OUTPUT_TOKENS } from '../src/core/engine/outputBudget';
import { t } from '../src/core/engine/strings';
import {
  ProviderError,
  textOf,
  type ChatMessage,
  type CompleteRequest,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderFlavor,
  type ProviderKind,
  type StreamRequest,
} from '../src/core/types';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';

/**
 * (lane:output-timeouts) Kiểm thử TÍCH HỢP qua engine thật + nhà cung cấp giả:
 *  H04 trần đầu ra thích ứng · H05 cắt đúng ranh giới + nối tiếp + nút «Chạy tiếp phần N» · B04 watchdog theo bậc (fake timers) ·
 *  B08 tổng kết ba phần khi hết vòng.
 */

const USAGE = { inputTokens: 100, outputTokens: 20 };
/** Lượt chữ bị cắt vì chạm trần đầu ra (không có công cụ). */
const cutTurn = (text: string): ProviderEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'max_tokens', usage: USAGE, message: { role: 'assistant', content: [{ type: 'text', text }] } },
];
const lastUserText = (req: StreamRequest): string =>
  req.messages
    .at(-1)!
    .content.filter((b): b is Extract<ChatMessage['content'][number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
const assistantTexts = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'assistant').map((m) => textOf(m));

describe('H05 — chạm trần đầu ra: cắt đúng ranh giới, đánh dấu phần, nối tiếp', () => {
  it('cắt giữa câu → lịch sử lưu bản đã lùi về hết câu; giao diện nhận trimTail + «[tiếp phần 2]»; tự nối tiếp bằng chỉ dẫn phần 2', async () => {
    const h = makeHarness([() => cutTurn('Phần một đã xong. Câu đang viết dở thì bị'), () => textTurn('Phần hai xong.')]);
    const r = await h.run('so sánh hai cách');
    expect(r.stopReason).toBe('end_turn');
    expect(assistantTexts(h.session.messages)).toEqual(['Phần một đã xong.', 'Phần hai xong.']);
    const trims = eventsOf(h.events, 'text').filter((e) => e.trimTail);
    expect(trims).toHaveLength(1);
    expect(trims[0].trimTail).toBe(' Câu đang viết dở thì bị'.length);
    expect(trims[0].delta).toContain('[tiếp phần 2]');
    // chỉ dẫn nối tiếp nói rõ "phần 2", không lặp phần trước — và được LƯU (synthetic)
    expect(lastUserText(h.provider.requests[1])).toBe(t('vi', 'continuePartPrompt', { n: 2 }));
    expect(h.session.messages.filter((m) => m.synthetic)).toHaveLength(1);
    expect(eventsOf(h.events, 'notice').map((n) => n.text)).toContain(t('vi', 'maxTokensContinue'));
    // không hiện nút khi đã tự nối tiếp thành công
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
  });

  it('lần gọi nối tiếp dùng trần ĐẦY ĐỦ dù câu hỏi ban đầu là lượt thường (8k)', async () => {
    const h = makeHarness([() => cutTurn('Một. Hai dở'), () => textTurn('Xong.')]);
    await h.run('hỏi ngắn');
    expect(h.provider.requests.map((r) => r.maxOutputTokens)).toEqual([SHORT_OUTPUT_TOKENS, LONG_OUTPUT_TOKENS]);
  });

  it('hết 2 lần tự nối tiếp mà vẫn bị cắt → HIỆN NÚT «Chạy tiếp phần 4» (kind continue) thay vì dừng im lặng', async () => {
    const h = makeHarness([() => cutTurn('A xong. A dở'), () => cutTurn('B xong. B dở'), () => cutTurn('C xong. C dở')]);
    const r = await h.run('viết');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.requests).toHaveLength(3);
    const opts = eventsOf(h.events, 'options');
    expect(opts).toHaveLength(1);
    expect(opts[0].options).toEqual([expect.objectContaining({ id: 'continue-part-4', kind: 'continue', label: 'Chạy tiếp phần 4' })]);
    expect(h.session.options?.[0]?.id).toBe('continue-part-4');
    expect(eventsOf(h.events, 'notice').map((n) => n.text)).toContain(t('vi', 'maxTokensButton', { n: 4 }));
    // ba dấu phần theo thứ tự
    expect(eventsOf(h.events, 'text').filter((e) => e.trimTail).map((e) => e.delta.trim())).toEqual(['[tiếp phần 2]', '[tiếp phần 3]', '[tiếp phần 4]']);
    expect(assistantTexts(h.session.messages)).toEqual(['A xong.', 'B xong.', 'C xong.']);
  });

  it('cắt giữa khối mã → đóng khối ``` trong lịch sử và trên giao diện (không để khối mã hở)', async () => {
    const h = makeHarness([() => cutTurn('Mã:\n```ts\nconst a = 1;\nconst b = '), () => textTurn('Hết.')]);
    await h.run('x');
    expect(assistantTexts(h.session.messages)[0]).toBe('Mã:\n```ts\nconst a = 1;\n```');
    const ev = eventsOf(h.events, 'text').find((e) => e.trimTail)!;
    expect(ev.delta.startsWith('\n```')).toBe(true);
  });

  it('đã có công cụ chạy cùng lượt (ranh giới tiếng Anh) → dấu phần tiếng Anh', async () => {
    const h = makeHarness([() => cutTurn('Done one. Half'), () => textTurn('Done two.')], { settings: { language: 'en' } });
    await h.run('x');
    expect(eventsOf(h.events, 'text').find((e) => e.trimTail)!.delta).toContain('[continued in part 2]');
    expect(lastUserText(h.provider.requests[1])).toBe(t('en', 'continuePartPrompt', { n: 2 }));
  });

  it('chạm trần khi đang gọi công cụ → lệnh cuối không chạy (đối số cụt), lần gọi kế được trần đầy đủ', async () => {
    const h = makeHarness(
      [() => toolTurn([{ name: 'list_dir', input: {} }, { name: 'write_file', input: { path: 'big.txt', content: 'cụt' } }], { stopReason: 'max_tokens' }), () => textTurn('ok')],
      { files: { 'x.txt': '1' } },
    );
    await h.run('x');
    const { existsSync } = await import('node:fs');
    expect(existsSync(h.dir + '/big.txt')).toBe(false);
    const ends = eventsOf(h.events, 'tool_end');
    expect(ends.find((e) => e.callId === 'call_2')?.state).toBe('error');
    // (lần gọi thứ 3 nếu có là của cổng hoàn thành — không thuộc lane này)
    expect(h.provider.requests.slice(0, 2).map((r) => r.maxOutputTokens)).toEqual([SHORT_OUTPUT_TOKENS, LONG_OUTPUT_TOKENS]);
  });
});

describe('H04 — trần đầu ra thích ứng truyền tới nhà cung cấp', () => {
  it('lượt thường → 8.000; yêu cầu báo cáo/tài liệu → trần đầy đủ; kẹp theo trần model; tắt thích ứng → luôn tối đa', async () => {
    const a = makeHarness([() => textTurn('ok')]);
    await a.run('sửa lỗi ở hàm parse');
    expect(a.provider.requests[0].maxOutputTokens).toBe(SHORT_OUTPUT_TOKENS);

    const b = makeHarness([() => textTurn('ok')]);
    await b.run('Viết báo cáo đầy đủ về hiệu năng');
    expect(b.provider.requests[0].maxOutputTokens).toBe(LONG_OUTPUT_TOKENS);

    const c = makeHarness([() => textTurn('ok')], { settings: { modelMaxOutputTokens: 16_000 } });
    await c.run('Viết báo cáo đầy đủ');
    expect(c.provider.requests[0].maxOutputTokens).toBe(16_000);

    const d = makeHarness([() => textTurn('ok')], { settings: { adaptiveOutputTokens: false } });
    await d.run('hỏi ngắn');
    expect(d.provider.requests[0].maxOutputTokens).toBe(LONG_OUTPUT_TOKENS);

    const e = makeHarness([() => textTurn('ok')], { settings: { maxOutputTokens: 12_000 } });
    await e.run('Write the full documentation');
    expect(e.provider.requests[0].maxOutputTokens).toBe(12_000);
  });

  it('sau khi gọi công cụ ghi nội dung dài (write_file) → các lần gọi sau trong cùng lượt dùng trần đầy đủ', async () => {
    const h = makeHarness([() => toolTurn([{ name: 'write_file', input: { path: 'a.md', content: 'x' } }]), () => toolTurn([{ name: 'read_file', input: { path: 'a.md' } }]), () => textTurn('ok')]);
    await h.run('tạo a.md');
    // (cổng hoàn thành có thể thêm lần gọi "kiểm chứng" ở cuối — mọi lần sau write_file đều phải là trần đầy đủ)
    const caps = h.provider.requests.map((r) => r.maxOutputTokens);
    expect(caps[0]).toBe(SHORT_OUTPUT_TOKENS);
    expect(caps.length).toBeGreaterThanOrEqual(3);
    expect(caps.slice(1).every((c) => c === LONG_OUTPUT_TOKENS)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B04 — watchdog: nhà cung cấp "treo" theo kịch bản
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

/** Phát `pre` rồi im hẳn cho tới khi bị huỷ (lúc đó ném 'aborted' như adapter thật). */
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
/** Phát `pre`, ngủ `ms` (fake), rồi phát `after`. */
const slow =
  (pre: ProviderEvent[], ms: number, after: ProviderEvent[]): HangStep =>
  async function* () {
    for (const ev of pre) yield ev;
    await new Promise((r) => setTimeout(r, ms));
    for (const ev of after) yield ev;
  };
const ok = (text: string): HangStep =>
  async function* () {
    for (const ev of textTurn(text)) yield ev;
  };

const STALL = { modelStallSeconds: 5, modelCallMaxSeconds: 600 } as const;

/** Nhường vòng lặp sự kiện THẬT (setImmediate không bị giả) — engine còn đọc tệp hướng dẫn, nén… trước khi gọi nhà cung cấp. */
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Chờ tới khi nhà cung cấp đã được gọi `n` lần (I/O thật), rồi vài nhịp nữa để generator bên trong tới chỗ chờ. */
async function untilRequests(p: HangProvider, n: number): Promise<void> {
  for (let i = 0; i < 5000 && p.requests.length < n; i++) await tick();
  for (let i = 0; i < 20; i++) await tick();
}

describe('B04 — watchdog theo bậc (fake timers)', () => {
  // Chỉ giả bộ hẹn giờ + Date; giữ setImmediate/nextTick/I-O thật để engine đi tới chỗ gọi model.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('treo lần 1 → báo + thử lại cùng lịch sử (không tính vòng); treo lần 2 → giữ phần đã viết, nút «Chạy tiếp», notice nói rõ nguyên nhân', async () => {
    const provider = new HangProvider([hang([{ type: 'text_delta', text: 'Đã xong câu một. Câu hai đang dở' }]), hang()]);
    const h = makeHarness([], { engineDeps: { provider }, settings: STALL });
    const run = h.run('làm việc');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(5_100); // lần 1 treo
    await untilRequests(provider, 2);
    await vi.advanceTimersByTimeAsync(5_100); // lần 2 treo
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    expect(r.turns).toBe(1); // lần thử lại không tính vào ngân sách vòng
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].messages).toEqual(provider.requests[1].messages); // cùng lịch sử, không chèn gì
    const notices = eventsOf(h.events, 'notice').map((n) => n.text);
    expect(notices).toContain(t('vi', 'stallRetry', { sec: 5 }));
    const giveUp = notices.find((x) => x.startsWith(t('vi', 'stallGiveUp', { sec: 5 })))!;
    expect(giveUp).toContain('• Đã làm');
    expect(giveUp).toContain('• Còn lại');
    expect(giveUp).toContain('• Chạy tiếp');
    // phần chữ đã sinh ở lần 1 được giữ, cắt về hết câu; giao diện: xoá phần dở của lần 1 trước khi thử lại, rồi hiện lại bản đã cắt khi chốt
    expect(assistantTexts(h.session.messages)).toEqual(['Đã xong câu một.']);
    const texts = eventsOf(h.events, 'text');
    expect(texts.find((e) => e.trimTail)).toMatchObject({ delta: '', trimTail: 'Đã xong câu một. Câu hai đang dở'.length });
    expect(texts.at(-1)).toMatchObject({ delta: 'Đã xong câu một.' });
    const opts = eventsOf(h.events, 'options');
    expect(opts.at(-1)!.options[0]).toMatchObject({ id: 'continue-work', kind: 'continue' });
    expect(h.session.options?.[0]?.id).toBe('continue-work');
    // không có lệnh gọi công cụ dở dang nào lọt vào lịch sử
    expect(h.session.messages.some((m) => m.content.some((b) => b.type === 'tool_use'))).toBe(false);
  });

  it('treo lần 1, lần thử lại chạy tốt → kết quả bình thường, không có nút', async () => {
    const provider = new HangProvider([hang(), ok('Xong rồi.')]);
    const h = makeHarness([], { engineDeps: { provider }, settings: STALL });
    const run = h.run('x');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(5_100);
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    expect(assistantTexts(h.session.messages)).toEqual(['Xong rồi.']);
    const notices = eventsOf(h.events, 'notice').map((n) => n.text);
    expect(notices).toContain(t('vi', 'stallRetry', { sec: 5 }));
    expect(notices.some((x) => x.startsWith(t('vi', 'stallGiveUp', { sec: 5 })))).toBe(false);
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
  });

  it('đứng HÀNG CHỜ của cổng (sự kiện queue) 20 s không bị tính là treo', async () => {
    const queue: ProviderEvent = { type: 'queue', position: 2, ahead: 1, attempt: 1, waitMs: 20_000, retryAt: Date.now() + 20_000 };
    const provider = new HangProvider([slow([queue], 20_000, textTurn('Sau hàng chờ.'))]);
    const h = makeHarness([], { engineDeps: { provider }, settings: STALL });
    const run = h.run('x');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(21_000);
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    expect(assistantTexts(h.session.messages)).toEqual(['Sau hàng chờ.']);
    expect(eventsOf(h.events, 'notice').map((n) => n.text)).not.toContain(t('vi', 'stallRetry', { sec: 5 }));
    expect(provider.requests).toHaveLength(1);
  });

  it('người dùng bấm Dừng ≠ hết hạn: không thử lại, không notice treo, kết quả aborted', async () => {
    const provider = new HangProvider([hang([{ type: 'text_delta', text: 'đang' }])]);
    const h = makeHarness([], { engineDeps: { provider }, settings: STALL });
    const ac = new AbortController();
    const run = h.run('x', ac.signal);
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await run;
    expect(r.stopReason).toBe('aborted');
    expect(provider.requests).toHaveLength(1);
    const notices = eventsOf(h.events, 'notice').map((n) => n.text);
    expect(notices.some((x) => x.includes('không gửi gì'))).toBe(false);
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
  });

  it('modelStallSeconds = 0 → watchdog tắt: im lặng 30 s vẫn chờ', async () => {
    const provider = new HangProvider([slow([], 30_000, textTurn('Chậm mà chắc.'))]);
    const h = makeHarness([], { engineDeps: { provider }, settings: { modelStallSeconds: 0 } });
    const run = h.run('x');
    await untilRequests(provider, 1);
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await run;
    expect(r.stopReason).toBe('end_turn');
    expect(assistantTexts(h.session.messages)).toEqual(['Chậm mà chắc.']);
    expect(eventsOf(h.events, 'notice')).toHaveLength(0);
  });

  it("ngưỡng 'auto' theo cỡ ngữ cảnh × mức suy luận: ngữ cảnh nhỏ, mức medium → 30 s (im 29 s không sao, im 31 s thì ngắt)", async () => {
    const fine = new HangProvider([slow([], 29_000, textTurn('ok'))]);
    const a = makeHarness([], { engineDeps: { provider: fine }, settings: { modelStallSeconds: 'auto' } });
    a.session.lastContextTokens = 10_000; // thinkingLevel mặc định của harness: medium → 20 s × 1,5
    const runA = a.run('x');
    await untilRequests(fine, 1);
    await vi.advanceTimersByTimeAsync(29_500);
    expect((await runA).stopReason).toBe('end_turn');
    expect(eventsOf(a.events, 'notice')).toHaveLength(0);

    const late = new HangProvider([hang(), ok('ok')]);
    const b = makeHarness([], { engineDeps: { provider: late }, settings: { modelStallSeconds: 'auto' } });
    b.session.lastContextTokens = 10_000;
    const runB = b.run('x');
    await untilRequests(late, 1);
    await vi.advanceTimersByTimeAsync(30_500);
    await runB;
    expect(eventsOf(b.events, 'notice').map((n) => n.text)).toContain(t('vi', 'stallRetry', { sec: 30 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B08 — hết vòng: lời nhắc tổng kết có vết thật; thông báo ba phần; nút Chạy tiếp
// ─────────────────────────────────────────────────────────────────────────────

describe('B08 — bị buộc dừng thì nói thật', () => {
  const todo = () =>
    toolTurn([
      {
        name: 'todo_write',
        input: { todos: [{ id: 't1', title: 'Đọc mã nguồn', status: 'completed' }, { id: 't2', title: 'Viết test cho parser', status: 'pending' }] },
      },
    ]);

  it('lời nhắc tổng kết đòi ba phần + đính kèm vết thật; sau lượt tổng kết có thông báo ba phần tất định và nút «Chạy tiếp»', async () => {
    const h = makeHarness([todo, () => textTurn('Đã làm: đọc mã. Còn lại: viết test. Chạy tiếp: nhắn tiếp tục.')], { settings: { maxTurns: 1 } });
    const r = await h.run('làm hai việc');
    expect(r.stopReason).toBe('end_turn'); // lượt tổng kết xong êm
    const prompt = lastUserText(h.provider.requests[1]);
    expect(prompt).toContain('ĐÚNG BA PHẦN');
    expect(prompt).toContain('việc chưa xong trong danh sách: Viết test cho parser');
    expect(h.provider.requests[1].toolChoice).toBe('none');
    const summary = eventsOf(h.events, 'notice').find((n) => n.text.startsWith(t('vi', 'stopReasonMaxTurns', { n: 1 })))!;
    expect(summary.level).toBe('warn');
    const lines = summary.text.split('\n');
    expect(lines[1]).toBe('• Đã làm: xong 1/2 việc.');
    expect(lines[2]).toBe('• Còn lại: Viết test cho parser.');
    expect(lines[3]).toMatch(/^• Chạy tiếp: bấm «Chạy tiếp»/);
    expect(lines).toHaveLength(4);
    const opts = eventsOf(h.events, 'options');
    expect(opts.at(-1)!.options).toEqual([expect.objectContaining({ id: 'continue-work', kind: 'continue', label: 'Chạy tiếp' })]);
    expect(h.session.options?.[0]?.prompt).toBe(t('vi', 'continueWorkPrompt'));
  });

  it('model nói "đã hoàn thành toàn bộ" khi còn việc → thông báo chỉ ra mâu thuẫn, bảo tin danh sách', async () => {
    const h = makeHarness([todo, () => textTurn('Đã hoàn thành toàn bộ công việc được giao.')], { settings: { maxTurns: 1 } });
    await h.run('làm');
    const summary = eventsOf(h.events, 'notice').find((n) => n.text.startsWith(t('vi', 'stopReasonMaxTurns', { n: 1 })))!;
    expect(summary.text.split('\n').at(-1)).toBe(t('vi', 'stopContradiction', { n: 1 }));
  });

  it('hết vòng nhưng mọi việc đã xong → không có nút, phần Chạy tiếp nói "không cần"', async () => {
    const allDone = () => toolTurn([{ name: 'todo_write', input: { todos: [{ id: 't1', title: 'A', status: 'completed' }] } }]);
    const h = makeHarness([allDone, () => textTurn('Đã làm: A. Còn lại: không. Chạy tiếp: không cần.')], { settings: { maxTurns: 1 } });
    await h.run('làm A');
    const summary = eventsOf(h.events, 'notice').find((n) => n.text.startsWith(t('vi', 'stopReasonMaxTurns', { n: 1 })))!;
    expect(summary.text).toContain('• Chạy tiếp: không cần');
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
  });

  it('lượt bình thường kết thúc êm → không có thông báo tổng kết nào (chỉ khi bị buộc dừng)', async () => {
    const h = makeHarness([() => textTurn('Xong.')]);
    await h.run('x');
    expect(eventsOf(h.events, 'notice')).toHaveLength(0);
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
  });
});
