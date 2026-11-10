import { strToU8, zipSync } from 'fflate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MARKETPLACES, OFFICIAL_MARKETPLACE, clearZipCache, fetchAllMarketplaces, installPlugin, mergeMarketplaces, parseMarketplace, type MarketplaceEntry } from '../src/core/plugins/marketplace';

/**
 * (0.7.7) Chợ plugin nhiều nguồn: danh sách MARKETPLACES hợp lệ; gộp nhiều marketplace.json (trùng tên → hậu tố, nguồn lỗi không kéo theo nguồn khác);
 * plugin `repo-path` của một nguồn KHÁC chợ chính thức phải được tải từ ĐÚNG kho của nguồn đó.
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-pms-'));
afterEach(() => clearZipCache());

const mk = (name: string, plugins: Array<{ name: string; source?: unknown; description?: string; category?: string }>) =>
  JSON.stringify({ name, plugins: plugins.map((p) => ({ description: `${p.name} mô tả`, category: 'dev', source: `./plugins/${p.name}`, ...p })) });

describe('MARKETPLACES', () => {
  it('nguồn đầu tiên là chợ chính thức; id duy nhất, ổn định, an toàn làm tên thư mục; có nhãn và độ tin cậy', () => {
    expect(MARKETPLACES[0]).toMatchObject({ id: 'claude-plugins-official', owner: OFFICIAL_MARKETPLACE.owner, repo: OFFICIAL_MARKETPLACE.repo, ref: OFFICIAL_MARKETPLACE.ref, trust: 'official' });
    const ids = MARKETPLACES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MARKETPLACES) {
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(m.owner).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(m.repo).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(m.label.length).toBeGreaterThan(3);
      expect(['official', 'vendor', 'community']).toContain(m.trust);
    }
  });

  it('nguồn cộng đồng được dán nhãn «cộng đồng» trong tên; nguồn của Anthropic đều là official', () => {
    for (const m of MARKETPLACES.filter((x) => x.trust === 'community')) expect(m.label).toContain('cộng đồng');
    for (const m of MARKETPLACES.filter((x) => x.owner === 'anthropics')) expect(m.trust).toBe('official');
  });
});

describe('mergeMarketplaces', () => {
  const [official, kwp, ms] = MARKETPLACES;

  it('gắn `market` cho từng plugin; trùng tên với nguồn đứng trước → đổi id thành <tên>-<id nguồn>; nguồn đứng trước giữ tên gốc', () => {
    const a = parseMarketplace(JSON.parse(mk('official', [{ name: 'azure' }, { name: 'sales' }])));
    const b = parseMarketplace(JSON.parse(mk('kwp', [{ name: 'sales' }, { name: 'legal' }])));
    const m = mergeMarketplaces([
      { source: official, parsed: a },
      { source: kwp, parsed: b },
    ]);
    expect(m.entries.map((e) => e.id)).toEqual(['azure', 'sales', 'sales-knowledge-work-plugins', 'legal']);
    expect(m.entries.map((e) => e.market)).toEqual(['claude-plugins-official', 'claude-plugins-official', 'knowledge-work-plugins', 'knowledge-work-plugins']);
    expect(m.entries.find((e) => e.id === 'sales-knowledge-work-plugins')?.name).toBe('sales'); // tên hiển thị gốc giữ nguyên
    expect(m.sources.map((s) => [s.source.id, s.count])).toEqual([
      ['claude-plugins-official', 2],
      ['knowledge-work-plugins', 2],
    ]);
  });

  it('TRONG MỘT chợ, nhiều tên trỏ cùng một kho là chủ ý của chủ chợ → giữ nguyên (chợ chính thức vẫn đủ 316 mục như trước)', () => {
    const github = { source: 'github', repo: 'astronomer/agents' };
    const a = parseMarketplace(JSON.parse(mk('official', [{ name: 'astronomer-data-agents', source: github }, { name: 'data', source: github }, { name: 'data-engineering', source: github }])));
    const m = mergeMarketplaces([{ source: official, parsed: a }]);
    expect(m.entries.map((e) => e.id)).toEqual(['astronomer-data-agents', 'data', 'data-engineering']);
  });

  it('cùng MỘT plugin (cùng kho + thư mục con) có ở nhiều chợ → chỉ hiện ở nguồn đứng trước, không nhân đôi, không đổi id', () => {
    const github = (repo: string, extra: Record<string, unknown> = {}) => ({ source: 'github', repo, ...extra });
    const a = parseMarketplace(JSON.parse(mk('official', [{ name: 'tavily', source: github('tavily-ai/skills') }, { name: 'figma', source: github('figma/mcp-server-guide') }])));
    const b = parseMarketplace(
      JSON.parse(
        mk('kwp', [
          { name: 'tavily', source: github('Tavily-AI/skills.git', { ref: 'v2' }) }, // cùng kho (khác hoa/thường, đuôi .git, ref) → trùng
          { name: 'data', source: './data' }, // plugin riêng của chợ này
          { name: 'figma', source: github('figma/other-repo') }, // cùng tên nhưng là plugin KHÁC → giữ, thêm hậu tố
        ]),
      ),
    );
    const m = mergeMarketplaces([
      { source: official, parsed: a },
      { source: kwp, parsed: b },
    ]);
    expect(m.entries.map((e) => `${e.id}@${e.market}`)).toEqual(['tavily@claude-plugins-official', 'figma@claude-plugins-official', 'data@knowledge-work-plugins', 'figma-knowledge-work-plugins@knowledge-work-plugins']);
    expect(m.sources.map((s) => s.count)).toEqual([2, 2]);
  });

  it('nguồn lỗi chỉ làm nguồn đó vắng mặt, kèm lý do; các nguồn khác vẫn dùng được', () => {
    const a = parseMarketplace(JSON.parse(mk('official', [{ name: 'azure' }])));
    const m = mergeMarketplaces([
      { source: official, parsed: a },
      { source: kwp, error: 'Không tải được danh sách plugin (HTTP 404).' },
      { source: ms },
    ]);
    expect(m.entries).toHaveLength(1);
    expect(m.sources[1]).toMatchObject({ count: 0, error: expect.stringContaining('404') });
    expect(m.sources[2].error).toBeTruthy();
  });

  it('id vẫn trùng sau khi thêm hậu tố thì bỏ mục sau, không ghi đè', () => {
    const a = parseMarketplace(JSON.parse(mk('official', [{ name: 'x' }, { name: 'x-knowledge-work-plugins' }])));
    const b = parseMarketplace(JSON.parse(mk('kwp', [{ name: 'x' }])));
    const m = mergeMarketplaces([
      { source: official, parsed: a },
      { source: kwp, parsed: b },
    ]);
    expect(m.entries.map((e) => e.id)).toEqual(['x', 'x-knowledge-work-plugins']);
    expect(m.sources[1].count).toBe(0);
  });
});

describe('fetchAllMarketplaces', () => {
  it('tải mọi nguồn song song đúng địa chỉ raw; một nguồn 404 không làm hỏng nguồn khác', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      const u = String(url);
      if (u.includes('/knowledge-work-plugins/')) return new Response('nope', { status: 404 });
      const name = u.split('/')[4] + '-' + u.split('/')[3];
      return new Response(mk(name, [{ name: `p-${u.split('/')[3]}-${u.split('/')[4]}` }]), { status: 200 });
    }) as unknown as typeof fetch;
    const m = await fetchAllMarketplaces(f, 'https://raw.test');
    expect(seen).toHaveLength(MARKETPLACES.length);
    for (const s of MARKETPLACES) expect(seen).toContain(`https://raw.test/${s.owner}/${s.repo}/${s.ref}/.claude-plugin/marketplace.json`);
    expect(m.sources.find((s) => s.source.id === 'knowledge-work-plugins')?.error).toContain('404');
    expect(m.entries.length).toBe(MARKETPLACES.length - 1);
  });

  it('HTTP lỗi mạng / JSON hỏng / danh sách rỗng đều thành lỗi của riêng nguồn đó', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new Error('ECONNRESET');
      if (n === 2) return new Response('<html>', { status: 200 });
      if (n === 3) return new Response(JSON.stringify({ name: 'x', plugins: [] }), { status: 200 });
      return new Response(mk('ok', [{ name: `p${n}` }]), { status: 200 });
    }) as unknown as typeof fetch;
    const m = await fetchAllMarketplaces(f, 'https://raw.test');
    expect(m.sources.slice(0, 3).every((s) => s.error)).toBe(true);
    expect(m.entries.length).toBe(MARKETPLACES.length - 3);
  });
});

describe('installPlugin: plugin repo-path của nguồn khác chợ chính thức', () => {
  it('tải zip từ kho CỦA NGUỒN ĐÓ (không phải anthropics/claude-plugins-official) và ghi dấu nguồn', async () => {
    const root = tmp();
    const zip = zipSync({
      'skills-main/plugins/ms-demo/skills/hello/SKILL.md': strToU8('---\nname: hello\ndescription: chào\n---\nChào bạn'),
      'skills-main/plugins/other/skills/x/SKILL.md': strToU8('---\nname: x\ndescription: x\n---\nx'),
    });
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(String(url));
      return new Response(zip, { status: 200, headers: { 'content-length': String(zip.length) } });
    }) as unknown as typeof fetch;
    const entry: MarketplaceEntry = { id: 'ms-demo', name: 'ms-demo', description: 'd', category: 'dev', source: { kind: 'repo-path', path: 'plugins/ms-demo' }, market: 'microsoft-skills' };
    const r = await installPlugin(entry, { userRoot: root, fetchImpl: f, codeloadBase: 'https://codeload.test', marketplace: { owner: 'microsoft', repo: 'skills', ref: 'main' } });
    expect(r.ok, r.message).toBe(true);
    expect(urls).toEqual(['https://codeload.test/microsoft/skills/zip/main']);
    expect(fs.existsSync(path.join(root, 'ms-demo', 'skills', 'hello', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'ms-demo', 'skills', 'x'))).toBe(false); // chỉ đúng thư mục con
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'ms-demo', '.locaith-plugin.json'), 'utf8')) as { source: string };
    expect(marker.source).toBe('microsoft/skills/plugins/ms-demo');
  });
});

/** `source: "./"` — marketplace của anthropics/skills (plugin = vài thư mục kỹ năng ở gốc kho) và coreyhaines31/marketingskills (cả gốc kho). */
describe('plugin có source "./" (gốc kho)', () => {
  const SKILLS_MARKETPLACE = {
    name: 'anthropic-agent-skills',
    plugins: [
      { name: 'document-skills', description: 'Word, Excel, PowerPoint, PDF', source: './', strict: false, skills: ['./skills/xlsx', './skills/docx', './skills/../../etc', './skills/xlsx'] },
      { name: 'claude-api', description: 'API Claude', source: './', strict: false, skills: ['./skills/claude-api'] },
      { name: 'marketing-skills', description: 'Marketing', source: './' },
      { name: 'weird', description: 'x', source: '../' },
    ],
  };

  it('parseMarketplace nhận «./» (và «.»): làm sạch mảng skills (bỏ trùng, bỏ đường dẫn thoát); «../» vẫn bị loại', () => {
    const p = parseMarketplace(SKILLS_MARKETPLACE);
    expect(p.entries.map((e) => e.id)).toEqual(['document-skills', 'claude-api', 'marketing-skills']);
    expect(p.skipped).toBe(1);
    expect(p.entries[0].source).toEqual({ kind: 'repo-root', skills: ['skills/xlsx', 'skills/docx'] });
    expect(p.entries[2].source).toEqual({ kind: 'repo-root' });
    expect(parseMarketplace({ plugins: [{ name: 'a', source: '.' }] }).entries[0].source).toEqual({ kind: 'repo-root' });
  });

  const ZIP = zipSync({
    'skills-main/skills/xlsx/SKILL.md': strToU8('---\nname: xlsx\ndescription: bảng tính\n---\nXLSX'),
    'skills-main/skills/xlsx/scripts/run.py': strToU8('print(1)'),
    'skills-main/skills/docx/SKILL.md': strToU8('---\nname: docx\ndescription: văn bản\n---\nDOCX'),
    'skills-main/skills/pdf/SKILL.md': strToU8('---\nname: pdf\ndescription: pdf\n---\nPDF'),
    'skills-main/spec/big.md': strToU8('không cần'),
    'skills-main/README.md': strToU8('# kho'),
    'skills-main/LICENSE': strToU8('MIT'),
    'skills-main/commands/hello.md': strToU8('---\ndescription: chào\n---\nchào'),
  });
  const fetchZip = (urls: string[]) =>
    (async (url: string) => {
      urls.push(String(url));
      return new Response(ZIP, { status: 200, headers: { 'content-length': String(ZIP.length) } });
    }) as unknown as typeof fetch;

  it('có danh sách skills: chỉ lấy đúng các thư mục đó, mỗi thư mục thành skills/<tên>/ của plugin; tải từ kho của nguồn', async () => {
    const root = tmp();
    const urls: string[] = [];
    const entry = parseMarketplace(SKILLS_MARKETPLACE).entries[0];
    const r = await installPlugin(entry, { userRoot: root, fetchImpl: fetchZip(urls), codeloadBase: 'https://codeload.test', marketplace: { owner: 'anthropics', repo: 'skills', ref: 'main' } });
    expect(r.ok, r.message).toBe(true);
    expect(urls).toEqual(['https://codeload.test/anthropics/skills/zip/main']);
    const dir = path.join(root, 'document-skills');
    expect(fs.existsSync(path.join(dir, 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'xlsx', 'scripts', 'run.py'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'docx', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'pdf'))).toBe(false); // không nằm trong danh sách
    expect(fs.existsSync(path.join(dir, 'spec'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(false);
    expect(r.plugin?.skillDirs.length).toBeGreaterThan(0);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.locaith-plugin.json'), 'utf8')) as { source: string };
    expect(marker.source).toBe('anthropics/skills (2 kỹ năng)');
  });

  it('không có danh sách (marketingskills): chỉ chép phần plugin ở gốc kho (skills/, commands/, LICENSE), bỏ phần còn lại', async () => {
    const root = tmp();
    const entry = parseMarketplace(SKILLS_MARKETPLACE).entries[2];
    const r = await installPlugin(entry, { userRoot: root, fetchImpl: fetchZip([]), codeloadBase: 'https://codeload.test', marketplace: { owner: 'coreyhaines31', repo: 'marketingskills', ref: 'main' } });
    expect(r.ok, r.message).toBe(true);
    const dir = path.join(root, 'marketing-skills');
    expect(fs.existsSync(path.join(dir, 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'commands', 'hello.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'spec'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(false);
  });

  it('gộp: hai plugin cùng gốc kho nhưng khác danh sách skills KHÔNG bị coi là trùng', () => {
    const src = MARKETPLACES.find((m) => m.id === 'anthropic-skills')!;
    const m = mergeMarketplaces([{ source: src, parsed: parseMarketplace(SKILLS_MARKETPLACE) }]);
    expect(m.entries.map((e) => e.id)).toEqual(['document-skills', 'claude-api', 'marketing-skills']);
  });

  it('hai nguồn gốc kho có mặt trong MARKETPLACES: Anthropic (official) và marketingskills (cộng đồng, có nhãn)', () => {
    expect(MARKETPLACES.find((m) => m.id === 'anthropic-skills')).toMatchObject({ owner: 'anthropics', repo: 'skills', trust: 'official' });
    expect(MARKETPLACES.find((m) => m.id === 'marketing-skills')).toMatchObject({ owner: 'coreyhaines31', repo: 'marketingskills', trust: 'community' });
  });
});
