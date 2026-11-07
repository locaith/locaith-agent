import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../src/core/types';
import { coreRunExtensions } from '../src/core/engine/extensions';
import { permissionRulesExtension, resolvePathPlain, type RuleSnapshot } from '../src/core/engine/extensions/permissionRules';
import { decidePermission } from '../src/core/engine/permissions';
import { resolveUserPathReal } from '../src/core/fsutil/paths';
import { buildRules, type RuleAction } from '../src/shared/permissionRules';
import type { ToolDef } from '../src/core/engine/types';
import { eventsOf, makeHarness, type HarnessOptions } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

const snapshot = (spec: Partial<Record<RuleAction, string[]>>, extra: Partial<RuleSnapshot> = {}): RuleSnapshot => ({
  rules: buildRules((['deny', 'ask', 'allow'] as const).filter((a) => spec[a]).map((a) => ({ action: a, source: 'user', items: spec[a]! }))),
  ...extra,
});

function withRules(spec: Partial<Record<RuleAction, string[]>>, extra: Partial<RuleSnapshot> = {}) {
  let snap = snapshot(spec, extra);
  const ext = permissionRulesExtension({
    source: () => snap,
    resolvePath: async (host, raw) => {
      const r = await resolveUserPathReal(host, raw);
      return { rel: r.rel, abs: r.abs, inWorkspace: r.zone === 'workspace' };
    },
  });
  return { ext, set: (s: Partial<Record<RuleAction, string[]>>) => (snap = snapshot(s, extra)) };
}

const results = (h: ReturnType<typeof makeHarness>, i: number): ToolResultBlock[] =>
  h.provider.requests[i].messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));

function harness(script: Parameters<typeof makeHarness>[0], ext: ReturnType<typeof withRules>['ext'], opts: HarnessOptions = {}) {
  return makeHarness(script, { ...opts, engineDeps: { extensions: [...coreRunExtensions(), ext], ...opts.engineDeps } });
}

/** Thay `run_command` thật bằng bản không spawn tiến trình (cùng tên, cùng kiểu xin phép) — test luật không phụ thuộc shell của máy. */
function fakeRunCommand(h: ReturnType<typeof makeHarness>, ran: string[]): void {
  const registry = h.engine['d'].registry;
  registry.unregister('run_command');
  registry.register({
    name: 'run_command',
    description: 'fake',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    risk: 'exec',
    concurrencySafe: false,
    async permission(input: { command: string }) {
      return { kind: 'command', title: 'Chạy lệnh này?', command: input.command, sessionKey: `cmd:${input.command}` };
    },
    async execute(input: { command: string }) {
      ran.push(input.command);
      return { content: `ran: ${input.command}` };
    },
  });
}

describe('luật quyền trong vòng lặp engine (dispatcher → decidePermission)', () => {
  it('deny chặn tuyệt đối — kể cả ở chế độ bypass; công cụ không chạy, model nhận lý do kèm luật', async () => {
    const { ext } = withRules({ deny: ['run_command(rm -rf*)'] });
    const h = harness([() => toolTurn([{ name: 'run_command', input: { command: 'rm -rf dist' } }]), () => textTurn('ok')], ext, { decide: () => 'allow' });
    h.session.mode = 'bypass';
    await h.run('xoá dist');
    const r = results(h, 1)[0];
    expect(r.isError).toBe(true);
    expect(r.content).toContain('run_command(rm -rf*)');
    expect(h.permissionRequests).toHaveLength(0);
    expect(eventsOf(h.events, 'tool_end')[0].state).toBe('denied');
  });

  it('deny bắt phần nguy hiểm trong lệnh ghép', async () => {
    const { ext } = withRules({ deny: ['run_command(rm -rf*)'], allow: ['run_command(npm test:*)'] });
    const h = harness([() => toolTurn([{ name: 'run_command', input: { command: 'npm test && rm -rf /' } }]), () => textTurn('ok')], ext);
    await h.run('chạy');
    expect(eventsOf(h.events, 'tool_end')[0].state).toBe('denied');
    expect(h.permissionRequests).toHaveLength(0);
  });

  it('allow bỏ câu hỏi (chế độ default) và dòng công cụ mang tên luật', async () => {
    const { ext } = withRules({ allow: ['run_command(npm test:*)'] });
    const ran: string[] = [];
    const h = harness([() => toolTurn([{ name: 'run_command', input: { command: 'npm test -- --ci' } }]), () => textTurn('ok')], ext, {
      decide: () => 'deny', // nếu bị hỏi thì sẽ bị từ chối → test đỏ
    });
    fakeRunCommand(h, ran);
    await h.run('test');
    expect(h.permissionRequests).toHaveLength(0);
    const starts = eventsOf(h.events, 'tool_start');
    expect(starts.some((e) => e.rule === 'run_command(npm test:*)')).toBe(true);
    const r = results(h, 1)[0];
    expect(r.isError).toBe(false);
    expect(ran).toEqual(['npm test -- --ci']);
  });

  it('allow KHÔNG áp dụng cho lệnh ghép không khớp trọn: vẫn hỏi', async () => {
    const { ext } = withRules({ allow: ['run_command(node -e:*)'] });
    const h = harness([() => toolTurn([{ name: 'run_command', input: { command: 'node -e "1" && node -v' } }]), () => textTurn('ok')], ext, { decide: () => 'deny' });
    await h.run('chạy');
    expect(h.permissionRequests).toHaveLength(1);
    expect(eventsOf(h.events, 'tool_end')[0].state).toBe('denied');
  });

  it('allow theo đường dẫn: edit_file(src/**) tự chạy, tệp ngoài mẫu vẫn hỏi; luật không vượt được yêu cầu nâng cao (.env)', async () => {
    const { ext } = withRules({ allow: ['write_file(src/**)', 'write_file(**)'] });
    const asked: string[] = [];
    const h = harness(
      [
        () => toolTurn([{ name: 'write_file', input: { path: 'src/a.ts', content: 'A' } }]),
        () => toolTurn([{ name: 'write_file', input: { path: '.env', content: 'SECRET=1' } }]),
        () => textTurn('ok'),
      ],
      ext,
      {
        decide: (req) => {
          asked.push(req.title);
          return 'deny';
        },
      },
    );
    await h.run('ghi');
    expect(readFileSync(h.dir + '/src/a.ts', 'utf8')).toBe('A');
    expect(existsSync(h.dir + '/.env')).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('.env');
  });

  it('allow theo đường dẫn không khớp qua đường tắt ..', async () => {
    const { ext } = withRules({ allow: ['write_file(src/**)'] });
    const h = harness([() => toolTurn([{ name: 'write_file', input: { path: 'src/../top.txt', content: 'x' } }]), () => textTurn('ok')], ext, { decide: () => 'deny' });
    await h.run('ghi');
    expect(h.permissionRequests).toHaveLength(1);
    expect(existsSync(h.dir + '/top.txt')).toBe(false);
  });

  it('ask buộc hỏi kể cả ở acceptEdits; thẻ quyền ghi luật đã quyết định', async () => {
    const { ext } = withRules({ ask: ['write_file(docs/**)'] });
    const h = harness([() => toolTurn([{ name: 'write_file', input: { path: 'docs/x.md', content: 'x' } }]), () => textTurn('ok')], ext, { decide: () => 'allow' });
    h.session.mode = 'acceptEdits';
    await h.run('ghi');
    expect(h.permissionRequests).toHaveLength(1);
    expect(h.permissionRequests[0].rule).toBe('write_file(docs/**)');
    expect(readFileSync(h.dir + '/docs/x.md', 'utf8')).toBe('x');
  });

  it('thẻ quyền mang đề xuất «Luôn cho phép»; lệnh nguy hiểm thì không', async () => {
    const { ext } = withRules({});
    const h = harness(
      [
        () => toolTurn([{ name: 'run_command', input: { command: 'npm run lint -- --fix' } }]),
        () => toolTurn([{ name: 'run_command', input: { command: 'rm -rf dist' } }]),
        () => toolTurn([{ name: 'write_file', input: { path: 'src/util/x.ts', content: 'x' } }]),
        () => textTurn('ok'),
      ],
      ext,
      { decide: () => 'deny' },
    );
    await h.run('chạy');
    expect(h.permissionRequests).toHaveLength(3);
    expect(h.permissionRequests[0].suggest).toEqual(['run_command(npm run lint:*)']);
    expect(h.permissionRequests[1].suggest).toBeUndefined();
    expect(h.permissionRequests[2].suggest).toEqual(['write_file(src/util/**)']);
  });

  it('luật thêm GIỮA lượt chạy có hiệu lực ở lệnh kế tiếp (nguồn được đọc lại mỗi lần)', async () => {
    const { ext, set } = withRules({});
    let n = 0;
    const ran: string[] = [];
    const h = harness(
      [() => toolTurn([{ name: 'run_command', input: { command: 'npm run lint' } }]), () => toolTurn([{ name: 'run_command', input: { command: 'npm run lint -- --fix' } }]), () => textTurn('ok')],
      ext,
      {
        decide: () => {
          n++;
          set({ allow: ['run_command(npm run lint:*)'] });
          return 'allow';
        },
      },
    );
    fakeRunCommand(h, ran);
    await h.run('chạy');
    expect(n).toBe(1); // lệnh thứ hai được luật mới cho qua
    expect(ran).toHaveLength(2);
  });

  it('tool gọi MCP trần: luật theo tên công cụ (kể cả *)', async () => {
    const def: ToolDef = {
      name: 'mcp__srv__danger',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      risk: 'write',
      concurrencySafe: false,
      async permission() {
        return { kind: 'other', title: 'Chạy mcp?' };
      },
      async execute() {
        return { content: 'ran' };
      },
    };
    const { ext } = withRules({ deny: ['mcp__srv__*'] });
    const h = harness([() => toolTurn([{ name: 'mcp__srv__danger', input: {} }]), () => textTurn('ok')], ext);
    h.engine['d'].registry.register(def);
    await h.run('mcp');
    expect(eventsOf(h.events, 'tool_end')[0].state).toBe('denied');
  });

  it('nhắc một lần mỗi phiên khi workspace có luật allow chưa xác nhận / workspace chưa tin cậy', async () => {
    const { ext } = withRules({}, { workspaceAllowPending: 2 });
    const h = harness([() => textTurn('a'), () => textTurn('b')], ext);
    await h.run('1');
    await h.run('2');
    const notices = eventsOf(h.events, 'notice').filter((e) => e.text.includes('/permissions'));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('2 luật');
    const { ext: ext2 } = withRules({}, { untrusted: true });
    const h2 = harness([() => textTurn('a')], ext2);
    await h2.run('1');
    expect(eventsOf(h2.events, 'notice').some((e) => e.level === 'warn' && e.text.includes('chưa được tin cậy'))).toBe(true);
  });
});

describe('decidePermission với luật (đơn vị)', () => {
  const ctx = { session: { approvals: [] as string[] } } as unknown as Parameters<typeof decidePermission>[2];
  const def = (need: unknown): ToolDef =>
    ({ name: 'x', description: '', inputSchema: {}, risk: 'exec', concurrencySafe: false, permission: async () => need, execute: async () => ({ content: '' }) }) as ToolDef;
  const hit = (action: 'allow' | 'ask' | 'deny') => ({ action, rule: `x(${action})`, source: 'user' as const });

  it('deny thắng mọi chế độ, kể cả khi công cụ không cần xin phép', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypass'] as const) {
      const v = await decidePermission(def(null), {}, ctx, mode, hit('deny'));
      expect(v).toMatchObject({ action: 'deny', reason: 'rule' });
    }
  });
  it('allow bỏ hỏi với yêu cầu thường; yêu cầu nâng cao vẫn hỏi; plan vẫn chặn công cụ ghi', async () => {
    expect((await decidePermission(def({ kind: 'command', title: 't' }), {}, ctx, 'default', hit('allow'))).action).toBe('allow');
    expect((await decidePermission(def({ kind: 'command', title: 't', elevated: true }), {}, ctx, 'default', hit('allow'))).action).toBe('ask');
    expect((await decidePermission(def({ kind: 'command', title: 't' }), {}, ctx, 'plan', hit('allow'))).action).toBe('deny');
  });
  it('ask buộc hỏi ở acceptEdits và bypass; không áp cho thẻ kế hoạch', async () => {
    expect((await decidePermission(def({ kind: 'edit', title: 't' }), {}, ctx, 'acceptEdits', hit('ask'))).action).toBe('ask');
    expect((await decidePermission(def({ kind: 'command', title: 't' }), {}, ctx, 'bypass', hit('ask'))).action).toBe('ask');
    expect((await decidePermission(def({ kind: 'plan', title: 't' }), {}, ctx, 'bypass', hit('ask'))).action).toBe('allow');
  });
  it('không có luật → hành vi cũ giữ nguyên', async () => {
    expect((await decidePermission(def({ kind: 'edit', title: 't' }), {}, ctx, 'acceptEdits')).action).toBe('allow');
    expect((await decidePermission(def({ kind: 'command', title: 't' }), {}, ctx, 'acceptEdits')).action).toBe('ask');
    expect((await decidePermission(def({ kind: 'command', title: 't' }), {}, ctx, 'bypass')).action).toBe('allow');
  });
  it('resolvePathPlain: tương đối sạch = trong workspace; .. hoặc tuyệt đối = ngoài', () => {
    expect(resolvePathPlain('src/a.ts')).toEqual({ rel: 'src/a.ts', abs: 'src/a.ts', inWorkspace: true });
    expect(resolvePathPlain('./src\\a.ts').rel).toBe('src/a.ts');
    expect(resolvePathPlain('../x').inWorkspace).toBe(false);
    expect(resolvePathPlain('C:\\x').inWorkspace).toBe(false);
    expect(resolvePathPlain('/etc/passwd').inWorkspace).toBe(false);
  });
});
