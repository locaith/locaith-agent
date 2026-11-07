import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/core/agents/definitions';
import { DEFAULT_ENGINE_SETTINGS, newSession } from '../../src/core/engine/types';
import { isVerificationCommand, shouldVerify } from '../../src/core/engine/verifier';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { ModelPool } from '../../src/core/orchestration/pool';
import { SkillRegistry } from '../../src/core/skills/registry';
import { builtinSkills } from '../../src/core/skills/builtin';
import { createToolRegistry } from '../../src/core/tools';
import { registerVerifySlash, verifierExtension, type VerifySlashHost } from '../../src/host/extensions/verifier';
import { SlashRegistry, type SlashContext } from '../../src/host/slashRegistry';
import type { UiEvent } from '../../src/shared/protocol';
import { FakeProvider, textTurn, toolTurn, type Step } from '../helpers/fakeProvider';
import { eventsOf, makeWorkspace } from '../helpers/harness';

/**
 * Test ĐỐI KHÁNG cho lane blind-verifier (reviewer mù). Mỗi test dưới đây phải ĐỎ trên mã hiện tại
 * nếu khẳng định lỗi tương ứng là đúng.
 *
 * Chạy: npx vitest run test/adversarial/blind-verifier.allowlist-and-planmode.test.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. isVerificationCommand: "khoá bằng máy" nhưng vẫn lọt lệnh GHI / đổi trạng thái kho git
// ─────────────────────────────────────────────────────────────────────────────

describe('[adversarial] isVerificationCommand — lệnh ghi lọt qua danh sách cho phép', () => {
  it('git branch tạo/xoá/đổi upstream nhánh KHÔNG phải lệnh kiểm chứng', () => {
    for (const c of [
      'git branch feature-x', // tạo nhánh mới
      'git branch --delete feature-x', // xoá nhánh (chỉ -d/-D bị chặn, --delete thì không)
      'git branch --set-upstream-to=origin/main', // ghi config
      'git branch --unset-upstream',
      'git branch -c main copy-of-main', // sao chép nhánh
    ]) {
      expect(isVerificationCommand(c), c).toBe(false);
    }
  });

  it('trình định dạng/lint ở chế độ GHI qua cờ không nằm trong DENY_FLAG vẫn bị chặn', () => {
    for (const c of [
      'npx biome check --apply src', // biome: --apply = ghi sửa vào tệp nguồn
      'npx biome check --apply-unsafe src',
    ]) {
      expect(isVerificationCommand(c), c).toBe(false);
    }
  });

  it('cờ ghi kết quả ra TỆP TUỲ Ý (đường dẫn ../) phải bị chặn', () => {
    for (const c of [
      'npx vitest run --outputFile=../../out.json', // DENY_FLAG có outfile/output/output-file nhưng không có outputFile
      'npm test -- --outputFile=../../../x.json',
      'npx vitest run --coverage.reportsDirectory=../../cov',
    ]) {
      expect(isVerificationCommand(c), c).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. /verify trong chế độ lập kế hoạch: agent kiểm tra KHÔNG có submit_verdict → không bao giờ nộp được kết luận
// ─────────────────────────────────────────────────────────────────────────────

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

function slashRig(script: Step[], mode: 'default' | 'plan') {
  const provider = new FakeProvider(script);
  const dir = makeWorkspace({ 'a.txt': 'hello' });
  const host = new NodeToolHost({ roots: [dir], settings: {}, onPermission: async () => ({ decision: 'allow' }) });
  const deps = fakeDeps(provider) as any;
  const session = newSession({ id: 's1', provider: 'fake', model: 'fake-1' });
  session.mode = mode;
  const registry = createToolRegistry({ skills: deps.skills, host });
  const events: UiEvent[] = [];
  const infos: string[] = [];
  const slash = new SlashRegistry();
  const c: VerifySlashHost = {
    host: host as any,
    registry,
    deps,
    session: () => session,
    emit: (ev) => events.push(ev),
    runTurn: async (fn) => {
      await fn(new AbortController().signal);
    },
  };
  registerVerifySlash(slash, c);
  const ctx = (): SlashContext => ({ args: '', lang: 'vi', info: (t) => infos.push(`info:${t}`), warn: (t) => infos.push(`warn:${t}`), runPrompt: async () => {}, busy: false });
  const ext = verifierExtension({ deps, host: host as any, registry, session: () => session });
  return { provider, host, session, registry, events, infos, slash, ctx, ext };
}

async function recordLastRun(r: ReturnType<typeof slashRig>): Promise<void> {
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
  await hooks.finalize!({ turn: { turn: 1, maxTurns: 10, turnsLeft: 9, wrapUp: false }, message: { role: 'assistant', content: [] }, text: 'đã làm X', stop: 'end_turn', pendingTodos: [], aborted: false });
}

describe('[adversarial] /verify trong chế độ lập kế hoạch', () => {
  it('agent kiểm tra phải có submit_verdict và nộp được kết luận (hiện bị buildSubRegistry lọc mất trong plan mode)', async () => {
    const r = slashRig([() => toolTurn([{ name: 'submit_verdict', input: { verdict: 'pass' } }]), () => textTurn('.')], 'plan');
    await recordLastRun(r);
    await r.slash.get('verify')!.run(r.ctx());
    // Công cụ nộp kết luận phải có trong bộ công cụ gửi đi
    expect(r.provider.requests[0].tools.map((t) => t.name)).toContain('submit_verdict');
    const notices = eventsOf(r.events, 'notice').filter((n) => n.verify);
    // ...và kết quả phải là kết luận thật, không phải "agent kiểm tra không nộp kết luận"
    expect(notices.map((n) => n.verify!.state)).toEqual(['running', 'pass']);
  });

  it('(đối chứng) cùng kịch bản ở chế độ mặc định thì nộp được', async () => {
    const r = slashRig([() => toolTurn([{ name: 'submit_verdict', input: { verdict: 'pass' } }]), () => textTurn('.')], 'default');
    await recordLastRun(r);
    await r.slash.get('verify')!.run(r.ctx());
    expect(r.provider.requests[0].tools.map((t) => t.name)).toContain('submit_verdict');
    expect(eventsOf(r.events, 'notice').filter((n) => n.verify).map((n) => n.verify!.state)).toEqual(['running', 'pass']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. auto: lần chạy chỉ ghi tệp QUA AGENT CON (công cụ `agent`, risk 'meta') → không kích hoạt kiểm tra
// ─────────────────────────────────────────────────────────────────────────────

describe('[adversarial] shouldVerify — ghi tệp qua agent con', () => {
  it('lần chạy uỷ quyền toàn bộ việc sửa tệp cho sub-agent (`agent` ok, không run_command) vẫn phải được kiểm tra ở auto', () => {
    const trace = {
      turns: 2,
      execs: 0,
      calls: [{ callId: '1', name: 'agent', risk: 'meta' as const, input: { name: 'coder', prompt: 'sửa a.ts' }, turn: 1, ts: 0, ok: true, resultHead: '[agent «coder» · …] Đã sửa a.ts' }],
    };
    expect(
      shouldVerify({ mode: 'auto', trace, thinkingLevel: 'medium', sessionMode: 'default', stop: 'end_turn', aborted: false, wrapUp: false }),
    ).toBe(true);
  });
});
