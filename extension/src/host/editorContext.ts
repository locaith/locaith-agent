import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditorContextInfo } from '../shared/protocol';

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

  constructor() {
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emitter.fire(this.current()), 150);
    };
    this.subs.push(vscode.window.onDidChangeActiveTextEditor(schedule), vscode.window.onDidChangeTextEditorSelection(schedule));
  }

  private editor(): vscode.TextEditor | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.scheme === 'file' ? ed : undefined;
  }

  current(): EditorContextInfo | null {
    const ed = this.editor();
    if (!ed) return null;
    const sel = ed.selection;
    return {
      file: relativeToWorkspace(ed.document.uri),
      language: ed.document.languageId,
      selection: sel.isEmpty
        ? undefined
        : { startLine: sel.start.line + 1, endLine: sel.end.line + 1, chars: ed.document.getText(sel).length },
    };
  }

  selection(): SelectionInfo | null {
    const ed = this.editor();
    if (!ed || ed.selection.isEmpty) return null;
    return {
      rel: relativeToWorkspace(ed.document.uri),
      abs: ed.document.uri.fsPath,
      startLine: ed.selection.start.line + 1,
      endLine: ed.selection.end.line + 1,
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
