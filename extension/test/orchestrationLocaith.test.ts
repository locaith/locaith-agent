import { describe, expect, it } from 'vitest';
import { FailoverProvider } from '../src/core/orchestration/failover';
import { ModelPool, type PoolProviderInfo } from '../src/core/orchestration/pool';
import { ProviderService } from '../src/core/providers/service';
import { ProviderError, type LLMProvider, type ModelInfo, type ProviderEvent, type StreamRequest } from '../src/core/types';
import { collect } from './helpers/mockServer';

const M = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });
const LOCAITH_MODELS: ModelInfo[] = [M('locaith-v5-flash', { tier: 'fast', contextWindow: 1_000_000 }), M('locaith-v5-si', { tier: 'top', reasoning: true, contextWindow: 1_000_000 })];
const CLAUDE: ModelInfo[] = [M('claude-opus-5', { tier: 'top' }), M('claude-haiku-5', { tier: 'fast' })];

const stub = (id: string): LLMProvider => ({
  id,
  label: id,
  kind: 'openai-chat',
  flavor: 'generic',
  capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'whole' },
  async *stream() {},
  async complete() {
    return '';
  },
  async fetchModels() {
    return [];
  },
  async ping() {},
});

describe('ModelPool — Locaith chưa đồng ý thông báo thì KHÔNG được tự chọn', () => {
  const make = (needsConsent: boolean) => {
    const list: (PoolProviderInfo & { p: LLMProvider })[] = [
      { id: 'locaith', label: 'Locaith AI Local', hasKey: true, needsConsent, models: LOCAITH_MODELS, p: stub('locaith') },
      { id: 'anthropic', label: 'Claude', hasKey: true, models: CLAUDE, p: stub('anthropic') },
    ];
    return new ModelPool({ summaries: async () => list, get: (id) => list.find((x) => x.id === id)!.p });
  };

  it('chưa đồng ý: không nằm trong kho, không xuất hiện ở bất kỳ hạng nào (Auto / failover / agent con đều không chạm tới)', async () => {
    const pool = make(true);
    expect((await pool.providers()).map((p) => p.id)).toEqual(['anthropic']);
    for (const tier of ['top', 'balanced', 'fast'] as const) expect((await pool.rank(tier)).map((t) => t.providerId)).not.toContain('locaith');
    expect((await pool.describe()).map((d) => d.providerId)).toEqual(['anthropic']);
  });

  it('đã đồng ý: vào kho với cửa sổ 1M token', async () => {
    const pool = make(false);
    expect((await pool.providers()).map((p) => p.id).sort()).toEqual(['anthropic', 'locaith']);
    const fast = await pool.rank('fast', { prefer: { providerId: 'locaith' } });
    expect(fast[0]).toMatchObject({ providerId: 'locaith', model: 'locaith-v5-flash', tier: 'fast', contextWindow: 1_000_000 });
    const top = (await pool.rank('top')).find((t) => t.providerId === 'locaith');
    expect(top).toMatchObject({ model: 'locaith-v5-si', tier: 'top' });
  });

  it('model chưa rõ cửa sổ nhưng tên đã biết (DeepSeek id cũ) → 1M thay vì 128K', async () => {
    const list = [{ id: 'deepseek', label: 'DeepSeek', hasKey: true, models: [M('deepseek-v4-flash')], p: stub('deepseek') }];
    const pool = new ModelPool({ summaries: async () => list, get: () => list[0].p });
    expect((await pool.rank('fast'))[0].contextWindow).toBe(1_000_000);
    const other = [{ id: 'x', label: 'X', hasKey: true, models: [M('mystery-model')], p: stub('x') }];
    expect((await new ModelPool({ summaries: async () => other, get: () => other[0].p }).rank('fast'))[0].contextWindow).toBe(128_000);
  });
});

describe('ProviderService — tóm tắt cho giao diện và cửa sổ ngữ cảnh', () => {
  const TOKEN = `lat_${'Ab1Cd2Ef3G'.repeat(5).slice(0, 43)}`;
  const service = (needs: boolean, withAccount = true) =>
    new ProviderService({
      baseUrls: () => ({}),
      customProviders: () => [],
      eagerInput: () => true,
      summarizerModel: () => 'auto',
      resolveKey: async () => undefined,
      log: () => undefined,
      env: {},
      ...(withAccount
        ? { account: { token: () => TOKEN, headers: () => ({}), guard: () => (needs ? new ProviderError('cần đồng ý', { kind: 'consent_required', providerId: 'locaith' }) : undefined) } }
        : {}),
    });

  it('locaith: account=true, hasKey=đã đăng nhập, needsConsent theo chốt chặn; hãng khác không có hai cờ này', async () => {
    const s = await service(true).summaries();
    const lo = s.find((x) => x.id === 'locaith')!;
    expect(lo).toMatchObject({ account: true, needsConsent: true, hasKey: true, builtin: true, keyFromEnv: false, label: 'Locaith AI Local' });
    expect(lo.keyUrl).toBeUndefined();
    expect(lo.models.map((m) => m.id)).toEqual(['locaith-v5-flash', 'locaith-v5-si']);
    for (const other of s.filter((x) => x.id !== 'locaith')) {
      expect(other.account).toBeUndefined();
      expect(other.needsConsent).toBeUndefined();
    }
    expect((await service(false).summaries()).find((x) => x.id === 'locaith')!.needsConsent).toBe(false);
    expect((await service(false, false).summaries()).map((x) => x.id)).not.toContain('locaith'); // bản trình duyệt
  });

  it('contextWindow: danh sách dự phòng → bảng theo tên → 128K cho model lạ', () => {
    const s = service(false);
    expect(s.contextWindow('locaith', 'locaith-v5-flash')).toBe(1_000_000);
    expect(s.contextWindow('locaith', 'locaith-v5-si')).toBe(1_000_000);
    expect(s.contextWindow('deepseek', 'deepseek-flash')).toBe(1_000_000);
    expect(s.contextWindow('deepseek', 'deepseek-v4-flash')).toBe(1_000_000);
    expect(s.contextWindow('deepseek', 'deepseek-chat')).toBe(128_000);
    expect(s.contextWindow('anthropic', 'một-model-lạ')).toBe(128_000);
  });
});

describe('FailoverProvider — hàng chờ chưa phải "đã bắt đầu trả lời"', () => {
  const req: StreamRequest = { model: 'x', system: '', messages: [], tools: [], maxOutputTokens: 10, thinking: { level: 'off', summaries: false }, signal: new AbortController().signal, sessionKey: 's' };
  const target = (id: string, p: LLMProvider) => ({ providerId: id, providerLabel: id, model: 'm', modelLabel: 'm', tier: 'fast' as const, contextWindow: 1000, provider: p });
  const gen = (id: string, events: ProviderEvent[], fail?: ProviderError): LLMProvider => ({
    ...stub(id),
    async *stream() {
      for (const e of events) yield e;
      if (fail) throw fail;
    },
  });
  const q: ProviderEvent = { type: 'queue', position: 3, ahead: 2, attempt: 1, waitMs: 1000, retryAt: 5 };
  const ok = (id: string): ProviderEvent[] => [
    { type: 'text_delta', text: `từ ${id}` },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [{ type: 'text', text: `từ ${id}` }] } },
  ];

  it('đã xếp hàng rồi mới gãy (chưa được nhận) → vẫn chuyển sang đích kế tiếp', async () => {
    const a = gen('locaith', [q], new ProviderError('quá tải', { kind: 'overloaded', providerId: 'locaith' }));
    const b = gen('claude', ok('claude'));
    const fo = new FailoverProvider([target('locaith', a), target('claude', b)], null);
    const events = await collect(fo.stream(req));
    expect(events.map((e) => e.type)).toEqual(['queue', 'text_delta', 'done']);
  });

  it('đã được nhận (queue_end) rồi mới gãy → KHÔNG chuyển (giao diện có thể đã hiện chữ): lỗi đi thẳng lên engine', async () => {
    const a = gen('locaith', [q, { type: 'queue_end' }], new ProviderError('đứt', { kind: 'network', providerId: 'locaith' }));
    const b = gen('claude', ok('claude'));
    const fo = new FailoverProvider([target('locaith', a), target('claude', b)], null);
    await expect(collect(fo.stream(req))).rejects.toMatchObject({ kind: 'network' });
  });
});
