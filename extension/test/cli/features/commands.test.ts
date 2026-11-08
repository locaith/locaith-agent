import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandsFeature, commandsStateOf } from '../../../src/cli/runtime/features/commands';
import { pluginsFeature } from '../../../src/cli/runtime/features/plugins';
import { FakeFeatureContext, writeFile } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

const names = (source: 'project' | 'user' | 'plugin') => (ctx.slashSources.get(source) ?? []).map((d) => d.name).sort();
const echoCmd = process.platform === 'win32' ? 'echo xin-chao' : 'echo xin-chao';

describe('lệnh tuỳ chỉnh', () => {
  it('nạp dự án/người dùng, khung YAML, $ARGUMENTS và $1, @file', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, '.locaith', 'commands', 'frontend', 'component.md'), '---\ndescription: Tạo component\nargument-hint: <tên> [thư mục]\nmodel: openai:gpt-x\n---\nTạo component $1 trong $2. Tất cả: $ARGUMENTS\nQuy ước: @docs/quy-uoc.md\n');
    writeFile(path.join(ctx.cwd, 'docs', 'quy-uoc.md'), 'LUON DUNG TYPESCRIPT');
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'chao.md'), 'Chào $ARGUMENTS nhé');
    await ctx.attach(commandsFeature);
    expect(names('project')).toEqual(['frontend:component']);
    expect(names('user')).toEqual(['chao']);
    const def = ctx.slashSources.get('project')![0];
    expect(def.argHint).toBe('<tên> [thư mục]');
    expect(def.description.vi).toBe('Tạo component');

    await ctx.runSlash('frontend:component', 'Nut src/ui');
    expect(ctx.prompts).toHaveLength(1);
    const p = ctx.prompts[0];
    expect(p.text).toContain('Tạo component Nut trong src/ui. Tất cả: Nut src/ui');
    expect(p.text).toContain('LUON DUNG TYPESCRIPT'); // @file được nhúng
    expect(p.text).toContain('<file path="docs/quy-uoc.md">');
    expect(p.model).toBe('openai:gpt-x');

    await ctx.runSlash('chao', 'Tuấn');
    expect(ctx.prompts[1].text).toBe('Chào Tuấn nhé');
  });

  it('@file không thoát ra ngoài thư mục làm việc, không nhúng tệp bí mật', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, '.env'), 'SECRET=1');
    writeFile(path.join(ctx.home, 'bi-mat.txt'), 'NGOAI');
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'doc.md'), 'Đọc @.env và @../ngoai.txt và @docs/a.md');
    writeFile(path.join(ctx.cwd, 'docs', 'a.md'), 'AAA');
    await ctx.attach(commandsFeature);
    await ctx.runSlash('doc');
    const t = ctx.prompts[0].text;
    expect(t).toContain('AAA');
    expect(t).not.toContain('SECRET=1');
    expect(t).not.toContain('NGOAI');
  });

  it('lệnh nhúng !`cmd`: không tương tác thì KHÔNG chạy; allowed-tools cho chạy; tương tác hỏi; deny chặn kể cả allowed-tools', async () => {
    const marker = path.join(__dirname, `.chay-${Date.now()}.txt`);
    ctx = new FakeFeatureContext({ interactive: false });
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'git.md'), `Kết quả: !\`${echoCmd}\``);
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'duoc.md'), `---\nallowed-tools: Bash(echo:*)\n---\nKết quả: !\`${echoCmd}\``);
    await ctx.attach(commandsFeature);

    await ctx.runSlash('git');
    expect(ctx.prompts[0].text).toContain('[not run: permission denied]');
    expect(ctx.toasts.some((t) => /không chạy/.test(t.text))).toBe(true);

    await ctx.runSlash('duoc');
    expect(ctx.prompts[1].text).toMatch(/^xin-chao$/m);

    ctx.interactive = true;
    ctx.askAnswers = [true];
    await ctx.runSlash('git');
    expect(ctx.asks.at(-1)).toMatchObject({ kind: 'confirm', danger: true });
    expect((ctx.asks.at(-1) as { detail: string }).detail).toContain(echoCmd);
    expect(ctx.prompts[2].text).toMatch(/^xin-chao$/m);

    // luật deny thắng cả allowed-tools
    fs.writeFileSync(ctx.settings.file('user'), JSON.stringify({ permissions: { deny: ['run_command(echo:*)'] } }));
    await ctx.runSlash('duoc');
    expect(ctx.prompts[3].text).not.toMatch(/^xin-chao$/m); // chỉ dòng lệnh được in lại, không có kết quả chạy
    expect(ctx.prompts[3].text).toMatch(/failed: bị luật permissions.deny chặn/);
    fs.rmSync(marker, { force: true });
  });

  it('thư mục chưa tin cậy: lệnh dự án không nạp, lệnh nhúng không chạy', async () => {
    ctx = new FakeFeatureContext({ trusted: false });
    writeFile(path.join(ctx.cwd, '.locaith', 'commands', 'doc-hai.md'), 'x');
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'ca-nhan.md'), `a !\`${echoCmd}\``);
    await ctx.attach(commandsFeature);
    expect(names('project')).toEqual([]);
    ctx.askAnswers = [true];
    await ctx.runSlash('ca-nhan');
    expect(ctx.prompts[0].text).toContain('not run: workspace is not trusted');
  });

  it('.claude/commands chỉ khi commands.includeClaude; quét lại khi tệp đổi và khi chạy lệnh', async () => {
    ctx = new FakeFeatureContext({ user: { commands: { includeClaude: false } } });
    writeFile(path.join(ctx.cwd, '.claude', 'commands', 'tu-claude.md'), 'x');
    await ctx.attach(commandsFeature);
    expect(names('project')).toEqual([]);
    await ctx.dispose();
    ctx.cleanup();

    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.cwd, '.claude', 'commands', 'tu-claude.md'), 'Nội dung cũ');
    await ctx.attach(commandsFeature);
    expect(names('project')).toEqual(['tu-claude']);
    // sửa tệp rồi chạy: dùng nội dung MỚI mà không cần khởi động lại
    writeFile(path.join(ctx.cwd, '.claude', 'commands', 'tu-claude.md'), 'Nội dung mới');
    await ctx.runSlash('tu-claude');
    expect(ctx.prompts[0].text).toBe('Nội dung mới');
    // xoá tệp rồi chạy: báo lệnh đã mất
    fs.rmSync(path.join(ctx.cwd, '.claude', 'commands', 'tu-claude.md'));
    expect(await ctx.runSlash('tu-claude')).toMatch(/không còn/);
    expect(ctx.prompts).toHaveLength(1);
    // thêm tệp mới + đổi phiên → menu cập nhật
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'moi.md'), 'm');
    ctx.setSession({ ...ctx.session(), id: 's_khac' });
    await commandsStateOf(ctx)!.reload();
    expect(names('user')).toEqual(['moi']);
  });

  it('khung YAML sai được báo một dòng cảnh báo, không sập; slash_command do model gọi đi qua luật chặn', async () => {
    ctx = new FakeFeatureContext();
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'hong.md'), '---\ndescription: thiếu đóng\nNội dung');
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'tot.md'), 'Tốt $ARGUMENTS');
    writeFile(path.join(ctx.home, '.locaith', 'commands', 'khoa.md'), '---\ndisable-model-invocation: true\n---\nkhoá');
    await ctx.attach(commandsFeature);
    expect(names('user')).toEqual(['khoa', 'tot']);
    expect(ctx.toasts.some((t) => t.level === 'warn' && /hong/.test(t.text))).toBe(true);
    const tool = ctx.contributedTools().find((t) => t.name === 'slash_command')!;
    expect(tool).toBeDefined();
    expect(tool.description).toContain('/tot');
    expect(tool.description).not.toContain('/khoa');
    const tctx = { signal: new AbortController().signal, session: ctx.session(), host: ctx.host, callId: 'c1' } as never;
    const ok = await tool.execute({ command: 'tot', args: 'abc' }, tctx);
    expect(ok.content).toContain('Tốt abc');
    const blocked = await tool.execute({ command: 'khoa' }, tctx);
    expect(blocked.isError).toBe(true);
  });

  it('lệnh của plugin đang bật thành nguồn plugin', async () => {
    ctx = new FakeFeatureContext();
    const plug = path.join(ctx.home, '.locaith', 'plugins', 'bo');
    writeFile(path.join(plug, 'plugin.json'), JSON.stringify({ name: 'bo' }));
    writeFile(path.join(plug, 'commands', 'lam.md'), '---\ndescription: Làm việc\n---\nLàm $ARGUMENTS');
    await ctx.attach(pluginsFeature);
    await ctx.attach(commandsFeature);
    expect(names('plugin')).toEqual([]);
    await ctx.runSlash('plugins', 'enable bo');
    await new Promise((r) => setTimeout(r, 150));
    expect(names('plugin')).toEqual(['bo:lam']);
    await ctx.runSlash('bo:lam', 'xong');
    expect(ctx.prompts[0].text).toBe('Làm xong');
  });
});
