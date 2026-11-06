import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/core/engine/tokens';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry, parseSkillMarkdown, skillAllowedFor, skillFromMarkdown, type SkillDef } from '../src/core/skills/registry';
import { createSkillTools } from '../src/core/tools/meta';
import locaithAddendum from '../src/core/prompts/locaith.addendum.md';

const md = (head: string, body = '# Hướng dẫn\nLàm theo từng bước.') => `---\n${head}\n---\n${body}`;
const GATED = md('name: soan-thao-thu\ndescription: Soạn văn bản hành chính theo Nghị định 30\nproviders: [locaith]\nunlocks: ghi_tep_docx\ntags: [văn bản]');
const OPEN = md('name: chung\ndescription: Kỹ năng chung cho mọi nhà cung cấp');

const def = (text: string, name: string): SkillDef => skillFromMarkdown(text, name, 'builtin')!;
const registry = () => new SkillRegistry([def(GATED, 'soan-thao-thu'), def(OPEN, 'chung')]);

describe('SKILL.md — khai báo `providers`', () => {
  it('đọc được mọi kiểu viết danh sách, chuẩn hoá chữ thường, bỏ giá trị sai', () => {
    expect(def(md('name: a\nproviders: [locaith]'), 'a').providers).toEqual(['locaith']);
    expect(def(md('name: a\nproviders: [Locaith, DeepSeek]'), 'a').providers).toEqual(['locaith', 'deepseek']);
    expect(def(md('name: a\nproviders: locaith, other'), 'a').providers).toEqual(['locaith', 'other']);
    expect(def(md('name: a\nproviders:\n  - locaith\n  - xai'), 'a').providers).toEqual(['locaith', 'xai']);
    expect(def(md('name: a\nproviders: [bad id!, locaith]'), 'a').providers).toEqual(['locaith']);
    expect(def(md('name: a'), 'a').providers).toBeUndefined();
    expect(def(md('name: a\nproviders: []'), 'a').providers).toBeUndefined();
    expect(parseSkillMarkdown(GATED).meta.providers).toEqual(['locaith']);
  });

  it('skillAllowedFor: không khai báo = mọi nơi; có khai báo mà không biết nhà cung cấp = KHÔNG (an toàn mặc định)', () => {
    expect(skillAllowedFor({}, undefined)).toBe(true);
    expect(skillAllowedFor({}, 'anthropic')).toBe(true);
    expect(skillAllowedFor({ providers: ['locaith'] }, 'locaith')).toBe(true);
    expect(skillAllowedFor({ providers: ['locaith'] }, 'LOCAITH')).toBe(true);
    expect(skillAllowedFor({ providers: ['locaith'] }, 'anthropic')).toBe(false);
    expect(skillAllowedFor({ providers: ['locaith'] }, undefined)).toBe(false);
    expect(skillAllowedFor({ providers: ['locaith'] }, '')).toBe(false);
  });
});

describe('SkillRegistry — kỹ năng riêng của họ mô hình', () => {
  it('list/get/search/catalog/unlockedTools: chỉ thấy với nhà cung cấp được khai báo', () => {
    const r = registry();
    expect(r.list('locaith').map((s) => s.name).sort()).toEqual(['chung', 'soan-thao-thu']);
    expect(r.list('anthropic').map((s) => s.name)).toEqual(['chung']);
    expect(r.list().map((s) => s.name)).toEqual(['chung']);

    expect(r.get('soan-thao-thu', 'locaith')?.name).toBe('soan-thao-thu');
    // Tên gọi có dấu vẫn đổi được về slug như trước (bí danh), nhưng vẫn bị chặn theo nhà cung cấp.
    expect(r.get('Soạn thảo thử', 'locaith')?.name).toBe('soan-thao-thu');
    expect(r.get('Soạn thảo thử', 'anthropic')).toBeUndefined();
    expect(r.get('soan-thao-thu', 'deepseek')).toBeUndefined();
    expect(r.get('soan-thao-thu')).toBeUndefined();
    expect(r.get('chung', 'deepseek')?.name).toBe('chung');

    expect(r.search('soạn văn bản nghị định', 5, 'locaith').map((s) => s.name)).toEqual(['soan-thao-thu']);
    expect(r.search('soạn văn bản nghị định', 5, 'anthropic')).toEqual([]);
    expect(r.search('', 5, 'anthropic').map((s) => s.name)).toEqual(['chung']);

    expect(r.catalog('locaith')).toContain('- soan-thao-thu:');
    expect(r.catalog('anthropic')).not.toContain('soan-thao-thu');
    expect(r.catalog()).not.toContain('soan-thao-thu');

    expect([...r.unlockedTools(['soan-thao-thu'], 'locaith')]).toEqual(['ghi_tep_docx']);
    expect([...r.unlockedTools(['soan-thao-thu'], 'anthropic')]).toEqual([]);
    expect([...r.unlockedTools(['soan-thao-thu'])]).toEqual([]);
  });

  it('kỹ năng người dùng ghi đè kỹ năng dựng sẵn cùng tên vẫn giữ khai báo của bản ghi đè (không "rò" khai báo cũ)', () => {
    const r = new SkillRegistry([def(GATED, 'soan-thao-thu')]);
    const over = def(md('name: soan-thao-thu\ndescription: Bản của người dùng'), 'soan-thao-thu');
    // Mô phỏng loadDirs: bản mới thay bản cũ trong map.
    (r as unknown as { skills: Map<string, SkillDef> }).skills.set(over.name, over);
    expect(r.get('soan-thao-thu', 'anthropic')?.description).toBe('Bản của người dùng');
  });
});

describe('load_skill / search_skills theo nhà cung cấp của phiên', () => {
  const ctx = (provider: string) => {
    const emitted: unknown[] = [];
    return { c: { session: { provider, loadedSkills: [] as string[] }, emit: (e: unknown) => emitted.push(e), assistantId: 'a1' } as never, emitted };
  };
  const tools = (currentProvider?: () => string | undefined) => {
    const [load, search] = createSkillTools(registry(), undefined, currentProvider);
    return { load, search };
  };

  it('Locaith nạp được và nhận công cụ mở khoá; nhà cung cấp khác bị báo "Không có kỹ năng" và không thấy tên nó trong danh sách', async () => {
    const { load } = tools();
    const a = ctx('locaith');
    const ok = await load.execute({ skill_name: 'soan-thao-thu' }, a.c);
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain('# Kỹ năng: soan-thao-thu');
    expect(ok.content).toContain('ghi_tep_docx');
    expect((a.c as never as { session: { loadedSkills: string[] } }).session.loadedSkills).toEqual(['soan-thao-thu']);
    expect(a.emitted).toHaveLength(1);

    const b = ctx('anthropic');
    const no = await load.execute({ skill_name: 'soan-thao-thu' }, b.c);
    expect(no.isError).toBe(true);
    expect(no.content).toContain('Không có kỹ năng "soan-thao-thu"');
    expect(no.content).not.toContain('Gần giống: soan-thao-thu');
    expect(no.content).not.toMatch(/- soan-thao-thu:/);
    expect(no.content).toContain('- chung:');
    expect((b.c as never as { session: { loadedSkills: string[] } }).session.loadedSkills).toEqual([]);
    expect(b.emitted).toHaveLength(0);
  });

  it('mô tả công cụ load_skill chỉ liệt kê kỹ năng dùng được với nhà cung cấp hiện tại (đổi model giữa cuộc là đổi danh mục)', () => {
    let cur: string | undefined = 'locaith';
    const { load } = tools(() => cur);
    expect(String(load.description)).toContain('soan-thao-thu');
    cur = 'deepseek';
    expect(String(load.description)).not.toContain('soan-thao-thu');
    expect(String(load.description)).toContain('chung');
    cur = undefined;
    expect(String(load.description)).not.toContain('soan-thao-thu');
  });

  it('search_skills cũng tôn trọng nhà cung cấp', async () => {
    const { search } = tools();
    const yes = await search.execute({ query: 'soạn văn bản nghị định' }, ctx('locaith').c);
    expect(yes.content).toContain('soan-thao-thu');
    const no = await search.execute({ query: 'soạn văn bản nghị định' }, ctx('xai').c);
    expect(no.content).not.toContain('soan-thao-thu');
  });
});

describe('kỹ năng dựng sẵn: cái nào riêng Locaith, cái nào cho mọi hãng', () => {
  const dir = path.resolve(__dirname, '../skills');
  const NAMES = ['soan-thao-van-ban-nd30', 'ghi-nho-memory'];
  const present = NAMES.every((n) => fs.existsSync(path.join(dir, n, 'SKILL.md')));

  it.runIf(present)('soạn thảo Nghị định 30 chỉ dành cho họ mô hình Locaith', () => {
    const r = new SkillRegistry(builtinSkills());
    const n = 'soan-thao-van-ban-nd30';
    const raw = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8');
    expect(parseSkillMarkdown(raw).meta.providers, `${n}: thiếu providers`).toEqual(['locaith']);
    expect(r.get(n, 'locaith'), `${n} phải nạp được với locaith`).toBeDefined();
    for (const other of ['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'locaith-auto', 'demo']) expect(r.get(n, other), `${n} lộ ra với ${other}`).toBeUndefined();
    expect(r.list().map((s) => s.name)).not.toContain(n);
    expect(r.catalog('anthropic')).not.toContain(n);
    expect(r.catalog('locaith')).toContain(n);
  });

  it.runIf(present)('ghi nhớ dùng được với MỌI nhà cung cấp (ký ức không phụ thuộc hãng mô hình)', () => {
    const r = new SkillRegistry(builtinSkills());
    const n = 'ghi-nho-memory';
    expect(parseSkillMarkdown(fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8')).meta.providers).toBeUndefined();
    for (const p of ['locaith', 'anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'locaith-auto']) expect(r.get(n, p), `${n} phải nạp được với ${p}`).toBeDefined();
    expect(r.catalog('anthropic')).toContain(n);
  });

  it.runIf(present)('đoạn nhắc trong system prompt gọi ĐÚNG tên hai kỹ năng thật', () => {
    for (const n of NAMES) expect(locaithAddendum).toContain(`\`${n}\``);
  });

  it('đoạn nhắc: tiếng Việt, ≤ 700 token, nêu cả hai kỹ năng, Bio-Memory và lời dặn không tiết lộ chỉ dẫn', () => {
    expect(estimateTokens(locaithAddendum)).toBeLessThanOrEqual(700);
    for (const n of NAMES) expect(locaithAddendum).toContain(n);
    expect(locaithAddendum).toMatch(/Nghị định 30/);
    expect(locaithAddendum).toMatch(/recall/);
    expect(locaithAddendum).toMatch(/store_memory/);
    expect(locaithAddendum).toMatch(/không thể chia sẻ cấu hình nội bộ/);
    expect(locaithAddendum).not.toMatch(/deepseek/i); // không nhắc tới nhà cung cấp mô hình nền
    expect(locaithAddendum).not.toMatch(/https?:\/\//);
  });
});
