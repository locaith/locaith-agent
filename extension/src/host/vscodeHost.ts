import * as vscode from 'vscode';
import { normalizeForCompare } from '../core/fsutil/paths';
import type { PermissionDecision } from '../core/engine/types';
import { NodeToolHost } from '../core/host/nodeHost';
import type { PermissionRequest } from '../shared/protocol';
import type { ConfigService } from './config';
import type { DiffPreview } from './diffPreview';
import type { Logger } from './logger';
import type { SecretsService } from './secrets';

export interface VsCodeHostDeps {
  config: ConfigService;
  secrets: SecretsService;
  logger: Logger;
  diffs: DiffPreview;
  /** Thư mục kỹ năng ngoài workspace được phép đọc. */
  extraRoots: () => string[];
  /** Xin phép người dùng (do ChatController cài đặt). */
  askPermission: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;
}

/**
 * ToolHost chạy trong VS Code: dùng Node cho đĩa/terminal (nhanh, không phụ thuộc API), nhưng đọc/ghi
 * ưu tiên nội dung đang mở trong editor để không bao giờ làm việc trên bản cũ và không phá undo của người dùng.
 */
export class VsCodeToolHost extends NodeToolHost {
  constructor(private readonly deps: VsCodeHostDeps) {
    super({ roots: [], shellPreference: deps.config.get<string>('terminal.shell', 'auto') });
  }

  override workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  override extraReadRoots(): string[] {
    return this.deps.extraRoots();
  }

  private openDoc(abs: string): vscode.TextDocument | undefined {
    const key = normalizeForCompare(abs);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && normalizeForCompare(d.uri.fsPath) === key);
  }

  override async readText(abs: string): Promise<string | null> {
    const doc = this.openDoc(abs);
    if (doc?.isDirty) return doc.getText(); // bản chưa lưu mới là sự thật người dùng đang nhìn
    return super.readText(abs);
  }

  override async writeText(abs: string, content: string): Promise<void> {
    const doc = this.openDoc(abs);
    if (doc) {
      // Qua WorkspaceEdit để editor cập nhật tại chỗ, giữ lịch sử hoàn tác (Ctrl+Z) của người dùng.
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
      if (await vscode.workspace.applyEdit(edit)) {
        await doc.save();
        return;
      }
    }
    await super.writeText(abs, content);
  }

  override setting<T>(key: string, fallback: T): T {
    return this.deps.config.get<T>(key, fallback);
  }

  override secret(name: string): Promise<string | undefined> {
    return this.deps.secrets.get(name);
  }

  override requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    return this.deps.askPermission(req, signal);
  }

  override log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (level === 'debug' && !this.deps.config.debug()) return;
    this.deps.logger.log(level, message);
  }

  recordFileChange(callId: string, change: { abs: string; rel: string; before: string | null; after: string }): void {
    this.deps.diffs.record(callId, change);
  }
}
