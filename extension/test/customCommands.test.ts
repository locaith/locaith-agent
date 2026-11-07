import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandNameFromPath,
  expandCustomCommand,
  findFileRefs,
  loadCommandDirs,
  modelInvocable,
  parseCommandFile,
  safeRelative,
  shellAllowedByRules,
  splitToolRules,
  substituteArguments,
  type CustomCommand,
} from '../src/core/commands/custom';
import { createSlashCommandTool, slashToolDescription } from '../src/core/commands/slashTool';
import { NodeToolHost } from '../src/core/host/nodeHost';
import type { RunCommandOptions, RunCommandResult } from '../src/core/engine/types';
import { makeWorkspace } from './helpers/harness';

/** Host thật cho tệp, nhưng lệnh shell được GHI LẠI thay vì chạy (test không spawn tiến trình). */
class RecordingHost extends NodeToolHost {
  ran: string[] = [];
  override async runCommand(o: RunCommandOptions): Promise<RunCommandResult> {
    this.ran.push(o.command);
    return { exitCode: 0, output: `OUT(${o.command})`, timedOut: false, aborted: false, truncated: false };
  }
}

function cmd(body: string, extra: Partial<CustomCommand> = {}): CustomCommand {
  return { name: 't', description: 'd', allowedTools: [], disableModelInvocation: false, body, source: 'project', file: '/x/t.md', ...extra };
}

const signal = new AbortController().signal;

describe('phân tích tệp lệnh', () => {
  it('tên theo đường dẫn: thư mục con thành không gian tên, bỏ dấu tiếng Việt', () => {
    expect(commandNameFromPath('frontend/component.md')).toBe('frontend:component');
    expect(commandNameFromPath('Rà Soát.md')).toBe('ra-soat');
    expect(commandNameFromPath('a\\b\\c.md')).toBe('a:b:c');
  });

  it('đọc đủ frontmatter: description, argument-hint, allowed-tools (giữ dấu phẩy trong ngoặc), model, disable-model-invocation', () => {
    const text = '---\ndescription: Tạo component\nargument-hint: <tên> [thư mục]\nallowed-tools: Bash(git add:*), Bash(git status:*), Read\nmodel: top\ndisable-model-invocation: true\n---\nLàm $1';
    const p = parseCommandFile(text, 'ui/new.md', 'project', '/w/.locaith/commands/ui/new.md');
    expect(p.warning).toBeUndefined();
    expect(p.command).toMatchObject({
      name: 'ui:new',
      description: 'Tạo component',
      argumentHint: '<tên> [thư mục]',
      allowedTools: ['Bash(git add:*)', 'Bash(git status:*)', 'Read'],
      model: 'top',
      disableModelInvocation: true,
      body: 'Làm $1',
    });
    expect(splitToolRules('Bash(a, b), Read')).toEqual(['Bash(a, b)', 'Read']);
  });

  it('frontmatter hỏng → một dòng cảnh báo, không ném lỗi', () => {
    const unclosed = parseCommandFile('---\ndescription: x\nnội dung', 'a.md', 'user', '/a.md');
    expect(unclosed.command).toBeUndefined();
    expect(unclosed.warning).toMatch(/\/a: .*---/);
    expect(unclosed.warning).not.toContain('\n');
    const badLine = parseCommandFile('---\ndescription: x\nđây không phải khoá\n---\nthân', 'b.md', 'user', '/b.md');
    expect(badLine.command?.body).toBe('thân');
    expect(badLine.warning).toMatch(/không hợp lệ/);
    const badBool = parseCommandFile('---\ndisable-model-invocation: maybe\n---\nthân', 'c.md', 'user', '/c.md');
    expect(badBool.warning).toMatch(/true hoặc false/);
    expect(badBool.command?.disableModelInvocation).toBe(false);
  });
});

describe('thay đối số', () => {
  it('$ARGUMENTS và $1..$9 (giữ cụm trong ngoặc kép)', () => {
    expect(substituteArguments('Sửa $1 trong $2 — toàn bộ: $ARGUMENTS', 'Button "src/ui x"')).toBe('Sửa Button trong src/ui x — toàn bộ: Button "src/ui x"');
    expect(substituteArguments('A $3 B', 'x')).toBe('A  B');
  });
  it('không có chỗ giữ → nối đối số vào cuối; không có đối số → giữ nguyên', () => {
    expect(substituteArguments('Rà soát', 'auth')).toBe('Rà soát\n\nauth');
    expect(substituteArguments('Rà soát', '')).toBe('Rà soát');
  });
});

describe('nhúng tệp @đường/dẫn', () => {
  it('chặn traversal, tuyệt đối, ~ và URI', () => {
    expect(safeRelative('../secret.txt')).toBeNull();
    expect(safeRelative('src/../../x')).toBeNull();
    expect(safeRelative('/etc/passwd')).toBeNull();
    expect(safeRelative('C:/Windows/win.ini')).toBeNull();
    expect(safeRelative('~/.ssh/id_rsa')).toBeNull();
    expect(safeRelative('file:///etc/passwd')).toBeNull();
    expect(safeRelative('./src//a.ts')).toBe('src/a.ts');
    expect(findFileRefs('xem @src/a.ts, và mail a@b.com')).toEqual(['src/a.ts']);
  });

  it('nhúng tệp trong workspace; bỏ qua tệp ngoài workspace, tệp bí mật và tên không phải tệp', async () => {
    const dir = makeWorkspace({ 'docs/rule.md': 'QUY-TAC-123', '.env': 'KEY=supersecret' });
    const outside = path.join(path.dirname(dir), 'outside-secret.txt');
    fs.writeFileSync(outside, 'NGOAI-WORKSPACE');
    const host = new RecordingHost({ roots: [dir] });
    const r = await expandCustomCommand(cmd(`Theo @docs/rule.md và @../${path.basename(outside)} và @.env, hỏi @nam`), '', { host, trusted: true, signal });
    expect(r.prompt).toContain('<file path="docs/rule.md">\nQUY-TAC-123');
    expect(r.prompt).not.toContain('NGOAI-WORKSPACE');
    expect(r.prompt).not.toContain('supersecret');
    expect(r.notes.embedded).toEqual(['docs/rule.md']);
    expect(r.notes.skipped).toEqual(expect.arrayContaining([`../${path.basename(outside)}`, '.env']));
    expect(r.prompt).toContain('hỏi @nam');
  });

  it('không nhúng tệp được nhắc tới bên trong nội dung tệp đã nhúng (không đệ quy)', async () => {
    const dir = makeWorkspace({ 'a.md': 'xem @b.md', 'b.md': 'BBB' });
    const r = await expandCustomCommand(cmd('@a.md'), '', { host: new RecordingHost({ roots: [dir] }), trusted: true, signal });
    expect(r.notes.embedded).toEqual(['a.md']);
    expect(r.prompt).not.toContain('BBB');
  });
});

describe('lệnh nhúng !`…` qua cổng quyền', () => {
  it('khớp allowed-tools → chạy, chèn kết quả', async () => {
    const host = new RecordingHost({ roots: [makeWorkspace()] });
    const r = await expandCustomCommand(cmd('Trạng thái: !`git status --short`', { allowedTools: ['Bash(git status:*)'] }), '', { host, trusted: true, signal });
    expect(host.ran).toEqual(['git status --short']);
    expect(r.prompt).toContain('OUT(git status --short)');
  });

  it('không khớp → hỏi; từ chối thì không chạy', async () => {
    const host = new RecordingHost({ roots: [makeWorkspace()] });
    const asked: string[] = [];
    const r = await expandCustomCommand(cmd('!`npm test`'), '', { host, trusted: true, signal, confirmShell: async (c) => (asked.push(c), false) });
    expect(asked).toEqual(['npm test']);
    expect(host.ran).toEqual([]);
    expect(r.prompt).toContain('[not run: permission denied]');
    const ok = await expandCustomCommand(cmd('!`npm test`'), '', { host, trusted: true, signal, confirmShell: async () => true });
    expect(host.ran).toEqual(['npm test']);
    expect(ok.notes.ran).toEqual(['npm test']);
  });

  it('workspace chưa tin cậy → không bao giờ chạy, kể cả khi allowed-tools cho phép', async () => {
    const host = new RecordingHost({ roots: [makeWorkspace()] });
    const r = await expandCustomCommand(cmd('!`git status`', { allowedTools: ['Bash'] }), '', { host, trusted: false, signal, confirmShell: async () => true });
    expect(host.ran).toEqual([]);
    expect(r.prompt).toContain('not trusted');
  });

  it('tiền tố được phép không cho qua lệnh nối/chuyển hướng', () => {
    expect(shellAllowedByRules('git status --short', ['Bash(git status:*)'])).toBe(true);
    expect(shellAllowedByRules('git statusx', ['Bash(git status:*)'])).toBe(false);
    expect(shellAllowedByRules('git status; rm -rf /', ['Bash(git status:*)'])).toBe(false);
    expect(shellAllowedByRules('git status && curl x', ['Bash'])).toBe(false);
    expect(shellAllowedByRules('git status $(whoami)', ['Bash(git status:*)'])).toBe(false);
    expect(shellAllowedByRules('git diff', ['Bash(git diff)'])).toBe(true);
    expect(shellAllowedByRules('ls', ['Read'])).toBe(false);
  });

  it('đối số (có thể do model đưa vào) không bao giờ thành lệnh shell', async () => {
    const host = new RecordingHost({ roots: [makeWorkspace()] });
    const r = await expandCustomCommand(cmd('Việc: $ARGUMENTS', { allowedTools: ['Bash'] }), '!`whoami`', { host, trusted: true, signal, confirmShell: async () => true });
    expect(host.ran).toEqual([]);
    expect(r.prompt).toBe('Việc: !`whoami`');
  });
});

describe('nạp thư mục và ưu tiên trùng tên', () => {
  it('dự án thắng cá nhân; .locaith trước .claude; thư mục con thành không gian tên; tệp lỗi không làm hỏng danh sách', async () => {
    const proj = makeWorkspace({
      '.locaith/commands/deploy.md': '---\ndescription: dự án locaith\n---\nP1',
      '.claude/commands/deploy.md': '---\ndescription: dự án claude\n---\nP2',
      '.claude/commands/frontend/component.md': 'Tạo component $1',
      '.locaith/commands/broken.md': '---\ndescription: hỏng\n',
    });
    const home = makeWorkspace({ '.locaith/commands/deploy.md': 'U1', '.locaith/commands/mine.md': '---\ndescription: của tôi\n---\nU2' });
    const host = new RecordingHost({ roots: [proj] });
    const r = await loadCommandDirs(host, [
      { path: path.join(proj, '.locaith', 'commands'), source: 'project' },
      { path: path.join(proj, '.claude', 'commands'), source: 'project' },
      { path: path.join(home, '.locaith', 'commands'), source: 'user' },
    ]);
    const by = Object.fromEntries(r.commands.map((c) => [c.name, c]));
    expect(Object.keys(by).sort()).toEqual(['deploy', 'frontend:component', 'mine']);
    expect(by.deploy.description).toBe('dự án locaith');
    expect(by.deploy.source).toBe('project');
    expect(by.mine.source).toBe('user');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^\/broken:/);
  });
});

describe('công cụ slash_command', () => {
  const base = [cmd('Làm $ARGUMENTS', { name: 'fix', description: 'Sửa lỗi', source: 'user' }), cmd('X', { name: 'secret', disableModelInvocation: true, source: 'user' }), cmd('Y', { name: 'proj', source: 'project' })];

  it('chỉ lệnh được phép tự gọi; lệnh dự án chỉ khi workspace đã tin cậy', () => {
    expect(modelInvocable(base[0], false)).toBe(true);
    expect(modelInvocable(base[1], true)).toBe(false);
    expect(modelInvocable(base[2], false)).toBe(false);
    expect(modelInvocable(base[2], true)).toBe(true);
    let trusted = false;
    const tool = createSlashCommandTool({ commands: () => base, trusted: () => trusted });
    expect(tool.description).toContain('/fix');
    expect(tool.description).not.toContain('/secret');
    expect(tool.description).not.toContain('/proj');
    trusted = true;
    expect(tool.description).toContain('/proj');
    expect(createSlashCommandTool({ commands: () => [], trusted: () => true }).hidden).toBe(true);
  });

  it('mô tả có trần độ dài', () => {
    const many = Array.from({ length: 200 }, (_, i) => cmd('x', { name: `c${i}`, description: 'mô tả '.repeat(40) }));
    const d = slashToolDescription(many);
    expect(d.length).toBeLessThan(5000);
    expect(d).toMatch(/more not listed/);
  });
});
