import * as vscode from 'vscode';
import type { Logger } from './logger';

const PREFIX = 'locaithAgent.secret.';

/** Khoá API lưu trong SecretStorage của VS Code (mã hoá bằng kho khoá của hệ điều hành) — không bao giờ gửi sang webview. */
export class SecretsService {
  constructor(
    private readonly storage: vscode.SecretStorage,
    private readonly logger: Logger,
  ) {}

  /** Tên bí mật cho khoá của nhà cung cấp. */
  static provider(id: string): string {
    return `provider.${id}`;
  }

  async get(name: string): Promise<string | undefined> {
    const v = await this.storage.get(PREFIX + name);
    if (v) this.logger.registerSecret(v);
    return v || undefined;
  }

  async set(name: string, value: string): Promise<void> {
    this.logger.registerSecret(value);
    await this.storage.store(PREFIX + name, value.trim());
  }

  async delete(name: string): Promise<void> {
    await this.storage.delete(PREFIX + name);
  }

  async has(name: string): Promise<boolean> {
    return !!(await this.storage.get(PREFIX + name));
  }

  onDidChange(cb: (name: string) => void): vscode.Disposable {
    return this.storage.onDidChange((e) => {
      if (e.key.startsWith(PREFIX)) cb(e.key.slice(PREFIX.length));
    });
  }
}

/** Các khoá tìm kiếm có thể đặt bằng lệnh "Đặt API key…". */
export const SEARCH_KEY_NAMES: { name: string; label: string; url: string }[] = [
  { name: 'search.brave', label: 'Brave Search (tìm kiếm web)', url: 'https://brave.com/search/api/' },
  { name: 'search.tavily', label: 'Tavily (tìm kiếm web)', url: 'https://app.tavily.com/' },
  { name: 'search.serper', label: 'Serper — kết quả Google (tìm kiếm web)', url: 'https://serper.dev/api-key' },
];
