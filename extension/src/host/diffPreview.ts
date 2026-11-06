import * as path from 'node:path';
import * as vscode from 'vscode';

interface Change {
  abs: string;
  rel: string;
  before: string | null;
  after: string;
}

const MAX_RECORDS = 40;
const MAX_CHARS = 2_000_000;

/** Giữ nội dung trước/sau của các thay đổi gần đây để mở diff đầy đủ trong editor của VS Code. */
export class DiffPreview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'nd-agent-diff';
  private readonly records = new Map<string, Change>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DiffPreview.scheme, this);
  }

  record(callId: string, change: Change): void {
    if ((change.before?.length ?? 0) + change.after.length > MAX_CHARS) return;
    this.records.delete(callId);
    this.records.set(callId, change);
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  has(callId: string): boolean {
    return this.records.has(callId);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, callId, side] = uri.path.split('/');
    const rec = this.records.get(callId);
    if (!rec) return '';
    return side === 'before' ? (rec.before ?? '') : rec.after;
  }

  async open(callId: string): Promise<boolean> {
    const rec = this.records.get(callId);
    if (!rec) return false;
    const name = path.basename(rec.rel);
    const left = vscode.Uri.from({ scheme: DiffPreview.scheme, path: `/${callId}/before/${name}` });
    const right = vscode.Uri.from({ scheme: DiffPreview.scheme, path: `/${callId}/after/${name}` });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${rec.rel} — thay đổi của trợ lý AI`, { preview: true });
    return true;
  }

  dispose(): void {
    this.registration.dispose();
    this.records.clear();
  }
}
