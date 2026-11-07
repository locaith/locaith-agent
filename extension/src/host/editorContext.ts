import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditorContextInfo } from '../shared/protocol';
import { selectionLineRange } from '../shared/lineMentions'; // (lane:ide-context)

export interface SelectionInfo {
  rel: string;
  abs: string;
  startLine: number;
  endLine: number;
  text: string;
}

export function relativeToWorkspace(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return uri.fsPath;
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') || '.';
}

/** Theo dõi tệp đang mở và vùng chọn để hiện chip "ngữ cảnh" và đính kèm tự động. */
export class EditorContextTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<EditorContextInfo | null>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** (lane:ide-context) Có gửi kèm tệp/vùng chọn của editor làm ngữ cảnh không (cài đặt `context.editor`, chip «Đang xem» bật/tắt). */
  static contextEnabled(): boolean {
    return vscode.workspace.getConfiguration('locaithAgent').get<boolean>('context.editor', true) !== false;
  }

  /** Bật/tắt từ chip «Đang xem» trong ô nhập (ghi vào cài đặt người dùng, rồi báo lại cho giao diện). */
  async setEnabled(on: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('locaithAgent').update('context.editor', on, vscode.ConfigurationTarget.Global);
    this.refresh();
  }

  /** Báo lại cho giao diện. */
  refresh(): void {
    this.emitter.fire(this.current());
  }

  constructor() {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emitter.fire(this.current()), 150);
    };
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeTextEditorSelection(schedule),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('locaithAgent.context.editor') && schedule()), // (lane:ide-context)
    );
  }

  private editor(): vscode.TextEditor | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.scheme === 'file' ? ed : undefined;
  }

  current(): EditorContextInfo | null {
    const ed = this.editor();
    if (!ed) return null;
    const sel = ed.selection;
    const lines = selectionLineRange(sel.start.line, sel.end.line, sel.end.character);
    return {
      file: relativeToWorkspace(ed.document.uri),
      language: ed.document.languageId,
      selection: sel.isEmpty
        ? undefined
        : { startLine: lines[0], endLine: lines[1], chars: ed.document.getText(sel).length },
      ...(EditorContextTracker.contextEnabled() ? {} : { off: true }),
    };
  }

  selection(): SelectionInfo | null {
    const ed = this.editor();
    if (!ed || ed.selection.isEmpty) return null;
    const lines = selectionLineRange(ed.selection.start.line, ed.selection.end.line, ed.selection.end.character);
    return {
      rel: relativeToWorkspace(ed.document.uri),
      abs: ed.document.uri.fsPath,
      startLine: lines[0],
      endLine: lines[1],
      text: ed.document.getText(ed.selection),
    };
  }

  activeFile(): { rel: string; abs: string } | null {
    const ed = this.editor();
    return ed ? { rel: relativeToWorkspace(ed.document.uri), abs: ed.document.uri.fsPath } : null;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subs.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
