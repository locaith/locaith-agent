import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ArtifactRecord } from '../core/engine/types';
import { htmlPage, LATIN_RANGE, renderArtifactDocumentWithFonts, VI_RANGE } from '../shared/artifactDoc';
import type { Logger } from './logger';


const FONTS: { family: string; pkg: string; weights: number[] }[] = [
  { family: 'Be Vietnam Pro', pkg: 'be-vietnam-pro', weights: [400, 600, 700] },
  { family: 'JetBrains Mono', pkg: 'jetbrains-mono', weights: [400, 700] },
];

let fontCssCache: string | null = null;

/** @font-face nhúng dạng data URI: artifact luôn có Be Vietnam Pro + JetBrains Mono, không cần mạng. */
function fontCss(extensionPath: string): string {
  if (fontCssCache !== null) return fontCssCache;
  const rules: string[] = [];
  for (const f of FONTS) {
    for (const w of f.weights) {
      for (const [subset, range] of [['vietnamese', VI_RANGE], ['latin', LATIN_RANGE]] as const) {
        const file = path.join(extensionPath, 'media', 'fonts', `${f.pkg}-${subset}-${w}-normal.woff2`);
        try {
          const b64 = fs.readFileSync(file).toString('base64');
          rules.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${range}}`);
        } catch {
          /* thiếu font → dùng font hệ thống */
        }
      }
    }
  }
  fontCssCache = rules.join('\n');
  return fontCssCache;
}

/** Nội dung đã bọc + chính sách CSP/sandbox (phần thuần nằm ở shared/artifactDoc.ts; ở đây nạp font từ đĩa). */
export function renderArtifactDocument(rec: Pick<ArtifactRecord, 'type' | 'content' | 'title'>, extensionPath: string): string {
  return renderArtifactDocumentWithFonts(rec, fontCss(extensionPath));
}

const EXT: Record<string, { ext: string; filter: Record<string, string[]> }> = {
  html: { ext: 'html', filter: { HTML: ['html'] } },
  svg: { ext: 'svg', filter: { SVG: ['svg'] } },
  markdown: { ext: 'md', filter: { Markdown: ['md'] } },
};

/** Quản lý các tab xem trước artifact (mỗi artifact một tab, cô lập hoàn toàn khỏi khung chat). */
export class ArtifactPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  open(rec: ArtifactRecord, opts: { preserveFocus?: boolean } = {}): void {
    const existing = this.panels.get(rec.id);
    if (existing) {
      existing.title = rec.title;
      existing.webview.html = renderArtifactDocument(rec, this.extensionUri.fsPath);
      existing.reveal(undefined, opts.preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'locaithAgent.artifact',
      rec.title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: opts.preserveFocus ?? false },
      { enableScripts: rec.type === 'html', retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.webview.html = renderArtifactDocument(rec, this.extensionUri.fsPath);
    panel.onDidDispose(() => this.panels.delete(rec.id));
    this.panels.set(rec.id, panel);
    this.logger.log('info', `Mở artifact "${rec.title}" (${rec.type}, ${rec.content.length} ký tự)`);
  }

  /** Làm mới tab nếu đang mở (khi model cập nhật artifact). */
  refresh(rec: ArtifactRecord): void {
    const p = this.panels.get(rec.id);
    if (!p) return;
    p.title = rec.title;
    p.webview.html = renderArtifactDocument(rec, this.extensionUri.fsPath);
  }

  async save(rec: ArtifactRecord): Promise<void> {
    const spec = EXT[rec.type] ?? EXT.html;
    const safe = rec.title.normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'artifact';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: root ? vscode.Uri.joinPath(root, `${safe}.${spec.ext}`) : undefined,
      filters: spec.filter,
      title: 'Lưu artifact',
    });
    if (!target) return;
    // HTML luôn kèm font nhúng sẵn để mở lại offline vẫn đẹp.
    const body = rec.type === 'html' ? htmlPage(rec.content, fontCss(this.extensionUri.fsPath)) : rec.content;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
    void vscode.window.showInformationMessage(`Đã lưu: ${vscode.workspace.asRelativePath(target)}`);
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}
