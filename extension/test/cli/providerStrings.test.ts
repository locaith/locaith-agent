/**
 * Chuỗi giao diện của `locaith provider` / `/provider`: đủ vi + en, cùng chỗ trống `{…}`, không còn chuỗi mồ côi, không có chuỗi nào trong mã mà thiếu bản dịch,
 * và văn bản sản phẩm không dùng đại từ riêng của cuộc trò chuyện giữa người với trợ lý («em», «anh»).
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { t } from '../../src/cli/i18n';
import '../../src/cli/strings';
import { HELP_TOPICS, helpTopicText } from '../../src/cli/help';

const read = (rel: string): string => fs.readFileSync(fileURLToPath(new URL(`../../src/cli/${rel}`, import.meta.url)), 'utf8');

const stringsSrc = read('strings.ts');
const enStart = stringsSrc.indexOf('\n  en: {');
const viBlock = stringsSrc.slice(0, enStart);
const enBlock = stringsSrc.slice(enStart);
const keysOf = (block: string): string[] => [...block.matchAll(/^\s{4}'(prov\.[^']+)':/gm)].map((m) => m[1]!);
const viKeys = keysOf(viBlock);
const enKeys = keysOf(enBlock);
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('chuỗi cli.prov.*', () => {
  it('có chuỗi (đủ để phép thử có nghĩa)', () => {
    expect(viKeys.length).toBeGreaterThan(80);
  });

  it('mỗi khoá có đủ vi + en, không trùng khoá trong cùng ngôn ngữ', () => {
    expect([...new Set(viKeys)].length).toBe(viKeys.length);
    expect([...new Set(enKeys)].length).toBe(enKeys.length);
    expect([...viKeys].sort()).toEqual([...enKeys].sort());
  });

  it('hai ngôn ngữ dùng đúng cùng tập chỗ trống {…}', () => {
    const bad: string[] = [];
    for (const k of viKeys) {
      const vi = t(`cli.${k}`, {}, 'vi');
      const en = t(`cli.${k}`, {}, 'en');
      expect(vi, k).not.toBe(`cli.${k}`);
      expect(en, k).not.toBe(`cli.${k}`);
      if (placeholders(vi).join() !== placeholders(en).join()) bad.push(`${k}: vi{${placeholders(vi)}} ≠ en{${placeholders(en)}}`);
    }
    expect(bad).toEqual([]);
  });

  it('văn bản sản phẩm trung tính: không dùng «em»/«anh» (đại từ của cuộc trò chuyện với trợ lý)', () => {
    const re = /(^|[\s,.;:!?()«“"'`])(em|anh)([\s,.;:!?()»”"'`]|$)/i;
    const hits = viKeys.filter((k) => re.test(t(`cli.${k}`, {}, 'vi'))).concat(enKeys.filter((k) => /\b(you,? ?sir)\b/i.test(t(`cli.${k}`, {}, 'en'))));
    expect(hits).toEqual([]);
  });

  it('mọi khoá cli.prov.* được dùng trong mã nguồn đều có chuỗi; chuỗi không còn ai dùng thì bị bắt (khỏi tích rác)', () => {
    const files = ['providerCmd.ts', 'providerWizard.ts', 'providerStore.ts', 'runtime/providers.ts', 'runtime/slash.ts', 'tui/onboarding.ts', 'doctor.ts'];
    const used = new Set<string>();
    const dynamicPrefixes = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/['"`]cli\.(prov\.[A-Za-z0-9_.-]+)(\$\{)?/g)) {
        if (m[2]) dynamicPrefixes.add(m[1]!);
        else used.add(m[1]!);
      }
      // khoá dựng bằng tr(d, 'cli.prov.x') đã khớp ở trên; khoá viết tắt 'prov.x' trong store qua hàm `msg('x')` thì liệt kê tay bên dưới
    }
    const missing = [...used].filter((k) => !viKeys.includes(k));
    expect(missing).toEqual([]);
    for (const p of dynamicPrefixes) expect(viKeys.some((k) => k.startsWith(p)), `tiền tố động ${p}`).toBe(true);
    const unused = viKeys.filter((k) => !used.has(k) && ![...dynamicPrefixes].some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });
});

describe('trợ giúp', () => {
  it('chủ đề `providers` có trong danh sách và nói đủ cả hai ngôn ngữ', () => {
    expect(HELP_TOPICS).toContain('providers');
    const vi = helpTopicText('providers', 'vi')!;
    const en = helpTopicText('providers', 'en')!;
    for (const txt of [vi, en]) {
      for (const needle of ['locaith provider add', 'locaith provider key', '--key-stdin', '--key-env', 'provider-keys.json', 'customProviders', 'baseUrls', 'OpenRouter', 'Ollama']) expect(txt, needle).toContain(needle);
    }
    expect(vi).toMatch(/NHÀ CUNG CẤP/);
    expect(en).toMatch(/MODEL PROVIDERS/);
  });

  it('không dạy gõ khoá ở dòng lệnh', () => {
    for (const lang of ['vi', 'en'] as const) {
      const txt = helpTopicText('providers', lang)!;
      expect(txt).not.toMatch(/--key[= ]\s*sk-/);
      expect(txt).not.toMatch(/provider key \S+ sk-/);
    }
  });
});
