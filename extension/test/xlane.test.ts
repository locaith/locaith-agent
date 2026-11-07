/**
 * Rà soát CHÉO giữa các lane (xlane): lỗi nằm ở chỗ hai lane gặp nhau.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamRequest } from '../src/core/types';
import type { WebviewMessage, TItem } from '../src/shared/protocol';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const harnesses: ControllerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.dispose();
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const local = (h: ControllerHarness, m: WebviewMessage): Promise<void> => (h.ctl as unknown as { onMessage(m: WebviewMessage): Promise<void> }).onMessage(m);
const feature = (h: ControllerHarness) => (h.ctl as unknown as { checkpoints: { flush(): Promise<void> } }).checkpoints;
const userIds = (h: ControllerHarness): string[] => h.view().transcript.filter((i: TItem) => i.kind === 'user' && !i.steer).map((i) => i.id);

function routed(req: StreamRequest) {
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  if (last.role === 'user' && last.content.some((b) => b.type === 'tool_result')) return textTurn('xong, đã ghi tệp theo yêu cầu và mọi thứ đều ổn thỏa như mong đợi của người dùng.');
  const text = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (text.includes('ghi')) return toolTurn([{ id: `w${msgs.length}`, name: 'write_file', input: { path: `f${msgs.length}.txt`, content: 'x\n' } }]);
  return textTurn('xong');
}

describe('xlane: Quay lại hội thoại × số đo ngữ cảnh', () => {
  it('sau khi cắt hội thoại, lastContextTokens không còn là số của lịch sử dài đã bị cắt', async () => {
    const h = makeControllerHarness({ storage: true, files: { 'a.txt': 'a\n' }, script: Array.from({ length: 30 }, () => routed) });
    harnesses.push(h);
    await local(h, { type: 'set_mode', mode: 'acceptEdits' } as WebviewMessage);
    await h.send('ghi một');
    await h.idle();
    await h.send('ghi hai');
    await h.idle();
    await feature(h).flush();
    await sleep(160);
    h.session().lastContextTokens = 150_000; // số của lần gọi model gần nhất (lịch sử dài)
    const [, u2] = userIds(h);
    await local(h, { type: 'rewind_plan', promptId: u2, what: 'conversation' } as WebviewMessage);
    await local(h, { type: 'rewind_apply' } as WebviewMessage);
    expect(h.session().lastContextTokens).toBe(0);
  });
});

describe('xlane: kiểm tra độc lập × nén ngữ cảnh giữa lần chạy', () => {
  it('yêu cầu bổ sung (tin chen giữa) vẫn nằm trong gói sau khi lịch sử bị nén làm đổi chỉ số', async () => {
    const { createVerifierExtension } = await import('../src/core/engine/verifier');
    const { newTrace } = await import('../src/core/engine/seams');
    const { t } = await import('../src/core/engine/strings');
    const u = (text: string, extra: Record<string, unknown> = {}) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }], ts: 1, ...extra });
    const a = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }], ts: 1 });
    const old = Array.from({ length: 10 }, (_, i) => (i % 2 ? a(`cũ ${i}`) : u(`cũ ${i}`)));
    const input = [{ type: 'text' as const, text: 'YEU-CAU-GOC' }];
    const session = { id: 's1', mode: 'default', todos: [], thinkingLevel: 'off', messages: [...old, { role: 'user' as const, content: input, ts: 2 }] } as never as { messages: unknown[]; id: string };
    let bundle: { requests: string[] } | undefined;
    const ext = createVerifierExtension({
      settings: () => ({ mode: 'auto', maxRounds: 2 }),
      registry: () => undefined as never,
      run: (async () => { throw new Error('không chạy'); }) as never,
      onLastRun: (l) => { bundle = l.bundle as never; },
    });
    const scope = { session, input, trace: newTrace(), lang: 'vi', emit: () => undefined, assistantId: () => 'a1', host: {}, signal: new AbortController().signal } as never;
    const hooks = ext.begin(scope)!;
    // Giữa lần chạy: tin chen giữa của người dùng (đi cùng kết quả công cụ) rồi lịch sử bị nén (ngắn lại, chỉ số đổi).
    const steer = { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'x', name: 'read_file', content: 'ok' }, { type: 'text' as const, text: t('vi', 'steerHeader', { n: 1 }) }, { type: 'text' as const, text: 'YEU-CAU-CHEN-GIUA' }], ts: 3 };
    session.messages.push(a('đang làm'), steer, a('làm tiếp'));
    session.messages = [u('<tom_tat>', { synthetic: true }), a('Đã nắm'), ...session.messages.slice(-3)];
    await hooks.finalize!({ turn: { turn: 5, maxTurns: 30, turnsLeft: 25, wrapUp: false }, message: a('xong'), text: 'xong', stop: 'end_turn', pendingTodos: [], aborted: false } as never);
    expect(bundle!.requests).toContain('YEU-CAU-GOC');
    expect(bundle!.requests).toContain('YEU-CAU-CHEN-GIUA');
  });
});

describe('xlane: luật quyền × agent con', () => {
  it('luật deny cũng chặn công cụ do AGENT CON gọi (không vượt qua bằng công cụ `agent`)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { AgentRegistry } = await import('../src/core/agents/definitions');
    const { Semaphore } = await import('../src/core/agents/semaphore');
    const { coreRunExtensions } = await import('../src/core/engine/extensions');
    const { DEFAULT_ENGINE_SETTINGS } = await import('../src/core/engine/types');
    const { ModelPool } = await import('../src/core/orchestration/pool');
    const { builtinSkills } = await import('../src/core/skills/builtin');
    const { SkillRegistry } = await import('../src/core/skills/registry');
    const { FakeProvider } = await import('./helpers/fakeProvider');
    const { makeHarness } = await import('./helpers/harness');
    const { ConfigService } = await import('../src/host/config');
    const { PERM_KEYS } = await import('../src/host/permissionRulesService');
    const { hostSubAgentExtensions } = await import('../src/host/hostExtensions');
    const { settingsStub, workspace } = await import('./helpers/vscode-stub');
    settingsStub.reset();
    workspace.isTrusted = true;
    settingsStub.global[PERM_KEYS.deny] = ['write_file(secret.txt)'];
    const config = new ConfigService();

    const provider = new FakeProvider([
      () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Ghi', prompt: 'Ghi secret.txt', agent_type: 'general' } }]),
      () => toolTurn([{ name: 'write_file', input: { path: 'secret.txt', content: 'x' } }]),
      () => textTurn('Không ghi được tệp vì bị luật cấm; tôi báo lại cho lượt chính biết điều này.'),
      () => textTurn('Agent con không ghi được secret.txt do luật quyền; đã báo lại cho người dùng rõ ràng.'),
    ]);
    const agents = {
      pool: new ModelPool({ summaries: async () => [], get: () => provider }),
      agents: new AgentRegistry(),
      skills: new SkillRegistry(builtinSkills()),
      mode: () => 'off' as const,
      engineSettings: () => ({ ...DEFAULT_ENGINE_SETTINGS }),
      provider: () => provider,
      contextWindow: () => 128_000,
      log: () => {},
      limiter: new Semaphore(4),
      writeLock: new Semaphore(1),
      extensions: () => hostSubAgentExtensions({ deps: { config } } as never, { id: 'noop-hooks', begin: () => undefined }),
    };
    const h = makeHarness([], { provider, agents: agents as never, engineDeps: { extensions: coreRunExtensions() }, settings: { maxTurns: 40 } });
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'secret.txt'))).toBe(false);
  });
});

describe('xlane: luật quyền × agent kiểm tra độc lập', () => {
  it('reviewer mù cũng bị luật deny: read_file(secret.txt) bị chặn trong lần kiểm tra', async () => {
    const { AgentRegistry } = await import('../src/core/agents/definitions');
    const { Semaphore } = await import('../src/core/agents/semaphore');
    const { DEFAULT_ENGINE_SETTINGS } = await import('../src/core/engine/types');
    const { ModelPool } = await import('../src/core/orchestration/pool');
    const { builtinSkills } = await import('../src/core/skills/builtin');
    const { SkillRegistry } = await import('../src/core/skills/registry');
    const { createToolRegistry } = await import('../src/core/tools');
    const { FakeProvider } = await import('./helpers/fakeProvider');
    const { makeHarness } = await import('./helpers/harness');
    const { ConfigService } = await import('../src/host/config');
    const { PERM_KEYS } = await import('../src/host/permissionRulesService');
    const { verifierSubExtensions } = await import('../src/host/extensions/verifier');
    const { createVerifierExtension, runnerFromServices } = await import('../src/core/engine/verifier');
    const { settingsStub, workspace } = await import('./helpers/vscode-stub');
    settingsStub.reset();
    workspace.isTrusted = true;
    settingsStub.global[PERM_KEYS.deny] = ['read_file(secret.txt)'];
    const config = new ConfigService();
    const provider = new FakeProvider([
      () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'hello' } }]),
      () => textTurn('Đã ghi out.txt xong, nội dung đúng như yêu cầu của người dùng và không còn việc nào dở dang.'),
      () => toolTurn([{ name: 'read_file', input: { path: 'secret.txt' } }]), // reviewer thử đọc tệp bị cấm
      () => toolTurn([{ name: 'submit_verdict', input: { verdict: 'pass' } }]),
      () => textTurn('Đạt.'),
    ]);
    const svc = {
      pool: new ModelPool({ summaries: async () => [], get: () => provider }),
      agents: new AgentRegistry(),
      skills: new SkillRegistry(builtinSkills()),
      mode: () => 'off' as const,
      engineSettings: () => ({ ...DEFAULT_ENGINE_SETTINGS }),
      provider: () => provider,
      contextWindow: () => 128_000,
      log: () => {},
      limiter: new Semaphore(4),
      writeLock: new Semaphore(1),
      extensions: () => verifierSubExtensions({ deps: { config } } as never),
    };
    let registry: ReturnType<typeof createToolRegistry> | undefined;
    const ext = createVerifierExtension({ settings: () => ({ mode: 'auto', maxRounds: 1 }), registry: () => registry!, run: runnerFromServices(svc as never) });
    const h = makeHarness([], { provider, files: { 'secret.txt': 'BI-MAT' }, engineDeps: { extensions: [ext] } });
    registry = createToolRegistry({ skills: h.skills, host: h.host });
    await h.run('ghi out.txt');
    const seen = JSON.stringify(provider.requests.map((r) => r.messages));
    expect(seen).not.toContain('BI-MAT');
    expect(seen).toContain('read_file(secret.txt)');
  });
});

describe('xlane: Remote × lệnh gạch chéo đổi quyền', () => {
  it('isLocalOnlySlash: chặn /permissions allow|trust, /hooks trust|open, /agents new; cho phép dạng chỉ đọc', async () => {
    const { isLocalOnlySlash } = await import('../src/shared/slashMode');
    for (const t of ['/permissions allow run_command(*)', '  /PERMISSIONS trust', '/permissions remove x', '/hooks trust', '/hooks open user', '/agents new foo']) expect(isLocalOnlySlash(t), t).toBe(true);
    for (const t of ['/permissions', '/permissions test npm test', '/hooks', '/agents', '/context', 'permissions allow x', 'hello /hooks trust']) expect(isLocalOnlySlash(t), t).toBe(false);
  });

  it('ChatController.handleRemote từ chối tin send mang /permissions allow (không thêm luật từ xa)', async () => {
    const h = makeControllerHarness({ script: [() => textTurn('xong')] });
    harnesses.push(h);
    await expect(h.ctl.handleRemote({ type: 'send', text: '/permissions allow run_command(*)', attachments: [] } as WebviewMessage, 'điện thoại')).rejects.toThrow('slash_local_only');
  });
});
