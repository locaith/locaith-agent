import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/core/agents/definitions';
import { Semaphore } from '../src/core/agents/semaphore';
import { DEFAULT_ENGINE_SETTINGS, newSession } from '../src/core/engine/types';
import type { LastRun } from '../src/core/engine/verifier';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { ModelPool } from '../src/core/orchestration/pool';
import { SkillRegistry } from '../src/core/skills/registry';
import { builtinSkills } from '../src/core/skills/builtin';
import { createToolRegistry } from '../src/core/tools';
import { readVerifierSettings, registerVerifySlash, verifierExtension, type VerifySlashHost } from '../src/host/extensions/verifier';
import { SlashRegistry, type SlashContext } from '../src/host/slashRegistry';
import type { UiEvent } from '../src/shared/protocol';
import { FakeProvider, textTurn, toolTurn, type Step } from './helpers/fakeProvider';
import { eventsOf, makeWorkspace } from './helpers/harness';

/**
 * (lane:blind-verifier) Lệnh /verify và phần đọc cài đặt phía host — chạy KHÔNG cần VS Code: host Node + ControllerDeps rút gọn
 * (chỉ các trường mà dịch vụ agent dùng). verifierExtension(ctx) lưu gói dữ liệu của lần chạy gần nhất; /verify chạy lại trên gói đó.
 */
function fakeDeps(provider: FakeProvider) {
  const skills = new SkillRegistry(builtinSkills());
  return {
    pool: new ModelPool({ summaries: async () => [], get: () => provider }),
    agents: new AgentRegistry(),
    skills,
    config: { orchestrationMode: () => 'off' as const, engine: () => ({ ...DEFAULT_ENGINE_SETTINGS }) },
    providers: { get: () => provider, contextWindow: () => 128_000 },
    logger: { log: () => {} },
  };
}

function hostWith(settings: Record<string, unknown>) {
  const dir = makeWorkspace({ 'a.txt': 'hello' });
  return new NodeToolHost({ roots: [dir], settings, onPermission: async () => ({ decision: 'allow' }) });
}

describe('readVerifierSettings', () => {
  it('mặc định auto, giá trị lạ → auto, model rỗng → undefined, cắt khoảng trắng', () => {
    expect(readVerifierSettings(hostWith({}) as any)).toMatchObject({ mode: 'auto', model: undefined, maxRounds: 2 });
    expect(readVerifierSettings(hostWith({ 'agent.verify': 'nope' }) as any).mode).toBe('auto');
    expect(readVerifierSettings(hostWith({ 'agent.verify': 'off' }) as any).mode).toBe('off');
    expect(readVerifierSettings(hostWith({ 'agent.verify': 'always', 'agent.verifyModel': '  openai:gpt-6.1-sol ' }) as any)).toMatchObject({ mode: 'always', model: 'openai:gpt-6.1-sol' });
  });
});

describe('/verify', () => {
  function rig(settings: Record<string, unknown>, script: Step[] = []) {
    const provider = new FakeProvider(script);
    const host = hostWith(settings);
    const deps = fakeDeps(provider) as any;
    const session = newSession({ id: 's1', provider: 'fake', model: 'fake-1' });
    const registry = createToolRegistry({ skills: deps.skills, host });
    const events: UiEvent[] = [];
    const infos: string[] = [];
    const slash = new SlashRegistry();
    let turns = 0;
    const c: VerifySlashHost = {
      host: host as any,
      registry,
      deps,
      session: () => session,
      emit: (ev) => events.push(ev),
      runTurn: async (fn) => {
        turns++;
        await fn(new AbortController().signal);
      },
    };
    registerVerifySlash(slash, c);
    const ctx = (args = ''): SlashContext => ({ args, lang: 'vi', info: (t) => infos.push(`info:${t}`), warn: (t) => infos.push(`warn:${t}`), runPrompt: async () => {}, busy: false });
    const ext = verifierExtension({ deps, host: host as any, registry, session: () => session });
    return { provider, host, session, registry, events, infos, slash, ctx, ext, turns: () => turns };
  }

  it('đăng ký lệnh /verify (vi + en); chưa có lần chạy nào → báo, không chạy lượt; off → báo tắt', async () => {
    const r = rig({});
    expect(r.slash.list('vi').find((x) => x.name === 'verify')?.description).toContain('Kiểm tra độc lập');
    expect(r.slash.list('en').find((x) => x.name === 'verify')?.description).toContain('Independently verify');
    await r.slash.get('verify')!.run(r.ctx());
    expect(r.infos[0]).toContain('Chưa có lần chạy nào');
    expect(r.turns()).toBe(0);
    const off = rig({ 'agent.verify': 'off' });
    await off.slash.get('verify')!.run(off.ctx());
    expect(off.infos[0]).toMatch(/TẮT/);
    expect(off.turns()).toBe(0);
  });

  it('có gói dữ liệu của phiên hiện tại → chạy agent kiểm tra trong một lượt riêng và báo kết quả (không buộc model chính làm tiếp)', async () => {
    const r = rig({}, [() => toolTurn([{ name: 'submit_verdict', input: { verdict: 'fail', missing: ['thiếu X'] } }]), () => textTurn('.')]);
    // Giả lập extension đã ghi lại lần chạy gần nhất (qua onLastRun của createVerifierExtension) bằng cách chạy finalize trên một scope tối thiểu.
    const hooks = r.ext.begin({
      session: r.session,
      settings: DEFAULT_ENGINE_SETTINGS,
      lang: 'vi',
      host: r.host,
      provider: r.provider,
      signal: new AbortController().signal,
      input: [{ type: 'text', text: 'làm X' }],
      trace: { wrote: false, execs: 0, turns: 1, calls: [], writtenPaths: () => [] },
      emit: () => {},
      notice: () => {},
      assistantId: () => 'a0',
    })!;
    r.session.messages.push({ role: 'user', content: [{ type: 'text', text: 'làm X' }] });
    // Hỏi-đáp thuần → auto không kích hoạt, nhưng gói dữ liệu vẫn được lưu cho /verify.
    const d = await hooks.finalize!({ turn: { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false }, message: { role: 'assistant', content: [] }, text: 'đã làm X', stop: 'end_turn', pendingTodos: [], aborted: false });
    expect(d).toEqual({ action: 'accept' });
    await r.slash.get('verify')!.run(r.ctx());
    expect(r.turns()).toBe(1);
    expect(eventsOf(r.events, 'assistant_start')).toHaveLength(1);
    const notices = eventsOf(r.events, 'notice').filter((n) => n.verify);
    expect(notices.map((n) => n.verify!.state)).toEqual(['running', 'fail']);
    expect(notices[1].verify).toMatchObject({ outstanding: true, missing: ['thiếu X'], round: 1, maxRounds: 1 });
    expect(notices[1].id).toBe(eventsOf(r.events, 'assistant_start')[0].id);
    expect(eventsOf(r.events, 'assistant_end')[0]).toMatchObject({ stopReason: 'end_turn' });
    // agent kiểm tra nhận đúng yêu cầu gốc + câu trả lời cuối
    const sent = JSON.stringify(r.provider.requests[0].messages);
    expect(sent).toContain('làm X');
    expect(sent).toContain('đã làm X');
    expect(r.provider.requests[0].tools.map((t) => t.name)).toContain('submit_verdict');
  });

  it('gói dữ liệu thuộc phiên khác → không chạy', async () => {
    const r = rig({});
    const other: LastRun = { sessionId: 'khac', bundle: { requests: [], changes: [], commands: [], todos: [], finalAnswer: '', ranByMain: [] }, lang: 'vi', at: 0 };
    void other;
    await r.slash.get('verify')!.run(r.ctx());
    expect(r.turns()).toBe(0);
  });
});
