/**
 * FailoverProvider: bọc một chuỗi đích (nhà cung cấp + model). Nếu đích đầu bị giới hạn tốc độ/quá tải/mất mạng/sai khoá
 * TRƯỚC KHI nó phát ra bất kỳ dữ liệu nào, chuyển sang đích kế tiếp và cho đích hỏng nghỉ một lúc (cooldown) —
 * đó là cách "chia sẻ tài nguyên" giữa các khoá API người dùng đã nhập. Đã phát dữ liệu giữa chừng thì KHÔNG chuyển
 * (giao diện đã hiện chữ; chuyển sẽ trộn hai câu trả lời) mà ném lỗi cho engine xử lý như cũ.
 *
 * An toàn khi đổi hãng giữa hội thoại: mỗi adapter chỉ phát lại khối suy luận do chính nó sinh ra (xem BlockOrigin).
 */

import {
  ProviderError,
  type CompleteRequest,
  type LLMProvider,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderFlavor,
  type ProviderKind,
  type StreamRequest,
} from '../types';
import type { ModelPool, Target } from './pool';

export interface SwitchInfo {
  from: Target;
  to: Target;
  reason: string;
  kind: string;
}

export interface FailoverHooks {
  onSwitch?(info: SwitchInfo): void;
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

const SWITCHABLE = new Set(['rate_limit', 'overloaded', 'server', 'network', 'timeout', 'auth', 'not_found']);

export function isSwitchable(err: unknown): err is ProviderError {
  return err instanceof ProviderError && SWITCHABLE.has(err.kind);
}

/** Thời gian cho nhà cung cấp "nghỉ" sau lỗi (ms). */
export function cooldownFor(err: ProviderError): number {
  switch (err.kind) {
    case 'rate_limit':
      return Math.min(Math.max(err.retryAfterMs ?? 60_000, 5_000), 10 * 60_000);
    case 'overloaded':
      return 30_000;
    case 'auth':
    case 'not_found':
      return 10 * 60_000;
    default:
      return 20_000;
  }
}

export class FailoverProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly flavor: ProviderFlavor;
  readonly capabilities: ProviderCapabilities;
  /** Đích đã trả lời thành công lần gần nhất. */
  lastUsed: Target | null = null;

  constructor(
    private readonly chain: readonly Target[],
    private readonly pool: ModelPool | null,
    private readonly hooks: FailoverHooks = {},
    meta: { id?: string; label?: string } = {},
  ) {
    if (chain.length === 0) throw new Error('FailoverProvider cần ít nhất một đích.');
    const p = chain[0].provider;
    this.id = meta.id ?? p.id;
    this.label = meta.label ?? p.label;
    this.kind = p.kind;
    this.flavor = p.flavor;
    this.capabilities = p.capabilities;
  }

  /** Đích đang nghỉ xuống cuối (nhưng vẫn thử nếu không còn lựa chọn nào khác). */
  private order(): Target[] {
    const ok = this.chain.filter((t) => !this.pool?.isCooling(t.providerId));
    const cooling = this.chain.filter((t) => this.pool?.isCooling(t.providerId));
    return [...ok, ...cooling];
  }

  private fail(from: Target, to: Target, err: ProviderError): void {
    this.pool?.markCooldown(from.providerId, cooldownFor(err));
    this.hooks.log?.('warn', `Failover: ${from.providerId}:${from.model} lỗi ${err.kind}${err.status ? ' ' + err.status : ''} → chuyển sang ${to.providerId}:${to.model}`);
    this.hooks.onSwitch?.({ from, to, reason: err.message, kind: err.kind });
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    const order = this.order();
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      let started = false;
      this.pool?.noteUse(t.providerId);
      try {
        for await (const ev of t.provider.stream({ ...req, model: t.model })) {
          // Thử lại / xếp hàng chưa phải là đã bắt đầu trả lời: vẫn còn chuyển được sang đích khác nếu đích này gãy sau khi chờ.
          if (ev.type !== 'retry' && ev.type !== 'queue') started = true;
          yield ev;
        }
        this.lastUsed = t;
        return;
      } catch (err) {
        if (started || i === order.length - 1 || !isSwitchable(err)) throw err;
        this.fail(t, order[i + 1], err);
      }
    }
  }

  async complete(req: CompleteRequest): Promise<string> {
    const order = this.order();
    let lastErr: unknown;
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      this.pool?.noteUse(t.providerId);
      try {
        const text = await t.provider.complete({ ...req, model: t.model });
        this.lastUsed = t;
        return text;
      } catch (err) {
        lastErr = err;
        if (i === order.length - 1 || !isSwitchable(err)) throw err;
        this.fail(t, order[i + 1], err);
      }
    }
    throw lastErr;
  }

  fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.chain[0].provider.fetchModels(signal);
  }

  ping(signal?: AbortSignal): Promise<void> {
    return this.chain[0].provider.ping(signal);
  }
}
