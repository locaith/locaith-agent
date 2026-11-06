import { describe, expect, it } from 'vitest';
import type { QueueState } from '../src/core/engine/engine';
import { SkillRegistry, skillFromMarkdown } from '../src/core/skills/registry';
import { ProviderError, type ProviderEvent } from '../src/core/types';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn } from './helpers/fakeProvider';

const queueEv = (position: number, attempt: number): ProviderEvent => ({ type: 'queue', position, ahead: position - 1, attempt, waitMs: 8000, retryAt: 1_700_000_000_000 + attempt * 8000, limit: 100, active: 100, waiting: 12 });

describe('engine — hàng chờ của cổng Locaith', () => {
  it('sự kiện queue → onQueue(trạng thái) + dòng trạng thái trong lượt trả lời; queue_end → onQueue(null) NGAY (không đợi token đầu)', async () => {
    const states: (QueueState | null)[] = [];
    const h = makeHarness([() => [queueEv(7, 1), queueEv(3, 2), { type: 'queue_end' }, ...textTurn('Chào bạn')]], {
      sessionProvider: 'locaith',
      engineDeps: { onQueue: (q) => states.push(q) },
    });
    const r = await h.run('xin chào');
    expect(r.stopReason).toBe('end_turn');
    expect(states).toHaveLength(3);
    expect(states[0]).toMatchObject({ position: 7, ahead: 6, attempt: 1, waitMs: 8000, limit: 100, active: 100, waiting: 12 });
    expect(states[1]).toMatchObject({ position: 3, attempt: 2 });
    expect(states[2]).toBeNull();
    // Dòng trạng thái: cùng một pill được cập nhật vị trí (không đẻ ra nhiều dòng).
    const pills = eventsOf(h.events, 'pill').filter((p) => p.pillId.endsWith(':queue'));
    expect(pills).toHaveLength(2);
    expect(new Set(pills.map((p) => p.pillId)).size).toBe(1);
    expect(pills[0].text).toMatch(/nhiều lượt sử dụng.*vị trí 7/);
    expect(pills[1].text).toMatch(/vị trí 3/);
  });

  it('không có queue_end: sự kiện nội dung đầu tiên cũng bỏ trạng thái hàng chờ; sự kiện retry thì KHÔNG', async () => {
    const states: (QueueState | null)[] = [];
    const h = makeHarness([() => [queueEv(2, 1), { type: 'retry', attempt: 1, maxAttempts: 4, delayMs: 1000, reason: 'x' }, ...textTurn('ok')]], {
      sessionProvider: 'locaith',
      engineDeps: { onQueue: (q) => states.push(q) },
    });
    await h.run('hi');
    expect(states.map((s) => (s ? s.position : null))).toEqual([2, null]);
  });

  it('luồng đứt / lỗi / bị dừng giữa lúc xếp hàng → dải hàng chờ phải biến mất (onQueue(null))', async () => {
    const aborted: (QueueState | null)[] = [];
    const h1 = makeHarness([() => [queueEv(4, 1)]], { sessionProvider: 'locaith', engineDeps: { onQueue: (q) => aborted.push(q) } });
    await h1.run('hi'); // luồng kết thúc mà không có done
    expect(aborted.map((s) => (s ? s.position : null))).toEqual([4, null]);

    const failed: (QueueState | null)[] = [];
    const h2 = makeHarness(
      [
        () => {
          throw new ProviderError('boom', { kind: 'server', providerId: 'locaith' });
        },
      ],
      { sessionProvider: 'locaith', engineDeps: { onQueue: (q) => failed.push(q) } },
    );
    await h2.run('hi');
    expect(failed).toEqual([]); // chưa từng xếp hàng thì không có gì để xoá

    const ctl = new AbortController();
    const mid: (QueueState | null)[] = [];
    const h3 = makeHarness([() => [queueEv(9, 1), queueEv(8, 2)]], { sessionProvider: 'locaith', eventDelayMs: 5, engineDeps: { onQueue: (q) => mid.push(q) } });
    const p = h3.run('hi', ctl.signal);
    // Huỷ khi ĐÃ có sự kiện hàng chờ (chờ tối đa 1 giây) — không dựa vào đồng hồ, tránh chập chờn khi máy bận.
    for (let i = 0; i < 200 && mid.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const res = await p;
    expect(res.stopReason).toBe('aborted');
    expect(mid.at(-1)).toBeNull();
  });
});

describe('engine — cổng Locaith đòi đồng ý thông báo dữ liệu', () => {
  it('consent_required → gọi onConsentRequired, báo lỗi dễ hiểu (nhắc «Thử lại»), kết thúc lượt, KHÔNG thử lại im lặng', async () => {
    let called = 0;
    const h = makeHarness(
      [
        () => {
          throw new ProviderError('403', { kind: 'consent_required', providerId: 'locaith', status: 403, retryable: false });
        },
      ],
      { sessionProvider: 'locaith', engineDeps: { onConsentRequired: () => called++ } },
    );
    const r = await h.run('xin chào');
    expect(r.stopReason).toBe('error');
    expect(called).toBe(1);
    const notices = eventsOf(h.events, 'notice');
    expect(notices.at(-1)).toMatchObject({ level: 'error' });
    expect(notices.at(-1)!.text).toMatch(/đồng ý thông báo dữ liệu của Locaith.*Thử lại/);
    expect(h.provider.requests).toHaveLength(1);
  });
});

describe('engine — kỹ năng riêng và đoạn nhắc theo nhà cung cấp của phiên', () => {
  const gated = skillFromMarkdown('---\nname: soan-thao-van-ban-nd30\ndescription: Soạn văn bản hành chính\nproviders: [locaith]\n---\n# Quy trình\n1. Xác định loại văn bản', 'soan-thao-van-ban-nd30', 'builtin')!;

  it('phiên Locaith: system prompt có khối <locaith_model>; phiên khác: không', async () => {
    const a = makeHarness([() => textTurn('ok')], { sessionProvider: 'locaith' });
    await a.run('hi');
    expect(a.provider.requests[0].system).toContain('<locaith_model>');
    const b = makeHarness([() => textTurn('ok')], { sessionProvider: 'anthropic' });
    await b.run('hi');
    expect(b.provider.requests[0].system).not.toContain('locaith_model');
  });

  it('load_skill trong vòng lặp thật: Locaith nạp được kỹ năng riêng; nhà cung cấp khác nhận lỗi "Không có kỹ năng"', async () => {
    const callLoad = () => [
      { type: 'tool_start' as const, id: 'c1', name: 'load_skill' },
      { type: 'tool_args_delta' as const, id: 'c1', name: 'load_skill', delta: '{"skill_name":"soan-thao-van-ban-nd30"}' },
      { type: 'tool_end' as const, id: 'c1', name: 'load_skill' },
      {
        type: 'done' as const,
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        message: { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'c1', name: 'load_skill', input: { skill_name: 'soan-thao-van-ban-nd30' } }] },
      },
    ];
    const loc = makeHarness([callLoad, () => textTurn('đã nạp')], { sessionProvider: 'locaith', skillsRegistry: new SkillRegistry([gated]) });
    await loc.run('soạn công văn');
    const locResult = loc.provider.requests[1].messages.at(-1)!.content.find((b) => b.type === 'tool_result');
    expect(locResult && locResult.type === 'tool_result' && locResult.isError).toBeFalsy();
    expect(locResult && locResult.type === 'tool_result' && locResult.content).toContain('# Kỹ năng: soan-thao-van-ban-nd30');
    expect(loc.session.loadedSkills).toEqual(['soan-thao-van-ban-nd30']);

    const other = makeHarness([callLoad, () => textTurn('không có')], { sessionProvider: 'anthropic', skillsRegistry: new SkillRegistry([gated]) });
    await other.run('soạn công văn');
    const otherResult = other.provider.requests[1].messages.at(-1)!.content.find((b) => b.type === 'tool_result');
    expect(otherResult && otherResult.type === 'tool_result' && otherResult.isError).toBe(true);
    expect(otherResult && otherResult.type === 'tool_result' && otherResult.content).toContain('Không có kỹ năng "soan-thao-van-ban-nd30"');
    expect(other.session.loadedSkills).toEqual([]);
    // Mô tả công cụ gửi cho model cũng không liệt kê kỹ năng riêng với nhà cung cấp khác.
    expect(other.provider.requests[0].tools.find((t) => t.name === 'load_skill')!.description).not.toContain('soan-thao-van-ban-nd30');
    expect(loc.provider.requests[0].tools.find((t) => t.name === 'load_skill')!.description).toContain('soan-thao-van-ban-nd30');
  });
});

describe('engine — lời của cổng hiện nguyên văn; token tài khoản hỏng thì nhờ host kiểm tra lại', () => {
  const failWith = (e: ProviderError) => [
    () => {
      throw e;
    },
  ];

  it('locaith_quota: thông báo = ĐÚNG lời của cổng (không phải câu chung "giới hạn tốc độ"), dừng lượt, không gọi lại', async () => {
    const msg = 'Hôm nay bạn đã dùng hết hạn mức của mô hình Locaith. Hạn mức làm mới lúc 00:00.';
    const h = makeHarness(failWith(new ProviderError(msg, { kind: 'rate_limit', providerId: 'locaith', status: 429, retryable: false, retryAfterMs: 10_800_000, verbatim: true })), { sessionProvider: 'locaith' });
    const r = await h.run('xin chào');
    expect(r.stopReason).toBe('error');
    const last = eventsOf(h.events, 'notice').at(-1)!;
    expect(last).toMatchObject({ level: 'error', text: msg });
    expect(last.text).not.toMatch(/giới hạn tốc độ|vài phút|thử lại sau ít phút/i);
    expect(h.provider.requests).toHaveLength(1);
  });

  it('locaith_rate_limited (chờ quá lâu) và locaith_model_not_found cũng hiện nguyên lời cổng', async () => {
    for (const [kind, msg] of [
      ['rate_limit', 'Bạn gửi quá nhiều yêu cầu cùng lúc. Hãy chờ vài phút.'],
      ['not_found', 'Không có mô hình "locaith-v9".'],
      ['overloaded', 'Dịch vụ mô hình Locaith đang bảo trì.'],
    ] as const) {
      const h = makeHarness(failWith(new ProviderError(msg, { kind, providerId: 'locaith', verbatim: true, retryable: false })), { sessionProvider: 'locaith' });
      await h.run('hi');
      expect(eventsOf(h.events, 'notice').at(-1)).toMatchObject({ level: 'error', text: msg });
    }
  });

  it('lỗi KHÔNG đánh dấu verbatim vẫn dùng câu chung như trước (không đổi hành vi của hãng khác)', async () => {
    const h = makeHarness(failWith(new ProviderError('429 từ máy chủ', { kind: 'rate_limit', providerId: 'openai', status: 429, retryable: false })), { sessionProvider: 'openai' });
    await h.run('hi');
    expect(eventsOf(h.events, 'notice').at(-1)!.text).toMatch(/giới hạn tốc độ/);
  });

  it('locaith_unauthorized: gọi onAccountInvalid ĐÚNG MỘT LẦN và báo "đang kiểm tra lại tài khoản" — không bảo người dùng nhập khoá API', async () => {
    let rechecks = 0;
    const h = makeHarness(failWith(new ProviderError('Phiên đăng nhập Locaith không còn hiệu lực.', { kind: 'auth', providerId: 'locaith', status: 401, retryable: false, accountAuth: true })), {
      sessionProvider: 'locaith',
      engineDeps: { onAccountInvalid: () => rechecks++ },
    });
    const r = await h.run('hi');
    expect(r.stopReason).toBe('error');
    expect(rechecks).toBe(1);
    const text = eventsOf(h.events, 'notice').at(-1)!.text;
    expect(text).toMatch(/Phiên đăng nhập Locaith không còn hiệu lực — đang kiểm tra lại tài khoản/);
    expect(text).not.toMatch(/khóa API|khoá API|Cài đặt để nhập lại/i);
    expect(h.provider.requests).toHaveLength(1);
  });

  it('lỗi auth thường (khoá API hỏng của hãng khác) vẫn nhắc nhập lại khoá và KHÔNG gọi onAccountInvalid', async () => {
    let rechecks = 0;
    const h = makeHarness(failWith(new ProviderError('401', { kind: 'auth', providerId: 'openai', status: 401, retryable: false })), { sessionProvider: 'openai', engineDeps: { onAccountInvalid: () => rechecks++ } });
    await h.run('hi');
    expect(rechecks).toBe(0);
    expect(eventsOf(h.events, 'notice').at(-1)!.text).toMatch(/Khóa API/);
  });
});
