/**
 * Công cụ cho mô hình chính: `agent` (một agent con, có thể gọi nhiều cái song song trong một lượt) và
 * `workflow_run` (chương trình JS điều phối hàng loạt agent con; ẩn cho tới khi kỹ năng `multi-agent` được nạp).
 */

import { availableParallelism, cpus } from 'node:os';
import type { ToolDef } from '../engine/types';
import { isTier } from '../orchestration/tiers';
import { clampLimits, runWorkflow, type WfAgentOpts, type WorkflowLimits } from './workflow';
import { createWorkflowProgress } from './progress';
import { resultHeader, runSubAgent, type AgentServices } from './runner';
import type { AgentTier } from './definitions';

interface AgentInput {
  description: string;
  prompt: string;
  agent_type?: string;
  tier?: AgentTier;
  max_turns?: number;
}

interface WorkflowInput {
  description: string;
  script: string;
  args?: unknown;
  max_agents?: number;
  max_concurrent?: number;
  max_tokens?: number;
  timeout_minutes?: number;
}

const WF_RESULT_CHARS = 12_000;
/** Cùng lúc: theo máy (như Claude Code: min(16, CPU − 2)), tối thiểu 4 — còn lại xếp hàng; bị giới hạn thêm bởi bộ giới hạn chung của hội thoại và của nhà cung cấp. */
export function autoConcurrency(cpuCount: number = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length): number {
  return Math.max(4, Math.min(16, Math.floor(cpuCount) - 2));
}
/**
 * Mặc định của workflow_run: tới 1.000 agent mỗi lần chạy, KHÔNG ngân sách token (ngân sách chỉ có khi người dùng/lệnh đặt `max_tokens`), hạn giờ dài — như Claude Code.
 * Trước 0.7.7: 60 agent / 2M token (Swarm: 300 / 5M) và token đếm cả ngữ cảnh đọc lại mỗi vòng (~1M mỗi agent) nên Swarm chết sau ~5 agent.
 * Người dùng vẫn duyệt từng lần chạy (thẻ xin phép nêu số agent, cùng lúc, hạn giờ) và có nút Dừng.
 */
const BASE_LIMITS = (): WorkflowLimits => ({ maxAgents: 1000, maxConcurrent: autoConcurrency(), maxTotalTokens: null, timeoutMs: 2 * 60 * 60_000 });
const SWARM_LIMITS = (): WorkflowLimits => ({ maxAgents: 1000, maxConcurrent: 16, maxTotalTokens: null, timeoutMs: 4 * 60 * 60_000 });
const limitDefaults = (s: { thinkingLevel: string; swarm?: boolean }): WorkflowLimits => (s.swarm || s.thinkingLevel === 'swarm' ? SWARM_LIMITS() : BASE_LIMITS());
const MAX_MIRROR_KEYS = 20;
/** Số báo cáo agent giữ lại trong RAM để cứu khi script lỗi/quá hạn giữa chừng (không để mất công của các agent đã xong). */
const MAX_RESCUE_REPORTS = 60;

function kfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')}k` : String(n);
}

export function createAgentTools(svc: AgentServices): ToolDef[] {
  const agentTool: ToolDef<AgentInput> = {
    name: 'agent',
    get description() {
      return (
        'Launch an independent sub-agent: a fresh session with its own context, its own narrowed tool set and (when orchestration is on) its own model tier. ' +
        'It sees ONLY the prompt you give it, works on its own, and returns a single final report — its intermediate steps never enter this conversation. ' +
        'Use it for broad searches, parallel investigations, independent reviews, or anything that would otherwise flood your context. ' +
        'Several `agent` calls in the same turn run IN PARALLEL. Give each a complete, self-contained prompt (goal, where to look, what to return). ' +
        'Do not delegate a task you could finish in one or two tool calls.\nAgent types:\n' +
        svc.agents.catalog()
      );
    },
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3–6 words describing the task (shown to the user).' },
        prompt: { type: 'string', description: 'The full, self-contained task for the sub-agent.' },
        agent_type: { type: 'string', description: 'Agent type from the list (default: explore).' },
        tier: { type: 'string', enum: ['top', 'balanced', 'fast', 'inherit'], description: 'Override the agent’s model tier (only used when orchestration is on).' },
        max_turns: { type: 'integer', minimum: 1, maximum: 40 },
      },
      required: ['description', 'prompt'],
    },
    risk: 'meta',
    concurrencySafe: true,
    timeoutMs: null, // một agent con có thể chạy lâu hơn 10 phút (tự giới hạn bằng số vòng, người dùng có nút Dừng)
    async validate(input) {
      if (input.agent_type && !svc.agents.get(input.agent_type)) return `Không có agent "${input.agent_type}". Các loại hiện có:\n${svc.agents.catalog()}`;
      return null;
    },
    async execute(input, ctx) {
      const def = svc.agents.get(input.agent_type || 'explore')!;
      const r = await runSubAgent(svc, ctx, {
        def,
        prompt: input.prompt,
        tier: input.tier && (isTier(input.tier) || input.tier === 'inherit') ? input.tier : undefined,
        label: input.description,
        maxTurns: input.max_turns,
        progress: (line) => ctx.progress(`${line}\n`),
      });
      const head = resultHeader(def.name, r);
      if (!r.ok) return { content: `${head}\nAgent con không hoàn thành: ${r.error ?? 'lỗi không rõ'}${r.text ? `\n\nBáo cáo dở dang:\n${r.text}` : ''}`, isError: true, summary: `${def.name} · lỗi` };
      return { content: `${head}\n\n${r.text}`, summary: `${def.name} · ${r.turns} vòng`, display: `${head}\n\n${r.text}` };
    },
  };

  const workflowTool: ToolDef<WorkflowInput> = {
    name: 'workflow_run',
    description:
      'Run a multi-agent workflow. You write a short JavaScript program (the BODY of an async function) that orchestrates many independent sub-agents. ' +
      'Intermediate results stay in script variables and the artifact store — they NEVER enter this conversation; only the value you `return` does, so return a COMPACT object (verdict, counts, artifact refs).\n' +
      'Globals: agent(prompt, {agent?, tier?, label?, json?, retries?, maxTurns?, cache?}) → Promise<{ok, text, data?, tokens, model, ref}>; ' +
      'parallel(tasks, {concurrency?}) where tasks = array of () => Promise; pipeline(items, fn, {concurrency?}) → ordered results; ' +
      'store.put(key, value) / store.get(key) / store.list(); phase(name) labels the current phase; log(...); args = the `args` input. ' +
      'No require/process/fetch/eval. Sub-agents are read-only by default (agent types: see the `agent` tool); json:true makes an agent return validated JSON.\n' +
      'Typical shape: phase("Trace"); const traces = await pipeline(hypotheses, h => agent(`Investigate: ${h}`, {tier:"balanced", json:true})); ' +
      'phase("Experiment"); const checks = await pipeline(traces, t => agent(`Try to falsify: ${t.text}`, {agent:"reviewer"})); ' +
      'phase("Adjudicate"); const v = await agent(`Weigh the evidence: ${JSON.stringify(checks.map(c => c.ref))}`, {tier:"top", json:true}); return v.data;\n' +
      'Limits: up to 1000 agents per run (≤16 run at once, the rest queue) and NO token budget unless you set max_tokens — set it ONLY when the user asked for a budget. ' +
      'A time limit applies (default 2 hours; Swarm 4). If a limit that was set is hit, agent() does not throw: it resolves {ok:false, skipped, error} and the script keeps running — always check `ok` and use the results you already have. The user must approve the run.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the workflow does, in a few words (shown to the user).' },
        script: { type: 'string', description: 'JavaScript: the body of an async function. Use `return` for the final compact result.' },
        args: { description: 'Any JSON value, available to the script as `args`.' },
        max_agents: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 1000.' },
        max_concurrent: { type: 'integer', minimum: 1, maximum: 16, description: 'Default: by CPU count (up to 16); the rest queue.' },
        max_tokens: { type: 'integer', minimum: 10000, description: 'Optional total token budget over all agents (counts every round-trip, including re-read context). NO default — omit it unless the user asked for a budget.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: 480, description: 'Default 120 (240 in Swarm mode).' },
      },
      required: ['description', 'script'],
    },
    risk: 'exec',
    concurrencySafe: false,
    hidden: true,
    timeoutMs: null, // workflow có hạn giờ riêng (timeout_minutes) và nút Dừng; cắt ở 10 phút làm lệnh báo lỗi trong khi workflow vẫn chạy mồ côi
    async validate(input) {
      if (!input.script.trim()) return 'Script rỗng.';
      return null;
    },
    async permission(input, ctx) {
      const lim = clampLimits({ maxAgents: input.max_agents, maxConcurrent: input.max_concurrent, maxTotalTokens: input.max_tokens, timeoutMs: input.timeout_minutes ? input.timeout_minutes * 60_000 : undefined }, limitDefaults(ctx.session));
      const budget = lim.maxTotalTokens === null ? 'không giới hạn token' : `ngân sách ${kfmt(lim.maxTotalTokens)} token`;
      return {
        kind: 'other',
        title: `Chạy workflow đa agent: ${input.description} (tối đa ${lim.maxAgents} agent, ${lim.maxConcurrent} chạy cùng lúc, ${budget}, hạn ${Math.round(lim.timeoutMs / 60_000)} phút)?`,
        detail: input.script.length > 3000 ? `${input.script.slice(0, 3000)}\n…` : input.script,
        sessionKey: 'workflow:run',
        sessionLabel: 'Luôn cho phép chạy workflow trong phiên này',
      };
    },
    async execute(input, ctx) {
      const limits = clampLimits(
        { maxAgents: input.max_agents, maxConcurrent: input.max_concurrent, maxTotalTokens: input.max_tokens, timeoutMs: input.timeout_minutes ? input.timeout_minutes * 60_000 : undefined },
        limitDefaults(ctx.session),
      );
      const runId = `wf${(ctx.session.scratchpad ? Object.keys(ctx.session.scratchpad).filter((k) => /^wf\d+:/.test(k)).length : 0) + 1}`;
      const mirrored: string[] = [];
      /** Báo cáo của các agent ĐÃ XONG (giữ ≤ MAX_RESCUE_REPORTS cái gần nhất): nếu script lỗi/quá hạn giữa chừng thì cứu vào scratchpad thay vì mất. */
      const rescue = new Map<string, string>();
      // Một workflow chạy nhiều agent con cùng lúc nhưng giao diện chỉ có MỘT dòng cho lệnh này: cộng số liệu của mọi agent vào đó.
      const wfProgress = createWorkflowProgress({ emit: ctx.emit, assistantId: ctx.assistantId, callId: ctx.callId, lang: svc.engineSettings().language });
      wfProgress.setLimits({ maxAgents: limits.maxAgents, concurrent: limits.maxConcurrent, tokenBudget: limits.maxTotalTokens });
      const res = await runWorkflow({
        script: input.script,
        args: input.args,
        limits,
        signal: ctx.signal,
        runId,
        hooks: {
          progress: (line) => ctx.progress(line),
          onArtifact: (key, value) => {
            if (key.startsWith('agent-')) {
              // báo cáo từng agent: quá nhiều để đưa hết vào scratchpad, chỉ để trong script — nhưng giữ bản sao nhỏ để CỨU khi workflow chết giữa chừng
              if (rescue.size >= MAX_RESCUE_REPORTS) rescue.delete(rescue.keys().next().value as string);
              rescue.set(key, value.slice(0, 20_000));
              return;
            }
            if (mirrored.length >= MAX_MIRROR_KEYS) return;
            ctx.session.scratchpad[`${runId}:${key}`] = value.slice(0, 20_000);
            mirrored.push(`${runId}:${key}`);
          },
          // Bảng từng agent (0.7.7): xếp hàng → chạy → xong/lỗi, pha, giới hạn — xem WfProgress.
          onAgent: (e) => wfProgress.agent(e),
          onPhase: (name) => wfProgress.setPhase(name),
          onLimit: (h) => wfProgress.limit(h),
          runAgent: async (prompt, opts: WfAgentOpts, signal, meta) => {
            const def = svc.agents.get(opts.agent || 'researcher') ?? svc.agents.get('researcher')!;
            const key = meta.n; // số thứ tự agent: cùng `n` với sự kiện onAgent (thử lại dùng lại đúng dòng)
            const r = await runSubAgent(svc, { ...ctx, signal }, {
              def,
              prompt,
              tier: opts.tier && (isTier(opts.tier) || opts.tier === 'inherit') ? opts.tier : undefined,
              label: opts.label || def.name,
              maxTurns: opts.maxTurns,
              maxChars: 50_000,
              onProgress: (p) => wfProgress.update(key, p),
            });
            return { ok: r.ok, text: r.text, tokens: r.inputTokens + r.outputTokens, model: r.model, error: r.error };
          },
        },
      });

      wfProgress.flush(); // số cuối cùng tới giao diện trước tool_end
      wfProgress.dispose();
      const skippedNote = res.skipped ? ` · BỎ QUA ${res.skipped} lời gọi agent() vì chạm giới hạn ${res.hit?.kind === 'tokens' ? `ngân sách ${kfmt(res.hit.limit)} token` : `${res.hit?.limit ?? limits.maxAgents} agent`}` : '';
      const stat = `${res.agents} agent · ${kfmt(res.tokens)} token · ${Math.max(1, Math.round(res.durationMs / 1000))} giây${res.phases.length ? ` · pha: ${res.phases.join(' → ')}` : ''}${skippedNote}`;
      if (!res.ok) {
        // Workflow chết giữa chừng (script lỗi / quá hạn / Dừng): CỨU báo cáo các agent đã xong vào scratchpad để model đọc tiếp thay vì chạy lại từ đầu.
        const saved: string[] = [];
        for (const [k, v] of [...rescue.entries()].slice(-MAX_MIRROR_KEYS)) {
          ctx.session.scratchpad[`${runId}:${k}`] = v;
          saved.push(`${runId}:${k}`);
        }
        const rescued = saved.length ? `\nBáo cáo của ${rescue.size} agent đã xong (${saved.length} cái gần nhất) vẫn đọc được bằng scratchpad (action read): ${saved.join(', ')} — DÙNG LẠI chúng, đừng chạy lại cả workflow.` : '';
        return { content: `Workflow thất bại (${stat}): ${res.error}${rescued}`, isError: true, summary: `${res.agents} agent · lỗi` };
      }

      let body = JSON.stringify(res.value ?? null, null, 2);
      if (body.length > WF_RESULT_CHARS) {
        const key = `${runId}:result`;
        ctx.session.scratchpad[key] = body.slice(0, 60_000);
        mirrored.push(key);
        body = `${body.slice(0, WF_RESULT_CHARS)}\n… [kết quả dài ${body.length} ký tự, đã cắt; bản đầy đủ trong scratchpad "${key}"]`;
      }
      const refs = mirrored.length ? `\nArtifact đọc được bằng scratchpad (action read): ${mirrored.join(', ')}` : '';
      return { content: `Workflow xong (${stat}).\nKết quả (giá trị script trả về):\n${body}${refs}`, summary: `${res.agents} agent · ${kfmt(res.tokens)} token`, display: `Workflow xong — ${stat}\n\n${body}` };
    },
  };

  return [agentTool as ToolDef, workflowTool as ToolDef];
}
