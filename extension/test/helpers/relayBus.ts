/**
 * Relay giả trong bộ nhớ cho kiểm thử: một "kênh quảng bá" mà mọi BusLink nghe được tin của nhau (trừ chính mình — giống `self:false` của Realtime).
 * Ghi lại MỌI tin đi qua (`wire`) — đó chính là những gì người vận hành relay nhìn thấy — và cho phép chèn lỗi (rớt/nhân đôi/trễ).
 */

import type { RelayLink, RelayStatus } from '../../src/core/remote/relayHost';
import type { ClientLink } from '../../src/core/remote/relayClient';

export class RelayBus {
  readonly links = new Set<BusLink>();
  /** Mọi tin đã đi qua kênh, theo thứ tự (bản sao JSON — đúng thứ qua dây). */
  wire: { from: BusLink; msg: any }[] = [];
  /** Trả true để RỚT tin này. */
  drop?: (msg: any, from: BusLink) => boolean;
  /** Trả true để GỬI HAI LẦN tin này. */
  dup?: (msg: any, from: BusLink) => boolean;
  /** Độ trễ giao tin (ms). */
  latency = 0;
  /** Cộng thêm một độ trễ NGẪU NHIÊN 0..jitter ms cho từng tin → tin tới lộn thứ tự (giống Supabase Realtime thật khi gửi dồn). */
  jitter = 0;

  link(name = 'link'): BusLink {
    return new BusLink(this, name);
  }

  deliver(from: BusLink, msg: object): boolean {
    const copy = JSON.parse(JSON.stringify(msg));
    this.wire.push({ from, msg: copy });
    if (this.drop?.(copy, from)) return true; // người gửi không biết tin bị rớt
    const times = this.dup?.(copy, from) ? 2 : 1;
    for (let i = 0; i < times; i++) {
      for (const l of this.links) {
        if (l === from || !l.up) continue;
        const m = JSON.parse(JSON.stringify(copy));
        setTimeout(() => l.receive(m), this.latency + (this.jitter ? Math.random() * this.jitter : 0));
      }
    }
    return true;
  }

  /** Toàn bộ nội dung trên dây dưới dạng một chuỗi (để kiểm "không lộ bản rõ"). */
  wireText(): string {
    return JSON.stringify(this.wire.map((w) => w.msg));
  }
}

/** Vừa là RelayLink (phía host) vừa là ClientLink (phía trình duyệt). */
export class BusLink implements RelayLink, ClientLink {
  status: RelayStatus = 'idle';
  up = false;
  tracked?: object;
  private readonly msgCbs = new Set<(m: unknown) => void>();
  private readonly stCbs = new Set<(s: RelayStatus) => void>();
  private readonly linkCbs = new Set<(up: boolean) => void>();

  constructor(
    private readonly bus: RelayBus,
    readonly name: string,
  ) {}

  start(): void {
    this.bus.links.add(this);
    this.setUp(true);
  }
  stop(): void {
    this.bus.links.delete(this);
    this.up = false;
    this.setStatus('idle');
  }
  /** Mô phỏng mất/có lại kết nối. */
  setUp(up: boolean): void {
    this.up = up;
    this.setStatus(up ? 'online' : 'offline');
    for (const cb of [...this.linkCbs]) cb(up);
  }
  private setStatus(s: RelayStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of [...this.stCbs]) cb(s);
  }
  send(msg: object): boolean {
    if (!this.up) return false;
    return this.bus.deliver(this, msg);
  }
  track(meta: object): void {
    this.tracked = meta;
  }
  onMessage(cb: (m: unknown) => void): () => void {
    this.msgCbs.add(cb);
    return () => void this.msgCbs.delete(cb);
  }
  onStatus(cb: (s: RelayStatus) => void): () => void {
    this.stCbs.add(cb);
    return () => void this.stCbs.delete(cb);
  }
  onLink(cb: (up: boolean) => void): () => void {
    this.linkCbs.add(cb);
    return () => void this.linkCbs.delete(cb);
  }
  receive(m: unknown): void {
    for (const cb of [...this.msgCbs]) cb(m);
  }
}
