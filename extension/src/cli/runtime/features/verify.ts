/**
 * Mô-đun 7 — kiểm chứng độc lập (reviewer mù). Logic ở `core/engine/verifier.ts`; ở đây:
 *   • RunExtension đăng ký CUỐI (`last:true`) đọc cài đặt `agent.verify` (`off|auto|always`, mặc định auto) và `agent.verifyModel`;
 *   • agent kiểm tra là một agent con chạy bằng `runnerFromServices`: dịch vụ agent lấy từ lõi (`agentServices()` / `mainRegistry()` nếu có),
 *     thiếu thì dựng tạm từ `RunScope` của chính lần chạy (nhà cung cấp + cài đặt của phiên, kho công cụ chỉ-đọc của host);
 *   • luật quyền (deny/ask) của người dùng cũng áp cho agent kiểm tra;
 *   • `/verify` kiểm tra lần chạy gần nhất của phiên hiện tại (bỏ điều kiện tự động, tôn trọng `off`).
 */

import { Semaphore } from '../../../core/agents/semaphore';
import type { AgentServices } from '../../../core/agents/runner';
import type { RunExtension, RunScope } from '../../../core/engine/seams';
import { t as engineT } from '../../../core/engine/strings';
import { ToolRegistry } from '../../../core/engine/toolRegistry';
import {
  VERIFY_MAX_ROUNDS,
  createVerifierExtension,
  normalizeMode,
  runVerification,
  runnerFromServices,
  verifyNotice,
  type LastRun,
  type VerifierRunner,
  type VerifierSettings,
} from '../../../core/engine/verifier';
import { ModelPool } from '../../../core/orchestration/pool';
import { createToolRegistry } from '../../../core/tools';
import type { UiEvent } from '../../../shared/protocol';
import { newId } from '../../../shared/transcript';
import type { FeatureContext, FeatureModule } from '../contract';
import { asExt, isSubAgentScope } from './ext';
import { makeRulesExtension } from './permissions';

export function readVerifierSettings(ctx: FeatureContext): VerifierSettings {
  const model = String(ctx.settings.get<string>('agent.verifyModel', '') ?? '').trim();
  return { mode: normalizeMode(ctx.settings.get<string>('agent.verify', 'auto')), model: model || undefined, maxRounds: VERIFY_MAX_ROUNDS };
}

interface VerifyState {
  last: LastRun | null;
  busy: boolean;
  /** Ngữ cảnh chạy gần nhất (nhà cung cấp, cài đặt) — dùng khi lõi chưa cấp `agentServices()`. */
  lastScope: Pick<RunScope, 'provider' | 'settings'> | null;
}

/** Dịch vụ agent: ưu tiên của lõi; thiếu thì dựng tạm từ phiên + nhà cung cấp của lần chạy. */
function servicesFor(ctx: FeatureContext, st: VerifyState, limiter: Semaphore, writeLock: Semaphore): Omit<AgentServices, 'registry'> | null {
  const fromCore = asExt(ctx).agentServices?.();
  if (fromCore) return fromCore;
  const sc = st.lastScope;
  if (!sc) return null;
  const s = ctx.session();
  const window = sc.settings.contextWindow || 128_000;
  const provider = sc.provider;
  return {
    pool: new ModelPool({
      summaries: async () => [{ id: s.provider, label: s.provider, hasKey: true, models: [{ id: s.model, label: s.model, contextWindow: window }] }],
      get: () => provider,
    }),
    agents: ctx.agents,
    skills: ctx.skills,
    mode: () => 'off',
    engineSettings: () => sc.settings,
    provider: () => provider,
    contextWindow: () => window,
    log: (level, msg) => ctx.log(level, msg),
    limiter,
    writeLock,
    extensions: () => [makeRulesExtension(ctx)],
  };
}

const states = new WeakMap<FeatureContext, VerifyState>();
export const verifyStateOf = (ctx: FeatureContext): VerifyState | undefined => states.get(ctx);

export const verifyFeature: FeatureModule = {
  name: 'verify',
  attach(ctx) {
    const st: VerifyState = { last: null, busy: false, lastScope: null };
    states.set(ctx, st);
    const limiter = new Semaphore(1);
    const writeLock = new Semaphore(1);
    let fallbackRegistry: ToolRegistry | null = null;

    const registry = (): ToolRegistry => {
      const main = asExt(ctx).mainRegistry?.();
      if (main) return main;
      return (fallbackRegistry ??= createToolRegistry({ skills: ctx.skills, host: ctx.host }));
    };
    const run: VerifierRunner = async (req) => {
      const svc = servicesFor(ctx, st, limiter, writeLock);
      if (!svc) return { stopReason: 'error', error: 'no model available', inputTokens: 0, outputTokens: 0, model: '' };
      return runnerFromServices(svc)(req);
    };

    const inner = createVerifierExtension({
      settings: () => readVerifierSettings(ctx),
      registry,
      run,
      onLastRun: (last) => {
        st.last = last;
      },
      busy: () => st.busy,
    });
    // Bọc để ghi nhớ nhà cung cấp/cài đặt của lần chạy, rồi giao cho extension lõi.
    const ext: RunExtension = {
      id: inner.id,
      begin(scope) {
        if (!isSubAgentScope(ctx, scope)) st.lastScope = { provider: scope.provider, settings: scope.settings };
        return inner.begin(scope);
      },
    };
    ctx.addRunExtension(ext, { last: true });

    ctx.slash({
      name: 'verify',
      description: { vi: 'Kiểm tra độc lập lần chạy gần nhất (reviewer mù)', en: 'Independently verify the last run (blind reviewer)' },
      needsIdle: true,
      async run(c) {
        const lang = c.lang;
        const settings = readVerifierSettings(ctx);
        if (settings.mode === 'off') {
          return c.output(lang === 'vi' ? 'Kiểm tra độc lập đang TẮT (cài đặt `agent.verify`). Đặt `auto` hoặc `always` để dùng /verify.' : 'Independent verification is OFF (setting `agent.verify`). Set it to `auto` or `always` to use /verify.', 'plain');
        }
        const last = st.last;
        if (!last || last.sessionId !== ctx.session().id) return c.output(engineT(lang, 'verifyNothing'), 'plain');
        if (last.stopReason && last.stopReason !== 'end_turn') c.output(engineT(lang, 'verifyStaleRun', { reason: last.stopReason }), 'plain');
        if (st.busy) return c.output(engineT(lang, 'verifySkipped', { reason: engineT(lang, 'verifyReasonBusy') }), 'plain');
        if (!asExt(ctx).agentServices && !st.lastScope) return c.output(engineT(lang, 'verifySkipped', { reason: 'no model' }), 'error');

        const key = `vm${Date.now().toString(36)}`;
        const session = ctx.session();
        const id = newId('a');
        const ac = new AbortController();
        const sig = (c as unknown as { signal?: AbortSignal }).signal;
        sig?.addEventListener('abort', () => ac.abort(), { once: true });
        const emit = (ev: UiEvent) => ctx.emit({ t: 'ui', ev });
        st.busy = true;
        emit({ t: 'assistant_start', id, provider: session.provider, model: session.model, ts: Date.now() });
        let stop = 'end_turn';
        try {
          emit(verifyNotice({ id, key, round: 1, maxRounds: 1, outcome: 'running', lang }));
          const outcome = await runVerification({
            bundle: last.bundle,
            registry: registry(),
            host: ctx.host,
            session,
            signal: ac.signal,
            emit,
            assistantId: id,
            callId: `verify:${key}`,
            lang,
            model: settings.model,
            run,
          });
          if (outcome.tokens > 0) session.usageTotals.input += outcome.tokens;
          if (outcome.kind === 'skipped' && outcome.reason === 'aborted') stop = 'aborted';
          // Chạy tay chỉ có MỘT vòng và không buộc model chính làm tiếp: kết quả là báo cáo cho người dùng.
          const outstanding = outcome.kind === 'verdict' && outcome.verdict.verdict !== 'pass';
          emit(verifyNotice({ id, key, round: 1, maxRounds: 1, outcome, outstanding, lang }));
        } finally {
          st.busy = false;
          emit({ t: 'assistant_end', id, stopReason: stop });
        }
      },
    });
  },
};
