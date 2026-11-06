/**
 * Công cụ cho mô hình chính: `agent` (một agent con, có thể gọi nhiều cái song song trong một lượt) và
 * `workflow_run` (chương trình JS điều phối hàng loạt agent con; ẩn cho tới khi kỹ năng `multi-agent` được nạp).
 */

import type { ToolDef } from '../engine/types';
import { isTier } from '../orchestration/tiers';
import { clampLimits, runWorkflow, type WfAgentOpts } from './workflow';
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
const BASE_LIMITS = { maxAgents: 60, maxConcurrent: 8, maxTotalTokens: 2_000_000, timeoutMs: 20 * 60_000 };
/** Chế độ Swarm: ngân sách mặc định lớn hơn (vẫn nằm dưới trần cứng 1.000 agent / 16 cùng lúc / 20M token). */
const SWARM_LIMITS = { maxAgents: 300, maxConcurrent: 16, maxTotalTokens: 5_000_000, timeoutMs: 45 * 60_000 };
const limitDefaults = (s: { thinkingLevel: string; swarm?: boolean }) => (s.swarm || s.thinkingLevel === 'swarm' ? SWARM_LIMITS : BASE_LIMITS);
const MAX_MIRROR_KEYS = 20;

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
      'Limits: ≤16 agents at once, ≤1000 agents per run, a token budget and a time limit (set them with max_*). The user must approve the run.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the workflow does, in a few words (shown to the user).' },
        script: { type: 'string', description: 'JavaScript: the body of an async function. Use `return` for the final compact result.' },
        args: { description: 'Any JSON value, available to the script as `args`.' },
        max_agents: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 60 (300 in Swarm mode).' },
        max_concurrent: { type: 'integer', minimum: 1, maximum: 16, description: 'Default 8 (16 in Swarm mode).' },
        max_tokens: { type: 'integer', minimum: 10000, description: 'Total token budget over all agents. Default 2,000,000 (5,000,000 in Swarm mode).' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 20.' },
      },
      required: ['description', 'script'],
    },
    risk: 'exec',
    concurrencySafe: false,
    hidden: true,
    async validate(input) {
      if (!input.script.trim()) return 'Script rỗng.';
      return null;
    },
    async permission(input, ctx) {
      const lim = clampLimits({ maxAgents: input.max_agents, maxConcurrent: input.max_concurrent, maxTotalTokens: input.max_tokens }, limitDefaults(ctx.session));
      return {
        kind: 'other',
        title: `Chạy workflow đa agent: ${input.description} (tối đa ${lim.maxAgents} agent, ${lim.maxConcurrent} chạy cùng lúc, ngân sách ${kfmt(lim.maxTotalTokens)} token)?`,
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
      // Một workflow chạy nhiều agent con cùng lúc nhưng giao diện chỉ có MỘT dòng cho lệnh này: cộng số liệu của mọi agent vào đó.
      const wfProgress = createWorkflowProgress({ emit: ctx.emit, assistantId: ctx.assistantId, callId: ctx.callId, lang: svc.engineSettings().language });
      let agentSeq = 0;
      const res = await runWorkflow({
        script: input.script,
        args: input.args,
        limits,
        signal: ctx.signal,
        runId,
        hooks: {
          progress: (line) => ctx.progress(line),
          onArtifact: (key, value) => {
            if (key.startsWith('agent-')) return; // báo cáo từng agent: quá nhiều, chỉ để trong script
            if (mirrored.length >= MAX_MIRROR_KEYS) return;
            ctx.session.scratchpad[`${runId}:${key}`] = value.slice(0, 20_000);
            mirrored.push(`${runId}:${key}`);
          },
          runAgent: async (prompt, opts: WfAgentOpts, signal) => {
            const def = svc.agents.get(opts.agent || 'researcher') ?? svc.agents.get('researcher')!;
            const key = ++agentSeq;
            const r = await runSubAgent(svc, { ...ctx, signal }, {
              def,
              prompt,
              tier: opts.tier && (isTier(opts.tier) || opts.tier === 'inherit') ? opts.tier : undefined,
              label: opts.label || def.name,
              maxTurns: opts.maxTurns,
              maxChars: 50_000,
              onProgress: (p) => wfProgress.update(key, p),
            });
            wfProgress.finish(key);
            return { ok: r.ok, text: r.text, tokens: r.inputTokens + r.outputTokens, model: r.model, error: r.error };
          },
        },
      });

      wfProgress.flush(); // số cuối cùng tới giao diện trước tool_end
      wfProgress.dispose();
      const stat = `${res.agents} agent · ${kfmt(res.tokens)} token · ${Math.max(1, Math.round(res.durationMs / 1000))} giây${res.phases.length ? ` · pha: ${res.phases.join(' → ')}` : ''}`;
      if (!res.ok) return { content: `Workflow thất bại (${stat}): ${res.error}`, isError: true, summary: `${res.agents} agent · lỗi` };

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
