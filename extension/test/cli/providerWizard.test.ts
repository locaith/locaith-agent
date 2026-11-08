import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askKey, addProviderFlow, customFlow, keyFlow, providerMenu, removeFlow, renderList, testFlow, testLine, vendorKeyFlow, wizardIoFromUi, type SayKind, type TestResult, type WizardDeps, type WizardIO } from '../../src/cli/providerWizard';
import { readStoredKeys, readUserCustomRaw, saveStoredKey, upsertCustomProvider } from '../../src/cli/providerStore';
import type { ProviderRow } from '../../src/cli/runtime/providers';
import type { PickItem } from '../../src/cli/runtime/contract';

const dirs: string[] = [];
function home(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pwiz-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Ans = string | boolean | null;
interface Call {
  kind: 'pick' | 'input' | 'confirm';
  title: string;
  secret?: boolean;
  initial?: string;
  items?: PickItem[];
}

/** Giao diện giả theo kịch bản: mỗi lần hỏi lấy một câu trả lời kế tiếp; hết kịch bản mà còn hỏi thì ném (bắt vòng lặp vô tận). */
function scriptIO(answers: Ans[]) {
  const calls: Call[] = [];
  const said: Array<{ kind: SayKind; text: string }> = [];
  let i = 0;
  const next = (c: Call): Ans => {
    calls.push(c);
    if (i >= answers.length) throw new Error(`Hết kịch bản ở lần hỏi #${i + 1}: ${c.kind} «${c.title}»`);
    return answers[i++]!;
  };
  const io: WizardIO = {
    pick: async (title, items) => next({ kind: 'pick', title, items }) as string | null,
    input: async (title, _detail, o) => next({ kind: 'input', title, secret: o?.secret, initial: o?.initial }) as string | null,
    confirm: async (title) => next({ kind: 'confirm', title }) as boolean | null,
    say: (kind, text) => void said.push({ kind, text }),
  };
  return { io, calls, said, left: () => answers.length - i, text: (k?: SayKind) => said.filter((s) => !k || s.kind === k).map((s) => s.text).join('\n') };
}

function deps(h: string, over: Partial<WizardDeps> = {}) {
  const log = { reloads: 0, tested: [] as string[], keys: [] as string[] };
  const d: WizardDeps = {
    home: h,
    env: {},
    lang: 'vi',
    reload: () => void log.reloads++,
    test: async (id) => {
      log.tested.push(id);
      return { ok: true, models: 3, ms: 7 };
    },
    onKey: (k) => void log.keys.push(k),
    ...over,
  };
  return { d, log };
}

describe('addProviderFlow: mẫu có sẵn', () => {
  it('OpenRouter: địa chỉ + id + tên + model + khoá → ghi định nghĩa, lưu khoá GẮN địa chỉ, nạp lại, thử kết nối, che khoá khỏi nhật ký', async () => {
    const h = home();
    const s = scriptIO(['p:openrouter', 'https://openrouter.ai/api/v1', 'openrouter', 'OpenRouter', '', 'sk-or-v1-abcdef123456']);
    const { d, log } = deps(h);
    const r = await addProviderFlow(s.io, d);
    expect(r).toEqual({ id: 'openrouter' });
    expect(s.left()).toBe(0);
    expect(readUserCustomRaw(h)).toEqual([{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, keyUrl: 'https://openrouter.ai/keys' }]);
    expect(readStoredKeys(h).keys.openrouter).toMatchObject({ key: 'sk-or-v1-abcdef123456', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(log.reloads).toBeGreaterThan(0);
    expect(log.tested).toEqual(['openrouter']);
    expect(log.keys).toEqual(['sk-or-v1-abcdef123456']);
    // ô khoá là ô ẩn và là ô DUY NHẤT ẩn
    expect(s.calls.filter((c) => c.secret).map((c) => c.kind)).toEqual(['input']);
    // khoá không bao giờ xuất hiện trong lời nhắn hiển thị
    expect(s.said.map((m) => m.text).join('\n')).not.toContain('sk-or-v1-abcdef123456');
    expect(s.said.some((m) => m.kind === 'ok')).toBe(true);
  });

  it('Ollama: không cần khoá → KHÔNG hỏi khoá; model ghim được tách theo dấu phẩy; định nghĩa requiresKey=false', async () => {
    const h = home();
    const s = scriptIO(['p:ollama', 'http://localhost:11434/v1', 'ollama', 'Ollama', 'qwen3-coder, llama3.3', ]);
    const { d, log } = deps(h);
    expect(await addProviderFlow(s.io, d)).toEqual({ id: 'ollama' });
    expect(s.calls.some((c) => c.secret)).toBe(false);
    expect(readUserCustomRaw(h)).toEqual([{ id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder', 'llama3.3'], requiresKey: false }]);
    expect(fs.existsSync(path.join(h, '.locaith', 'provider-keys.json'))).toBe(false);
    expect(log.tested).toEqual(['ollama']);
  });

  it('để trống ô khoá → vẫn thêm API, nhắc đặt biến <ID>_API_KEY, không lưu khoá', async () => {
    const h = home();
    const s = scriptIO(['p:groq', 'https://api.groq.com/openai/v1', 'groq', 'Groq', '', '']);
    const { d } = deps(h);
    expect(await addProviderFlow(s.io, d)).toEqual({ id: 'groq' });
    expect(readUserCustomRaw(h)).toHaveLength(1);
    expect(readStoredKeys(h).keys).toEqual({});
    expect(s.text('info')).toContain('GROQ_API_KEY');
  });

  it('huỷ ở bất kỳ bước nào → không ghi gì (kể cả khi đã nhập gần hết)', async () => {
    const h = home();
    const s = scriptIO(['p:groq', 'https://api.groq.com/openai/v1', 'groq', 'Groq', '', null]);
    expect(await addProviderFlow(s.io, deps(h).d)).toBeNull();
    expect(fs.existsSync(path.join(h, '.locaith', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(h, '.locaith', 'provider-keys.json'))).toBe(false);
    // huỷ ngay ở màn chọn
    expect(await addProviderFlow(scriptIO([null]).io, deps(h).d)).toBeNull();
  });
});

describe('addProviderFlow: địa chỉ bất kỳ', () => {
  it('địa chỉ bị từ chối được hỏi lại KÈM lý do; id sai/dành riêng bị hỏi lại; khoá sai dạng bị hỏi lại; nhãn trống lấy id', async () => {
    const h = home();
    const s = scriptIO([
      'custom',
      true, // cần khoá
      'http://api.example.com/v1', // http công cộng → bị từ chối
      'https://llm.example.com/v1',
      'BAD ID', // sai dạng
      'openai', // dành riêng
      'my-llm',
      '', // nhãn trống
      '', // không ghim model
      'sk bad key', // khoá có khoảng trắng
      'sk-mine-12345678',
    ]);
    const { d, log } = deps(h);
    expect(await addProviderFlow(s.io, d)).toEqual({ id: 'my-llm' });
    expect(s.left()).toBe(0);
    const warns = s.said.filter((m) => m.kind === 'warn').map((m) => m.text);
    expect(warns.length).toBeGreaterThanOrEqual(4);
    expect(warns[0]).toContain('api.example.com'); // lý do nêu đúng máy chủ
    expect(warns.some((w) => w.includes('bad id'))).toBe(true); // id được hạ chữ thường trước khi kiểm
    expect(warns.some((w) => w.includes('openai'))).toBe(true);
    expect(readUserCustomRaw(h)).toEqual([{ id: 'my-llm', label: 'my-llm', baseUrl: 'https://llm.example.com/v1', requiresKey: true }]);
    expect(readStoredKeys(h).keys['my-llm']).toMatchObject({ key: 'sk-mine-12345678', baseUrl: 'https://llm.example.com/v1' });
    expect(log.keys).toEqual(['sk-mine-12345678']);
  });

  it('bốn lần nhập địa chỉ sai liên tiếp → thôi (không lặp vô tận)', async () => {
    const h = home();
    const s = scriptIO(['custom', true, 'x', 'y', 'ftp://z.example', 'http://q.example/v1']);
    expect(await addProviderFlow(s.io, deps(h).d)).toBeNull();
    expect(fs.existsSync(path.join(h, '.locaith', 'settings.json'))).toBe(false);
  });

  it('http tới mạng nội bộ chỉ qua khi chọn «không cần khoá»; chọn «cần khoá» thì bị từ chối và nêu lý do', async () => {
    const h = home();
    const needKey = scriptIO(['custom', true, 'http://192.168.1.50:8000/v1', null]);
    expect(await addProviderFlow(needKey.io, deps(h).d)).toBeNull();
    expect(needKey.text('warn')).toContain('192.168.1.50');
    const noKey = scriptIO(['custom', false, 'http://192.168.1.50:8000/v1', 'nas-llm', 'NAS', 'm1']);
    expect(await addProviderFlow(noKey.io, deps(h).d)).toEqual({ id: 'nas-llm' });
    expect(readUserCustomRaw(h)).toEqual([{ id: 'nas-llm', label: 'NAS', baseUrl: 'http://192.168.1.50:8000/v1', models: ['m1'], requiresKey: false }]);
  });

  it('id đã có: hỏi xác nhận ghi đè; không đồng ý thì phải chọn id khác và định nghĩa cũ còn nguyên', async () => {
    const h = home();
    upsertCustomProvider(h, { id: 'groq', label: 'Groq cũ', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const s = scriptIO(['custom', true, 'https://api.example.org/v1', 'groq', false, 'groq2', 'Mới', '', 'sk-new-12345678']);
    expect(await addProviderFlow(s.io, deps(h).d)).toEqual({ id: 'groq2' });
    const raw = readUserCustomRaw(h) as Array<{ id: string; label: string }>;
    expect(raw.map((x) => x.id)).toEqual(['groq', 'groq2']);
    expect(raw[0]!.label).toBe('Groq cũ');
    expect(s.calls.filter((c) => c.kind === 'confirm').map((c) => c.title).length).toBe(2); // «cần khoá?» + «ghi đè?»
  });

  it('id đã có + đồng ý ghi đè → thay định nghĩa', async () => {
    const h = home();
    upsertCustomProvider(h, { id: 'groq', label: 'Groq cũ', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const s = scriptIO(['custom', true, 'https://api.example.org/v1', 'groq', true, 'Groq mới', '', '']);
    expect(await addProviderFlow(s.io, deps(h).d)).toEqual({ id: 'groq' });
    expect(readUserCustomRaw(h)).toEqual([{ id: 'groq', label: 'Groq mới', baseUrl: 'https://api.example.org/v1', requiresKey: true }]);
  });

  it('gợi ý id từ tên máy chủ (api.mistral.ai → mistral); tên máy chủ lạ/IP → custom', async () => {
    const h = home();
    const s = scriptIO(['custom', true, 'https://api.acme-ai.com/v1', null]);
    await addProviderFlow(s.io, deps(h).d);
    const idPrompt = s.calls.filter((c) => c.kind === 'input')[1];
    expect(idPrompt?.initial).toBe('acme-ai');
    const s2 = scriptIO(['custom', false, 'http://10.0.0.5:8000/v1', null]);
    await addProviderFlow(s2.io, deps(h).d);
    expect(s2.calls.filter((c) => c.kind === 'input')[1]?.initial).toBe('custom');
  });

  it('thử kết nối hỏng KHÔNG làm mất cấu hình đã lưu; báo đúng nguyên nhân', async () => {
    const h = home();
    const fail: TestResult = { ok: false, ms: 5, reason: 'unreachable', error: 'Máy chủ từ chối kết nối (ECONNREFUSED).' };
    const s = scriptIO(['p:ollama', 'http://localhost:11434/v1', 'ollama', 'Ollama', 'qwen3-coder']);
    expect(await addProviderFlow(s.io, deps(h, { test: async () => fail }).d)).toEqual({ id: 'ollama' });
    expect(readUserCustomRaw(h)).toHaveLength(1);
    const warn = s.said.find((m) => m.kind === 'warn');
    expect(warn?.text).toContain('ECONNREFUSED');
    expect(warn?.text).not.toContain('vẫn dùng được'); // không an ủi sai khi máy chủ còn không tới được
  });
});

describe('hãng dựng sẵn: chỉ cần khoá', () => {
  it('chọn DeepSeek → khoá được lưu GẮN địa chỉ mặc định của hãng', async () => {
    const h = home();
    const s = scriptIO(['v:deepseek', 'sk-ds-12345678']);
    const { d, log } = deps(h);
    expect(await addProviderFlow(s.io, d)).toEqual({ id: 'deepseek' });
    expect(readStoredKeys(h).keys.deepseek).toMatchObject({ key: 'sk-ds-12345678', baseUrl: 'https://api.deepseek.com' });
    expect(log.tested).toEqual(['deepseek']);
    expect(fs.existsSync(path.join(h, '.locaith', 'settings.json'))).toBe(false); // hãng dựng sẵn không thêm định nghĩa
  });

  it('khoá bỏ trống hoặc huỷ → false, không lưu', async () => {
    const h = home();
    expect(await vendorKeyFlow(scriptIO(['']).io, deps(h).d, 'openai')).toBe(false);
    expect(await vendorKeyFlow(scriptIO([null]).io, deps(h).d, 'openai')).toBe(false);
    expect(await vendorKeyFlow(scriptIO([]).io, deps(h).d, 'không-có')).toBe(false);
    expect(readStoredKeys(h).keys).toEqual({});
  });

  it('địa chỉ hãng đã đổi qua baseUrls → khoá gắn với địa chỉ MỚI', async () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.locaith'), { recursive: true });
    fs.writeFileSync(path.join(h, '.locaith', 'settings.json'), JSON.stringify({ baseUrls: { openai: 'https://proxy.example.com/v1' } }));
    await vendorKeyFlow(scriptIO(['sk-oa-12345678']).io, deps(h).d, 'openai');
    expect(readStoredKeys(h).keys.openai!.baseUrl).toBe('https://proxy.example.com/v1');
  });
});

describe('askKey', () => {
  const d = (): WizardDeps => deps(home()).d;
  it('trả khoá đã làm sạch (bỏ «Bearer »), chuỗi rỗng khi để trống, null khi huỷ', async () => {
    expect(await askKey(scriptIO(['Bearer sk-x-12345678']).io, d(), { label: 'X', envName: 'X_API_KEY' })).toBe('sk-x-12345678');
    expect(await askKey(scriptIO(['   ']).io, d(), { label: 'X', envName: 'X_API_KEY' })).toBe('');
    expect(await askKey(scriptIO([null]).io, d(), { label: 'X', envName: 'X_API_KEY' })).toBeNull();
  });
  it('khoá sai dạng: hỏi lại tối đa 3 lần rồi thôi', async () => {
    const s = scriptIO(['a b', 'c d', 'e f']);
    expect(await askKey(s.io, d(), { label: 'X', envName: 'X_API_KEY' })).toBeNull();
    expect(s.calls).toHaveLength(3);
    expect(s.said.filter((m) => m.kind === 'warn')).toHaveLength(3);
  });
  it('ô nhập luôn là ô ẩn', async () => {
    const s = scriptIO(['sk-ok-12345678']);
    await askKey(s.io, d(), { label: 'X', envName: 'X_API_KEY' });
    expect(s.calls[0]!.secret).toBe(true);
  });
});

describe('keyFlow', () => {
  it('đặt khoá cho hãng theo id; đổi khoá thì thay khoá cũ', async () => {
    const h = home();
    saveStoredKey(h, 'openai', 'sk-old-12345678', 'https://api.openai.com/v1');
    const { d, log } = deps(h);
    expect(await keyFlow(scriptIO(['sk-new-87654321']).io, d, 'openai')).toBe(true);
    expect(readStoredKeys(h).keys.openai!.key).toBe('sk-new-87654321');
    expect(log.tested).toEqual(['openai']);
  });
  it('không đưa id: chọn từ danh sách (hãng dựng sẵn + API tuỳ chỉnh), có ghi trạng thái khoá', async () => {
    const h = home();
    upsertCustomProvider(h, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    saveStoredKey(h, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    const s = scriptIO(['groq', 'gsk-12345678']);
    expect(await keyFlow(s.io, deps(h, { env: { OPENAI_API_KEY: 'sk-env-1234567' } }).d)).toBe(true);
    const items = s.calls[0]!.items!;
    expect(items.map((i) => i.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'groq']);
    expect(items.find((i) => i.id === 'openai')!.detail).toMatch(/biến môi trường/);
    expect(items.find((i) => i.id === 'deepseek')!.detail).toMatch(/đã lưu/);
    expect(items.find((i) => i.id === 'anthropic')!.detail).toMatch(/chưa/);
    expect(readStoredKeys(h).keys.groq).toMatchObject({ key: 'gsk-12345678', baseUrl: 'https://api.groq.com/openai/v1' });
  });
  it('id không tồn tại → báo lỗi, không hỏi khoá', async () => {
    const s = scriptIO([]);
    expect(await keyFlow(s.io, deps(home()).d, 'không-có')).toBe(false);
    expect(s.said[0]!.kind).toBe('error');
  });
  it('«locaith» dùng tài khoản, không dùng khoá API → chỉ lối vào `locaith login`, không hỏi khoá', async () => {
    const s = scriptIO([]);
    expect(await keyFlow(s.io, deps(home()).d, 'locaith')).toBe(false);
    expect(s.said[0]!.text).toContain('locaith login');
    expect(s.calls).toHaveLength(0);
  });
  it('biến môi trường của hãng đang đặt → nhắc nó thắng khoá vừa lưu', async () => {
    const h = home();
    const s = scriptIO(['sk-new-87654321']);
    await keyFlow(s.io, deps(h, { env: { OPENAI_API_KEY: 'sk-env-1234567' } }).d, 'openai');
    expect(readStoredKeys(h).keys.openai!.key).toBe('sk-new-87654321');
    expect(s.said.find((m) => m.kind === 'warn')!.text).toContain('OPENAI_API_KEY');
  });
  it('khoá để trống / huỷ → không đổi gì', async () => {
    const h = home();
    saveStoredKey(h, 'openai', 'sk-old-12345678', 'https://api.openai.com/v1');
    expect(await keyFlow(scriptIO(['']).io, deps(h).d, 'openai')).toBe(false);
    expect(await keyFlow(scriptIO([null]).io, deps(h).d, 'openai')).toBe(false);
    expect(readStoredKeys(h).keys.openai!.key).toBe('sk-old-12345678');
  });
});

describe('removeFlow', () => {
  function setup() {
    const h = home();
    upsertCustomProvider(h, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    saveStoredKey(h, 'groq', 'gsk-12345678', 'https://api.groq.com/openai/v1');
    saveStoredKey(h, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    return h;
  }
  it('gỡ API tuỳ chỉnh gỡ luôn khoá của nó, giữ khoá khác; nạp lại', async () => {
    const h = setup();
    const { d, log } = deps(h);
    const s = scriptIO(['groq', true]);
    expect(await removeFlow(s.io, d)).toBe(true);
    expect(readUserCustomRaw(h)).toEqual([]);
    expect(Object.keys(readStoredKeys(h).keys)).toEqual(['deepseek']);
    expect(log.reloads).toBeGreaterThan(0);
    expect(s.calls[0]!.items!.map((i) => i.id).sort()).toEqual(['deepseek', 'groq']);
  });
  it('hãng dựng sẵn: chỉ xoá khoá đã lưu', async () => {
    const h = setup();
    expect(await removeFlow(scriptIO(['deepseek', true]).io, deps(h).d)).toBe(true);
    expect(Object.keys(readStoredKeys(h).keys)).toEqual(['groq']);
    expect(readUserCustomRaw(h)).toHaveLength(1);
  });
  it('không xác nhận → không xoá gì', async () => {
    const h = setup();
    expect(await removeFlow(scriptIO(['groq', false]).io, deps(h).d)).toBe(false);
    expect(await removeFlow(scriptIO(['groq', null]).io, deps(h).d)).toBe(false);
    expect(await removeFlow(scriptIO([null]).io, deps(h).d)).toBe(false);
    expect(readUserCustomRaw(h)).toHaveLength(1);
    expect(Object.keys(readStoredKeys(h).keys).sort()).toEqual(['deepseek', 'groq']);
  });
  it('không có gì để gỡ → nói rõ, không hỏi', async () => {
    const s = scriptIO([]);
    expect(await removeFlow(s.io, deps(home()).d)).toBe(false);
    expect(s.said[0]!.kind).toBe('info');
  });
});

describe('testFlow và menu', () => {
  it('testFlow: chọn trong danh sách thử được; có id thì thử thẳng; danh sách rỗng → báo', async () => {
    const h = home();
    const { d, log } = deps(h, { testable: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
    await testFlow(scriptIO(['b']).io, d);
    await testFlow(scriptIO([]).io, d, 'a');
    expect(log.tested).toEqual(['b', 'a']);
    const empty = scriptIO([]);
    await testFlow(empty.io, deps(h, { testable: () => [] }).d);
    expect(empty.said[0]!.kind).toBe('info');
    await testFlow(scriptIO([null]).io, d); // huỷ ở màn chọn
    expect(log.tested).toEqual(['b', 'a']);
  });
  it('testFlow dùng đúng câu theo nguyên nhân (khoá bị từ chối / máy chủ không có /models)', async () => {
    const h = home();
    const auth = scriptIO([]);
    await testFlow(auth.io, deps(h, { test: async () => ({ ok: false, ms: 1, reason: 'auth', error: 'HTTP 401' }) }).d, 'x');
    expect(auth.said.at(-1)!.text).toMatch(/từ chối khoá/);
    expect(auth.said.at(-1)!.text).toContain('locaith provider key x');
    upsertCustomProvider(h, { id: 'pin', label: 'Pin', baseUrl: 'https://p.example.com/v1', models: ['m1'], requiresKey: false }, 'vi');
    const pinned = scriptIO([]);
    await testFlow(pinned.io, deps(h, { test: async () => ({ ok: false, ms: 1, reason: 'no-models', error: 'HTTP 404' }) }).d, 'pin');
    expect(pinned.said.at(-1)!.text).toMatch(/vẫn dùng được/);
    const unpinned = scriptIO([]);
    await testFlow(unpinned.io, deps(h, { test: async () => ({ ok: false, ms: 1, reason: 'no-models', error: 'HTTP 404' }) }).d, 'other');
    expect(unpinned.said.at(-1)!.text).toContain('--model other:');
  });
  it('providerMenu: chuyển đúng hành động; huỷ thì thôi', async () => {
    const h = home();
    const list = scriptIO(['list']);
    await providerMenu(list.io, deps(h, { list: () => 'DANH-SÁCH' }).d);
    expect(list.said[0]).toEqual({ kind: 'text', text: 'DANH-SÁCH' });
    const add = scriptIO(['add', null]);
    await providerMenu(add.io, deps(h).d);
    expect(add.calls.map((c) => c.kind)).toEqual(['pick', 'pick']);
    await providerMenu(scriptIO([null]).io, deps(h).d);
    const rm = scriptIO(['remove']);
    await providerMenu(rm.io, deps(h).d);
    expect(rm.said[0]!.kind).toBe('info');
  });
});

describe('customFlow trực tiếp', () => {
  it('mẫu tuỳ ý (không phải mẫu dựng sẵn) với requiresKey=false không hỏi «cần khoá không»', async () => {
    const h = home();
    const s = scriptIO(['http://127.0.0.1:8080/v1', 'local-llm', 'Local', 'm']);
    const r = await customFlow(s.io, deps(h).d, { id: 'x', label: 'X', baseUrl: 'http://127.0.0.1:8080/v1', requiresKey: false });
    expect(r).toEqual({ id: 'local-llm' });
    expect(s.calls.some((c) => c.kind === 'confirm')).toBe(false);
  });
});

describe('wizardIoFromUi', () => {
  it('đổi chữ ký ô nhập (secret là tham số thứ ba của giao diện terminal)', async () => {
    const seen: unknown[] = [];
    const io = wizardIoFromUi({
      pick: async () => 'p',
      confirm: async () => true,
      input: async (title, detail, secret, o) => {
        seen.push({ title, detail, secret, o });
        return 'v';
      },
      say: () => undefined,
    });
    expect(await io.input('T', 'D', { secret: true, initial: 'i', placeholder: 'ph' })).toBe('v');
    expect(await io.input('T2', 'D2')).toBe('v');
    expect(seen).toEqual([
      { title: 'T', detail: 'D', secret: true, o: { initial: 'i', placeholder: 'ph' } },
      { title: 'T2', detail: 'D2', secret: false, o: { initial: undefined, placeholder: undefined } },
    ]);
  });
});

describe('renderList', () => {
  const rows: ProviderRow[] = [
    { id: 'locaith', label: 'Locaith', baseUrl: 'https://gw.locaith.ai/v1', kind: 'openai-chat', builtin: true, usable: true, key: { source: 'login' } },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', kind: 'openai-responses', builtin: true, usable: true, key: { source: 'env', env: 'OPENAI_API_KEY' } },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://proxy.example.com/v1', kind: 'openai-chat', builtin: true, usable: false, key: { source: 'mismatch', savedUrl: 'https://api.deepseek.com' } },
    { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', kind: 'openai-responses', builtin: true, usable: true, key: { source: 'saved' } },
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', kind: 'openai-chat', builtin: false, usable: true, key: { source: 'not-required' } },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', kind: 'openai-chat', builtin: false, usable: false, key: { source: 'none' } },
  ];
  it('markdown: dấu ✔/○, địa chỉ, nguồn khoá cho từng dòng, chỉ đúng lệnh sửa cho mục chưa có khoá, khối vấn đề', () => {
    const md = renderList(rows, ['customProviders[2]: sai'], 'vi', 'markdown');
    expect(md).toContain('- ✔ **openai**');
    expect(md).toContain('- ○ **groq**');
    expect(md).toContain('`https://api.groq.com/openai/v1`');
    expect(md).toContain('OPENAI_API_KEY');
    expect(md).toContain('locaith provider key groq');
    expect(md).toContain('https://api.deepseek.com'); // khoá lệch địa chỉ: nêu địa chỉ đã lưu
    expect(md).toContain('customProviders[2]: sai');
  });
  it('nhà cung cấp «locaith» chưa đăng nhập → chỉ lối vào `locaith login` (không bảo lưu khoá API cho tài khoản)', () => {
    const logged = rows.map((r) => (r.id === 'locaith' ? { ...r, usable: false, key: { source: 'none' as const } } : r));
    const md = renderList(logged, [], 'vi', 'markdown');
    expect(md).toMatch(/\*\*locaith\*\*.*locaith login/);
    expect(md).not.toContain('locaith provider key locaith');
    expect(renderList(logged, [], 'en', 'plain')).toMatch(/not signed in/);
  });
  it('plain (terminal) và tiếng Anh', () => {
    const plain = renderList(rows, [], 'en', 'plain');
    expect(plain).not.toContain('**');
    expect(plain).toContain('groq');
    expect(plain).toMatch(/no key|not set|missing/i);
  });
  it('khoá không bao giờ có mặt trong danh sách', () => {
    const txt = renderList(rows, [], 'vi', 'markdown') + renderList(rows, [], 'vi', 'plain');
    expect(txt).not.toMatch(/sk-[a-z0-9]{6,}/i);
  });
});

describe('testLine', () => {
  it('thành công: có/không có số model', () => {
    expect(testLine('vi', 'a', { ok: true, models: 5, ms: 12 }).text).toContain('5 model');
    expect(testLine('vi', 'a', { ok: true, ms: 12 }).text).not.toMatch(/\d+ model/);
    expect(testLine('en', 'a', { ok: true, models: 5, ms: 12 })).toEqual({ ok: true, text: 'a: connected — 5 models · 12 ms' });
  });
  it('mỗi nguyên nhân hỏng một câu riêng, đều nêu lỗi gốc', () => {
    const base = { ok: false, ms: 1, error: 'LỖI-GỐC' } as const;
    const un = testLine('vi', 'a', { ...base, reason: 'unreachable' }).text;
    const au = testLine('vi', 'a', { ...base, reason: 'auth' }).text;
    const nm = testLine('vi', 'a', { ...base, reason: 'no-models' }).text;
    const pin = testLine('vi', 'a', { ...base, reason: 'no-models' }, true).text;
    const ot = testLine('vi', 'a', { ...base }).text;
    for (const x of [un, au, nm, pin, ot]) expect(x).toContain('LỖI-GỐC');
    expect(new Set([un, au, nm, pin]).size).toBe(4);
    expect(ot).toBe(un);
  });
  it('cắt lỗi gốc dài để dòng không tràn', () => {
    expect(testLine('vi', 'a', { ok: false, ms: 1, error: 'x'.repeat(1000) }).text.length).toBeLessThan(400);
  });
});
