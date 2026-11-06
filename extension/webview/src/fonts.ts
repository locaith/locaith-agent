/** Font chữ của giao diện và cách áp vào CSS (biến trên :root). */
import type { UiFontFamily, UiSettings } from '../../src/shared/protocol';

export const FONT_STACKS: Record<UiFontFamily, string> = {
  'be-vietnam-pro': "'Be Vietnam Pro', 'Segoe UI', system-ui, sans-serif",
  manrope: "'Manrope', 'Segoe UI', system-ui, sans-serif",
  inter: "'Inter', 'Segoe UI', system-ui, sans-serif",
  system: "var(--vscode-font-family, 'Segoe UI'), system-ui, sans-serif",
};

/**
 * Hệ số quang học: mỗi họ font có x-height/độ rộng khác nhau nên cùng 14px nhìn to nhỏ khác nhau.
 * Be Vietnam Pro chạy rộng → thu nhẹ; Manrope hơi nhỏ → nới nhẹ. Đo bằng mắt qua ảnh chụp so sánh.
 */
export const FONT_SCALE: Record<UiFontFamily, number> = {
  'be-vietnam-pro': 0.96,
  manrope: 1.02,
  inter: 1,
  system: 1,
};

const CODE_STACK = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";
const EDITOR_CODE_STACK = "var(--vscode-editor-font-family, Consolas, 'Courier New', monospace)";

export function applyUiSettings(s: UiSettings, root: HTMLElement = document.documentElement): void {
  const style = root.style;
  style.setProperty('--nd-font-ui', FONT_STACKS[s.fontFamily] ?? FONT_STACKS['be-vietnam-pro']);
  style.setProperty('--nd-font-code', s.codeFont === 'editor' ? EDITOR_CODE_STACK : CODE_STACK);
  style.setProperty('--nd-font-size', `${s.fontSize}px`);
  style.setProperty('--nd-font-scale', String(FONT_SCALE[s.fontFamily] ?? 1));
  style.setProperty('--nd-line-height', String(s.lineHeight));
  root.lang = s.language;
}
