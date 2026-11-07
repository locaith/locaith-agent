import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/core/agents/definitions';
import type { AgentServices } from '../src/core/agents/runner';
import { Semaphore } from '../src/core/agents/semaphore';
import { coreRunExtensions } from '../src/core/engine/extensions';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { hooksRunExtension } from '../src/core/hooks/runExtension';
import type { HookService } from '../src/core/hooks/service';
import type { HooksConfig } from '../src/core/hooks/types';
import { ModelPool } from '../src/core/orchestration/pool';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import type { ToolResultBlock } from '../src/core/types';
import { FakeProvider, textTurn, toolTurn, type Step } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';
import { exits, makeKit, printsJson, recordStdin, TEST_SHELL, tmpRoot } from './helpers/hookKit';

function setup(steps: Step[], hooks: HooksConfig, withSubExt = true) {
  const provider = new FakeProvider(steps);
  let svc!: HookService;
  const agents: Omit<AgentServices, 'registry'> = {
    pool: new ModelPool({ summaries: async () => [], get: () => provider }),
    agents: new AgentRegistry(),
    skills: new SkillRegistry(builtinSkills()),
    mode: () => 'off',
    engineSettings: () => ({ ...DEFAULT_ENGINE_SETTINGS }),
    provider: () => provider,
    contextWindow: () => 128_000,
    log: () => {},
    limiter: new Semaphore(4),
    writeLock: new Semaphore(1),
    extensions: withSubExt ? () => [hooksRunExtension(() => svc, { subAgent: true })] : undefined,
  };
  const h = makeHarness([], {
    provider,
    agents,
    hostSettings: { 'terminal.shell': TEST_SHELL },
    engineDeps: { extensions: [...coreRunExtensions(), hooksRunExtension(() => svc)] },
    settings: { maxTurns: 40 },
  });
  const kit = makeKit({ root: h.dir, userHooks: hooks });
  svc = kit.service;
  return { h, kit };
}

const results = (h: ReturnType<typeof setup>['h'], i: number): string[] =>
  h.provider.requests[i].messages
    .flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'))
    .map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)));

describe('hooks — agent con', () => {
  const steps = (): Step[] => [
    () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Ghi', prompt: 'Ghi out.txt', agent_type: 'general' } }]),
    () => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]),
    () => textTurn('Không ghi được.'),
    () => textTurn('Xong.'),
  ];

  it('PreToolUse chặn công cụ do AGENT CON gọi (không vượt qua bằng công cụ `agent`)', async () => {
    const { h } = setup(steps(), { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: exits(2, 'cấm ghi') }] }] });
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(false);
    const sub = results(h, 2).join('\n'); // yêu cầu model thứ 3 = lượt kế của agent con, sau khi write_file bị chặn
    expect(sub).toContain('cấm ghi');
    expect(sub).toContain('PreToolUse');
  });

  it('đối chứng: không đăng ký extension cho agent con thì công cụ chạy (test thật sự đỏ khi sửa hỏng)', async () => {
    const { h } = setup(steps(), { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: exits(2, 'cấm ghi') }] }] }, false);
    await h.run('ghi file');
    expect(fs.existsSync(path.join(h.dir, 'out.txt'))).toBe(true);
  });

  it('agent con kết thúc KHÔNG làm mất liên kết hiển thị của luồng chính: hook sau đó vẫn hiện dòng pill', async () => {
    const log = path.join(tmpRoot(), 'seen.log');
    const { h } = setup(
      [
        () => toolTurn([{ id: 'ag1', name: 'agent', input: { description: 'Đọc', prompt: 'Đọc', agent_type: 'explore' } }]),
        () => textTurn('Đã đọc.'),
        () => toolTurn([{ name: 'write_file', input: { path: 'main.txt', content: 'y' } }]),
        () => textTurn('Xong.'),
      ],
      { PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', name: 'ghi-nhat-ky', command: recordStdin(log) }] }] },
    );
    await h.run('làm việc');
    expect(fs.existsSync(path.join(h.dir, 'main.txt'))).toBe(true);
    expect(eventsOf(h.events, 'pill').some((p) => p.text.includes('ghi-nhat-ky'))).toBe(true);
  });
});

describe('hooks — continue:false', () => {
  it('SessionStart trả {continue:false} cũng dừng tin nhắn (không tới model)', async () => {
    const kit = makeKit({ root: tmpRoot(), userHooks: { SessionStart: [{ hooks: [{ type: 'command', command: printsJson({ continue: false, stopReason: 'phiên bị khoá' }) }] }] } });
    const r = await kit.service.beforeSend('xin chào', new AbortController().signal);
    expect(r).toMatchObject({ blocked: true, reason: 'phiên bị khoá' });
  });

  it('UserPromptSubmit trả {} thì KHÔNG chặn', async () => {
    const kit = makeKit({ root: tmpRoot(), userHooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: printsJson({}) }] }] } });
    expect((await kit.service.beforeSend('xin chào', new AbortController().signal)).blocked).toBe(false);
  });
});
