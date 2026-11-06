import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * Thư mục webview được đọc tệp. Ngoài `dist` (giao diện), còn có các thư mục workspace, thư mục người dùng và thư mục tạm (0.6.3) để
 * ảnh / GIF / video / âm thanh mà trợ lý làm ra phát được ngay trong khung chat. Host chỉ đưa vào webview những tệp đã kiểm
 * (core/fsutil/mediaPaths.ts) và webview không có đường ra mạng (CSP bên dưới), nên đọc được tệp không có nghĩa là gửi được tệp đi đâu.
 * Đặt MỘT lần lúc tạo khung chat: đổi `localResourceRoots` sau đó làm VS Code nạp lại webview (mất trạng thái giao diện).
 */
export function chatResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  const out = new Map<string, vscode.Uri>();
  const add = (u: vscode.Uri | undefined) => {
    if (u) out.set(u.toString().toLowerCase(), u);
  };
  add(vscode.Uri.joinPath(extensionUri, 'dist'));
  for (const f of vscode.workspace.workspaceFolders ?? []) add(f.uri);
  for (const dir of [safe(() => os.homedir()), safe(() => os.tmpdir())]) if (dir) add(vscode.Uri.file(dir));
  return [...out.values()];
}

function safe(f: () => string): string {
  try {
    return f();
  } catch {
    return '';
  }
}

export function chatWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: chatResourceRoots(extensionUri) };
}

/**
 * Khung HTML của giao diện chat. Chính sách CSP chặt: chỉ chạy script có nonce, không tải gì từ internet
 * (font và ảnh đều nằm trong extension hoặc là tệp cục bộ host đã kiểm) — nên nội dung Markdown do model sinh ra không thể gọi ra ngoài.
 */
export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, lang: 'vi' | 'en'): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', file));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `media-src ${webview.cspSource} blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('main.css')}">
<title>Locaith AI</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
}
