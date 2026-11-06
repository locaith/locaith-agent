import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/core/agents/definitions';
import type { AgentServices } from '../src/core/agents/runner';
import { Semaphore } from '../src/core/agents/semaphore';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { AUTO_PROVIDER_ID, ModelPool } from '../src/core/orchestration/pool';
import { chooseTier } from '../src/core/orchestration/autoProvider';
import { builtinSkills } from '../src/core/skills/builtin';
import { SkillRegistry } from '../src/core/skills/registry';
import type { LLMProvider } from '../src/core/types';
import { THINKING_LEVELS } from '../src/shared/protocol';
import { makeBackup, parseBackup } from '../src/shared/sessionBackup';
import { newSession } from '../src/core/engine/types';
import { FakeProvider, textTurn } from './helpers/fakeProvider';
import { makeHarness } from './helpers/harness';

function services(provider: LLMProvider): Omit<AgentServices, 'registry'> {
  return {
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
  };
}

async function first(level: 'high' | 'max' | 'swarm') {
  const provider = new FakeProvider([() => textTurn('xong')]);
  const h = makeHarness([], { provider, agents: services(provider) });
  h.session.thinkingLevel = level;
  await h.run('xin chào');
  return provider.requests[0];
}

describe('chế độ Swarm', () => {
  it('là mức thứ sáu trong danh sách, sau "max"', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high', 'max', 'swarm']);
  });

  it('gửi cho nhà cung cấp mức suy luận "max" (adapter không phải biết Swarm)', async () => {
    expect((await first('swarm')).thinking.level).toBe('max');
    expect((await first('max')).thinking.level).toBe('max');
    expect((await first('high')).thinking.level).toBe('high');
  });

  it('workflow_run sẵn sàng ngay (không cần nạp kỹ năng multi-agent); mức khác thì vẫn ẩn', async () => {
    const names = (r: Awaited<ReturnType<typeof first>>) => r.tools.map((t) => t.name);
    expect(names(await first('swarm'))).toContain('workflow_run');
    expect(names(await first('swarm'))).toContain('agent');
    expect(names(await first('max'))).not.toContain('workflow_run');
  });

  it('chỉ dẫn hệ thống có khối swarm_mode (kèm giới hạn 1000/16 và cách làm), mức khác thì không', async () => {
    const sys = (await first('swarm')).system;
    expect(sys).toContain('<swarm_mode>');
    expect(sys).toContain('up to 1000 per run, 16 at a time');
    expect(sys).toContain('FALSIFY');
    expect(sys).toContain('Start small');
    expect((await first('max')).system).not.toContain('<swarm_mode>');
  });

  it('Auto xếp Swarm vào hạng "top" (qua mức max)', () => {
    expect(chooseTier({ tools: [], thinking: { level: 'max', summaries: false } })).toBe('top');
  });

  it('ngân sách mặc định của workflow: Swarm 300 agent / 16 luồng / 5M token; thường 60 / 8 / 2M — thẻ xin phép nêu rõ', async () => {
    const run = async (level: 'high' | 'swarm') => {
      const provider = new FakeProvider([
        () => ({ events: [] as never, ...textTurn('x') }) as never,
      ]);
      const wf = { name: 'workflow_run', input: { description: 'thử', script: 'return 1;' } };
      const turn = (n: number) => [{ type: 'tool_start', id: `w${n}`, name: wf.name }, { type: 'tool_args_delta', id: `w${n}`, name: wf.name, delta: JSON.stringify(wf.input) }, { type: 'tool_end', id: `w${n}`, name: wf.name }, { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', content: [{ type: 'tool_use', id: `w${n}`, name: wf.name, input: wf.input }] } }];
      const p2 = new FakeProvider([() => turn(1) as never, () => textTurn('xong')]);
      void provider;
      const h = makeHarness([], { provider: p2, agents: services(p2), decide: () => 'deny' });
      h.session.thinkingLevel = level;
      if (level === 'high') h.session.loadedSkills.push('multi-agent');
      await h.run('chạy workflow');
      return h.permissionRequests.find((r) => r.tool === 'workflow_run')?.title ?? '(không có thẻ)';
    };
    const swarm = await run('swarm');
    expect(swarm).toContain('tối đa 300 agent, 16 chạy cùng lúc');
    expect(swarm).toMatch(/ngân sách 5(,|\.)0k token|ngân sách 5000(,|\.)0k|ngân sách 5.000k/);
    const normal = await run('high');
    expect(normal).toContain('tối đa 60 agent, 8 chạy cùng lúc');
  });

  it('sao lưu → khôi phục giữ nguyên mức Swarm của phiên', () => {
    // Phiên rỗng (không có tin nào) bị coi là "không dùng được" khi khôi phục → cho phiên một tin.
    const s = newSession({ id: 's_sw', provider: 'p', model: 'm', title: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'xin chào' }], ts: 1 }] });
    s.thinkingLevel = 'swarm';
    const file = makeBackup([{ workspace: 'w', session: s, transcript: [] }], { version: '0.5.1', platform: 'vscode' } as never);
    const parsed = parseBackup(JSON.stringify(file), 'w');
    expect(parsed.ok, JSON.stringify(parsed).slice(0, 300)).toBe(true);
    if (parsed.ok) expect(parsed.sessions[0].session.thinkingLevel).toBe('swarm');
    void AUTO_PROVIDER_ID;
  });
});
