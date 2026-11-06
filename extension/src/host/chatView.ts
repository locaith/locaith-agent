import * as vscode from 'vscode';
import type { ChatController } from './chatController';
import { chatWebviewOptions, renderChatHtml } from './webviewHtml';

/** Khung chat nằm ở thanh bên (Activity Bar). Controller sống lâu hơn webview: ẩn/hiện không làm mất phiên. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'locaithAgent.chatView';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly lang: () => 'vi' | 'en',
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = chatWebviewOptions(this.extensionUri);
    view.webview.html = renderChatHtml(view.webview, this.extensionUri, this.lang());
    const sub = this.controller.attach(view.webview, () => view.visible);
    // Khi VS Code huỷ rồi dựng lại webview (ẩn/hiện), giao diện tự gửi `ready` và host trả lại toàn bộ trạng thái.
    view.onDidDispose(() => {
      sub.dispose();
      this.controller.detach(view.webview);
      if (this.view === view) this.view = undefined;
    });
  }

  get isOpen(): boolean {
    return this.view !== undefined;
  }
}

/** Các tab chat độc lập ("Mở trợ lý AI trong tab mới"): mỗi tab một controller và một hội thoại riêng. */
export class ChatPanelManager implements vscode.Disposable {
  private readonly panels = new Set<{ panel: vscode.WebviewPanel; controller: ChatController }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly create: () => ChatController,
    private readonly lang: () => 'vi' | 'en',
    private readonly onChanged: () => void,
  ) {}

  open(): ChatController {
    const controller = this.create();
    const panel = vscode.window.createWebviewPanel('locaithAgent.chatPanel', 'Locaith AI', vscode.ViewColumn.Active, chatWebviewOptions(this.extensionUri));
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    panel.webview.html = renderChatHtml(panel.webview, this.extensionUri, this.lang());
    const sub = controller.attach(panel.webview, () => panel.visible);
    const entry = { panel, controller };
    this.panels.add(entry);
    panel.onDidDispose(() => {
      sub.dispose();
      controller.dispose();
      this.panels.delete(entry);
      this.onChanged();
    });
    return controller;
  }

  controllers(): ChatController[] {
    return [...this.panels].map((p) => p.controller);
  }

  dispose(): void {
    for (const p of [...this.panels]) p.panel.dispose();
    this.panels.clear();
  }
}
