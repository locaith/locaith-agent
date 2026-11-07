/**
 * (lane:blind-verifier) Phần CHỈ VS Code của kiểm tra độc lập: đọc cài đặt, dựng dịch vụ agent từ ControllerDeps, giữ gói dữ liệu
 * của lần chạy gần nhất cho lệnh `/verify`. Logic thật nằm ở `src/core/engine/verifier.ts` (dùng chung mọi bề mặt).
 */

import type { UiEvent } from '../../shared/protocol';
import { newId } from '../../shared/transcript';
import { Semaphore } from '../../core/agents/semaphore';
import type { RunExtension } from '../../core/engine/seams';
import { t } from '../../core/engine/strings';
import type { ToolRegistry } from '../../core/engine/toolRegistry';
import type { SessionState } from '../../core/engine/types';
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
} from '../../core/engine/verifier';
import type { HostExtensionContext } from '../hostExtensions';
import type { ControllerDeps } from '../chatController';
import type { SlashRegistry } from '../slashRegistry';
import { permissionRulesExtension } from './permissionRules';
import type { VsCodeToolHost } from '../vscodeHost';

/** Trạng thái theo controller (khoá = ToolHost của controller đó, mỗi khung chat một host). */
interface VerifierState {
  last: LastRun | null;
  busy: boolean;
  runner: VerifierRunner | null;
}

const STATES = new WeakMap<object, VerifierState>();

function stateFor(host: object): VerifierState {
  let s = STATES.get(host);
  if (!s) {
    s = { last: null, busy: false, runner: null };
    STATES.set(host, s);
  }
  return s;
}

export function readVerifierSettings(host: VsCodeToolHost): VerifierSettings {
  const model = String(host.setting<string>('agent.verifyModel', '') ?? '').trim();
  return { mode: normalizeMode(host.setting<string>('agent.verify', 'auto')), model: model || undefined, maxRounds: VERIFY_MAX_ROUNDS };
}

/** Agent kiểm tra là một agent con: luật quyền (deny/ask) của người dùng cũng phải áp cho nó, nếu không `read_file(.env*)` bị cấm vẫn đọc được qua reviewer (xlane). */
export function verifierSubExtensions(ctx: HostExtensionContext): RunExtension[] {
  return [permissionRulesExtension(ctx)];
}

function runnerFor(deps: ControllerDeps, host: VsCodeToolHost, ctx: HostExtensionContext): VerifierRunner {
  const s = stateFor(host);
  if (!s.runner) {
    s.runner = runnerFromServices({
      pool: deps.pool,
      agents: deps.agents,
      skills: deps.skills,
      mode: () => deps.config.orchestrationMode(),
      engineSettings: () => deps.config.engine(),
      provider: (id) => deps.providers.get(id),
      contextWindow: (p, m) => deps.providers.contextWindow(p, m),
      log: (level, msg) => deps.logger.log(level, msg),
      limiter: new Semaphore(1),
      writeLock: new Semaphore(1),
      extensions: () => verifierSubExtensions(ctx),
    });
  }
  return s.runner;
}

/** RunExtension 'verifier' cho engine của một controller. Luôn ĐỨNG CUỐI trong hostRunExtensions. */
export function verifierExtension(ctx: HostExtensionContext): RunExtension {
  const state = stateFor(ctx.host);
  return createVerifierExtension({
    settings: () => readVerifierSettings(ctx.host),
    registry: () => ctx.registry,
    run: runnerFor(ctx.deps, ctx.host, ctx),
    onLastRun: (last) => {
      state.last = last;
    },
    busy: () => state.busy,
  });
}

/** Những gì lệnh /verify cần từ controller (controller dựng đối tượng này ở dòng đăng ký của lane). */
export interface VerifySlashHost {
  host: VsCodeToolHost;
  registry: ToolRegistry;
  deps: ControllerDeps;
  session(): SessionState;
  emit(ev: UiEvent): void;
  /** Chạy một "lượt" của controller (khoá lượt, cờ đang chạy, nút Dừng) với tín hiệu huỷ của lượt đó. */
  runTurn(fn: (signal: AbortSignal) => Promise<void>): Promise<void>;
}

/** `/verify`: kiểm tra độc lập lần chạy gần nhất của cuộc trò chuyện hiện tại (bỏ qua điều kiện tự động; tôn trọng `off`). */
export function registerVerifySlash(slash: SlashRegistry, c: VerifySlashHost): void {
  slash.register({
    name: 'verify',
    description: { vi: 'Kiểm tra độc lập lần chạy gần nhất (reviewer mù)', en: 'Independently verify the last run (blind reviewer)' },
    needsIdle: true,
    async run(sctx) {
      const lang = sctx.lang;
      const settings = readVerifierSettings(c.host);
      if (settings.mode === 'off') {
        sctx.info(lang === 'vi' ? 'Kiểm tra độc lập đang TẮT (cài đặt locaithAgent.agent.verify). Bật `auto` hoặc `always` để dùng /verify.' : 'Independent verification is OFF (setting locaithAgent.agent.verify). Set it to `auto` or `always` to use /verify.');
        return;
      }
      const state = stateFor(c.host);
      const last = state.last;
      if (!last || last.sessionId !== c.session().id) {
        sctx.info(t(lang, 'verifyNothing'));
        return;
      }
      // Lần chạy gần nhất kết thúc không bình thường (Dừng / lỗi / hết vòng): nói rõ để người dùng biết đang kiểm tra trạng thái nào.
      if (last.stopReason && last.stopReason !== 'end_turn') sctx.info(t(lang, 'verifyStaleRun', { reason: last.stopReason }));
      if (state.busy) {
        sctx.warn(t(lang, 'verifySkipped', { reason: t(lang, 'verifyReasonBusy') }));
        return;
      }
      const key = `vm${Date.now().toString(36)}`;
      await c.runTurn(async (signal) => {
        state.busy = true;
        const session = c.session();
        // Một "lượt trả lời" riêng cho lần kiểm tra: dòng «Kiểm tra độc lập» và thẻ xin phép (nếu agent kiểm tra cần chạy lệnh) có chỗ để hiện.
        const id = newId('a');
        c.emit({ t: 'assistant_start', id, provider: session.provider, model: session.model, ts: Date.now() });
        let stop = 'end_turn';
        try {
          c.emit(verifyNotice({ id, key, round: 1, maxRounds: 1, outcome: 'running', lang }));
          const outcome = await runVerification({
            bundle: last.bundle,
            registry: c.registry,
            host: c.host,
            session,
            signal,
            emit: (ev) => c.emit(ev),
            assistantId: id,
            callId: `verify:${key}`,
            lang,
            model: settings.model,
            run: runnerFor(c.deps, c.host, { deps: c.deps, host: c.host, registry: c.registry, session: () => c.session() }),
          });
          if (outcome.tokens > 0) session.usageTotals.input += outcome.tokens;
          if (outcome.kind === 'skipped' && outcome.reason === 'aborted') stop = 'aborted';
          // Chạy tay chỉ có MỘT vòng và không buộc model chính làm tiếp: kết quả là báo cáo cho người dùng (tồn đọng nếu không đạt).
          const outstanding = outcome.kind === 'verdict' && outcome.verdict.verdict !== 'pass';
          c.emit(verifyNotice({ id, key, round: 1, maxRounds: 1, outcome, outstanding, lang }));
        } finally {
          state.busy = false;
          c.emit({ t: 'assistant_end', id, stopReason: stop });
        }
      });
    },
  });
}
