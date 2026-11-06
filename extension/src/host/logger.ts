import * as vscode from 'vscode';
import type { LogLevel } from '../core/types';
import { maskSecrets } from '../shared/maskSecrets';

export { maskSecrets };

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Locaith AI');
  private readonly secrets = new Set<string>();

  /** Đăng ký giá trị khoá để che chính xác (ngoài các mẫu chung). */
  registerSecret(value: string | undefined): void {
    if (value && value.length >= 8) this.secrets.add(value);
  }

  log(level: LogLevel, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`[${ts}] [${level.toUpperCase()}] ${maskSecrets(message, this.secrets)}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
