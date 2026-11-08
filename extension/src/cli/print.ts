/**
 * Chế độ IN MỘT LẦN (`locaith -p "việc"`, `locaith ask "việc"`, `cat log | locaith -p "tóm tắt"`): không giao diện, không hỏi quyền.
 * Kết quả: `text` (chỉ câu trả lời cuối ra stdout), `json` (một đối tượng; giữ cả khoá cũ của 0.3.x), `stream-json` (NDJSON, mỗi sự kiện một dòng).
 * Tiến trình/thống kê đi stderr để `locaith -p … > out.json` ra tệp sạch. Mã thoát: 0 xong, 1 lỗi/chưa xong, 2 dùng sai, 130 bị ngắt.
 */

import type { ParsedArgs } from './args';
import type { CliRuntime, RuntimeEvent, RuntimeOptions } from './runtime/contract';
import type { UiEvent } from '../shared/protocol';
import { t } from './i18n';

export interface PrintDeps {
  /** Tạo runtime (đã tính khoá/tin cậy); tách ra để test chèn nhà cung cấp giả. */
  createRuntime(opts: RuntimeOptions): Promise<CliRuntime>;
  readStdin(): Promise<string>;
  /** stdin có phải ống/tệp (không phải terminal) không. */
  stdinPiped: boolean;
  out(line: string): void;
  err(line: string): void;
  version: string;
  isTrusted(cwd: string): boolean | Promise<boolean>;
  lang: 'vi' | 'en';
}

interface RunSummary {
  text: string;
  turns: number;
  stopReason: string;
  errors: string[];
  denied: number;
}

export function buildPrompt(argPrompt: string | undefined, stdinText: string): string | undefined {
  const a = (argPrompt ?? '').trim();
  const s = stdinText.replace(/\s+$/, '');
  if (a && s) return `${a}\n\n---\n${s}`;
  return a || s || undefined;
}

function lastAssistantText(blocksByAssistant: Map<string, string[]>, lastId: string | undefined): string {
  if (!lastId) return '';
  return (blocksByAssistant.get(lastId) ?? []).join('').trim();
}

export async function runPrint(a: ParsedArgs, d: PrintDeps): Promise<number> {
  const stdinText = d.stdinPiped ? await d.readStdin() : '';
  const prompt = buildPrompt(a.prompt, stdinText);
  const json = a.outputFormat === 'json' || a.json;
  const stream = a.outputFormat === 'stream-json';
  if (!prompt) {
    const msg = t('cli.print.noPrompt');
    if (json) d.out(JSON.stringify({ ok: false, type: 'result', is_error: true, error: msg }));
    else d.err(msg);
    return 2;
  }

  const rt = await d.createRuntime({
    cwd: a.cwd,
    version: d.version,
    interactive: false,
    model: a.model,
    baseUrl: a.baseUrl,
    permissionMode: a.permissionMode,
    allowedTools: a.allowedTools,
    disallowedTools: a.disallowedTools,
    addDirs: a.addDirs,
    appendSystemPrompt: a.appendSystemPrompt,
    maxTurns: a.maxTurns,
    timeoutSec: a.timeoutSec ?? 900,
    mcpConfig: a.mcpConfig,
    resume: a.resume ?? (a.continueLast ? true : undefined),
    noPersist: a.noPersist,
    lang: a.lang ?? d.lang,
    verbose: a.verbose,
    trusted: await d.isTrusted(a.cwd),
  });

  const sum: RunSummary = { text: '', turns: 0, stopReason: 'unknown', errors: [], denied: 0 };
  const textBy = new Map<string, string[]>();
  let lastAssistant: string | undefined;
  let pendingText = '';
  const t0 = Date.now();
  const show = !json && !stream && !a.quiet && a.verbose;

  const emitJson = (o: unknown): void => d.out(JSON.stringify(o));
  const flushText = (): void => {
    if (!stream || !pendingText.trim()) {
      pendingText = '';
      return;
    }
    emitJson({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: pendingText }] } });
    pendingText = '';
  };

  const onUi = (ev: UiEvent): void => {
    switch (ev.t) {
      case 'assistant_start':
        sum.turns++;
        lastAssistant = ev.id;
        textBy.set(ev.id, []);
        break;
      case 'text':
        if (ev.trimTail && lastAssistant) {
          const arr = textBy.get(lastAssistant) ?? [];
          const joined = arr.join('');
          textBy.set(lastAssistant, [joined.slice(0, Math.max(0, joined.length - ev.trimTail))]);
        }
        (textBy.get(ev.id) ?? textBy.set(ev.id, []).get(ev.id)!).push(ev.delta);
        pendingText += ev.delta;
        break;
      case 'tool_start':
        flushText();
        if (stream) emitJson({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: ev.callId, name: ev.name, input: ev.args }] } });
        else if (show) d.err(`· ${ev.name}`);
        break;
      case 'tool_end':
        if (ev.state === 'denied') sum.denied++;
        if (stream) {
          emitJson({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.callId, content: ev.output ?? ev.summary ?? '', is_error: ev.state !== 'done' }] },
          });
        }
        break;
      case 'notice':
        if (ev.level === 'error') sum.errors.push(ev.text);
        if (show || (!json && !stream && ev.level !== 'info' && !a.quiet)) d.err(`${ev.level === 'error' ? '✘' : '!'} ${ev.text}`);
        break;
      case 'assistant_end':
        sum.stopReason = ev.stopReason;
        flushText();
        break;
      default:
        break;
    }
  };

  const off = rt.on((e: RuntimeEvent) => {
    if (e.t === 'ui') onUi(e.ev);
    else if (e.t === 'toast' && e.level !== 'info' && !json && !stream && !a.quiet) d.err(`${e.level === 'error' ? '✘' : '!'} ${e.text}`);
    else if (e.t === 'output' && e.kind === 'error') sum.errors.push(e.text);
  });

  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    rt.interrupt();
  };
  process.once('SIGINT', onSigint);

  if (stream) {
    const s = rt.status();
    emitJson({ type: 'system', subtype: 'init', session_id: s.sessionId, cwd: s.cwd, model: s.model, permissionMode: s.mode });
  }

  try {
    await rt.submit(prompt);
    await rt.idle();
  } catch (err) {
    sum.errors.push(err instanceof Error ? err.message : String(err));
    sum.stopReason = 'error';
  } finally {
    process.removeListener('SIGINT', onSigint);
    off();
  }

  const status = rt.status();
  sum.text = lastAssistantText(textBy, lastAssistant);
  const ok = !interrupted && sum.errors.length === 0 && sum.stopReason === 'end_turn';
  const ms = Date.now() - t0;
  const tokens = status.usage.input + status.usage.output;

  if (json || stream) {
    const result = {
      type: 'result',
      subtype: ok ? 'success' : interrupted ? 'interrupted' : sum.stopReason === 'max_turns' ? 'error_max_turns' : 'error',
      is_error: !ok,
      result: sum.text,
      ...(sum.errors.length ? { error: sum.errors[0] } : {}),
      session_id: status.sessionId,
      num_turns: sum.turns,
      duration_ms: ms,
      usage: { input_tokens: status.usage.input, output_tokens: status.usage.output },
      ...(status.costUsd !== undefined ? { total_cost_usd: status.costUsd } : {}),
      // Khoá của CLI 0.3.x — giữ để script cũ không vỡ.
      ok,
      stopReason: sum.stopReason,
      turns: sum.turns,
      model: status.model,
      ms,
      text: sum.text,
    };
    if (stream) emitJson(result);
    else d.out(JSON.stringify(result, null, 2));
  } else {
    d.out(sum.text || t('cli.print.noAnswer'));
    if (!a.quiet) {
      d.err(`\n— ${t('cli.print.footer', { turns: sum.turns, tokens, secs: Math.round(ms / 100) / 10 })}`);
      if (sum.denied > 0) d.err(t('cli.print.denied', { n: sum.denied }));
    }
  }

  await rt.dispose();
  return interrupted ? 130 : ok ? 0 : 1;
}
