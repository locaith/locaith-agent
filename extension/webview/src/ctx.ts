import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { EditorContextInfo, UiSettings } from '../../src/shared/protocol';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/protocol';
import { makeT, type Lang, type TFn } from './i18n';

export interface AppContextValue {
  lang: Lang;
  t: TFn;
  settings: UiSettings;
  editor: EditorContextInfo | null;
  folders: string[];
  /** Có vùng chọn trong editor → bật nút "Thay vùng chọn" ở khối mã. */
  hasSelection: boolean;
  /** Bề mặt đang chạy: 'vscode' hoặc 'browser' (Chrome/Edge). */
  platform: 'vscode' | 'browser';
  openSettings(): void;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
}

export const AppContext = createContext<AppContextValue>({
  lang: 'vi',
  t: makeT('vi'),
  settings: DEFAULT_UI_SETTINGS,
  editor: null,
  folders: [],
  hasSelection: false,
  platform: 'vscode',
  openSettings: () => {},
  toast: () => {},
});

export function useApp(): AppContextValue {
  return useContext(AppContext);
}
