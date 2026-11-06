import * as vscode from 'vscode';
import { BaseSessionStore, type PersistedSession, type StoreIO } from '../shared/sessionStore';

export type { PersistedSession, StoreIO };

export function vscodeStoreIO(storageUri: vscode.Uri): StoreIO {
  const dir = vscode.Uri.joinPath(storageUri, 'sessions');
  const at = (name: string) => vscode.Uri.joinPath(dir, name);
  const fsApi = vscode.workspace.fs;
  return {
    read: async (name) => fsApi.readFile(at(name)),
    async write(name, data) {
      await fsApi.createDirectory(dir);
      const tmp = at(`${name}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
      await fsApi.writeFile(tmp, data);
      await fsApi.rename(tmp, at(name), { overwrite: true });
    },
    async remove(name) {
      await fsApi.delete(at(name)).then(undefined, () => undefined);
    },
    async names() {
      try {
        return (await fsApi.readDirectory(dir)).filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => name);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Lưu hội thoại vào thư mục lưu trữ toàn cục của extension: `sessions/<id>.json` + `index.json`.
 * Logic chỉ mục/hợp nhất nằm ở `BaseSessionStore` (dùng chung với bản trình duyệt).
 */
export class SessionStore extends BaseSessionStore {
  constructor(storageUri: vscode.Uri | undefined, workspaceKey: string, io?: StoreIO, workspaceName?: string) {
    super(io ?? vscodeStoreIO(storageUri as vscode.Uri), workspaceKey, workspaceName);
  }
}
