import { zipSync, strToU8 } from 'fflate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillMarket, MARKER } from '../src/core/market/market';
import { discoverPlugins, expandCommand, inside, loadPlugin, loadPluginCommands } from '../src/core/plugins/loader';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import { createSkillTools } from '../src/core/tools/meta';
import { newSession, type ToolContext } from '../src/core/engine/types';
import { makeWorkspace } from './helpers/harness';

function ctx(): ToolContext {
  return { signal: new AbortController().signal, session: newSession({ id: 's', provider: 'p', model: 'm' }), host: {} as never, callId: 'c', assistantId: 'a', emit: () => {}, progress: () => {}, log: () => {} };
}

describe('plugin', () => {
  const dir = makeWorkspace({
    'p1/plugin.json': JSON.stringify({ name: 'Bao Gia', version: '1.2.0', description: 'Bộ báo giá' }),
    'p1/skills/bao-gia/SKILL.md': '---\nname: bao-gia\ndescription: Soạn báo giá\n---\nnội dung',
    'p1/agents/kiem-tra.md': '---\ndescription: Kiểm tra\n---\nvai trò',
    'p1/commands/soan.md': '---\ndescription: Soạn nhanh\n---\nHãy soạn báo giá cho: $ARGUMENTS',
    'p1/.mcp.json': JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.js'] }, bad: { foo: 1 } } }),
    'p2/.claude-plugin/plugin.json': JSON.stringify({ name: 'kieu-claude', skills: ['kn'], agents: '../ngoai' }),
    'p2/kn/x/SKILL.md': '---\nname: x\n---\nx',
    'p3/readme.txt': 'không phải plugin',
    'p4/skills/only/SKILL.md': '---\nname: only\n---\nx',
  });

  it('nhận plugin có manifest (plugin.json / .claude-plugin) và plugin chỉ có thư mục skills/', async () => {
    const found = await discoverPlugins([dir]);
    expect(found.map((p) => p.id).sort()).toEqual(['bao-gia', 'kieu-claude', 'p4']);
    const p1 = found.find((p) => p.id === 'bao-gia')!;
    expect(p1).toMatchObject({ name: 'Bao Gia', version: '1.2.0' });
    expect(p1.skillDirs).toEqual([path.join(dir, 'p1', 'skills')]);
    expect(p1.agentDirs).toEqual([path.join(dir, 'p1', 'agents')]);
    expect(Object.keys(p1.mcpServers)).toEqual(['Bao Gia:db']); // mục hỏng bị bỏ; tên có tiền tố plugin
    expect(p1.mcpServers['Bao Gia:db'].cwd).toBe(path.join(dir, 'p1'));
  });

  it('đường dẫn trong manifest không được thoát ra ngoài thư mục plugin', async () => {
    const p2 = await loadPlugin(path.join(dir, 'p2'));
    expect(p2?.skillDirs).toEqual([path.join(dir, 'p2', 'kn')]);
    expect(p2?.agentDirs).toEqual([]); // "../ngoai" bị loại
    expect(inside('/a/b', '../c')).toBeNull();
    expect(inside('/a/b', '/etc/passwd')).toBeNull();
    expect(inside('/a/b', 'x/y')).toBe(path.resolve('/a/b', 'x/y'));
  });

  it('lệnh gạch chéo của plugin: tên "<plugin>:<lệnh>", thay $ARGUMENTS', async () => {
    const p1 = (await discoverPlugins([dir])).find((p) => p.id === 'bao-gia')!;
    const cmds = await loadPluginCommands(p1);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ name: 'bao-gia:soan', description: 'Soạn nhanh', plugin: 'Bao Gia' });
    expect(expandCommand(cmds[0].template, 'công ty ABC')).toBe('Hãy soạn báo giá cho: công ty ABC');
    expect(expandCommand('Không có biến', 'thêm')).toBe('Không có biến\n\nthêm');
  });
});

describe('Chợ kỹ năng', () => {
  function fixture() {
    const marketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-market-'));
    const installRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-skills-')), 'skills');
    const index = [
      { id: 'pdf-doctor', name: 'pdf-doctor', description: 'Đọc và sửa tệp PDF', group: 'community', repo: 'r1', license: 'MIT', files: 2, bytes: 100 },
      { id: 'sql-tuner', name: 'sql-tuner', description: 'Tối ưu truy vấn SQL', group: 'vendor', repo: 'r2', license: 'Apache-2.0', files: 1, bytes: 50 },
    ];
    fs.writeFileSync(path.join(marketDir, 'index.json'), JSON.stringify(index));
    fs.writeFileSync(
      path.join(marketDir, 'skills.zip'),
      zipSync({
        'pdf-doctor/SKILL.md': strToU8('---\nname: pdf-doctor\ndescription: Đọc và sửa tệp PDF\n---\nHướng dẫn PDF'),
        'pdf-doctor/scripts/run.py': strToU8('print(1)'),
        'pdf-doctor/../../escape.txt': strToU8('độc hại'),
        'sql-tuner/SKILL.md': strToU8('---\nname: sql-tuner\n---\nSQL'),
      }),
    );
    return { market: new SkillMarket(marketDir, installRoot), installRoot, marketDir };
  }

  it('Thêm = giải nén đúng một kỹ năng (kèm tệp đi kèm) và đánh dấu; kỹ năng khác không bị đụng tới', async () => {
    const { market, installRoot } = fixture();
    expect(await market.installedIds()).toEqual(new Set());
    const r = await market.install('pdf-doctor');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(installRoot, 'pdf-doctor', 'SKILL.md'), 'utf8')).toContain('Hướng dẫn PDF');
    expect(fs.existsSync(path.join(installRoot, 'pdf-doctor', 'scripts', 'run.py'))).toBe(true);
    expect(fs.existsSync(path.join(installRoot, 'sql-tuner'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installRoot, 'pdf-doctor', MARKER), 'utf8')).id).toBe('pdf-doctor');
    expect(await market.installedIds()).toEqual(new Set(['pdf-doctor']));
  });

  it('chặn ".." trong tên tệp của gói (không ghi ra ngoài thư mục kỹ năng)', async () => {
    const { market, installRoot } = fixture();
    await market.install('pdf-doctor');
    const parent = path.dirname(installRoot);
    expect(fs.existsSync(path.join(parent, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(installRoot, 'escape.txt'))).toBe(false);
  });

  it('cài lại là cập nhật; thư mục của người dùng (không có dấu của Chợ) không bị ghi đè; id lạ bị từ chối', async () => {
    const { market, installRoot } = fixture();
    expect((await market.install('pdf-doctor')).ok).toBe(true);
    expect((await market.install('pdf-doctor')).ok).toBe(true);
    fs.mkdirSync(path.join(installRoot, 'sql-tuner'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'sql-tuner', 'SKILL.md'), 'của tôi');
    const r = await market.install('sql-tuner');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('không phải do Chợ cài');
    expect(fs.readFileSync(path.join(installRoot, 'sql-tuner', 'SKILL.md'), 'utf8')).toBe('của tôi');
    expect((await market.install('../../etc')).ok).toBe(false);
    expect((await market.install('khong-co')).ok).toBe(false);
  });

  it('Gỡ chỉ xoá thư mục do Chợ cài', async () => {
    const { market, installRoot } = fixture();
    await market.install('pdf-doctor');
    expect((await market.uninstall('pdf-doctor')).ok).toBe(true);
    expect(fs.existsSync(path.join(installRoot, 'pdf-doctor'))).toBe(false);
    fs.mkdirSync(path.join(installRoot, 'sql-tuner'), { recursive: true });
    const r = await market.uninstall('sql-tuner');
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(installRoot, 'sql-tuner'))).toBe(true);
  });

  it('tìm kiếm không dấu, bỏ qua kỹ năng đã có', async () => {
    const { market } = fixture();
    expect((await market.search('doc file pdf', 3)).map((s) => s.id)).toEqual(['pdf-doctor']);
    expect((await market.search('toi uu sql', 3)).map((s) => s.id)).toEqual(['sql-tuner']);
    expect(await market.search('toi uu sql', 3, new Set(['sql-tuner']))).toEqual([]);
    expect(await market.search('', 3)).toEqual([]);
  });

  it('search_skills gợi ý kỹ năng trong Chợ chưa được thêm (mô hình không tự cài)', async () => {
    const { market } = fixture();
    const [, search] = createSkillTools(new SkillRegistry(builtinSkills()), market);
    const r = await search.execute({ query: 'chuẩn đoán pdf' }, ctx());
    expect(r.content).toContain('Chợ kỹ năng còn có');
    expect(r.content).toContain('pdf-doctor');
    expect(r.content).toContain('nhờ người dùng');
    // không truyền market → hành vi cũ
    const [, plain] = createSkillTools(new SkillRegistry(builtinSkills()));
    expect((await plain.execute({ query: 'qqqqzzzz' }, ctx())).content).toContain('Không có kỹ năng nào khớp');
  });
});
