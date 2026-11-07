/**
 * Chạy một agent con: phiên MỚI (ngữ cảnh riêng, danh sách tác vụ riêng, scratchpad riêng) với model do bộ điều phối chọn,
 * tập công cụ bị thu hẹp theo định nghĩa agent. Luồng chính chỉ nhận báo cáo cuối — mọi bước trung gian ở lại trong phiên con,
 * đó là điều giúp chạy hàng trăm agent mà ngữ cảnh chính không bị "rác".
 *
 * Quyền: agent con dùng chung `ToolHost` với luồng chính nên thao tác cần phép (ghi tệp, chạy lệnh, tên miền mới) vẫn xin ngay trên
 * giao diện của luồng chính (thẻ xin phép được chuyển tiếp dưới callId có tiền tố). Phiên con thừa hưởng các lựa chọn "cho phép
 * trong phiên" đã có và chế độ quyền của luồng chính (kế hoạch ⇒ chỉ đọc).
 */

import type { AgentProgress, UiEvent } from '../../shared/protocol';
import { newId } from '../../shared/transcript';
import { agentActivity, agentPhase, streamTokenEstimate } from './activity';
import { createProgressReporter } from './progress';
import { getTaskManager } from '../tasks/backgroundTasks'; // lane:bg-tasks
import { AgentEngine } from '../engine/engine';
import { coreRunExtensions } from '../engine/extensions';
import type { RunExtension } from '../engine/seams';
import { ToolRegistry, isPlanSafe } from '../engine/toolRegistry';
import { newSession, type EngineSettings, type SessionState, type ToolContext } from '../engine/types';
import { FailoverProvider, type FailoverHooks } from '../orchestration/failover';
import { AUTO_PROVIDER_ID, type ModelPool, type OrchestrationMode, type Target } from '../orchestration/pool';
import { classifyTier, type Tier } from '../orchestration/tiers';
import type { SkillRegistry } from '../skills/registry';
import { textOf, type ApiThinkingLevel, type LLMProvider, type ThinkingLevel } from '../types';
import { READONLY_TOOLS, NEVER_FOR_SUB, type AgentDef, type AgentRegistry, type AgentTier } from './definitions';
import { Semaphore } from './semaphore';

export interface AgentServices {
  pool: ModelPool;
  agents: AgentRegistry;
  skills: SkillRegistry;
  mode(): OrchestrationMode;
  engineSettings(): EngineSettings;
  /** Kho công cụ của luồng chính (nguồn để thu hẹp cho agent con). */
  registry(): ToolRegistry;
  provider(id: string): LLMProvider;
  contextWindow(providerId: string, model: string): number;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Số agent con chạy đồng thời tối đa (toàn cục). */
  limiter: Semaphore;
  /** Chỉ một agent có quyền ghi/chạy lệnh tại một thời điểm (hai agent cùng sửa một tệp sẽ hỏng dữ liệu). */
  writeLock: Semaphore;
  onSwitch?: FailoverHooks['onSwitch'];
  /** (lane:hooks) Extension bổ sung cho engine của agent con (vd. PreToolUse/PostToolUse) — nếu không, hook bị vượt qua bằng công cụ `agent`. */
  extensions?(): RunExtension[];
}

export interface RunAgentOptions {
  def: AgentDef;
  prompt: string;
  tier?: AgentTier;
  label?: string;
  maxTurns?: number;
  /** Dòng tiến độ ngắn cho giao diện. */
  progress?(line: string): void;
  /**
   * Nhận tiến độ SỐNG (token · lệnh · việc đang làm), đã gộp ≤ 2 lần/giây. Không đặt → runSubAgent tự phát `agent_progress` lên luồng chính cho
   * đúng lệnh gọi `ctx.callId`; workflow đặt nó để cộng số liệu của nhiều agent vào MỘT dòng.
   */
  onProgress?(p: AgentProgress): void;
  /** Giới hạn độ dài báo cáo trả về (ký tự). */
  maxChars?: number;
}

export interface SubAgentResult {
  ok: boolean;
  text: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  providerId: string;
  tier: Tier;
  stopReason: string;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

const DEFAULT_MAX_CHARS = 12_000;

const THINKING_RANK: Record<ThinkingLevel, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4, swarm: 5 };

/**
 * Mức suy luận của agent con: KHÔNG BAO GIỜ thấp hơn mức của phiên cha.
 * `swarm` là mức của luồng chính (được gửi lên nhà cung cấp dưới dạng `max`) ⇒ mọi agent con cũng chạy `max`,
 * để cả bầy suy luận ở mức sâu nhất thay vì mỗi agent tự hạ xuống theo định nghĩa của nó.
 * Định nghĩa agent chỉ có tác dụng NÂNG mức lên (ví dụ `explore` khai `low` nhưng phiên cha đang `max` ⇒ `max`).
 */
export function subAgentThinking(parent: ThinkingLevel, own: ThinkingLevel): ApiThinkingLevel {
  const p: ApiThinkingLevel = parent === 'swarm' ? 'max' : parent;
  const o: ApiThinkingLevel = own === 'swarm' ? 'max' : own;
  return THINKING_RANK[o] >= THINKING_RANK[p] ? o : p;
}

/** Chuỗi đích cho một agent con: kế thừa phiên cha, hoặc chọn theo hạng trong kho model (khi bật điều phối). */
export async function resolveChain(
  svc: Pick<AgentServices, 'mode' | 'pool' | 'provider' | 'contextWindow'>,
  def: Pick<AgentDef, 'tier' | 'model'>,
  tierOverride: AgentTier | undefined,
  parent: Pick<SessionState, 'provider' | 'model'>,
): Promise<Target[]> {
  const mode = svc.mode();
  const tier: AgentTier = tierOverride ?? def.tier;
  const inherit = async (): Promise<Target[]> => {
    if (parent.provider === AUTO_PROVIDER_ID) return svc.pool.rank('balanced', { spread: mode === 'auto' });
    const own: Target = {
      providerId: parent.provider,
      providerLabel: svc.provider(parent.provider).label,
      model: parent.model,
      modelLabel: parent.model,
      tier: classifyTier({ id: parent.model, label: parent.model }),
      contextWindow: svc.contextWindow(parent.provider, parent.model),
      provider: svc.provider(parent.provider),
    };
    if (mode === 'off') return [own];
    const others = await svc.pool.rank(own.tier, { prefer: { providerId: parent.provider }, exclude: [parent.provider] });
    return [own, ...others];
  };

  if (def.model && def.model.includes(':')) {
    const i = def.model.indexOf(':');
    const providerId = def.model.slice(0, i);
    const model = def.model.slice(i + 1);
    const ok = (await svc.pool.providers()).some((p) => p.id === providerId);
    if (ok) {
      return [
        {
          providerId,
          providerLabel: svc.provider(providerId).label,
          model,
          modelLabel: model,
          tier: classifyTier({ id: model, label: model }),
          contextWindow: svc.contextWindow(providerId, model),
          provider: svc.provider(providerId),
        },
      ];
    }
  }
  if (mode !== 'auto' || tier === 'inherit') return inherit();
  const ranked = await svc.pool.rank(tier, { prefer: { providerId: parent.provider }, spread: true });
  return ranked.length ? ranked : inherit();
}

/** Thu hẹp kho công cụ theo định nghĩa agent. */
export function buildSubRegistry(source: ToolRegistry, def: Pick<AgentDef, 'tools'>, parentMode: SessionState['mode']): ToolRegistry {
  const reg = new ToolRegistry();
  const all = def.tools === 'all' && parentMode !== 'plan';
  const list = Array.isArray(def.tools) ? def.tools : null;
  for (const d of source.all()) {
    if (NEVER_FOR_SUB.has(d.name)) continue;
    let ok: boolean;
    if (all) ok = true;
    else if (list) ok = list.some((p) => (p.endsWith('*') ? d.name.startsWith(p.slice(0, -1)) : d.name === p));
    else ok = READONLY_TOOLS.includes(d.name);
    if (ok && parentMode === 'plan' && !isPlanSafe(d)) ok = false;
    if (ok) reg.register(d);
  }
  return reg;
}

function brief(def: AgentDef, prompt: string, lang: 'vi' | 'en', maxTurns: number): string {
  const head = lang === 'vi'
    ? `Bạn là sub-agent độc lập «${def.name}». Bạn KHÔNG thấy hội thoại của người dùng — chỉ có nhiệm vụ bên dưới. Làm đúng nhiệm vụ trong tối đa ${maxTurns} vòng, rồi trả về BÁO CÁO CUỐI ngắn gọn, có dẫn chứng (đường dẫn:dòng, URL). Không hỏi lại người dùng; nếu thiếu thông tin thì nói rõ điều gì còn thiếu. Trả lời bằng ngôn ngữ của nhiệm vụ.`
    : `You are the independent sub-agent «${def.name}». You do NOT see the user's conversation — only the task below. Complete it within at most ${maxTurns} turns, then return a concise FINAL REPORT with evidence (path:line, URLs). Do not ask the user questions; if information is missing, say exactly what is missing. Answer in the task's language.`;
  return `<vai_tro>\n${def.prompt}\n</vai_tro>\n\n${head}\n\n<nhiem_vu>\n${prompt}\n</nhiem_vu>`;
}

export async function runSubAgent(svc: AgentServices, ctx: ToolContext, o: RunAgentOptions): Promise<SubAgentResult> {
  const started = Date.now();
  const label = o.label || o.def.name;
  const settings = svc.engineSettings();
  const empty = (error: string): SubAgentResult => ({
    ok: false, text: '', turns: 0, inputTokens: 0, outputTokens: 0, model: '', providerId: '', tier: 'balanced', stopReason: 'error', toolCalls: 0, durationMs: Date.now() - started, error,
  });

  let chain: Target[];
  try {
    chain = await resolveChain(svc, o.def, o.tier, ctx.session);
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
  if (chain.length === 0) return empty('Không có model nào khả dụng cho agent con (chưa nhập khoá API?).');
  const first = chain[0];
  const provider: LLMProvider = chain.length > 1 ? new FailoverProvider(chain, svc.pool, { onSwitch: svc.onSwitch, log: svc.log }) : first.provider;

  const releases: Array<() => void> = [];
  let subSessionId: string | undefined; // lane:bg-tasks
  let progressRef: { dispose(): void } | undefined;
  try {
    releases.push(await svc.limiter.acquire(ctx.signal));
    releases.push(await svc.pool.limiter(first.providerId).acquire(ctx.signal));
    svc.pool.noteUse(first.providerId);

    const registry = buildSubRegistry(svc.registry(), o.def, ctx.session.mode);
    if (registry.all().some((d) => d.risk === 'write' || d.risk === 'exec' || d.risk === 'act')) releases.push(await svc.writeLock.acquire(ctx.signal));

    const maxTurns = Math.max(1, Math.min(40, o.maxTurns ?? o.def.maxTurns));
    subSessionId = newId('sa');
    const session = newSession({
      id: subSessionId,
      provider: first.providerId,
      model: first.model,
      title: label,
      mode: ctx.session.mode,
      thinkingLevel: subAgentThinking(ctx.session.thinkingLevel, o.def.thinking),
      approvals: [...ctx.session.approvals],
    });

    // Chuyển tiếp thẻ xin phép của agent con lên giao diện của luồng chính (callId có tiền tố để không đụng nhau).
    const fwd = new Set<string>();
    const starts = new Map<string, { name: string; args: Record<string, unknown> }>();
    const pid = (cid: string) => `${ctx.callId}~${cid}`;
    let toolCalls = 0;
    const errors: string[] = [];

    // Tiến độ sống: token (thật từ `usage` + ước lượng phần đang stream), số lệnh, số lệnh lỗi, việc đang làm. Gộp ≤ 2 lần/giây.
    const lang = settings.language;
    let failedCalls = 0;
    let streaming = 0; // token ước lượng của lượt model đang stream (về 0 khi `usage` thật tới)
    let peakTokens = 0; // số hiển thị không bao giờ giảm (ước lượng có thể vượt số thật một chút)
    let activity = agentPhase(lang, 'starting');
    const report = createProgressReporter({
      send: (p) => (o.onProgress ? o.onProgress(p) : ctx.emit({ t: 'agent_progress', id: ctx.assistantId, callId: ctx.callId, ...p })),
    });
    const publish = (): void => {
      // Trong lúc một lượt model đang stream, số thật của nó chưa tới: cộng ước lượng phần ra + cỡ ngữ cảnh của lượt trước làm ước lượng phần vào
      // (ngữ cảnh chỉ lớn thêm chút ít giữa hai lượt), để con số chạy đều thay vì nhảy một bước lớn mỗi khi lượt kết thúc.
      const inflight = streaming > 0 ? session.lastContextTokens + streaming : 0;
      peakTokens = Math.max(peakTokens, Math.floor(session.usageTotals.input + session.usageTotals.output + inflight));
      // Lệnh đã chuyển thẻ xin phép lên luồng chính có dòng riêng ở đó (và được đếm ở đó) → không đếm hai lần.
      report.update({ tokens: peakTokens, tools: toolCalls - fwd.size, ...(failedCalls ? { failed: failedCalls } : {}), activity });
    };
    const setActivity = (next: string): void => {
      activity = next;
    };
    progressRef = report;
    publish();

    const emit = (ev: UiEvent): void => {
      switch (ev.t) {
        case 'tool_start':
          starts.set(ev.callId, { name: ev.name, args: ev.args });
          if (fwd.has(ev.callId)) ctx.emit({ ...ev, id: ctx.assistantId, callId: pid(ev.callId) });
          else {
            toolCalls++;
            o.progress?.(`  ↳ ${label}: ${ev.name}`);
          }
          setActivity(agentActivity(lang, ev.name, ev.args));
          publish();
          break;
        case 'thinking':
          streaming += streamTokenEstimate(ev.delta);
          setActivity(agentPhase(lang, 'thinking'));
          publish();
          break;
        case 'text':
          streaming += streamTokenEstimate(ev.delta);
          setActivity(agentPhase(lang, 'writing'));
          publish();
          break;
        case 'usage':
          streaming = 0; // số thật của lượt vừa xong đã nằm trong session.usageTotals (engine cộng trước khi phát sự kiện này)
          publish();
          break;
        case 'tool_permission': {
          if (!fwd.has(ev.callId)) {
            fwd.add(ev.callId);
            const s = starts.get(ev.callId);
            ctx.emit({ t: 'tool_start', id: ctx.assistantId, callId: pid(ev.callId), name: s?.name ?? ev.request.tool, args: s?.args ?? {} });
          }
          ctx.emit({ ...ev, id: ctx.assistantId, callId: pid(ev.callId), request: { ...ev.request, callId: pid(ev.callId) } });
          break;
        }
        case 'tool_progress':
          if (fwd.has(ev.callId)) ctx.emit({ ...ev, id: ctx.assistantId, callId: pid(ev.callId) });
          break;
        case 'tool_end':
          if (fwd.has(ev.callId)) ctx.emit({ ...ev, id: ctx.assistantId, callId: pid(ev.callId) });
          else if (ev.state === 'error') {
            failedCalls++;
            publish();
          }
          break;
        case 'notice':
          if (ev.level === 'error') errors.push(ev.text);
          break;
        default:
          break;
      }
    };

    const engine = new AgentEngine({
      provider,
      summarizer: null,
      registry,
      skills: svc.skills,
      host: ctx.host,
      settings: { ...settings, maxTurns, contextWindow: first.contextWindow },
      emit,
      extensions: [...coreRunExtensions(), ...(svc.extensions?.() ?? [])], // (lane:hooks)
    });
    const run = await engine.run({ session, content: [{ type: 'text', text: brief(o.def, o.prompt, settings.language, maxTurns) }], signal: ctx.signal });
    streaming = 0;
    peakTokens = 0; // chốt số THẬT (bỏ phần ước lượng còn sót) trước khi báo lần cuối
    publish();
    report.flush(); // số cuối cùng phải tới giao diện TRƯỚC tool_end của lệnh `agent`

    const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
    const full = lastAssistant ? textOf(lastAssistant).trim() : '';
    const max = o.maxChars ?? DEFAULT_MAX_CHARS;
    const text = full.length > max ? `${full.slice(0, max)}\n\n[… báo cáo bị cắt ${full.length - max} ký tự]` : full;
    const usedTarget = provider instanceof FailoverProvider ? provider.lastUsed ?? first : first;
    const ok = text.length > 0 && run.stopReason !== 'aborted' && run.stopReason !== 'error';
    return {
      ok,
      text,
      turns: run.turns,
      inputTokens: session.usageTotals.input,
      outputTokens: session.usageTotals.output,
      model: usedTarget.model,
      providerId: usedTarget.providerId,
      tier: usedTarget.tier,
      stopReason: run.stopReason,
      toolCalls,
      durationMs: Date.now() - started,
      error: ok ? undefined : errors[errors.length - 1] ?? (run.stopReason === 'aborted' ? 'Đã dừng.' : 'Agent con không trả về báo cáo.'),
    };
  } catch (err) {
    if (ctx.signal.aborted) return { ...empty('Đã dừng.'), stopReason: 'aborted' };
    return empty(err instanceof Error ? err.message : String(err));
  } finally {
    // lane:bg-tasks: tác vụ nền do agent con khởi chạy gắn với phiên 'sa…' (agent cha không thấy/dừng được) → dọn khi agent con xong,
    // kẻo dev server thành tiến trình mồ côi tới khi đóng cửa sổ.
    if (subSessionId) {
      try {
        await getTaskManager(ctx.host).disposeSession(subSessionId);
      } catch {
        /* dọn nền không được làm hỏng kết quả agent con */
      }
    }
    progressRef?.dispose();
    for (const r of releases.reverse()) r();
  }
}

/** Tiêu đề kết quả: «agent explore · deepseek-v4-flash (fast) · 3 vòng · 4,2k token · 12 giây». */
export function resultHeader(name: string, r: SubAgentResult): string {
  const tokens = r.inputTokens + r.outputTokens;
  const k = tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace('.', ',')}k` : String(tokens);
  return `[agent «${name}» · ${r.model || '?'} (${r.tier}) · ${r.turns} vòng · ${r.toolCalls} lệnh · ${k} token · ${Math.max(1, Math.round(r.durationMs / 1000))} giây]`;
}
