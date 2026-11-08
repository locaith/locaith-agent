import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentsFeature } from '../../../src/cli/runtime/features/agents';
import { pluginsFeature } from '../../../src/cli/runtime/features/plugins';
import { skillsFeature } from '../../../src/cli/runtime/features/skills';
import { FakeFeatureContext, writeFile } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

const skillMd = (name: string, desc: string, body = 'Làm theo các bước sau.') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;
const agentMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\ntools: readonly\nmodel: inherit\n---\nBạn là ${name}.\n`;

describe('kỹ năng', () => {
  it('nạp thư mục người dùng và dự án; trùng tên thì bản cá nhân thắng (như extension/Claude Code); cho phép đọc ~/.locaith', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.home, '.locaith', 'skills', 'ca-nhan', 'SKILL.md'), skillMd('ca-nhan', 'Kỹ năng cá nhân'));
    writeFile(path.join(ctx.home, '.locaith', 'skills', 'chung', 'SKILL.md'), skillMd('chung', 'bản cá nhân'));
    writeFile(path.join(ctx.cwd, '.locaith', 'skills', 'chung', 'SKILL.md'), skillMd('chung', 'bản dự án'));
    writeFile(path.join(ctx.cwd, '.locaith', 'skills', 'chung', 'mau.txt'), 'x');
    await ctx.attach(skillsFeature);
    const names = ctx.skills.list().map((s) => s.name).sort();
    expect(names).toEqual(['ca-nhan', 'chung']);
    expect(ctx.skills.get('chung')?.description).toBe('bản cá nhân'); // thư mục nạp SAU thắng: cá nhân đứng sau dự án
    expect(ctx.skills.get('chung')?.source).toBe('user');
    expect(ctx.readRoots).toContain(path.join(ctx.home, '.locaith'));
    const out = await ctx.runSlash('skills');
    expect(out).toContain('ca-nhan');
    expect(out).toContain('bản cá nhân');
    expect(out).toContain('Kỹ năng** (2)');
    ctx.session().loadedSkills.push('ca-nhan');
    expect(await ctx.runSlash('skills')).toMatch(/● \*\*ca-nhan\*\*/);
    writeFile(path.join(ctx.home, '.locaith', 'skills', 'chung', 'mau.txt'), 'x');
    const detail = await ctx.runSlash('skills', 'chung');
    expect(detail).toContain('mau.txt');
    expect(detail).toContain('Làm theo các bước');
    expect(await ctx.runSlash('skills', 'khong-co')).toMatch(/Không có kỹ năng/);
    expect(ctx.slashNamed('skills').needsIdle).toBe(false);
  });

  it('thư mục dự án chưa tin cậy không được nạp; thêm kỹ năng mới thì /skills reload thấy', async () => {
    ctx = new FakeFeatureContext({ trusted: false });
    writeFile(path.join(ctx.cwd, '.locaith', 'skills', 'doc-hai', 'SKILL.md'), skillMd('doc-hai', 'không được nạp'));
    await ctx.attach(skillsFeature);
    expect(ctx.skills.get('doc-hai')).toBeUndefined();
    writeFile(path.join(ctx.home, '.locaith', 'skills', 'moi', 'SKILL.md'), skillMd('moi', 'mới thêm'));
    expect(ctx.skills.get('moi')).toBeUndefined();
    expect(await ctx.runSlash('skills', 'reload')).toMatch(/Đã nạp lại: 1/);
    expect(ctx.skills.get('moi')).toBeDefined();
  });

  it('.claude/skills chỉ đọc khi commands.includeClaude bật (mặc định bật)', async () => {
    ctx = new FakeFeatureContext({ user: { commands: { includeClaude: false } } });
    writeFile(path.join(ctx.home, '.claude', 'skills', 'tu-claude', 'SKILL.md'), skillMd('tu-claude', 'x'));
    await ctx.attach(skillsFeature);
    expect(ctx.skills.get('tu-claude')).toBeUndefined();
    await ctx.dispose();
    ctx.cleanup();
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.home, '.claude', 'skills', 'tu-claude', 'SKILL.md'), skillMd('tu-claude', 'x'));
    await ctx.attach(skillsFeature);
    expect(ctx.skills.get('tu-claude')).toBeDefined();
  });
});

describe('agent', () => {
  it('nạp agent người dùng + dự án, /agents liệt kê theo nguồn, /agents new tạo mẫu và nạp lại', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.home, '.locaith', 'agents', 'ca-nhan.md'), agentMd('ca-nhan', 'Agent cá nhân'));
    writeFile(path.join(ctx.cwd, '.locaith', 'agents', 'du-an.md'), agentMd('du-an', 'Agent dự án'));
    await ctx.attach(agentsFeature);
    expect(ctx.agents.get('ca-nhan')?.source).toBe('user');
    expect(ctx.agents.get('du-an')?.source).toBe('workspace');
    expect(ctx.agents.get('explore')).toBeDefined(); // dựng sẵn vẫn còn
    const out = await ctx.runSlash('agents');
    expect(out).toContain('Agent dự án');
    expect(out).toContain('Agent cá nhân');
    expect(out).toContain('Dựng sẵn');

    const created = await ctx.runSlash('agents', 'new Kiểm Thử Mới');
    expect(created).toContain('.locaith/agents/kiem-thu-moi.md');
    expect(fs.existsSync(path.join(ctx.cwd, '.locaith', 'agents', 'kiem-thu-moi.md'))).toBe(true);
    expect(ctx.agents.get('kiem-thu-moi')).toBeDefined();
    expect(ctx.events.find((e) => e.t === 'action')).toMatchObject({ action: 'open_editor' });
    expect(await ctx.runSlash('agents', 'new Kiểm Thử Mới')).toMatch(/Đã có tệp/);

    ctx.events.length = 0;
    await ctx.runSlash('agents', 'open du-an');
    expect(ctx.events[0]).toMatchObject({ t: 'action', action: 'open_editor', payload: path.join(ctx.cwd, '.locaith', 'agents', 'du-an.md') });
    expect(await ctx.runSlash('agents', 'open explore')).toMatch(/dựng sẵn/);
    expect(await ctx.runSlash('agents', 'open khong-co')).toMatch(/Không có agent/);
  });

  it('thư mục chưa tin cậy: không tạo mẫu, không nạp agent dự án', async () => {
    ctx = new FakeFeatureContext({ trusted: false });
    writeFile(path.join(ctx.cwd, '.locaith', 'agents', 'doc-hai.md'), agentMd('doc-hai', 'x'));
    await ctx.attach(agentsFeature);
    expect(ctx.agents.get('doc-hai')).toBeUndefined();
    expect(await ctx.runSlash('agents', 'new abc')).toMatch(/chưa được tin cậy/);
  });
});

describe('plugin', () => {
  it('plugin mặc định tắt; bật thì kỹ năng và agent của nó vào sổ', async () => {
    ctx = new FakeFeatureContext();
    const plug = path.join(ctx.home, '.locaith', 'plugins', 'bo-doi');
    writeFile(path.join(plug, 'plugin.json'), JSON.stringify({ name: 'bo-doi', version: '1.2.3', description: 'Bộ đồ nghề' }));
    writeFile(path.join(plug, 'skills', 'tu-plugin', 'SKILL.md'), skillMd('tu-plugin', 'Kỹ năng trong plugin'));
    writeFile(path.join(plug, 'agents', 'ag-plugin.md'), agentMd('ag-plugin', 'Agent trong plugin'));
    await ctx.attach(pluginsFeature);
    await ctx.attach(skillsFeature);
    await ctx.attach(agentsFeature);
    expect(ctx.skills.get('tu-plugin')).toBeUndefined();
    expect(await ctx.runSlash('plugins')).toContain('bo-doi');
    expect(await ctx.runSlash('plugins', 'enable bo-doi')).toMatch(/bật/);
    await new Promise((r) => setTimeout(r, 100)); // nạp lại chạy nền sau khi bật
    expect(ctx.skills.get('tu-plugin')).toBeDefined();
    expect(ctx.agents.get('ag-plugin')?.source).toBe('plugin');
    expect(ctx.readRoots).toContain(plug);
    expect(await ctx.runSlash('plugins', 'enable khong-co')).toMatch(/Không có plugin/);
  });
});
