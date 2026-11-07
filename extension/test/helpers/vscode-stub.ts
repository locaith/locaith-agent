// Stub tối thiểu của module 'vscode' để test lớp host bằng Node thuần. Bổ sung khi cần.

/** Test đặt giá trị cài đặt ở từng cấp để kiểm tra việc cài đặt workspace bị bỏ qua đúng chỗ. */
export const settingsStub = {
  global: {} as Record<string, unknown>,
  workspace: {} as Record<string, unknown>,
  reset() {
    this.global = {};
    this.workspace = {};
  },
};

export const workspace = {
  // (0.6.31) Đủ cho test ChatController với deps giả (test/helpers/controllerHarness.ts): workspace tin cậy, chưa có tài liệu mở.
  isTrusted: true,
  name: undefined as string | undefined,
  textDocuments: [] as { uri: { scheme: string; fsPath: string }; isClosed: boolean; isDirty: boolean }[],
  workspaceFolders: undefined as undefined | { uri: { fsPath: string; scheme?: string }; name: string }[],
  getConfiguration: () => ({
    get: <T>(key: string, def?: T): T | undefined => {
      if (key in settingsStub.workspace) return settingsStub.workspace[key] as T;
      if (key in settingsStub.global) return settingsStub.global[key] as T;
      return def;
    },
    inspect: <T>(key: string) => ({
      key,
      defaultValue: undefined as T | undefined,
      globalValue: settingsStub.global[key] as T | undefined,
      workspaceValue: settingsStub.workspace[key] as T | undefined,
      workspaceFolderValue: undefined as T | undefined,
    }),
    // (lane:perm-rules) ghi vào đúng cấp để test kiểm được "lưu vào phạm vi nào".
    update: async (key: string, value: unknown, target?: number) => {
      const bag = target === 1 || target === undefined ? settingsStub.global : settingsStub.workspace;
      if (value === undefined) delete bag[key];
      else bag[key] = value;
    },
  }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
};
export const window = {};
export class Uri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  static file(p: string) {
    return new Uri(p);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri([base.fsPath, ...parts].join('/'));
  }
  toString() {
    return 'file://' + this.fsPath.replace(/\\/g, '/');
  }
}
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export default { workspace, window, Uri, ConfigurationTarget };
