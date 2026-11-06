import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { chatResourceRoots, renderChatHtml } from '../src/host/webviewHtml';

/**
 * (0.6.3) Video / âm thanh kết quả phát ngay trong khung chat: CSP thêm `media-src` (chỉ nguồn của webview, không mạng) và webview được đọc
 * thư mục workspace, thư mục người dùng, thư mục tạm. Mọi thứ khác của CSP giữ nguyên chặt.
 */
const stubWs = (vscode as unknown as { workspace: { workspaceFolders: unknown } }).workspace;

afterEach(() => {
  stubWs.workspaceFolders = undefined;
});

describe('khung HTML của khung chat', () => {
  it('CSP: media-src chỉ từ nguồn webview; không mạng, không eval, script phải có nonce', () => {
    const webview = { cspSource: 'https://*.vscode-cdn.net', asWebviewUri: (u: { fsPath: string }) => `https://file.vscode-cdn.net/${u.fsPath}` };
    const html = renderChatHtml(webview as never, vscode.Uri.file('/ext') as never, 'vi');
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('media-src https://*.vscode-cdn.net blob:');
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/unsafe-eval|https?:\/\/(?!\*\.vscode-cdn\.net)|connect-src|\*(?!\.vscode-cdn)/);
  });

  it('webview đọc được: dist của extension, thư mục workspace, thư mục người dùng, thư mục tạm', () => {
    stubWs.workspaceFolders = [{ uri: vscode.Uri.file('C:/du-an'), name: 'du-an' }];
    const roots = chatResourceRoots(vscode.Uri.file('/ext') as never).map((u) => (u as unknown as { fsPath: string }).fsPath);
    expect(roots).toEqual(['/ext/dist', 'C:/du-an', os.homedir(), os.tmpdir()].filter((v, i, a) => a.indexOf(v) === i));
  });
});
