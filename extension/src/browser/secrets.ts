/**
 * Kho khoá API của bản trình duyệt.
 *
 * LƯU Ý BẢO MẬT (đã nói rõ trong README và Cài đặt): trình duyệt KHÔNG có kho bí mật gắn với hệ điều hành như SecretStorage của
 * VS Code. Khoá nằm trong `chrome.storage.local` của riêng extension này — các trang web và extension khác không đọc được,
 * nhưng nó KHÔNG được mã hoá trên đĩa. Hồ sơ trình duyệt bị chép đi / máy bị cài mã độc đọc được hồ sơ là lộ khoá.
 * Giảm thiểu: chỉ dùng khoá có hạn mức chi tiêu, và xoá khoá khi không dùng.
 */

import type { KeyValueStore } from './kv';

const KEY = 'nd.keys';

export class BrowserSecrets {
  private cache: Record<string, string> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kv: KeyValueStore) {
    kv.onChanged((keys) => {
      if (!keys.includes(KEY)) return;
      this.cache = null; // đọc lại lần sau (ngữ cảnh khác vừa ghi)
      for (const l of this.listeners) l();
    });
  }

  private async all(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    const raw = await this.kv.get<Record<string, unknown>>(KEY);
    const out: Record<string, string> = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
    this.cache = out;
    return out;
  }

  async get(providerId: string): Promise<string | undefined> {
    return (await this.all())[providerId];
  }

  async set(providerId: string, key: string): Promise<void> {
    const next = { ...(await this.all()), [providerId]: key };
    this.cache = next;
    await this.kv.set(KEY, next);
  }

  async delete(providerId: string): Promise<void> {
    const next = { ...(await this.all()) };
    delete next[providerId];
    this.cache = next;
    await this.kv.set(KEY, next);
  }

  /** Giá trị của mọi khoá — để che trong nhật ký. */
  async values(): Promise<string[]> {
    return Object.values(await this.all());
  }

  onDidChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
