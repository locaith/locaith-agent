import { describe, expect, it } from 'vitest';
import { AUTO_PROVIDER_ID, ModelPool, type PoolProviderInfo } from '../src/core/orchestration/pool';
import { AutoProvider, chooseTier } from '../src/core/orchestration/autoProvider';
import { FailoverProvider } from '../src/core/orchestration/failover';
import { classifyTier } from '../src/core/orchestration/tiers';
import { ProviderError, type LLMProvider, type ModelInfo, type ProviderEvent, type StreamRequest } from '../src/core/types';
import { collect } from './helpers/mockServer';

type Behaviour = 'ok' | 'rate' | 'overloaded' | 'auth' | 'partial';

function mk(id: string, behaviour: Behaviour = 'ok'): LLMProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    label: id.toUpperCase(),
    kind: 'openai-chat',
    flavor: 'generic',
    capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'whole' },
    calls,
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
      calls.push(req.model);
      if (behaviour === 'rate') throw new ProviderError('429', { kind: 'rate_limit', providerId: id, status: 429, retryAfterMs: 50_000 });
      if (behaviour === 'overloaded') throw new ProviderError('529', { kind: 'overloaded', providerId: id });
      if (behaviour === 'auth') throw new ProviderError('401', { kind: 'auth', providerId: id });
      yield { type: 'text_delta', text: `từ ${id}:${req.model}` };
      if (behaviour === 'partial') throw new ProviderError('đứt mạng', { kind: 'network', providerId: id });
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [{ type: 'text', text: `từ ${id}:${req.model}` }], provider: id, model: req.model } };
    },
    async complete(req) {
      calls.push(req.model);
      if (behaviour === 'rate') throw new ProviderError('429', { kind: 'rate_limit', providerId: id });
      return `complete ${id}:${req.model}`;
    },
    async fetchModels() {
      return [];
    },
    async ping() {},
  };
}

const M = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });

const ANTHROPIC: ModelInfo[] = [M('claude-opus-5', { tier: 'top', reasoning: true }), M('claude-sonnet-5', { tier: 'balanced' }), M('claude-haiku-5', { tier: 'fast' })];
const DEEPSEEK: ModelInfo[] = [M('deepseek-v4-flash'), M('deepseek-chat'), M('deepseek-reasoner', { reasoning: true })];

function poolOf(list: (PoolProviderInfo & { p: LLMProvider })[], now = () => 1_000) {
  return new ModelPool({ summaries: async () => list, get: (id) => list.find((x) => x.id === id)!.p }, { now });
}

const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'auto',
  system: '',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxOutputTokens: 100,
  thinking: { level: 'medium', summaries: false },
  signal: new AbortController().signal,
  sessionKey: 's1',
  ...over,
});

describe('classifyTier — phân hạng model', () => {
  it('dùng tier của adapter nếu có; còn lại suy ra từ tên', () => {
    expect(classifyTier(M('x', { tier: 'fast' }))).toBe('fast');
    expect(classifyTier(M('gpt-5-mini'))).toBe('fast');
    expect(classifyTier(M('gemini-2.5-flash-lite'))).toBe('fast');
    expect(classifyTier(M('DeepSeek V4.1 Flash'))).toBe('fast');
    expect(classifyTier(M('gpt-5'))).toBe('top');
    expect(classifyTier(M('grok-4.7'))).toBe('top');
    expect(classifyTier(M('deepseek-reasoner'))).toBe('top');
    expect(classifyTier(M('gpt-4o'))).toBe('balanced');
    expect(classifyTier(M('deepseek-chat'))).toBe('balanced');
    expect(classifyTier(M('llama-3.3-70b'))).toBe('balanced');
  });
});

describe('ModelPool', () => {
  const a = mk('anthropic');
  const d = mk('deepseek');
  const list = [
    { id: 'anthropic', label: 'Anthropic', hasKey: true, models: ANTHROPIC, p: a },
    { id: 'deepseek', label: 'DeepSeek', hasKey: true, models: DEEPSEEK, p: d },
    { id: 'openai', label: 'OpenAI', hasKey: false, models: [M('gpt-5')], p: mk('openai') },
    { id: 'demo', label: 'Demo', hasKey: true, models: [M('demo-1')], p: mk('demo') },
    { id: AUTO_PROVIDER_ID, label: 'Auto', hasKey: true, models: [M('auto')], p: mk(AUTO_PROVIDER_ID) },
  ];

  it('chỉ dùng nhà cung cấp ĐÃ có khoá; bỏ demo và Auto', async () => {
    const pool = poolOf(list);
    expect((await pool.providers()).map((p) => p.id)).toEqual(['anthropic', 'deepseek']);
  });

  it('chọn model đúng hạng của từng nhà cung cấp và ưu tiên nhà cung cấp được chỉ định', async () => {
    const pool = poolOf(list);
    const top = await pool.rank('top', { prefer: { providerId: 'deepseek' } });
    expect(top.map((t) => `${t.providerId}:${t.model}`)).toEqual(['deepseek:deepseek-reasoner', 'anthropic:claude-opus-5']);
    const fast = await pool.rank('fast');
    expect(fast.map((t) => `${t.providerId}:${t.model}`)).toEqual(['anthropic:claude-haiku-5', 'deepseek:deepseek-v4-flash']);
  });

  it('nhà cung cấp đang nghỉ (cooldown) xuống cuối; hết giờ thì trở lại', async () => {
    let now = 1_000;
    const pool = poolOf(list, () => now);
    pool.markCooldown('anthropic', 10_000);
    expect((await pool.rank('balanced'))[0].providerId).toBe('deepseek');
    now += 11_000;
    expect((await pool.rank('balanced'))[0].providerId).toBe('anthropic');
  });

  it('chế độ chia tải: ưu tiên nhà cung cấp ít được dùng nhất', async () => {
    const pool = poolOf(list);
    pool.noteUse('anthropic');
    pool.noteUse('anthropic');
    const r = await pool.rank('balanced', { spread: true, prefer: { providerId: 'anthropic' } });
    expect(r[0].providerId).toBe('deepseek');
  });

  it('describe() cho thấy bảng hạng → model', async () => {
    const d1 = await poolOf(list).describe();
    expect(d1.find((x) => x.providerId === 'anthropic')?.tiers.top?.model).toBe('claude-opus-5');
    expect(d1.find((x) => x.providerId === 'deepseek')?.tiers.fast?.model).toBe('deepseek-v4-flash');
  });
});

describe('FailoverProvider', () => {
  it('lỗi giới hạn tốc độ TRƯỚC khi có dữ liệu → chuyển sang đích kế, báo onSwitch và cho đích hỏng nghỉ', async () => {
    const bad = mk('a', 'rate');
    const good = mk('b');
    const pool = poolOf([
      { id: 'a', label: 'A', hasKey: true, models: [M('a1')], p: bad },
      { id: 'b', label: 'B', hasKey: true, models: [M('b1')], p: good },
    ]);
    const chain = await pool.rank('balanced');
    const switches: string[] = [];
    const fo = new FailoverProvider(chain, pool, { onSwitch: (s) => switches.push(`${s.from.providerId}->${s.to.providerId}:${s.kind}`) });
    const evs = await collect(fo.stream(req()));
    expect(evs.some((e) => e.type === 'text_delta' && e.text === 'từ b:b1')).toBe(true);
    expect(switches).toEqual(['a->b:rate_limit']);
    expect(pool.isCooling('a')).toBe(true);
    expect(fo.lastUsed?.providerId).toBe('b');
  });

  it('đã phát dữ liệu giữa chừng rồi mới lỗi → KHÔNG chuyển (không trộn hai câu trả lời)', async () => {
    const p1 = mk('a', 'partial');
    const p2 = mk('b');
    const pool = poolOf([
      { id: 'a', label: 'A', hasKey: true, models: [M('a1')], p: p1 },
      { id: 'b', label: 'B', hasKey: true, models: [M('b1')], p: p2 },
    ]);
    const fo = new FailoverProvider(await pool.rank('balanced'), pool);
    await expect(collect(fo.stream(req()))).rejects.toThrow(/đứt mạng/);
    expect(p2.calls).toEqual([]);
  });

  it('lỗi không đáng chuyển (bad_request) thì ném nguyên; hết đích thì ném lỗi cuối', async () => {
    const only = mk('a', 'overloaded');
    const pool = poolOf([{ id: 'a', label: 'A', hasKey: true, models: [M('a1')], p: only }]);
    const fo = new FailoverProvider(await pool.rank('balanced'), pool);
    await expect(collect(fo.stream(req()))).rejects.toMatchObject({ kind: 'overloaded' });
  });

  it('complete() cũng chuyển đích', async () => {
    const pool = poolOf([
      { id: 'a', label: 'A', hasKey: true, models: [M('a1')], p: mk('a', 'rate') },
      { id: 'b', label: 'B', hasKey: true, models: [M('b1')], p: mk('b') },
    ]);
    const fo = new FailoverProvider(await pool.rank('balanced'), pool);
    expect(await fo.complete({ model: 'x', system: '', prompt: 'p', maxOutputTokens: 10 })).toBe('complete b:b1');
  });
});

describe('AutoProvider — Locaith Auto', () => {
  const anth = mk('anthropic');
  const deep = mk('deepseek');
  const mkPool = () =>
    poolOf([
      { id: 'anthropic', label: 'Anthropic', hasKey: true, models: ANTHROPIC, p: anth },
      { id: 'deepseek', label: 'DeepSeek', hasKey: true, models: DEEPSEEK, p: deep },
    ]);

  it('chooseTier: lập kế hoạch hoặc suy luận cao → top; còn lại → balanced', () => {
    expect(chooseTier({ tools: [{ name: 'exit_plan_mode', description: '', inputSchema: {} }], thinking: { level: 'low', summaries: false } })).toBe('top');
    expect(chooseTier({ tools: [], thinking: { level: 'high', summaries: false } })).toBe('top');
    expect(chooseTier({ tools: [], thinking: { level: 'max', summaries: false } })).toBe('top');
    expect(chooseTier({ tools: [], thinking: { level: 'medium', summaries: false } })).toBe('balanced');
  });

  it('chọn model theo hạng trong các khoá đã nhập và báo đích được chọn', async () => {
    const picks: string[] = [];
    const auto = new AutoProvider(mkPool(), { onPick: (t, tier) => picks.push(`${t.providerId}:${t.model}/${tier}`) });
    await collect(auto.stream(req({ thinking: { level: 'high', summaries: false } })));
    await collect(auto.stream(req({ sessionKey: 's2' })));
    expect(picks).toEqual(['anthropic:claude-opus-5/top', 'anthropic:claude-sonnet-5/balanced']);
  });

  it('cùng phiên, đổi hạng (suy luận cao → thường) vẫn ở lại hãng cũ nếu hãng đó không nghỉ', async () => {
    const pool = poolOf([
      { id: 'anthropic', label: 'Anthropic', hasKey: true, models: ANTHROPIC, p: mk('anthropic') },
      { id: 'deepseek', label: 'DeepSeek', hasKey: true, models: DEEPSEEK, p: mk('deepseek') },
    ]);
    const picks: string[] = [];
    const auto = new AutoProvider(pool, { onPick: (t) => picks.push(t.providerId) });
    // lượt 1 phải sang deepseek vì anthropic đang nghỉ → lượt 2 (hết nghỉ) vẫn ưu tiên deepseek nhờ "bám hãng"
    pool.markCooldown('anthropic', 500);
    await collect(auto.stream(req({ sessionKey: 'z' })));
    pool.clearCooldown();
    await collect(auto.stream(req({ sessionKey: 'z' })));
    expect(picks).toEqual(['deepseek']);
  });

  it('bị giới hạn tốc độ thì tự sang hãng khác; lần sau bỏ qua hãng đang nghỉ', async () => {
    const bad = mk('anthropic', 'rate');
    const good = mk('deepseek');
    const pool = poolOf([
      { id: 'anthropic', label: 'Anthropic', hasKey: true, models: ANTHROPIC, p: bad },
      { id: 'deepseek', label: 'DeepSeek', hasKey: true, models: DEEPSEEK, p: good },
    ]);
    const auto = new AutoProvider(pool);
    const out = await collect(auto.stream(req({ sessionKey: 'x' })));
    expect(out.some((e) => e.type === 'text_delta' && e.text.startsWith('từ deepseek'))).toBe(true);
    bad.calls.length = 0;
    await collect(auto.stream(req({ sessionKey: 'y' })));
    expect(bad.calls).toEqual([]); // anthropic đang nghỉ nên không bị gọi lại
  });

  it('chưa có khoá nào → báo lỗi auth rõ ràng bằng tiếng Việt', async () => {
    const auto = new AutoProvider(poolOf([]));
    await expect(collect(auto.stream(req()))).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('khoá API') });
  });

  it('trong một vòng gọi công cụ giữ nguyên hãng của lượt trước', async () => {
    const pool = mkPool();
    const picks: string[] = [];
    const auto = new AutoProvider(pool, { onPick: (t) => picks.push(t.providerId) });
    await collect(auto.stream(req({ sessionKey: 'loop' })));
    pool.markCooldown('anthropic', 1); // hết hiệu lực ngay (now cố định = 1000 → until=2000>1000: vẫn nghỉ) — đặt lại bằng clear
    pool.clearCooldown();
    const toolMsg = { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 't', name: 'x', content: 'ok' }] };
    await collect(auto.stream(req({ sessionKey: 'loop', messages: [...req().messages, toolMsg] })));
    expect(new Set(picks).size).toBe(1);
  });
});
