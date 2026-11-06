/** Cổng đếm bất đồng bộ: giới hạn số việc chạy đồng thời (agent con, lệnh gọi theo từng nhà cung cấp). */
export class Semaphore {
  private n = 0;
  private readonly queue: Array<() => void> = [];

  constructor(public max: number) {}

  get active(): number {
    return this.n;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Chờ tới lượt; trả về hàm nhả. Huỷ bằng `signal` thì ném lỗi 'aborted' và rời hàng đợi. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const grant = () => {
        this.n++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.n--;
          this.pump();
        });
      };
      if (this.n < Math.max(1, this.max)) return grant();
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        grant();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private pump(): void {
    while (this.n < Math.max(1, this.max) && this.queue.length > 0) this.queue.shift()!();
  }
}
