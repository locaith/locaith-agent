import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CUSTOM_PRESETS } from '../core/providers';
import type { AttachmentInfo } from '../shared/protocol';
import type { ChatController } from './chatController';
import type { ChatPanelManager } from './chatView';
import { isAllowedBaseUrl, type ConfigService } from './config';
import { relativeToWorkspace, type EditorContextTracker } from './editorContext';
import type { Logger } from './logger';
import type { ProviderService } from './providerService';
import { SecretsService, SEARCH_KEY_NAMES } from './secrets';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  config: ConfigService;
  secrets: SecretsService;
  providers: ProviderService;
  editor: EditorContextTracker;
  sidebar: ChatController;
  panels: ChatPanelManager;
  allControllers: () => ChatController[];
  reloadSkills: () => Promise<void>;
  afterProvidersChanged: () => Promise<void>;
}

const PROJECT_TEMPLATE = `# Hướng dẫn dự án cho trợ lý AI

> Trợ lý đọc tệp này ở đầu mỗi cuộc trò chuyện. Giữ ngắn gọn, chỉ ghi những gì KHÔNG thể suy ra từ mã nguồn.

## Tổng quan
- Dự án này làm gì, người dùng là ai.

## Lệnh thường dùng
- Cài đặt: \`...\`
- Chạy thử: \`...\`
- Kiểm tra (lint / test / build): \`...\`

## Quy ước
- Ngôn ngữ chú thích và thông báo cho người dùng: tiếng Việt có dấu đầy đủ.
- Cách đặt tên, cấu trúc thư mục, thư viện ưu tiên dùng.

## Lưu ý
- Việc không được làm, khu vực nhạy cảm, hành vi bất ngờ cần biết.
`;

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function selectionAttachment(editor: EditorContextTracker): AttachmentInfo | null {
  const sel = editor.selection();
  if (!sel) return null;
  return { kind: 'selection', label: `${path.basename(sel.rel)}:${sel.startLine}-${sel.endLine}`, path: sel.rel, range: [sel.startLine, sel.endLine] };
}

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  const vi = () => d.config.language() === 'vi';

  const focusSidebar = async () => {
    await vscode.commands.executeCommand('locaithAgent.chatView.focus');
    d.sidebar.focus();
  };

  const pickProviderForKey = async (): Promise<{ kind: 'provider' | 'search'; id: string; label: string } | undefined> => {
    // Họ mô hình Locaith dùng token đăng nhập tài khoản, không có «API key» để đặt.
    const descriptors = (await d.providers.registry.descriptors()).filter((p) => !p.account);
    const items: (vscode.QuickPickItem & { kind2?: 'provider' | 'search'; id?: string })[] = [
      ...descriptors.map((p) => ({ label: p.label, description: p.hasKey ? (p.keyFromEnv ? (vi() ? 'đang dùng khoá từ biến môi trường' : 'using env var key') : vi() ? 'đã có khoá' : 'key set') : '', detail: p.keyUrl, kind2: 'provider' as const, id: p.id })),
      { label: vi() ? 'Tìm kiếm web' : 'Web search', kind: vscode.QuickPickItemKind.Separator },
      ...SEARCH_KEY_NAMES.map((s) => ({ label: s.label, detail: s.url, kind2: 'search' as const, id: s.name })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: vi() ? 'Chọn dịch vụ để đặt API key' : 'Choose a service to set an API key', matchOnDetail: true });
    return pick?.id && pick.kind2 ? { kind: pick.kind2, id: pick.id, label: pick.label } : undefined;
  };

  return [
    reg('locaithAgent.open', focusSidebar),

    reg('locaithAgent.openInTab', () => {
      d.panels.open();
    }),

    reg('locaithAgent.newChat', async () => {
      await focusSidebar();
      await d.sidebar.startNewSession();
    }),

    reg('locaithAgent.showHistory', async () => {
      await vscode.commands.executeCommand('locaithAgent.chatView.focus');
      await d.sidebar.showScreen('history');
    }),

    reg('locaithAgent.openMarket', async () => {
      await vscode.commands.executeCommand('locaithAgent.chatView.focus');
      await d.sidebar.showScreen('market');
    }),

    reg('locaithAgent.openSettings', async () => {
      await vscode.commands.executeCommand('locaithAgent.chatView.focus');
      await d.sidebar.showScreen('settings');
    }),

    reg('locaithAgent.stop', () => d.allControllers().forEach((c) => c.stop())),

    reg('locaithAgent.addSelectionToChat', async () => {
      const att = selectionAttachment(d.editor);
      if (!att) return void vscode.window.showInformationMessage(vi() ? 'Hãy chọn một đoạn mã trước.' : 'Select some code first.');
      await focusSidebar();
      d.sidebar.insert(undefined, [att]);
    }),

    reg('locaithAgent.addFileToChat', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') return;
      let isDir = false;
      try {
        isDir = ((await vscode.workspace.fs.stat(target)).type & vscode.FileType.Directory) !== 0;
      } catch {
        /* coi như tệp */
      }
      const rel = relativeToWorkspace(target);
      await focusSidebar();
      d.sidebar.insert(undefined, [{ kind: isDir ? 'folder' : 'file', label: path.basename(rel) || rel, path: rel }]);
    }),

    reg('locaithAgent.explainSelection', async () => {
      const att = selectionAttachment(d.editor);
      if (!att) return void vscode.window.showInformationMessage(vi() ? 'Hãy chọn một đoạn mã trước.' : 'Select some code first.');
      await focusSidebar();
      await d.sidebar.ask(vi() ? 'Giải thích đoạn mã này: nó làm gì, các điểm đáng chú ý và rủi ro (nếu có).' : 'Explain this code: what it does, notable points and risks (if any).', [att]);
    }),

    reg('locaithAgent.fixSelection', async () => {
      const att = selectionAttachment(d.editor);
      if (!att) return void vscode.window.showInformationMessage(vi() ? 'Hãy chọn một đoạn mã trước.' : 'Select some code first.');
      await focusSidebar();
      await d.sidebar.ask(
        vi() ? 'Tìm lỗi trong đoạn mã này và sửa trực tiếp trong tệp. Giải thích ngắn gọn nguyên nhân và cách sửa.' : 'Find bugs in this code and fix them directly in the file. Briefly explain the cause and the fix.',
        [att],
      );
    }),

    reg('locaithAgent.setApiKey', async () => {
      const target = await pickProviderForKey();
      if (!target) return;
      const key = await vscode.window.showInputBox({
        title: `${vi() ? 'API key cho' : 'API key for'} ${target.label}`,
        prompt: vi() ? 'Dán khoá API. Khoá được lưu trong kho bí mật của VS Code, không ghi ra tệp cài đặt.' : 'Paste the API key. It is stored in VS Code secret storage, not in settings files.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/\s/.test(v) ? (vi() ? 'Khoá không được chứa khoảng trắng' : 'Key must not contain whitespace') : undefined),
      });
      if (!key) return;
      await d.secrets.set(target.kind === 'provider' ? SecretsService.provider(target.id) : target.id, key.trim());
      if (target.kind === 'provider') {
        d.providers.registry.catalog.invalidate(target.id);
        await d.providers.refresh([target.id], true);
      }
      await d.afterProvidersChanged();
      void vscode.window.showInformationMessage(vi() ? `Đã lưu API key cho ${target.label}.` : `Saved the API key for ${target.label}.`);
    }),

    reg('locaithAgent.clearApiKey', async () => {
      const descriptors = (await d.providers.registry.descriptors()).filter((p) => p.hasKey && !p.keyFromEnv && !p.account);
      if (descriptors.length === 0) return void vscode.window.showInformationMessage(vi() ? 'Chưa có API key nào được lưu.' : 'No stored API keys.');
      const pick = await vscode.window.showQuickPick(
        descriptors.map((p) => ({ label: p.label, id: p.id })),
        { title: vi() ? 'Xoá API key của…' : 'Remove the API key of…' },
      );
      if (!pick) return;
      await d.secrets.delete(SecretsService.provider(pick.id));
      d.providers.registry.catalog.invalidate(pick.id);
      await d.afterProvidersChanged();
    }),

    reg('locaithAgent.addCustomProvider', async () => {
      const items = [
        ...CUSTOM_PRESETS.map((p) => ({ label: p.label, description: p.baseUrl, detail: p.note, preset: p })),
        { label: vi() ? '$(add) Khác — tự nhập URL…' : '$(add) Other — enter a URL…', preset: undefined },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: vi() ? 'Thêm API tương thích OpenAI' : 'Add an OpenAI-compatible API',
        placeHolder: vi() ? 'Chọn dịch vụ có sẵn hoặc tự nhập URL' : 'Pick a service or enter a URL',
      });
      if (!pick) return;
      const preset = pick.preset;

      const label = await vscode.window.showInputBox({ title: vi() ? 'Tên hiển thị' : 'Display name', value: preset?.label ?? '', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : vi() ? 'Không được để trống' : 'Required') });
      if (!label) return;
      const baseUrl = await vscode.window.showInputBox({
        title: vi() ? 'URL gốc của API (thường kết thúc bằng /v1)' : 'API base URL (usually ends with /v1)',
        value: preset?.baseUrl ?? 'https://',
        ignoreFocusOut: true,
        validateInput: (v) =>
          isAllowedBaseUrl(v)
            ? undefined
            : vi()
              ? 'Cần là URL https hợp lệ (http chỉ cho localhost / mạng nội bộ) và không chứa tên đăng nhập'
              : 'Must be a valid https URL (http only for localhost / private network) without credentials',
      });
      if (!baseUrl) return;
      const key = await vscode.window.showInputBox({
        title: vi() ? 'API key' : 'API key',
        prompt: preset && !preset.requiresKey ? (vi() ? 'Máy cục bộ thường không cần khoá — có thể để trống.' : 'Local servers usually need no key — leave empty.') : vi() ? 'Dán khoá API (lưu trong kho bí mật của VS Code).' : 'Paste the API key (stored in secret storage).',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      const models = await vscode.window.showInputBox({
        title: vi() ? 'Model muốn ghim sẵn (tuỳ chọn)' : 'Models to pin (optional)',
        prompt: vi() ? 'Cách nhau dấu phẩy. Để trống = tự lấy danh sách từ API.' : 'Comma-separated. Empty = fetch the list from the API.',
        ignoreFocusOut: true,
      });
      if (models === undefined) return;

      const existing = d.config.customProviders();
      const taken = new Set([...d.providers.registry.ids(), ...existing.map((c) => c.id)]);
      const base = preset?.id ?? (slug(label) || 'custom');
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

      await d.config.setCustomProviders([
        ...existing,
        { id, label: label.trim(), kind: 'openai-chat', baseUrl: baseUrl.trim().replace(/\/+$/, ''), models: models.split(',').map((s) => s.trim()).filter(Boolean), requiresKey: preset?.requiresKey ?? !!key, keyUrl: preset?.keyUrl },
      ]);
      if (key.trim()) await d.secrets.set(SecretsService.provider(id), key.trim());
      d.providers.reconfigure();
      await d.providers.refresh([id], true);
      await d.afterProvidersChanged();
      void vscode.window.showInformationMessage(vi() ? `Đã thêm "${label}". Chọn model của nó trong danh sách model.` : `Added "${label}". Pick its model in the model list.`);
    }),

    reg('locaithAgent.selectModel', async () => {
      await d.providers.refresh();
      const summaries = await d.providers.summaries();
      const current = d.sidebar.currentModel;
      const items: (vscode.QuickPickItem & { provider?: string; model?: string })[] = [];
      for (const p of summaries) {
        if (!p.hasKey) continue;
        items.push({ label: p.label, kind: vscode.QuickPickItemKind.Separator });
        for (const m of p.models) {
          items.push({
            label: `${p.id === current.provider && m.id === current.model ? '$(check) ' : ''}${m.label}`,
            description: m.id,
            detail: [m.tier === 'top' ? (vi() ? 'mạnh nhất' : 'most capable') : m.tier === 'fast' ? (vi() ? 'nhanh, rẻ' : 'fast, cheap') : '', m.contextWindow ? `${Math.round(m.contextWindow / 1000).toLocaleString('vi-VN')}K token` : ''].filter(Boolean).join(' · '),
            provider: p.id,
            model: m.id,
          });
        }
      }
      if (items.length === 0) return void vscode.window.showInformationMessage(vi() ? 'Chưa có nhà cung cấp nào có API key. Dùng "Đặt API key…".' : 'No provider has an API key yet. Use "Set API key…".', vi() ? 'Đặt API key' : 'Set API key').then((c) => c && vscode.commands.executeCommand('locaithAgent.setApiKey'));
      const pick = await vscode.window.showQuickPick(items, { title: vi() ? 'Chọn model' : 'Choose a model', matchOnDescription: true, matchOnDetail: true });
      if (pick?.provider && pick.model) await d.sidebar.setModel(pick.provider, pick.model);
    }),

    reg('locaithAgent.refreshModels', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vi() ? 'Đang làm mới danh sách model…' : 'Refreshing model lists…' }, () => d.providers.refresh(undefined, true));
      await d.afterProvidersChanged();
    }),

    reg('locaithAgent.reloadSkills', async () => {
      await d.reloadSkills();
      void vscode.window.showInformationMessage(vi() ? 'Đã nạp lại kỹ năng.' : 'Skills reloaded.');
    }),

    reg('locaithAgent.initProjectFile', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) return void vscode.window.showWarningMessage(vi() ? 'Hãy mở một thư mục (workspace) trước.' : 'Open a folder first.');
      const target = vscode.Uri.joinPath(root, 'LOCAITH.md');
      try {
        await vscode.workspace.fs.stat(target);
      } catch {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(PROJECT_TEMPLATE));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    }),

    reg('locaithAgent.exportChat', () => d.sidebar.exportChat()),

    reg('locaithAgent.showLogs', () => d.logger.show()),
  ];
}

/** Các thư mục kỹ năng được quét: workspace và thư mục người dùng (tương thích `.claude/skills`). */
export function skillDirectories(config: ConfigService, extraDirs: string[] = []): { path: string; source: 'workspace' | 'user' }[] {
  const out: { path: string; source: 'workspace' | 'user' }[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== 'file') continue;
    out.push({ path: path.join(f.uri.fsPath, '.locaith', 'skills'), source: 'workspace' }, { path: path.join(f.uri.fsPath, '.claude', 'skills'), source: 'workspace' });
  }
  const home = os.homedir();
  out.push({ path: path.join(home, '.locaith', 'skills'), source: 'user' }, { path: path.join(home, '.claude', 'skills'), source: 'user' });
  for (const p of config.skillPaths()) if (p.trim()) out.push({ path: p.trim().replace(/^~(?=$|[\\/])/, home), source: 'user' });
  // Kỹ năng do plugin đang bật đóng góp.
  for (const p of extraDirs) if (p.trim()) out.push({ path: p, source: 'user' });
  return out;
}
