import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/core/agents/definitions';
import { NodeToolHost } from '../src/core/host/nodeHost';
import type { RunCommandOptions, RunCommandResult, SessionState } from '../src/core/engine/types';
import { newSession } from '../src/core/engine/types';
import { ToolRegistry } from '../src/core/engine/toolRegistry';
import { registerCommandsSlash, type CommandsLaneAccess } from '../src/host/commandsSlash';
import { formatDoctor, formatStatus } from '../src/host/commandsReport';
import { SlashRegistry, type SlashContext } from '../src/host/slashRegistry';
import type { UiEvent } from '../src/shared/protocol';
import { textTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';
import { makeWorkspace } from './helpers/harness';
import { workspace } from './helpers/vscode-stub';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('quá hạn chờ');
    await wait(20);
  }
}
const noticeTexts = (events: UiEvent[]) => events.filter((e): e is Extract<UiEvent, { t: 'notice' }> => e.t === 'notice').map((e) => e.text);
const userTextOf = (h: ControllerHarness, i: number) => JSON.stringify(h.provider.requests[i].messages);

describe('ChatController thật: lệnh tuỳ chỉnh + lệnh dựng sẵn', () => {
  let h: ControllerHarness | undefined;
  afterEach(() => {
    h?.dispose();
    h = undefined;
    workspace.isTrusted = true;
  });

  it('lệnh .locaith/commands hiện trong menu kèm nhãn nguồn và chạy thành prompt đã thay đối số', async () => {
    h = makeControllerHarness({
      script: [() => textTurn('xong')],
      files: { '.locaith/commands/greet.md': '---\ndescription: Chào một người\nargument-hint: <tên>\n---\nHãy chào $1 thật lịch sự.' },
    });
    await until(() => !!h!.view().slashCommands?.some((c) => c.name === 'greet'));
    const entry = h.view().slashCommands!.find((c) => c.name === 'greet')!;
    expect(entry.description).toContain('Chào một người');
    expect(entry.description).toContain('(dự án)');
    await h.send('/greet Lan');
    await h.idle();
    expect(userTextOf(h, 0)).toContain('Hãy chào Lan thật lịch sự.');
  });

  it('menu làm mới khi tệp lệnh thay đổi (reload)', async () => {
    h = makeControllerHarness({ script: [] });
    await until(() => !!h!.view().slashCommands?.some((c) => c.name === 'review'));
    expect(h.view().slashCommands!.some((c) => c.name === 'later')).toBe(false);
    fs.mkdirSync(path.join(h.dir, '.locaith', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, '.locaith', 'commands', 'later.md'), 'Thêm sau');
    const { commandsLaneState } = await import('../src/host/commandsSlash');
    await commandsLaneState(h.ctl)!.reload();
    expect(h.view().slashCommands!.some((c) => c.name === 'later')).toBe(true);
  });

  it('/review và /security-review chạy một lượt với prompt rà soát không sửa mã; /simplify yêu cầu sửa', async () => {
    h = makeControllerHarness({ script: [() => textTurn('r1'), () => textTurn('r2'), () => textTurn('r3')] });
    await until(() => !!h!.view().slashCommands?.some((c) => c.name === 'review'));
    await h.send('/review main');
    await h.idle();
    expect(userTextOf(h, 0)).toContain('DO NOT modify any file');
    expect(userTextOf(h, 0)).toContain('git diff');
    expect(userTextOf(h, 0)).toContain('**Critical**');
    expect(userTextOf(h, 0)).toContain('\\"main\\"');
    await h.send('/security-review');
    await h.idle();
    expect(userTextOf(h, 1)).toMatch(/security review/i);
    await h.send('/simplify');
    await h.idle();
    expect(userTextOf(h, 2)).toContain('APPLY the improvements');
  });

  it('/status hiện model, chế độ quyền, ngữ cảnh trong khung chat (notice), không gọi model', async () => {
    h = makeControllerHarness({ script: [] });
    await until(() => !!h!.view().slashCommands?.some((c) => c.name === 'status'));
    await h.send('/status');
    await until(() => noticeTexts(h!.events).some((t) => t.includes('Trạng thái')));
    const txt = noticeTexts(h.events).find((t) => t.includes('Trạng thái'))!;
    expect(txt).toContain('fake · fake-1');
    expect(txt).toContain('Chế độ quyền: default');
    expect(txt).toContain('/ 200k');
    expect(h.provider.requests).toHaveLength(0);
  });

  it('/output-style concise áp vào system prompt của lượt kế tiếp; tên lạ báo lỗi', async () => {
    h = makeControllerHarness({ script: [() => textTurn('ok')] });
    await until(() => !!h!.view().slashCommands?.some((c) => c.name === 'output-style'));
    await h.send('/output-style khong-co');
    await until(() => noticeTexts(h!.events).some((t) => t.includes('Không có phong cách')));
    await h.send('/output-style concise');
    await until(() => h!.session().outputStyle?.name === 'concise');
    await h.send('chào');
    await h.idle();
    expect(h.provider.requests[0].system).toContain('<output_style name="concise">');
  });

  it('workspace chưa tin cậy: không đọc .claude/commands của dự án, lệnh nhúng không chạy', async () => {
    workspace.isTrusted = false;
    h = makeControllerHarness({
      script: [],
      files: { '.claude/commands/cc.md': 'từ claude', '.locaith/commands/lo.md': 'Kết quả: !`whoami`' },
    });
    workspace.isTrusted = false;
    const { commandsLaneState } = await import('../src/host/commandsSlash');
    await commandsLaneState(h.ctl)!.reload();
    const names = commandsLaneState(h.ctl)!.commands.map((c) => c.name);
    expect(names).toContain('lo');
    expect(names).not.toContain('cc');
  });
});

// ── Đơn vị: lệnh dựng sẵn với phụ thuộc giả ──

class FakeHost extends NodeToolHost {
  ran: string[] = [];
  override async runCommand(o: RunCommandOptions): Promise<RunCommandResult> {
    this.ran.push(o.command);
    return { exitCode: o.command.startsWith('node') ? 1 : 0, output: o.command === 'git --version' ? 'git version 2.50.0' : 'ok', timedOut: false, aborted: false, truncated: false };
  }
}

function fakeAccess(dir: string, extra: Partial<CommandsLaneAccess['deps']> = {}) {
  const host = new FakeHost({ roots: [dir] });
  const session: SessionState = newSession({ id: 's', provider: 'p', model: 'm', thinkingLevel: 'medium' });
  const agents = new AgentRegistry();
  const shown: string[] = [];
  const access: CommandsLaneAccess = {
    deps: {
      config: { get: (_k: string, d: unknown) => d, language: () => 'vi', engine: () => ({ instructionFiles: ['LOCAITH.md'] }) },
      logger: { log: () => undefined },
      agents,
      plugins: { agentDirs: () => [], commands: () => [] },
      mcp: { status: () => [{ name: 'mem', status: 'running', tools: [{}, {}], error: undefined }] },
      providers: { contextWindow: () => 100_000, summaries: async () => [{ id: 'p', label: 'Prov', hasKey: false }] },
      context: { extension: { packageJSON: { version: '9.9.9' } } },
      ...extra,
    } as unknown as CommandsLaneAccess['deps'],
    host,
    registry: new ToolRegistry(),
    session: () => session,
    refreshMenu: () => undefined,
    notice: () => undefined,
    onDispose: () => undefined,
    showScreen: async (s) => void shown.push(s),
  };
  return { access, host, session, agents, shown };
}

function ctxOf(args: string) {
  const out = { info: [] as string[], warn: [] as string[], prompts: [] as string[] };
  const ctx: SlashContext = { args, lang: 'vi', info: (t) => out.info.push(t), warn: (t) => out.warn.push(t), runPrompt: async (t) => void out.prompts.push(t), busy: false };
  return { ctx, out };
}

describe('lệnh dựng sẵn (đơn vị)', () => {
  it('/agents liệt kê theo nguồn; /agents new tạo mẫu trong .locaith/agents và nạp lại', async () => {
    const dir = makeWorkspace();
    workspace.workspaceFolders = [{ uri: { fsPath: dir, scheme: 'file' }, name: 'ws' }];
    const { access, agents } = fakeAccess(dir);
    const reg = new SlashRegistry();
    registerCommandsSlash(reg, { commandsLaneAccess: () => access });
    const a = ctxOf('');
    await reg.get('agents')!.run(a.ctx);
    expect(a.out.info[0]).toContain('**test-runner**');
    expect(a.out.info[0]).toContain('*dựng sẵn*');
    const n = ctxOf('new ui critic');
    await reg.get('agents')!.run(n.ctx);
    const file = path.join(dir, '.locaith', 'agents', 'ui-critic.md');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^---\nname: ui-critic\n/);
    expect(agents.get('ui-critic')?.source).toBe('workspace');
    const again = ctxOf('new ui critic');
    await reg.get('agents')!.run(again.ctx);
    expect(again.out.warn[0]).toContain('Đã có tệp');
    workspace.workspaceFolders = undefined;
  });

  it('/agents new bị từ chối khi workspace chưa tin cậy', async () => {
    const dir = makeWorkspace();
    workspace.workspaceFolders = [{ uri: { fsPath: dir, scheme: 'file' }, name: 'ws' }];
    workspace.isTrusted = false;
    const { access } = fakeAccess(dir);
    const reg = new SlashRegistry();
    registerCommandsSlash(reg, { commandsLaneAccess: () => access });
    const n = ctxOf('new x');
    await reg.get('agents')!.run(n.ctx);
    expect(n.out.warn[0]).toContain('chưa được tin cậy');
    expect(fs.existsSync(path.join(dir, '.locaith', 'agents', 'x.md'))).toBe(false);
    workspace.isTrusted = true;
    workspace.workspaceFolders = undefined;
  });

  it('/mcp liệt kê máy chủ và mở bảng MCP', async () => {
    const { access, shown } = fakeAccess(makeWorkspace());
    const reg = new SlashRegistry();
    registerCommandsSlash(reg, { commandsLaneAccess: () => access });
    const c = ctxOf('');
    await reg.get('mcp')!.run(c.ctx);
    expect(c.out.info[0]).toContain('✓ mem — running · 2');
    expect(shown).toEqual(['market']);
  });

  it('/doctor: mỗi mục ✓/⚠ kèm cách sửa; lệnh dò chạy ở thư mục cá nhân, không ở workspace', async () => {
    const dir = makeWorkspace();
    workspace.workspaceFolders = [{ uri: { fsPath: dir, scheme: 'file' }, name: 'ws' }];
    const { access, host } = fakeAccess(dir);
    const reg = new SlashRegistry();
    registerCommandsSlash(reg, { commandsLaneAccess: () => access });
    const c = ctxOf('');
    await reg.get('doctor')!.run(c.ctx);
    const txt = c.out.info[0];
    expect(txt).toContain('✓ **Git**: git version 2.50.0');
    expect(txt).toContain('⚠ **Node.js**');
    expect(txt).toContain('⚠ **Kết nối model**');
    expect(txt).toMatch(/Cách sửa: Nhập khoá API/);
    expect(host.ran).toEqual(['echo ok', 'git --version', 'node --version']);
    workspace.workspaceFolders = undefined;
  });

  it('đăng ký công cụ slash_command một lần', () => {
    const { access } = fakeAccess(makeWorkspace());
    registerCommandsSlash(new SlashRegistry(), { commandsLaneAccess: () => access });
    registerCommandsSlash(new SlashRegistry(), { commandsLaneAccess: () => access });
    expect(access.registry.all().filter((t) => t.name === 'slash_command')).toHaveLength(1);
  });

  it('formatStatus / formatDoctor (en)', () => {
    const s = formatStatus(
      {
        version: '1', account: null, provider: 'p', model: 'm', mode: 'plan', thinking: 'high', swarm: false, contextWindow: 200_000, lastContextTokens: 50_000,
        mcp: [], hooks: null, instructions: 'LOCAITH.md', memoryFiles: 2, outputStyle: 'concise', commands: { project: 1, user: 2, plugin: 0 }, agents: 6, skillsLoaded: [], trusted: false,
      },
      'en',
    );
    expect(s).toContain('Context window: 50k / 200k (25%)');
    expect(s).toContain('plan (workspace not trusted)');
    expect(formatDoctor([{ ok: true, label: 'A', detail: 'fine', fix: 'never shown' }], 'en')).not.toContain('never shown');
  });
});
