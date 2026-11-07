/**
 * Tool Dispatcher — chạy các lệnh gọi công cụ mà model phát ra trong một lượt.
 *
 * - Lệnh chỉ đọc (concurrencySafe) liên tiếp nhau chạy SONG SONG (ví dụ 5 lệnh tìm kiếm web cùng lúc);
 *   lệnh ghi/chạy lệnh chạy TUẦN TỰ theo đúng thứ tự model phát ra.
 * - Mọi đối số đều được kiểm tra theo JSON-schema trước khi chạy (đối số do model sinh ra không đáng tin;
 *   Claude với eager_input_streaming có thể trả đối số bị cụt mà vẫn parse được).
 * - Xin phép người dùng theo chế độ quyền; kết quả luôn được trả về, kể cả khi lỗi/từ chối/dừng,
 *   để lịch sử hội thoại không bao giờ có tool_use thiếu tool_result.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import type { ToolResultBlock, ToolUseBlock } from '../types';
import { sliceSafe } from '../textSafe';
import type { PermissionRequest, ToolImage, UiEvent } from '../../shared/protocol';
import { UI_TOOL_OUTPUT_LIMIT } from '../../shared/protocol';
import { newId } from '../../shared/transcript';
import { decidePermission, rememberApproval } from './permissions';
import { t, type Lang } from './strings';
import type { ToolRegistry } from './toolRegistry';
import type { ActiveExtension, PermissionAdvice } from './seams';
import type { SessionState, ToolContext, ToolDef, ToolHost, ToolResult } from './types';

export const MAX_TOOL_RESULT_CHARS = 40_000;

/** Giữ đầu và đuôi, bỏ giữa — đầu/đuôi thường chứa nhiều thông tin nhất (lỗi nằm ở cuối). */
export function truncateForModel(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.25);
  const cut = text.length - head - tail;
  return `${sliceSafe(text, 0, head)}\n\n[… đã lược bỏ ${cut.toLocaleString('en-US')} ký tự ở giữa để tiết kiệm ngữ cảnh …]\n\n${sliceSafe(text, text.length - tail)}`;
}

export interface DispatcherOptions {
  registry: ToolRegistry;
  host: ToolHost;
  emit(ev: UiEvent): void;
  language: Lang;
  parallel: boolean;
  /** Thời gian tối đa cho một công cụ (ms); công cụ tự giới hạn riêng (run_command) thường ngắn hơn. */
  toolTimeoutMs?: number;
  maxResultChars?: number;
}

export interface RunBatchInput {
  calls: ToolUseBlock[];
  session: SessionState;
  assistantId: string;
  signal: AbortSignal;
  /** Tên các công cụ đang khả dụng với model ở lượt này. */
  available: ReadonlySet<string>;
  /** Extension đang hoạt động của lần chạy (móc toolBefore/toolAfter — xem seams.ts). */
  hooks?: readonly ActiveExtension[];
}

/** Ảnh đưa lên giao diện để người dùng bấm xem: tối đa 4 ảnh, mỗi ảnh ≤ ~3 MB base64 (ảnh lớn hơn chỉ đi tới mô hình, không hiện). */
function uiImages(images: ReadonlyArray<{ mediaType: string; data: string }> | undefined): ToolImage[] | undefined {
  const out = (images ?? []).filter((i) => i.data && i.data.length <= 3_000_000).slice(0, 4).map((i) => ({ mediaType: i.mediaType, data: i.data }));
  return out.length ? out : undefined;
}

const allowsNull = (s: any): boolean =>
  !!s && (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null')) || (Array.isArray(s.anyOf) && s.anyOf.some(allowsNull)) || (Array.isArray(s.oneOf) && s.oneOf.some(allowsNull)));

/**
 * Nhiều model gửi `null` cho tham số tuỳ chọn mà chúng không dùng. Với `coerceTypes`, Ajv ép `null` thành 0 / false / "" và làm ĐỔI NGHĨA lệnh
 * (`tab_id: null` → tab 0, `clear: null` → nối thêm thay vì thay thế, `links: null` → tắt liên kết). Bỏ các khoá `null` của tham số không bắt buộc
 * (và schema không cho phép null) — như thể model không truyền chúng. Sửa tại chỗ vì `call.input` còn được dùng ở các bước sau.
 */
export function stripNullOptionals(input: unknown, schema: any): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const props = schema?.properties ?? {};
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  for (const k of Object.keys(input)) {
    if ((input as Record<string, unknown>)[k] === null && !required.has(k) && !allowsNull(props[k])) delete (input as Record<string, unknown>)[k];
  }
}

export class ToolDispatcher {
  private readonly ajv = new Ajv({ allErrors: false, strict: false, coerceTypes: true, useDefaults: true });
  private readonly validators = new Map<string, ValidateFunction | null>();

  constructor(private readonly o: DispatcherOptions) {}

  async runBatch(input: RunBatchInput): Promise<ToolResultBlock[]> {
    const { calls } = input;
    const results: ToolResultBlock[] = new Array(calls.length);
    const isSafe = (c: ToolUseBlock): boolean => {
      const def = this.o.registry.get(c.name);
      // Công cụ không tồn tại chỉ trả lỗi ngay, không có tác dụng phụ → gộp được.
      return !def || def.concurrencySafe;
    };

    let i = 0;
    while (i < calls.length) {
      if (this.o.parallel && isSafe(calls[i])) {
        const group: number[] = [];
        let j = i;
        while (j < calls.length && isSafe(calls[j])) group.push(j++);
        await Promise.all(
          group.map(async (k) => {
            results[k] = await this.runOne(calls[k], input);
          }),
        );
        i = j;
      } else {
        results[i] = await this.runOne(calls[i], input);
        i++;
      }
    }
    return results;
  }

  private validatorFor(name: string, schema: object): ValidateFunction | null {
    if (this.validators.has(name)) return this.validators.get(name) ?? null;
    let v: ValidateFunction | null = null;
    try {
      v = this.ajv.compile(schema);
    } catch (err) {
      this.o.host.log('warn', `Schema của công cụ ${name} không biên dịch được: ${err instanceof Error ? err.message : err}`);
    }
    this.validators.set(name, v);
    return v;
  }

  private async runOne(call: ToolUseBlock, input: RunBatchInput): Promise<ToolResultBlock> {
    const { session, assistantId, signal } = input;
    const { emit, language } = this.o;
    const started = Date.now();
    const maxChars = this.o.maxResultChars ?? MAX_TOOL_RESULT_CHARS;

    emit({ t: 'tool_start', id: assistantId, callId: call.id, name: call.name, args: call.input });

    const finish = (state: 'done' | 'error' | 'denied' | 'cancelled', res: ToolResult): ToolResultBlock => {
      const finalState = state === 'done' && res.isError ? 'error' : state;
      emit({
        t: 'tool_end',
        id: assistantId,
        callId: call.id,
        state: finalState,
        summary: res.summary,
        output: (res.display ?? res.content).slice(0, UI_TOOL_OUTPUT_LIMIT * 2),
        diff: res.diff,
        images: uiImages(res.displayImages ?? res.images), // (lane:customer-bugs) displayImages: chỉ cho người dùng xem
        step: res.step,
        durationMs: Date.now() - started,
      });
      return {
        type: 'tool_result',
        toolUseId: call.id,
        name: call.name,
        content: truncateForModel(res.content, maxChars),
        isError: finalState !== 'done',
        images: res.images,
      };
    };
    const fail = (message: string, state: 'error' | 'denied' | 'cancelled' = 'error'): ToolResultBlock =>
      finish(state, { content: message, isError: true });

    if (signal.aborted) return fail(t(language, 'toolCancelled'), 'cancelled');

    const def = this.o.registry.get(call.name);
    if (!def || !input.available.has(call.name)) {
      return fail(t(language, 'unknownTool', { name: call.name }));
    }

    if (call.parseError) {
      const raw = (call.rawArgs ?? '').slice(0, 500);
      return fail(
        `Đối số của ${call.name} không phải JSON hợp lệ (${call.parseError}). ` +
          `Có thể đầu ra bị cắt do giới hạn độ dài — hãy chia nhỏ nội dung và gọi lại.` +
          (raw ? `\nĐối số nhận được (đầu): ${raw}` : ''),
      );
    }

    stripNullOptionals(call.input, def.inputSchema);
    const validate = this.validatorFor(def.name, def.inputSchema);
    if (validate && !validate(call.input)) {
      return fail(`Đối số không hợp lệ cho ${def.name}: ${this.ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
    }

    const ctx: ToolContext = {
      signal,
      session,
      host: this.o.host,
      callId: call.id,
      assistantId,
      emit,
      progress: (text) => emit({ t: 'tool_progress', id: assistantId, callId: call.id, output: text }),
      log: (level, message) => this.o.host.log(level, `[${def.name}] ${message}`),
    };

    try {
      const semantic = await def.validate?.(call.input, ctx);
      if (semantic) return fail(semantic);

      // Móc toolBefore của extension (hook PreToolUse, chốt chặn kỷ luật…): có thể chặn hoặc sửa đối số TRƯỚC khi hỏi quyền.
      let beforeNote = '';
      for (const ext of input.hooks ?? []) {
        if (!ext.hooks.toolBefore) continue;
        let r: Awaited<ReturnType<NonNullable<typeof ext.hooks.toolBefore>>>;
        try {
          r = await ext.hooks.toolBefore(call, def, ctx);
        } catch (err) {
          this.o.host.log('warn', `Extension "${ext.id}" lỗi ở móc toolBefore: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!r) continue;
        if ('block' in r) return fail(r.block, r.state ?? 'error');
        if ('input' in r) {
          // Đối số do extension sửa phải qua cùng kiểm tra schema như đối số của model.
          const next = JSON.parse(JSON.stringify(r.input)) as Record<string, unknown>;
          stripNullOptionals(next, def.inputSchema);
          if (validate && !validate(next)) return fail(`Đối số (đã được ${ext.id} sửa) không hợp lệ cho ${def.name}: ${this.ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
          call.input = next;
          if (r.note) beforeNote += (beforeNote ? '\n' : '') + r.note;
          emit({ t: 'tool_start', id: assistantId, callId: call.id, name: call.name, args: call.input });
        }
      }

      // (lane:perm-rules) Luật quyền bền (allow/ask/deny theo mẫu): móc `permissionRule` của extension — extension đầu tiên có `hit` thắng, `suggest` gộp lại.
      const advice = await collectPermissionAdvice(input.hooks, call, def, ctx, this.o.host);

      const verdict = await decidePermission(def, call.input, ctx, session.mode, advice.hit);
      if (verdict.action === 'deny') {
        return fail(verdict.reason === 'rule' ? t(language, 'ruleDenied', { rule: verdict.rule.rule }) : t(language, 'planMode'), 'denied');
      }
      // (lane:perm-rules) Cho qua nhờ luật: dòng công cụ ghi «cho phép bởi luật …» (trường tuỳ chọn, bản cũ/Remote cũ bỏ qua).
      if (verdict.action === 'allow' && verdict.rule) emit({ t: 'tool_start', id: assistantId, callId: call.id, name: call.name, args: call.input, rule: verdict.rule.rule });

      if (verdict.action === 'ask') {
        const { need } = verdict;
        const req: PermissionRequest = {
          id: newId('perm'),
          callId: call.id,
          tool: def.name,
          kind: need.kind,
          title: need.title,
          detail: need.detail,
          command: need.command,
          diff: need.diff,
          planMarkdown: need.planMarkdown,
          canAllowSession: need.kind === 'plan' ? true : !!need.sessionKey && !need.elevated,
          sessionLabel: need.sessionLabel,
          // (lane:perm-rules) luật ask đã buộc hỏi + đặc tả «Luôn cho phép» đề xuất (không đề xuất cho yêu cầu nâng cao / kế hoạch).
          ...(verdict.rule ? { rule: verdict.rule.rule } : {}),
          ...(advice.suggest?.length && !need.elevated && need.kind !== 'plan' ? { suggest: advice.suggest.slice(0, 3) } : {}),
        };
        emit({ t: 'tool_permission', id: assistantId, callId: call.id, request: req });
        const decision = await this.o.host.requestPermission(req, signal);
        if (signal.aborted) return fail(t(language, 'toolCancelled'), 'cancelled');
        if (decision.decision === 'deny') {
          const msg = decision.feedback
            ? t(language, 'toolDeniedWithFeedback', { feedback: decision.feedback })
            : t(language, 'toolDenied');
          return fail(msg, 'denied');
        }
        if (need.kind === 'plan') {
          // allow = duyệt kế hoạch và tiếp tục hỏi từng bước; allow_session = duyệt và tự nhận chỉnh sửa.
          session.mode = decision.decision === 'allow_session' ? 'acceptEdits' : 'default';
          emit({ t: 'mode', mode: session.mode });
        } else if (decision.decision === 'allow_session' && req.canAllowSession) {
          // Yêu cầu "nâng cao" (ngoài workspace, lệnh nguy hiểm, vùng nhạy cảm) không bao giờ được ghi nhớ cho cả phiên,
          // dù giao diện gửi lên quyết định nào.
          rememberApproval(session, need.sessionKey);
        }
        // Đưa dòng công cụ về trạng thái "đang chạy" sau khi được duyệt.
        emit({ t: 'tool_start', id: assistantId, callId: call.id, name: call.name, args: call.input });
      }

      let result = await raceWithAbort(def.execute(call.input, ctx), signal, this.o.toolTimeoutMs ?? 10 * 60_000);
      if (signal.aborted) return fail(t(language, 'toolCancelled'), 'cancelled');
      if (beforeNote) result = { ...result, content: `${beforeNote}\n${result.content}` };
      // Móc toolAfter (PostToolUse, chẩn đoán IDE…): thêm ghi chú/sửa kết quả mà model nhìn thấy.
      for (const ext of input.hooks ?? []) {
        if (!ext.hooks.toolAfter) continue;
        try {
          const r = await ext.hooks.toolAfter(call, def, ctx, result);
          if (r) result = r;
        } catch (err) {
          this.o.host.log('warn', `Extension "${ext.id}" lỗi ở móc toolAfter: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return finish('done', result);
    } catch (err) {
      if (signal.aborted) return fail(t(language, 'toolCancelled'), 'cancelled');
      const msg = err instanceof Error ? err.message : String(err);
      this.o.host.log('warn', `Công cụ ${def.name} lỗi: ${msg}`);
      return fail(`Lỗi khi chạy ${def.name}: ${msg}`);
    }
  }
}

/** (lane:perm-rules) Gom lời khuyên luật quyền từ các extension: `hit` đầu tiên thắng, `suggest` gộp (bỏ trùng). Lỗi của một móc không làm hỏng lệnh. */
async function collectPermissionAdvice(
  hooks: readonly ActiveExtension[] | undefined,
  call: ToolUseBlock,
  def: ToolDef,
  ctx: ToolContext,
  host: ToolHost,
): Promise<PermissionAdvice> {
  const out: PermissionAdvice = {};
  for (const ext of hooks ?? []) {
    if (!ext.hooks.permissionRule) continue;
    try {
      const r = await ext.hooks.permissionRule(call, def, ctx);
      if (!r) continue;
      if (r.hit && !out.hit) out.hit = r.hit;
      for (const s of r.suggest ?? []) {
        if (typeof s !== 'string' || !s) continue;
        (out.suggest ??= []).includes(s) || out.suggest.push(s);
      }
    } catch (err) {
      host.log('warn', `Extension "${ext.id}" lỗi ở móc permissionRule: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hết thời gian chờ (${Math.round(timeoutMs / 1000)} giây).`)), timeoutMs);
    const onAbort = () => reject(new Error('Đã dừng.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
