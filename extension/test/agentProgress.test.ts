import { describe, expect, it } from 'vitest';
import { ACTIVITY_MAX, agentActivity, agentPhase, streamTokenEstimate } from '../src/core/agents/activity';
import { AgentRegistry } from '../src/core/agents/definitions';
import { createProgressReporter, createWorkflowProgress, PROGRESS_MIN_INTERVAL_MS, sameProgress } from '../src/core/agents/progress';
import type { AgentServices } from '../src/core/agents/runner';
import { Semaphore } from '../src/core/agents/semaphore';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { ModelPool, type OrchestrationMode } from '../src/core/orchestration/pool';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import type { LLMProvider } from '../src/core/types';
import type { AgentProgress, AssistantItem, TItem, UiEvent } from '../src/shared/protocol';
import { applyEvent, reduceView } from '../src/shared/transcript';
import { FakeProvider, textTurn, toolTurn } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';

/** Đồng hồ + hẹn giờ giả: test không phải chờ thật. */
function fakeClock() {
  let t = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number);
    },
    advance(ms: number): void {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      t = target;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

const P = (tokens: number, tools = 0, extra: Partial<AgentProgress> = {}): AgentProgress => ({ tokens, tools, ...extra });

describe('createProgressReporter — gộp ≤ 2 lần/giây, số cuối luôn tới nơi', () => {
  it('lần đầu gửi ngay; các lần trong khoảng chờ chỉ giữ bản MỚI NHẤT và gửi đúng lúc hết khoảng chờ', () => {
    const clock = fakeClock();
    const sent: AgentProgress[] = [];
    const r = createProgressReporter({ send: (p) => sent.push(p), ...clock });
    r.update(P(10));
    expect(sent).toEqual([P(10)]);
    clock.advance(100);
    r.update(P(20));
    clock.advance(100);
    r.update(P(30, 1));
    expect(sent).toHaveLength(1); // chưa tới hạn
    clock.advance(PROGRESS_MIN_INTERVAL_MS - 200 - 1);
    expect(sent).toHaveLength(1);
    clock.advance(1);
    expect(sent).toEqual([P(10), P(30, 1)]); // bản 20 bị gộp mất, 30 tới đúng hạn
    expect(clock.pendingTimers).toBe(0);
  });

  it('không gửi lại khi chẳng có gì đổi; quay về đúng giá trị đã gửi thì bản chờ bị bỏ', () => {
    const clock = fakeClock();
    const sent: AgentProgress[] = [];
    const r = createProgressReporter({ send: (p) => sent.push(p), ...clock });
    r.update(P(10, 1, { activity: 'a' }));
    r.update(P(10, 1, { activity: 'a' }));
    clock.advance(1000);
    r.update(P(10, 1, { activity: 'a' }));
    expect(sent).toHaveLength(1);
    r.update(P(11)); // sẽ bị hoãn vì vừa gửi? không: đã qua 1000 ms → gửi ngay
    expect(sent).toHaveLength(2);
    r.update(P(12)); // trong khoảng chờ → hoãn
    r.update(P(11)); // quay về giá trị ĐÃ GỬI → không còn gì để gửi
    clock.advance(1000);
    expect(sent).toHaveLength(2);
  });

  it('flush gửi ngay bản đang chờ và huỷ hẹn giờ; dispose bỏ bản đang chờ', () => {
    const clock = fakeClock();
    const sent: AgentProgress[] = [];
    const r = createProgressReporter({ send: (p) => sent.push(p), ...clock });
    r.update(P(1));
    r.update(P(2));
    expect(sent).toEqual([P(1)]);
    r.flush();
    expect(sent).toEqual([P(1), P(2)]);
    expect(clock.pendingTimers).toBe(0);
    r.flush(); // không còn gì
    expect(sent).toHaveLength(2);

    const sent2: AgentProgress[] = [];
    const r2 = createProgressReporter({ send: (p) => sent2.push(p), ...clock });
    r2.update(P(1));
    r2.update(P(2));
    r2.dispose();
    clock.advance(5000);
    expect(sent2).toEqual([P(1)]);
  });

  it('sameProgress so sánh đủ các trường (failed/activity thiếu = rỗng)', () => {
    expect(sameProgress(P(1, 2), P(1, 2, { failed: 0, activity: '' }))).toBe(true);
    expect(sameProgress(P(1, 2), P(1, 2, { failed: 1 }))).toBe(false);
    expect(sameProgress(P(1, 2), P(1, 2, { activity: 'x' }))).toBe(false);
    expect(sameProgress(undefined, P(1))).toBe(false);
  });
});

describe('createWorkflowProgress — cộng số liệu nhiều agent vào MỘT dòng', () => {
  it('tổng token/lệnh/lỗi, «N agent đang chạy · việc vừa báo», agent xong vẫn nằm trong tổng', () => {
    const clock = fakeClock();
    const events: UiEvent[] = [];
    const w = createWorkflowProgress({ emit: (e) => events.push(e), assistantId: 'A', callId: 'wf1', lang: 'vi', ...clock });
    w.update(1, P(100, 2, { activity: 'Đang đọc a.ts' }));
    clock.advance(600);
    w.update(2, P(50, 1, { failed: 1, activity: 'Đang suy nghĩ…' }));
    clock.advance(600);
    const last = events[events.length - 1] as Extract<UiEvent, { t: 'agent_progress' }>;
    expect(last).toMatchObject({ t: 'agent_progress', id: 'A', callId: 'wf1', tokens: 150, tools: 3, failed: 1, activity: '2 agent đang chạy · Đang suy nghĩ…' });
    w.finish(1);
    w.flush();
    const after = events[events.length - 1] as Extract<UiEvent, { t: 'agent_progress' }>;
    expect(after).toMatchObject({ tokens: 150, tools: 3, activity: '1 agent đang chạy · Đang suy nghĩ…' });
    w.finish(2);
    w.flush();
    const end = events[events.length - 1] as Extract<UiEvent, { t: 'agent_progress' }>;
    expect(end.tokens).toBe(150);
    expect(end.activity).toBe('Đang suy nghĩ…'); // không còn agent chạy → chỉ việc cuối
  });

  it('tiếng Anh: số ít/nhiều', () => {
    const clock = fakeClock();
    const events: UiEvent[] = [];
    const w = createWorkflowProgress({ emit: (e) => events.push(e), assistantId: 'A', callId: 'wf', lang: 'en', ...clock });
    w.update(1, P(1, 0, { activity: 'x' }));
    expect((events[0] as { activity?: string }).activity).toBe('1 agent running · x');
    clock.advance(600);
    w.update(2, P(1, 0, { activity: 'y' }));
    clock.advance(600);
    expect((events[events.length - 1] as { activity?: string }).activity).toBe('2 agents running · y');
  });
});

describe('agentActivity / agentPhase', () => {
  it('mô tả từng công cụ bằng tiếng Việt và tiếng Anh', () => {
    expect(agentActivity('vi', 'read_file', { path: 'src/a.ts' })).toBe('Đang đọc src/a.ts');
    expect(agentActivity('en', 'read_file', { path: 'src/a.ts' })).toBe('Reading src/a.ts');
    expect(agentActivity('vi', 'web_search', { query: 'giá vàng' })).toBe('Đang tìm trên web “giá vàng”');
    expect(agentActivity('vi', 'grep', { pattern: 'MAX_RETRY' })).toBe('Đang tìm trong mã “MAX_RETRY”');
    expect(agentActivity('vi', 'run_command', { command: 'npm test\nnpm run build' })).toBe('Đang chạy lệnh: npm test');
    expect(agentActivity('en', 'list_dir', {})).toBe('Listing .');
    expect(agentActivity('vi', 'mcp__db__query', {})).toBe('Đang dùng công cụ mcp__db__query');
    expect(agentPhase('vi', 'thinking')).toBe('Đang suy nghĩ…');
    expect(agentPhase('en', 'writing')).toBe('Writing the report…');
    expect(agentPhase('vi', 'starting')).toBe('Đang bắt đầu…');
  });

  it('một dòng, ≤ 120 ký tự, che khoá bí mật, bỏ ký tự điều khiển, chịu đối số sai kiểu', () => {
    const long = agentActivity('vi', 'read_file', { path: `${'x/'.repeat(100)}a.ts` });
    expect(long.length).toBeLessThanOrEqual(ACTIVITY_MAX);
    expect(long.endsWith('…')).toBe(true);
    const secret = agentActivity('vi', 'run_command', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x.io' });
    expect(secret).not.toContain('abcdefghijklmnop12345');
    expect(agentActivity('vi', 'fetch_url', { url: 'https://a.io/?k=sk-abcdefghijklmnopqrstuv' })).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(agentActivity('vi', 'read_file', { path: 'a\u0000b\tc' })).toBe('Đang đọc a b c');
    expect(() => agentActivity('vi', 'read_file', { path: 42 as unknown as string })).not.toThrow();
    expect(() => agentActivity('vi', 'read_file', undefined)).not.toThrow();
  });

  it('streamTokenEstimate cộng dồn được (không làm tròn lên từng đoạn nhỏ)', () => {
    const text = 'xin chào các bạn, đây là một đoạn văn khá dài để ước lượng token';
    const whole = streamTokenEstimate(text);
    let parts = 0;
    for (const ch of text) parts += streamTokenEstimate(ch);
    expect(parts).toBeCloseTo(whole, 6);
    expect(streamTokenEstimate('')).toBe(0);
  });
});

describe('reducer: agent_progress', () => {
  const base = (): TItem[] =>
    applyEvent(
      applyEvent([], { t: 'assistant_start', id: 'A', provider: 'p', model: 'm', ts: 1 }),
      { t: 'tool_start', id: 'A', callId: 'c1', name: 'agent', args: { description: 'Tìm hằng số' } },
    );
  const tool = (items: TItem[]) => (items[0] as AssistantItem).blocks.find((b) => b.type === 'tool') as import('../src/shared/protocol').ToolBlock;

  it('gắn tiến độ vào đúng khối công cụ, bỏ trường rỗng', () => {
    const items = applyEvent(base(), { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 120, tools: 2, failed: 0, activity: 'Đang đọc a.ts' });
    expect(tool(items).agent).toEqual({ tokens: 120, tools: 2, activity: 'Đang đọc a.ts' });
  });

  it('không đổi gì thì trả về CHÍNH mảng cũ (không dựng lại cả lượt); đổi thì mảng mới', () => {
    const a = applyEvent(base(), { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 1, tools: 0 });
    const same = applyEvent(a, { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 1, tools: 0 });
    expect(same).toBe(a);
    const changed = applyEvent(a, { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 2, tools: 0 });
    expect(changed).not.toBe(a);
    expect(tool(changed).agent?.tokens).toBe(2);
  });

  it('callId lạ hoặc lượt lạ: bỏ qua; tool_end không xoá số liệu; khối cũ không có `agent` vẫn như trước', () => {
    const b = base();
    expect(applyEvent(b, { t: 'agent_progress', id: 'A', callId: 'khong-co', tokens: 5, tools: 1 })).toBe(b);
    expect(applyEvent(b, { t: 'agent_progress', id: 'Z', callId: 'c1', tokens: 5, tools: 1 })).toBe(b);
    const withAgent = applyEvent(b, { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 9, tools: 3 });
    const done = applyEvent(withAgent, { t: 'tool_end', id: 'A', callId: 'c1', state: 'done', durationMs: 5 });
    expect(tool(done).agent).toEqual({ tokens: 9, tools: 3 });
    expect(tool(b).agent).toBeUndefined();
  });

  it('reduceView: chỉ transcript đổi, các trường khác giữ nguyên', () => {
    const state = { transcript: base(), running: true } as unknown as Parameters<typeof reduceView>[0];
    const next = reduceView(state, { t: 'agent_progress', id: 'A', callId: 'c1', tokens: 7, tools: 1 });
    expect(next.running).toBe(true);
    expect(next.transcript).not.toBe(state.transcript);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Đầu-cuối với engine thật: agent con báo tiến độ lên luồng chính
// ─────────────────────────────────────────────────────────────────────────────

function services(provider: LLMProvider, mode: OrchestrationMode = 'off'): Omit<AgentServices, 'registry'> {
  return {
    pool: new ModelPool({ summaries: async () => [], get: () => provider }),
    agents: new AgentRegistry(),
    skills: new SkillRegistry(builtinSkills()),
    mode: () => mode,
    engineSettings: () => ({ ...DEFAULT_ENGINE_SETTINGS }),
    provider: () => provider,
    contextWindow: () => 128_000,
    log: () => {},
    limiter: new Semaphore(4),
    writeLock: new Semaphore(1),
  };
}

const progressOf = (events: UiEvent[], callId?: string) => eventsOf(events, 'agent_progress').filter((e) => !callId || e.callId === callId);

describe('runSubAgent báo tiến độ (engine thật)', () => {
  it('phát tiến độ lên đúng lệnh `agent`, gộp theo thời gian, và số cuối cùng (token thật, số lệnh) tới TRƯỚC tool_end', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Tìm hằng số', prompt: 'Tìm MAX_RETRY', agent_type: 'explore' } }]),
      () => toolTurn([{ name: 'read_file', input: { path: 'src/a.ts' } }]),
      () => textTurn('Tìm thấy: src/a.ts:1'),
      () => textTurn('Xong.'),
    ]);
    const h = makeHarness([], { provider, files: { 'src/a.ts': 'export const MAX_RETRY = 5;\n' }, agents: services(provider) });
    await h.run('MAX_RETRY ở đâu?');

    const ev = progressOf(h.events, 'ag1');
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev.length).toBeLessThanOrEqual(4); // vài mili-giây, dưới 500 ms: bị gộp mạnh (không phải một sự kiện cho mỗi đoạn chữ)
    expect(ev[0]).toMatchObject({ id: expect.any(String), callId: 'ag1', tokens: 0, tools: 0, activity: 'Đang bắt đầu…' });
    const last = ev[ev.length - 1];
    // 2 lượt model của agent con: mỗi lượt FakeProvider báo 100 vào + 20 ra
    expect(last).toMatchObject({ tokens: 240, tools: 1 });
    expect(last.failed).toBeUndefined();
    // thứ tự: mọi tiến độ nằm trước tool_end của lệnh agent
    const endIdx = h.events.findIndex((e) => e.t === 'tool_end' && e.callId === 'ag1');
    const lastIdx = h.events.lastIndexOf(last);
    expect(endIdx).toBeGreaterThan(lastIdx);
    // tiến độ chảy qua reducer thành khối `agent` của lệnh gọi
    let items: TItem[] = [];
    for (const e of h.events) items = applyEvent(items, e);
    const blk = (items.find((i) => i.kind === 'assistant') as AssistantItem).blocks.find((b) => b.type === 'tool' && b.id === 'ag1') as import('../src/shared/protocol').ToolBlock;
    expect(blk.agent).toMatchObject({ tokens: 240, tools: 1 });
  });

  it('đếm lệnh lỗi của agent con (đọc tệp không tồn tại)', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Đọc', prompt: 'Đọc nope.ts', agent_type: 'explore' } }]),
      () => toolTurn([{ name: 'read_file', input: { path: 'khong-co.ts' } }]),
      () => textTurn('Không có tệp.'),
      () => textTurn('Xong.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider) });
    await h.run('đọc');
    const last = progressOf(h.events, 'ag1').pop()!;
    expect(last).toMatchObject({ tools: 1, failed: 1 });
  });

  it('lệnh đã chuyển thẻ xin phép lên luồng chính được đếm ở đó, KHÔNG đếm hai lần trong số liệu agent', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Tạo tệp', prompt: 'Tạo out.txt', agent_type: 'general' } }]),
      () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'xin chào' } }]),
      () => textTurn('Đã tạo out.txt'),
      () => textTurn('Xong.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider), decide: () => 'allow' });
    await h.run('tạo tệp');
    expect(eventsOf(h.events, 'tool_permission')[0].callId).toContain('~'); // đã chuyển lên luồng chính
    const last = progressOf(h.events, 'ag1').pop()!;
    expect(last.tools).toBe(0);
  });

  it('workflow_run: một dòng duy nhất cho cả workflow, cộng số liệu của các agent con chạy song song', async () => {
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'load_skill', input: { skill_name: 'multi-agent' } }]),
      () => toolTurn([{ id: 'wf1', name: 'workflow_run', input: { description: 'Hai việc', script: 'const rs = await parallel([() => agent("việc A", { agent: "explore" }), () => agent("việc B", { agent: "explore" })]); return rs.map((r) => r.ok);' } }]),
      () => textTurn('KẾT QUẢ A'),
      () => textTurn('KẾT QUẢ B'),
      () => textTurn('Đã xong workflow.'),
    ]);
    const h = makeHarness([], { provider, agents: services(provider) });
    const res = await h.run('chạy workflow');
    expect(res.stopReason).toBe('end_turn');
    const ev = progressOf(h.events, 'wf1');
    expect(ev.length).toBeGreaterThan(0);
    const last = ev[ev.length - 1];
    expect(last.tokens).toBe(240); // (100 + 20) × 2 agent
    expect(ev.every((e) => e.callId === 'wf1')).toBe(true);
    expect(h.events.findIndex((e) => e.t === 'tool_end' && e.callId === 'wf1')).toBeGreaterThan(h.events.lastIndexOf(last));
  });
});
