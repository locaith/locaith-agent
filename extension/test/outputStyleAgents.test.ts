import { describe, expect, it } from 'vitest';
import { agentFromMarkdown, builtinAgents } from '../src/core/agents/definitions';
import { createSlashCommandTool } from '../src/core/commands/slashTool';
import { builtinOutputStyles, loadOutputStyles, outputStyleBlock, outputStyleFromMarkdown } from '../src/core/commands/outputStyles';
import type { CustomCommand } from '../src/core/commands/custom';
import { buildSystemPrompt } from '../src/core/engine/context';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import { createToolRegistry } from '../src/core/tools';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeHarness, makeWorkspace } from './helpers/harness';
import * as path from 'node:path';

const host = new NodeToolHost({ roots: ['/w'] });
const baseInput = { host, model: 'm', providerLabel: 'P', mode: 'default' as const, language: 'vi' as const, now: new Date(2026, 10, 7) };

describe('phong cách đầu ra', () => {
  it('mặc định / không có → system prompt giữ nguyên từng byte', () => {
    const plain = buildSystemPrompt(baseInput);
    expect(buildSystemPrompt({ ...baseInput, outputStyle: null })).toBe(plain);
    expect(buildSystemPrompt({ ...baseInput, outputStyle: { name: 'default', prompt: '' } })).toBe(plain);
  });

  it('phong cách chọn → khối <output_style> nằm SAU hiến pháp, kèm câu không nới lỏng quy tắc', () => {
    const concise = builtinOutputStyles().find((s) => s.name === 'concise')!;
    const sys = buildSystemPrompt({ ...baseInput, outputStyle: { name: concise.name, prompt: concise.prompt } });
    const at = sys.indexOf('<output_style name="concise">');
    expect(at).toBeGreaterThan(0);
    expect(sys.indexOf('<environment>')).toBeLessThan(at);
    expect(sys.slice(at)).toMatch(/never relaxes the rules/);
  });

  it('dữ liệu phiên hỏng không làm vỡ prompt; tên lạ được làm sạch; nội dung có trần', () => {
    expect(outputStyleBlock({ name: 'x', prompt: 42 as unknown as string })).toBeNull();
    const b = outputStyleBlock({ name: 'a"><x', prompt: 'p'.repeat(10_000) })!;
    expect(b).toContain('name="a___x"');
    expect(b.length).toBeLessThan(4400);
  });

  it('tệp .locaith/output-styles: dự án ghi đè cá nhân, không ghi đè được "default"', async () => {
    const proj = makeWorkspace({ 'st/pirate.md': '---\nname: pirate\ndescription: Cướp biển\n---\nNói như cướp biển.', 'st/default.md': 'không được' });
    const home = makeWorkspace({ 'st/pirate.md': 'bản cá nhân', 'st/mine.md': 'của tôi' });
    const styles = await loadOutputStyles(new NodeToolHost({ roots: [proj] }), [
      { path: path.join(proj, 'st'), source: 'project' },
      { path: path.join(home, 'st'), source: 'user' },
    ]);
    const by = Object.fromEntries(styles.map((s) => [s.name, s]));
    expect(by.pirate.prompt).toBe('Nói như cướp biển.');
    expect(by.mine.source).toBe('user');
    expect(by.default.prompt).toBe('');
    expect(outputStyleFromMarkdown('---\nname: x\n---\n', 'x', 'user')).toBeNull();
  });

  it('engine thật: phong cách của phiên được gửi trong system prompt; cài đặt mặc định dùng khi phiên chưa chọn', async () => {
    const h = makeHarness([() => textTurn('ok'), () => textTurn('ok2')], { engineDeps: { outputStyle: () => ({ name: 'explanatory', prompt: 'EXPLAIN-STYLE' }) } });
    await h.run('xin chào');
    expect(h.provider.requests[0].system).toContain('EXPLAIN-STYLE');
    h.session.outputStyle = { name: 'concise', prompt: 'CONCISE-STYLE' };
    await h.run('tiếp');
    expect(h.provider.requests[1].system).toContain('CONCISE-STYLE');
    expect(h.provider.requests[1].system).not.toContain('EXPLAIN-STYLE');
  });
});

describe('công cụ slash_command trong engine thật', () => {
  it('model gọi lệnh → nhận prompt đã mở rộng làm kết quả công cụ', async () => {
    const commands: CustomCommand[] = [
      { name: 'release-notes', description: 'Viết ghi chú phát hành', allowedTools: [], disableModelInvocation: false, body: 'Viết ghi chú cho phiên bản $1', source: 'user', file: '/u/rn.md' },
    ];
    const dir = makeWorkspace();
    const h0 = new NodeToolHost({ roots: [dir] });
    const skills = new SkillRegistry(builtinSkills());
    const registry = createToolRegistry({ skills, host: h0 });
    registry.register(createSlashCommandTool({ commands: () => commands, trusted: () => true }));
    const h = makeHarness(
      [() => toolTurn([{ name: 'slash_command', input: { command: '/release-notes', args: '1.2.0' } }]), () => textTurn('xong')],
      { engineDeps: { registry, skills } },
    );
    await h.run('viết ghi chú phát hành 1.2.0');
    expect(h.provider.requests[0].tools.some((t) => t.name === 'slash_command' && t.description.includes('/release-notes'))).toBe(true);
    const second = JSON.stringify(h.provider.requests[1].messages);
    expect(second).toContain('Viết ghi chú cho phiên bản 1.2.0');
  });
});

describe('agent con', () => {
  it('dựng sẵn có explore / plan / reviewer / test-runner, không trùng tên', () => {
    const names = builtinAgents().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['explore', 'plan', 'reviewer', 'test-runner', 'general']));
    expect(new Set(names).size).toBe(names.length);
    const tr = builtinAgents().find((a) => a.name === 'test-runner')!;
    expect(tr.tools).toContain('run_command');
    expect(tr.tools).not.toContain('edit_file');
    expect(tr.tools).not.toContain('write_file');
  });

  it('agent từ tệp đọc color (hợp lệ) và bỏ màu lạ', () => {
    const a = agentFromMarkdown('---\nname: ui-critic\ndescription: Phê bình UI\ntools: Read, Grep\ncolor: purple\n---\nVai trò', 'x', 'workspace');
    expect(a).toMatchObject({ name: 'ui-critic', color: 'purple', tools: ['read_file', 'grep'] });
    const b = agentFromMarkdown('---\ncolor: red;background:url(x)\n---\nVai trò', 'y', 'workspace');
    expect(b?.color).toBeUndefined();
  });
});
