import { describe, expect, it, vi } from 'vitest';
import { ModelCatalog, MODELS_FAIL_TTL_MS, MODELS_TTL_MS, enrichModels } from '../../src/core/providers/catalog';
import type { LLMProvider, ModelInfo } from '../../src/core/types';

/** Đồng hồ giả để test TTL mà không phải chờ. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

type Fetch = (signal?: AbortSignal) => Promise<ModelInfo[]>;

function fakeProvider(fetchModels: Fetch, id = 'p'): LLMProvider {
  return {
    id,
    label: id,
    kind: 'openai-chat',
    flavor: 'generic',
    capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'incremental' },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('không dùng');
    },
    complete: async () => '',
    fetchModels,
    ping: async () => undefined,
  };
}

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });
const ids = (r: { models: ModelInfo[] }) => r.models.map((x) => x.id).join(',');

const FALLBACK: ModelInfo[] = [m('fb-1', { label: 'Dự phòng 1', tier: 'top', contextWindow: 1000 }), m('fb-2', { label: 'Dự phòng 2' })];

function setup(fetchImpl: Fetch, opts: { key?: string | undefined; requiresKey?: boolean; pinned?: ModelInfo[] } = {}) {
  const c = clock();
  const catalog = new ModelCatalog({ now: c.now });
  const state = { key: 'key' in opts ? opts.key : 'k1' };
  const fetchModels = vi.fn(fetchImpl);
  catalog.register({
    provider: fakeProvider(fetchModels),
    getApiKey: async () => state.key,
    requiresKey: opts.requiresKey,
    fallback: FALLBACK,
    pinned: opts.pinned,
  });
  return { catalog, c, state, fetchModels };
}

describe('ModelCatalog — danh sách thật & bộ nhớ đệm', () => {
  it('chưa có khoá → danh sách dự phòng, KHÔNG gọi mạng', async () => {
    const { catalog, fetchModels } = setup(async () => [m('live')], { key: undefined });
    const r = await catalog.list('p');
    expect(r).toEqual({ models: FALLBACK, source: 'fallback' });
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('có khoá → danh sách thật (source live), lần sau lấy từ đệm (source cache), chỉ gọi 1 lần', async () => {
    const { catalog, fetchModels } = setup(async () => [m('live-1'), m('live-2')]);
    const first = await catalog.list('p');
    expect(first.source).toBe('live');
    expect(ids(first)).toBe('live-1,live-2');
    expect(first.fetchedAt).toBeDefined();
    const second = await catalog.list('p');
    expect(second.source).toBe('cache');
    expect(ids(second)).toBe('live-1,live-2');
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('nhiều lượt gọi cùng lúc dùng chung MỘT lượt hỏi', async () => {
    const { catalog, fetchModels } = setup(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [m('live')];
    });
    const results = await Promise.all([catalog.list('p'), catalog.list('p'), catalog.list('p')]);
    expect(results.every((r) => ids(r) === 'live')).toBe(true);
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('hết hạn đệm 1 giờ thì hỏi lại; force bỏ qua đệm', async () => {
    const { catalog, c, fetchModels } = setup(async () => [m('live')]);
    await catalog.list('p');
    c.advance(MODELS_TTL_MS - 1000);
    await catalog.list('p');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    c.advance(2000);
    await catalog.list('p');
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await catalog.list('p', { force: true });
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it('danh sách thật được bổ sung nhãn/bậc/cửa sổ ngữ cảnh từ bản dự phòng theo id', async () => {
    const { catalog } = setup(async () => [m('fb-1'), m('moi-ra-mat', { contextWindow: 5 })]);
    const r = await catalog.list('p');
    expect(r.models[0]).toEqual({ id: 'fb-1', label: 'Dự phòng 1', tier: 'top', contextWindow: 1000 });
    expect(r.models[1]).toEqual({ id: 'moi-ra-mat', label: 'moi-ra-mat', contextWindow: 5 });
  });

  it('danh sách thật rỗng → dùng dự phòng (source fallback, không báo lỗi)', async () => {
    const { catalog } = setup(async () => []);
    const r = await catalog.list('p');
    expect(r.source).toBe('fallback');
    expect(r.models).toEqual(FALLBACK);
    expect(r.error).toBeUndefined();
  });
});

describe('ModelCatalog — lỗi', () => {
  it('hãng sập → dự phòng kèm lỗi; nhớ ngắn 2 phút để không hỏi dồn', async () => {
    const { catalog, c, fetchModels } = setup(async () => {
      throw new Error('Gemini trả mã 500');
    });
    const a = await catalog.list('p');
    expect(a).toMatchObject({ source: 'fallback', error: 'Gemini trả mã 500' });
    expect(a.models).toEqual(FALLBACK);
    const b = await catalog.list('p');
    expect(b.source).toBe('fallback');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    c.advance(MODELS_FAIL_TTL_MS + 1000);
    await catalog.list('p');
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('hỏi lại lỗi mà còn danh sách cũ → dùng danh sách cũ (source cache + error), tốt hơn dự phòng', async () => {
    let fail = false;
    const { catalog, c } = setup(async () => {
      if (fail) throw new Error('mất mạng');
      return [m('live-cu')];
    });
    await catalog.list('p');
    fail = true;
    c.advance(MODELS_TTL_MS + 1000);
    const r = await catalog.list('p');
    expect(r).toMatchObject({ source: 'cache', error: 'mất mạng' });
    expect(ids(r)).toBe('live-cu');
  });

  it('khôi phục sau lỗi: lần hỏi thành công kế tiếp trả danh sách thật', async () => {
    let fail = true;
    const { catalog, c } = setup(async () => {
      if (fail) throw new Error('x');
      return [m('live')];
    });
    await catalog.list('p');
    fail = false;
    c.advance(MODELS_FAIL_TTL_MS + 1000);
    expect(await catalog.list('p')).toMatchObject({ source: 'live' });
  });
});

describe('ModelCatalog — khoá API', () => {
  it('danh sách lấy bằng khoá cũ không dùng cho khoá mới', async () => {
    const lists: Record<string, ModelInfo[]> = { k1: [m('cua-k1')], k2: [m('cua-k2')] };
    const state = { key: 'k1' };
    const c = clock();
    const catalog = new ModelCatalog({ now: c.now });
    const fetchModels = vi.fn(async () => lists[state.key]);
    catalog.register({ provider: fakeProvider(fetchModels), getApiKey: async () => state.key, fallback: FALLBACK });
    expect(ids(await catalog.list('p'))).toBe('cua-k1');
    state.key = 'k2';
    expect(ids(await catalog.list('p'))).toBe('cua-k2');
    expect(fetchModels).toHaveBeenCalledTimes(2);
    state.key = 'k1';
    expect(ids(await catalog.list('p'))).toBe('cua-k1'); // quay lại khoá cũ → hỏi lại (đệm đã bị bỏ)
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it('xoá khoá giữa chừng → quay về dự phòng, không dùng danh sách đệm của khoá cũ', async () => {
    const { catalog, state } = setup(async () => [m('live')]);
    await catalog.list('p');
    state.key = undefined;
    expect(await catalog.list('p')).toEqual({ models: FALLBACK, source: 'fallback' });
  });

  it('requiresKey=false (Ollama…) → vẫn hỏi dù không có khoá', async () => {
    const { catalog, fetchModels } = setup(async () => [m('llama3')], { key: undefined, requiresKey: false });
    expect(ids(await catalog.list('p'))).toBe('llama3');
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

describe('ModelCatalog — resolveModel', () => {
  it('model đã lưu còn được cung cấp → giữ nguyên', async () => {
    const { catalog } = setup(async () => [m('a'), m('b')]);
    expect(await catalog.resolveModel('p', 'b')).toBe('b');
  });

  it('model đã bị hãng khai tử → thay bằng model mong muốn nếu còn, không thì model đầu danh sách', async () => {
    const { catalog } = setup(async () => [m('moi-1'), m('moi-2')]);
    expect(await catalog.resolveModel('p', 'da-xoa', { preferred: 'moi-2' })).toBe('moi-2');
    expect(await catalog.resolveModel('p', 'da-xoa', { preferred: 'cung-khong-con' })).toBe('moi-1');
    expect(await catalog.resolveModel('p', undefined)).toBe('moi-1');
  });

  it('chỉ có danh sách dự phòng (không kiểm chứng được) → giữ nguyên lựa chọn của người dùng, kể cả tên gõ tay', async () => {
    const { catalog } = setup(async () => [m('x')], { key: undefined });
    expect(await catalog.resolveModel('p', 'ten-go-tay')).toBe('ten-go-tay');
    expect(await catalog.resolveModel('p', undefined, { preferred: 'fb-2' })).toBe('fb-2');
    expect(await catalog.resolveModel('p', undefined)).toBe('fb-1');
  });
});

describe('ModelCatalog — khác', () => {
  it('model ghim tay luôn có mặt (kể cả khi danh sách thật không có)', async () => {
    const { catalog } = setup(async () => [m('live')], { pinned: [m('ghim-1'), m('live')] });
    expect(ids(await catalog.list('p'))).toBe('live,ghim-1');
  });

  it('peek: undefined khi chưa hỏi; sau đó trả kết quả mà không gọi mạng', async () => {
    const { catalog, fetchModels } = setup(async () => [m('live')]);
    expect(catalog.peek('p')).toBeUndefined();
    await catalog.list('p');
    expect(catalog.peek('p')).toMatchObject({ source: 'cache' });
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('invalidate buộc hỏi lại; unregister xoá hẳn', async () => {
    const { catalog, fetchModels } = setup(async () => [m('live')]);
    await catalog.list('p');
    catalog.invalidate('p');
    await catalog.list('p');
    expect(fetchModels).toHaveBeenCalledTimes(2);
    catalog.unregister('p');
    await expect(catalog.list('p')).rejects.toThrow(/chưa đăng ký/);
  });

  it('fallbackOf trả dự phòng (kèm model ghim)', () => {
    const { catalog } = setup(async () => [], { pinned: [m('ghim')] });
    expect(catalog.fallbackOf('p').map((x) => x.id)).toEqual(['fb-1', 'fb-2', 'ghim']);
  });
});

describe('enrichModels', () => {
  it('trường của hãng thắng, nhãn đẹp chỉ thế chỗ khi nhãn thật = id', () => {
    const out = enrichModels(
      [m('a', { label: 'Tên thật từ hãng', contextWindow: 7 }), m('b'), m('c')],
      [m('a', { label: 'Nhãn đẹp', contextWindow: 1, tier: 'fast' }), m('b', { label: 'B đẹp', tier: 'top' })],
    );
    expect(out[0]).toMatchObject({ label: 'Tên thật từ hãng', contextWindow: 7, tier: 'fast' });
    expect(out[1]).toMatchObject({ label: 'B đẹp', tier: 'top' });
    expect(out[2]).toEqual(m('c'));
  });
});
