/**
 * Kịch bản dựng video quảng cáo (chỉ dùng ở harness, KHÔNG nằm trong gói .vsix): giao diện là giao diện THẬT của extension,
 * còn nội dung trả lời được phát lại theo mốc thời gian để quay màn hình ổn định.
 *   ?scenario=promo&promo=3d|nd30|mem|model
 * Nội dung dài (văn bản công văn do Locaith-v5-flash viết) được nạp qua window.__PROMO__ (do trang quay cấp), không nhúng vào mã.
 */
import type { UiEvent } from '../../src/shared/protocol';
import type { Step } from './scenarios';

declare global {
  interface Window {
    __PROMO__?: { nd30Text?: string; sceneLines?: number; sceneSeconds?: number; sceneTokens?: number };
  }
}

function chunk(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

function stream(id: string, text: string, from: number, perChunkMs: number, size: number): { steps: Step[]; end: number } {
  const steps: Step[] = [];
  let at = from;
  for (const c of chunk(text, size)) {
    steps.push({ at, events: [{ t: 'text', id, delta: c }] });
    at += perChunkMs;
  }
  return { steps, end: at };
}

function think(id: string, text: string, from: number): { steps: Step[]; end: number } {
  const steps: Step[] = [];
  let at = from;
  for (const c of chunk(text, 9)) {
    steps.push({ at, events: [{ t: 'thinking', id, delta: c }] });
    at += 22;
  }
  return { steps, end: at };
}

const head = (id: string, prompt: string, provider: string, model: string): Step => ({
  at: 0,
  events: [{ t: 'user', id: `u_${id}`, text: prompt, attachments: [], ts: Date.now() }, { t: 'run_state', running: true }, { t: 'assistant_start', id, provider, model, ts: Date.now() }],
});

const tail = (id: string, at: number, out = 260): Step => ({
  at,
  marker: 'done',
  events: [
    { t: 'usage', id, usage: { inputTokens: 1955, outputTokens: out } },
    { t: 'assistant_end', id, stopReason: 'end_turn' },
    { t: 'run_state', running: false },
  ],
});

export function promoReply(kind: string, id: string, prompt: string, provider: string, model: string): Step[] {
  const P = window.__PROMO__ ?? {};
  const steps: Step[] = [head(id, prompt, provider, model)];

  if (kind === 'nd30') {
    const th = think(id, 'Official letter under Decree 30: header block, motto, subject line, recipient, body, recipients list, signature. Missing facts go in brackets.', 500);
    steps.push(...th.steps);
    steps.push({ at: th.end + 150, events: [{ t: 'tool_start', id, callId: 'k1', name: 'load_skill', args: { skill_name: 'soan-thao-van-ban-nd30' } }, { t: 'skill', id, skill: 'soan-thao-van-ban-nd30', unlocked: [] }] });
    steps.push({ at: th.end + 650, events: [{ t: 'tool_end', id, callId: 'k1', state: 'done', summary: 'Decree 30 skill', output: 'ok', durationMs: 380 }] });
    const st = stream(id, P.nd30Text ?? '', th.end + 800, 16, 22);
    steps.push({ at: th.end + 800, marker: 'streaming' });
    steps.push(...st.steps);
    steps.push(tail(id, st.end + 200, 1180));
    return steps;
  }

  if (kind === 'mem') {
    steps.push({ at: 500, events: [{ t: 'pill', id, pillId: `${id}p`, text: 'Checking memory first', kind: 'thinking' }] });
    steps.push({ at: 1000, events: [{ t: 'tool_start', id, callId: 'm1', name: 'mcp__bio-memory-locaith__recall', args: { query: 'ABC extension letter, Hanoi Department of Planning and Investment' } }] });
    steps.push({
      at: 2300,
      marker: 'recalled',
      events: [{ t: 'tool_end', id, callId: 'm1', state: 'done', summary: '4 memories', output: 'letter: ABC Co. → Hanoi DPI, extend Q3 investment report to 20 Nov 2026\nreason: accounting system upgrade\nsigner: Nguyen Van An, Director\nopen: document number, street address', durationMs: 640 }],
    });
    const ans =
      'Picking up where we left off. Yesterday we drafted ABC Co.’s letter asking the Hanoi Department of Planning and Investment to extend the Q3 investment report to **20 Nov 2026**, because the accounting system is being upgraded. Mr. Nguyen Van An, Director, signs.\n\n' +
      'Only two blanks remain: the **document number** and the **street address**. Give me those and I’ll export the final .docx.';
    const st = stream(id, ans, 2700, 26, 12);
    steps.push(...st.steps);
    steps.push(tail(id, st.end + 200, 190));
    return steps;
  }

  // 3d
  const th = think(id, 'One self-contained HTML file. Three.js from a CDN importmap: glowing core, two tilted rings with orbiting particles, star field, slow camera drift.', 500);
  steps.push(...th.steps);
  const intro = stream(id, 'I’ll build this as one self-contained Three.js page: a glowing core, two tilted orbit rings with particles, a star field and a slow camera drift.', th.end + 150, 24, 8);
  steps.push(...intro.steps);
  steps.push({
    at: intro.end + 250,
    marker: 'writing',
    events: [{ t: 'tool_start', id, callId: 'w1', name: 'write_file', args: { path: 'scene.html', content: '' } }],
  });
  const done = intro.end + 250 + 2600;
  steps.push({
    at: done,
    marker: 'written',
    events: [{ t: 'tool_end', id, callId: 'w1', state: 'done', summary: `${P.sceneLines ?? 343} lines`, output: 'wrote scene.html', durationMs: Math.round((P.sceneSeconds ?? 11) * 1000) }],
  });
  const fin = stream(id, 'Done. Open `scene.html` in a browser and it runs straight away.', done + 250, 24, 8);
  steps.push(...fin.steps);
  steps.push(tail(id, fin.end + 200, P.sceneTokens ?? 3298));
  return steps;
}

export type { UiEvent };
