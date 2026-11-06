/**
 * Giao diện dùng chung được viết cho webview VS Code nên lấy màu từ biến `--vscode-*`. Ở trình duyệt ta tự định nghĩa các biến đó
 * (sáng/tối theo hệ điều hành) và gắn lớp `vscode-light` / `vscode-dark` lên <body> như VS Code vẫn làm.
 */

type Vars = Record<string, string>;

const DARK: Vars = {
  foreground: '#e3e3e3',
  descriptionForeground: '#a0a0a8',
  'editor-background': '#1b1b1f',
  'editor-foreground': '#e3e3e3',
  'sideBar-background': '#1b1b1f',
  'panel-border': '#34343b',
  'input-background': '#26262c',
  'input-foreground': '#e3e3e3',
  'input-border': '#3d3d45',
  'input-placeholderForeground': '#9a9aa3',
  focusBorder: '#a89bff',
  'textLink-foreground': '#a89bff',
  'textCodeBlock-background': '#26262c',
  'textPreformat-foreground': '#d8d8de',
  'textPreformat-background': '#32323a',
  'editorWidget-background': '#232328',
  'editorWidget-border': '#44444d',
  'widget-shadow': 'rgba(0,0,0,0.45)',
  errorForeground: '#ff7b72',
  'editorWarning-foreground': '#e0a800',
};

const LIGHT: Vars = {
  foreground: '#26262b',
  descriptionForeground: '#666672',
  'editor-background': '#ffffff',
  'editor-foreground': '#26262b',
  'sideBar-background': '#ffffff',
  'panel-border': '#e4e4ea',
  'input-background': '#ffffff',
  'input-foreground': '#26262b',
  'input-border': '#cfcfd8',
  'input-placeholderForeground': '#74747f',
  focusBorder: '#5138ee',
  'textLink-foreground': '#5138ee',
  'textCodeBlock-background': '#f3f3f7',
  'textPreformat-foreground': '#26262b',
  'textPreformat-background': '#ececf2',
  'editorWidget-background': '#ffffff',
  'editorWidget-border': '#d5d5de',
  'widget-shadow': 'rgba(20,20,40,0.16)',
  errorForeground: '#cf222e',
  'editorWarning-foreground': '#9a6700',
};

export function themeCss(dark: boolean): string {
  const vars = dark ? DARK : LIGHT;
  return `:root{color-scheme:${dark ? 'dark' : 'light'};${Object.entries(vars)
    .map(([k, v]) => `--vscode-${k}:${v}`)
    .join(';')}}`;
}

export function applyTheme(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let style = document.getElementById('nd-theme') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'nd-theme';
    document.head.append(style);
  }
  const apply = () => {
    style!.textContent = themeCss(mq.matches);
    document.body.classList.toggle('vscode-dark', mq.matches);
    document.body.classList.toggle('vscode-light', !mq.matches);
    document.body.classList.add('nd-browser');
  };
  apply();
  mq.addEventListener('change', apply);
}
