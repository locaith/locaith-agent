/**
 * Kho khoá–giá trị mỏng bao quanh chrome.storage (và bản trong bộ nhớ để kiểm thử), để config/khoá API không gọi chrome.* trực tiếp.
 */

export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Gọi khi một khoá đổi (kể cả do ngữ cảnh khác của extension ghi). Trả hàm huỷ. */
  onChanged(cb: (keys: string[]) => void): () => void;
}

export class ChromeKv implements KeyValueStore {
  constructor(private readonly areaName: 'local' | 'session' = 'local') {}

  private get area(): chrome.storage.StorageArea {
    return chrome.storage[this.areaName];
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.area.get(key);
    return r[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }

  onChanged(cb: (keys: string[]) => void): () => void {
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === this.areaName) cb(Object.keys(changes));
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }
}

export class MemoryKv implements KeyValueStore {
  private readonly data = new Map<string, unknown>();
  private readonly listeners = new Set<(keys: string[]) => void>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
    for (const l of this.listeners) l([key]);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
    for (const l of this.listeners) l([key]);
  }

  onChanged(cb: (keys: string[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
