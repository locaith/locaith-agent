import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_VENDORS,
  KeyStoreCorruptError,
  PROVIDER_ID_RE,
  ProviderConfigError,
  QUICK_PRESETS,
  RESERVED_IDS,
  SettingsCorruptError,
  checkBaseUrl,
  classifyHost,
  cleanKey,
  customEnvName,
  effectiveVendorUrl,
  knownProviders,
  normalizeUrl,
  providerKeysFile,
  readStoredKeys,
  readUserCustomRaw,
  removeCustomProvider,
  removeStoredKey,
  saveStoredKey,
  setBaseUrlOverride,
  storedKeyFor,
  upsertCustomProvider,
  updateUserSettings,
  urlProblemText,
  userSettingsFile,
  validateBaseUrls,
  validateCustomProviders,
} from '../../src/cli/providerStore';

const dirs: string[] = [];
function home(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pstore-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('danh mục', () => {
  it('năm hãng dựng sẵn + bảy mẫu thêm nhanh; id dành riêng gồm hãng dựng sẵn, locaith, demo, auto', () => {
    expect(BUILTIN_VENDORS.map((v) => v.id)).toEqual(['anthropic', 'openai', 'gemini', 'deepseek', 'xai']);
    expect(QUICK_PRESETS.map((p) => p.id)).toEqual(['openrouter', 'ollama', 'lmstudio', 'groq', 'together', 'mistral', 'fireworks']);
    for (const id of ['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'locaith', 'demo', 'auto']) expect(RESERVED_IDS.has(id)).toBe(true);
    // mẫu thêm nhanh KHÔNG được trùng id dành riêng (nếu không «add openrouter» sẽ không thêm được)
    for (const p of QUICK_PRESETS) expect(RESERVED_IDS.has(p.id)).toBe(false);
    for (const p of QUICK_PRESETS) expect(PROVIDER_ID_RE.test(p.id)).toBe(true);
  });

  it('tên biến môi trường của API tuỳ chỉnh khớp registry (<ID>_API_KEY, gạch ngang → gạch dưới)', () => {
    expect(customEnvName('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(customEnvName('my-llm')).toBe('MY_LLM_API_KEY');
  });
});

describe('phân loại máy chủ', () => {
  it.each([
    ['localhost', 'loopback'],
    ['LOCALHOST', 'loopback'],
    ['app.localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.5.5.5', 'loopback'],
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.10', 'private'],
    ['100.64.0.7', 'private'],
    ['100.127.255.254', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'private'],
    ['my-nas', 'private'],
    ['box.local', 'private'],
    ['gpu.lan', 'private'],
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['100.63.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['api.openai.com', 'public'],
    ['2001:db8::1', 'public'],
  ])('%s → %s', (host, zone) => {
    expect(classifyHost(host)).toBe(zone);
  });
});

describe('kiểm địa chỉ gốc', () => {
  it('https luôn được; http tới máy này được dù cần khoá', () => {
    expect(checkBaseUrl('https://api.example.com/v1', { requiresKey: true })).toMatchObject({ ok: true, scheme: 'https', zone: 'public' });
    expect(checkBaseUrl('http://localhost:11434/v1', { requiresKey: true })).toMatchObject({ ok: true, scheme: 'http', zone: 'loopback' });
    expect(checkBaseUrl('http://127.0.0.1:8080/v1', { requiresKey: false })).toMatchObject({ ok: true });
    expect(checkBaseUrl('  https://x.dev/v1  ', { requiresKey: true })).toMatchObject({ ok: true, url: 'https://x.dev/v1' });
  });

  it('http tới mạng nội bộ chỉ được khi KHÔNG cần khoá (khoá sẽ đi dạng văn bản thô)', () => {
    expect(checkBaseUrl('http://192.168.1.10:11434/v1', { requiresKey: false })).toMatchObject({ ok: true, zone: 'private' });
    expect(checkBaseUrl('http://gpu.local:1234/v1', { requiresKey: false })).toMatchObject({ ok: true });
    expect(checkBaseUrl('http://192.168.1.10:11434/v1', { requiresKey: true })).toMatchObject({ ok: false, code: 'http-key' });
  });

  it('http tới máy công cộng luôn bị từ chối', () => {
    expect(checkBaseUrl('http://api.example.com/v1', { requiresKey: false })).toMatchObject({ ok: false, code: 'http-public', host: 'api.example.com' });
    expect(checkBaseUrl('http://8.8.8.8/v1', { requiresKey: true })).toMatchObject({ ok: false, code: 'http-public' });
  });

  it('từ chối: rỗng, sai cú pháp, scheme lạ, kèm user:mật-khẩu', () => {
    expect(checkBaseUrl('', { requiresKey: false })).toMatchObject({ ok: false, code: 'empty' });
    expect(checkBaseUrl(undefined, { requiresKey: false })).toMatchObject({ ok: false, code: 'empty' });
    expect(checkBaseUrl('not a url', { requiresKey: false })).toMatchObject({ ok: false, code: 'syntax' });
    expect(checkBaseUrl('ftp://files.example.com', { requiresKey: false })).toMatchObject({ ok: false, code: 'scheme' });
    expect(checkBaseUrl('file:///etc/passwd', { requiresKey: false })).toMatchObject({ ok: false, code: 'scheme' });
    expect(checkBaseUrl('javascript:alert(1)', { requiresKey: false })).toMatchObject({ ok: false, code: 'scheme' });
    expect(checkBaseUrl('https://user:pass@api.example.com/v1', { requiresKey: true })).toMatchObject({ ok: false, code: 'credentials' });
  });

  it('mọi mã lỗi đều có câu giải thích vi + en (không lộ khoá chuỗi)', () => {
    for (const code of ['empty', 'syntax', 'scheme', 'credentials', 'http-public', 'http-key'] as const) {
      for (const lang of ['vi', 'en'] as const) {
        const txt = urlProblemText({ ok: false, code, host: 'h.example' }, lang);
        expect(txt).not.toMatch(/^cli\.prov\./);
        expect(txt.length).toBeGreaterThan(10);
      }
    }
  });

  it('so sánh địa chỉ bỏ qua "/" cuối và hoa/thường của scheme + host', () => {
    expect(normalizeUrl('https://API.example.com/v1/')).toBe(normalizeUrl('https://api.example.com/v1'));
    expect(normalizeUrl('https://api.example.com:443/v1')).toBe(normalizeUrl('https://api.example.com/v1'));
    expect(normalizeUrl('https://api.example.com/v1')).not.toBe(normalizeUrl('https://api.example.org/v1'));
    expect(normalizeUrl('https://api.example.com/v1')).not.toBe(normalizeUrl('https://api.example.com/v2'));
  });
});

describe('làm sạch khoá', () => {
  it('bỏ khoảng trắng đầu/cuối và tiền tố Bearer', () => {
    expect(cleanKey('  sk-abc123  ')).toEqual({ ok: true, key: 'sk-abc123' });
    expect(cleanKey('Bearer sk-abc123')).toEqual({ ok: true, key: 'sk-abc123' });
    expect(cleanKey('bearer   sk-abc123\n')).toEqual({ ok: true, key: 'sk-abc123' });
  });
  it('từ chối rỗng, có khoảng trắng/xuống dòng/ký tự điều khiển ở giữa, quá dài', () => {
    expect(cleanKey('')).toEqual({ ok: false, code: 'empty' });
    expect(cleanKey('   ')).toEqual({ ok: false, code: 'empty' });
    expect(cleanKey('sk abc')).toEqual({ ok: false, code: 'space' });
    expect(cleanKey('sk-abc\nsk-def')).toEqual({ ok: false, code: 'space' });
    expect(cleanKey('sk-\u0007abc')).toEqual({ ok: false, code: 'space' });
    expect(cleanKey('k'.repeat(5000))).toEqual({ ok: false, code: 'long' });
  });
});

describe('kho khoá đã lưu', () => {
  it('lưu → đọc lại; ghi nguyên tử, quyền 600 (trừ Windows); không có tệp tạm sót lại', () => {
    const h = home();
    const file = saveStoredKey(h, 'openai', 'sk-test-ABCDEF', 'https://api.openai.com/v1');
    expect(file).toBe(providerKeysFile(h));
    const r = readStoredKeys(h);
    expect(r.problem).toBeUndefined();
    expect(r.keys.openai).toMatchObject({ key: 'sk-test-ABCDEF', baseUrl: 'https://api.openai.com/v1' });
    expect(Date.parse(r.keys.openai!.savedAt)).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('lưu thêm không làm mất khoá khác; lưu lại thay khoá cũ; xoá chỉ xoá đúng mục', () => {
    const h = home();
    saveStoredKey(h, 'openai', 'sk-one-11111111', 'https://api.openai.com/v1');
    saveStoredKey(h, 'deepseek', 'sk-two-22222222', 'https://api.deepseek.com');
    saveStoredKey(h, 'openai', 'sk-new-33333333', 'https://api.openai.com/v1');
    expect(Object.keys(readStoredKeys(h).keys).sort()).toEqual(['deepseek', 'openai']);
    expect(readStoredKeys(h).keys.openai!.key).toBe('sk-new-33333333');
    expect(removeStoredKey(h, 'openai')).toBe(true);
    expect(removeStoredKey(h, 'openai')).toBe(false);
    expect(Object.keys(readStoredKeys(h).keys)).toEqual(['deepseek']);
  });

  it('khoá sai dạng không được lưu', () => {
    const h = home();
    expect(() => saveStoredKey(h, 'openai', 'sk bad key', 'https://api.openai.com/v1')).toThrow(/không hợp lệ/);
    expect(fs.existsSync(providerKeysFile(h))).toBe(false);
  });

  it('tệp khoá hỏng: báo `problem`, KHÔNG ghi đè khi lưu/xoá (khỏi mất khoá)', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.locaith'), { recursive: true });
    fs.writeFileSync(providerKeysFile(h), '{ không phải json');
    const r = readStoredKeys(h);
    expect(r.keys).toEqual({});
    expect(r.problem).toContain('provider-keys.json');
    expect(() => saveStoredKey(h, 'openai', 'sk-x-12345678', 'https://api.openai.com/v1')).toThrow(KeyStoreCorruptError);
    expect(() => removeStoredKey(h, 'openai')).toThrow(KeyStoreCorruptError);
    expect(fs.readFileSync(providerKeysFile(h), 'utf8')).toBe('{ không phải json');
  });

  it('sai dạng (không có "keys") cũng được báo, mục hỏng bị bỏ qua', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.locaith'), { recursive: true });
    fs.writeFileSync(providerKeysFile(h), JSON.stringify([1, 2]));
    expect(readStoredKeys(h).problem).toMatch(/sai định dạng/);
    fs.writeFileSync(providerKeysFile(h), JSON.stringify({ version: 1, keys: { aa: { key: 'sk-ok-12345678', baseUrl: 'https://x.dev' }, bb: { key: 123 }, cc: 'x', dd: { key: 'có khoảng trắng', baseUrl: 'https://x.dev' } } }));
    expect(Object.keys(readStoredKeys(h).keys)).toEqual(['aa']);
  });

  it('tệp khoá bị sửa với id lạ (__proto__, hoa, quá ngắn…): bỏ qua, không làm lệch đối tượng kết quả, không làm hỏng khoá đúng', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.locaith'), { recursive: true });
    fs.writeFileSync(
      providerKeysFile(h),
      '{"version":1,"keys":{"__proto__":{"key":"sk-evil-12345678","baseUrl":"https://evil.example/v1"},"Key":{"key":"sk-up-12345678","baseUrl":"https://a.example"},"x":{"key":"sk-one-12345678","baseUrl":"https://a.example"},"openai":{"key":"sk-ok-12345678","baseUrl":"https://api.openai.com/v1"}}}',
    );
    const r = readStoredKeys(h);
    expect(Object.keys(r.keys)).toEqual(['openai']);
    expect(Object.getPrototypeOf(r.keys)).toBe(Object.prototype);
    expect((r.keys as Record<string, unknown>).key).toBeUndefined();
    expect(storedKeyFor(h, 'openai', 'https://api.openai.com/v1')).toEqual({ key: 'sk-ok-12345678' });
    expect(storedKeyFor(h, 'constructor', 'https://x.example')).toEqual({ none: true });
    expect(removeStoredKey(h, 'toString')).toBe(false);
  });

  it('khoá gắn với địa chỉ: khớp (kể cả "/" cuối) → dùng; địa chỉ đổi → KHÔNG dùng; chưa lưu → none', () => {
    const h = home();
    saveStoredKey(h, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    expect(storedKeyFor(h, 'deepseek', 'https://api.deepseek.com')).toEqual({ key: 'sk-ds-12345678' });
    expect(storedKeyFor(h, 'deepseek', 'https://api.deepseek.com/')).toEqual({ key: 'sk-ds-12345678' });
    expect(storedKeyFor(h, 'deepseek', 'https://evil.example.com/v1')).toEqual({ mismatch: { savedUrl: 'https://api.deepseek.com' } });
    expect(storedKeyFor(h, 'openai', 'https://api.openai.com/v1')).toEqual({ none: true });
  });
});

describe('ghi cài đặt người dùng', () => {
  it('giữ nguyên khoá khác, ghi quyền 600, tạo thư mục khi chưa có', () => {
    const h = home();
    const file = updateUserSettings(h, (d) => {
      d.language = 'vi';
    });
    expect(file).toBe(userSettingsFile(h));
    updateUserSettings(h, (d) => {
      d.agent = { compactAtPercent: 90 };
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ language: 'vi', agent: { compactAtPercent: 90 } });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tệp cài đặt hỏng → ném SettingsCorruptError và KHÔNG đụng tới tệp', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.locaith'), { recursive: true });
    fs.writeFileSync(userSettingsFile(h), '{ "agent": ');
    expect(() => updateUserSettings(h, () => undefined)).toThrow(SettingsCorruptError);
    expect(fs.readFileSync(userSettingsFile(h), 'utf8')).toBe('{ "agent": ');
  });
});

describe('API tuỳ chỉnh: thêm, thay, gỡ', () => {
  const entry = { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder'], requiresKey: false };

  it('thêm rồi thay theo id; không đụng mục khác và khoá khác trong cài đặt', () => {
    const h = home();
    updateUserSettings(h, (d) => {
      d.language = 'en';
    });
    expect(upsertCustomProvider(h, entry, 'vi').replaced).toBe(false);
    upsertCustomProvider(h, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const r = upsertCustomProvider(h, { ...entry, label: 'Ollama (nhà)' }, 'vi');
    expect(r.replaced).toBe(true);
    const raw = readUserCustomRaw(h) as Array<Record<string, unknown>>;
    expect(raw.map((x) => x.id)).toEqual(['ollama', 'groq']);
    expect(raw[0]!.label).toBe('Ollama (nhà)');
    expect(JSON.parse(fs.readFileSync(userSettingsFile(h), 'utf8')).language).toBe('en');
  });

  it('kiểm hợp lệ TRƯỚC khi ghi: id sai/dành riêng, kind lạ, địa chỉ bị từ chối → ném ProviderConfigError, không tạo tệp', () => {
    const h = home();
    const bad = (e: Partial<typeof entry> & { kind?: string }, code: string) => {
      let err: unknown;
      try {
        upsertCustomProvider(h, { ...entry, ...e } as never, 'vi');
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(ProviderConfigError);
      expect((err as ProviderConfigError).code).toBe(code);
    };
    bad({ id: 'A' }, 'id');
    bad({ id: 'x' }, 'id');
    bad({ id: 'openai' }, 'reserved');
    bad({ id: 'locaith' }, 'reserved');
    bad({ kind: 'soap' }, 'kind');
    bad({ baseUrl: 'http://api.example.com/v1' }, 'url');
    bad({ baseUrl: 'http://192.168.1.2/v1', requiresKey: true } as never, 'url');
    expect(fs.existsSync(userSettingsFile(h))).toBe(false);
  });

  it('ghi mặc định: kind openai-chat không ghi ra tệp; requiresKey luôn tường minh', () => {
    const h = home();
    upsertCustomProvider(h, { id: 'my-llm', label: '', baseUrl: 'https://llm.example.com/v1', kind: 'openai-chat' }, 'vi');
    upsertCustomProvider(h, { id: 'claude-proxy', label: 'Proxy', baseUrl: 'https://p.example.com', kind: 'anthropic', requiresKey: true }, 'vi');
    const raw = readUserCustomRaw(h) as Array<Record<string, unknown>>;
    expect(raw[0]).toEqual({ id: 'my-llm', label: 'my-llm', baseUrl: 'https://llm.example.com/v1', requiresKey: false });
    expect(raw[1]).toMatchObject({ kind: 'anthropic', requiresKey: true });
  });

  it('gỡ: xoá đúng mục; hết mục thì bỏ luôn khoá customProviders; không có mục → không ghi lại tệp', () => {
    const h = home();
    upsertCustomProvider(h, entry, 'vi');
    upsertCustomProvider(h, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const before = fs.statSync(userSettingsFile(h)).mtimeMs;
    expect(removeCustomProvider(h, 'nope').removed).toBe(false);
    expect(fs.statSync(userSettingsFile(h)).mtimeMs).toBe(before);
    expect(removeCustomProvider(h, 'ollama').removed).toBe(true);
    expect((readUserCustomRaw(h) as Array<{ id: string }>).map((x) => x.id)).toEqual(['groq']);
    expect(removeCustomProvider(h, 'groq').removed).toBe(true);
    expect(JSON.parse(fs.readFileSync(userSettingsFile(h), 'utf8'))).toEqual({});
  });

  it('ghi đè địa chỉ hãng dựng sẵn qua baseUrls và địa chỉ hiệu lực dùng để gắn khoá', () => {
    const h = home();
    expect(effectiveVendorUrl(h, 'deepseek', 'vi')).toBe('https://api.deepseek.com');
    setBaseUrlOverride(h, 'deepseek', 'https://proxy.example.com/v1');
    expect(effectiveVendorUrl(h, 'deepseek', 'vi')).toBe('https://proxy.example.com/v1');
    setBaseUrlOverride(h, 'deepseek', 'http://api.example.com/v1'); // http công cộng: bị bỏ qua khi tính địa chỉ hiệu lực
    expect(effectiveVendorUrl(h, 'deepseek', 'vi')).toBe('https://api.deepseek.com');
    setBaseUrlOverride(h, 'deepseek', undefined);
    expect(JSON.parse(fs.readFileSync(userSettingsFile(h), 'utf8'))).toEqual({});
  });
});

describe('lọc customProviders / baseUrls (mục sai bị bỏ KÈM lý do)', () => {
  it('mục đúng được giữ nguyên dạng, models được làm sạch', () => {
    const r = validateCustomProviders([{ id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: [' a ', '', 5, 'b'], requiresKey: false, keyUrl: 'https://k.example' }], 'vi');
    expect(r.problems).toEqual([]);
    expect(r.valid).toEqual([{ id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['a', 'b'], requiresKey: false, keyUrl: 'https://k.example' }]);
  });

  it('mỗi loại lỗi cho một câu riêng, nhắc đúng vị trí; không bao giờ ném', () => {
    const r = validateCustomProviders(
      [
        7,
        {},
        { id: 'BAD ID', baseUrl: 'https://a.example' },
        { id: 'openai', baseUrl: 'https://a.example' },
        { id: 'one', baseUrl: 'https://a.example', kind: 'soap' },
        { id: 'two', baseUrl: 'http://a.example/v1' },
        { id: 'three', baseUrl: 'http://192.168.0.9/v1', requiresKey: true },
        { id: 'four', baseUrl: 'https://ok.example/v1' },
        { id: 'four', baseUrl: 'https://dup.example/v1' },
      ],
      'vi',
    );
    expect(r.valid.map((c) => c.id)).toEqual(['four']);
    expect(r.valid[0]!.baseUrl).toBe('https://ok.example/v1');
    expect(r.problems).toHaveLength(8);
    expect(r.problems[0]).toContain('customProviders[0]');
    expect(r.problems[1]).toContain('thiếu "id"');
    expect(r.problems[2]).toContain('id không hợp lệ');
    expect(r.problems[3]).toContain('«openai»');
    expect(r.problems[4]).toContain('kind');
    expect(r.problems[5]).toContain('a.example');
    expect(r.problems[6]).toContain('192.168.0.9');
    expect(r.problems[7]).toContain('trùng');
    // tiếng Anh
    expect(validateCustomProviders([{ id: 'x1', baseUrl: 'http://a.example' }], 'en').problems[0]).toMatch(/clear text/);
  });

  it('không phải mảng → một câu báo; undefined/null → im lặng', () => {
    expect(validateCustomProviders({ id: 'x' }, 'vi').problems).toHaveLength(1);
    expect(validateCustomProviders(undefined, 'vi')).toEqual({ valid: [], problems: [] });
    expect(validateCustomProviders(null, 'vi')).toEqual({ valid: [], problems: [] });
  });

  it('baseUrls: https + http máy này được; http mạng nội bộ/công cộng bị bỏ kèm lý do (hãng dựng sẵn luôn cần khoá)', () => {
    const r = validateBaseUrls({ deepseek: 'https://p.example.com/v1', openai: 'http://127.0.0.1:9000/v1', xai: 'http://192.168.1.2/v1', gemini: 'http://a.example/v1', anthropic: 5 }, 'vi');
    expect(r.valid).toEqual({ deepseek: 'https://p.example.com/v1', openai: 'http://127.0.0.1:9000/v1' });
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join('\n')).toMatch(/baseUrls\.xai/);
    expect(validateBaseUrls([1], 'vi').problems).toHaveLength(1);
    expect(validateBaseUrls(undefined, 'vi')).toEqual({ valid: {}, problems: [] });
  });

  it('baseUrls chỉ áp cho hãng dựng sẵn + cổng Locaith; khoá khác (API tuỳ chỉnh, id lạ, __proto__) bị bỏ KÈM lý do — để địa chỉ «hiệu lực» luôn khớp địa chỉ thật được gọi', () => {
    const raw = JSON.parse('{"locaith":"https://gw.example.com/v1","groq":"https://x.example/v1","__proto__":"https://y.example/v1","demo":"https://z.example/v1"}');
    const r = validateBaseUrls(raw, 'vi');
    expect(r.valid).toEqual({ locaith: 'https://gw.example.com/v1' });
    expect(r.problems).toHaveLength(3);
    expect(r.problems[0]).toContain('baseUrls.groq');
    expect(r.problems[0]).toContain('customProviders');
    expect(Object.getPrototypeOf(r.valid)).toBe(Object.prototype);
  });
});

describe('nhà cung cấp đã dùng được sẵn', () => {
  it('khoá đã lưu còn khớp địa chỉ, API không cần khoá, API có biến <ID>_API_KEY — nhưng KHÔNG tính khoá lệch địa chỉ hay mồ côi', () => {
    const h = home();
    expect(knownProviders(h, {}, 'vi')).toEqual([]);
    saveStoredKey(h, 'deepseek', 'sk-ds-12345678', 'https://api.deepseek.com');
    saveStoredKey(h, 'openai', 'sk-oa-12345678', 'https://elsewhere.example/v1'); // lệch địa chỉ hãng
    saveStoredKey(h, 'ghost', 'sk-gh-12345678', 'https://ghost.example/v1'); // không có nhà cung cấp tương ứng
    upsertCustomProvider(h, { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', requiresKey: false }, 'vi');
    upsertCustomProvider(h, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true }, 'vi');
    const names = knownProviders(h, {}, 'vi');
    expect(names).toEqual(['deepseek (đã lưu khoá)', 'ollama (không cần khoá)']);
    expect(knownProviders(h, { GROQ_API_KEY: 'gsk-xxxxxxxx' }, 'vi')).toContain('groq (GROQ_API_KEY)');
  });
});
