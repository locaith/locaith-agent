/** Tô màu cú pháp bằng highlight.js (chỉ nạp ~22 ngôn ngữ thông dụng để giữ gói nhẹ). */
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const REGISTER: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(REGISTER)) hljs.registerLanguage(name, def);

const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsonc: 'json',
  json5: 'json',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  yml: 'yaml',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  golang: 'go',
  rs: 'rust',
  md: 'markdown',
  docker: 'dockerfile',
  toml: 'ini',
  scss: 'css',
  less: 'css',
  patch: 'diff',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  sqlite: 'sql',
};

/** Tên ngôn ngữ chuẩn của highlight.js, hoặc null nếu không hỗ trợ. */
export function resolveLang(lang: string | undefined): string | null {
  const key = (lang ?? '').trim().toLowerCase().split(/[\s{:,]/)[0];
  if (!key) return null;
  const name = ALIASES[key] ?? key;
  return hljs.getLanguage(name) ? name : null;
}

const SHELL_OR_TEXT = new Set(['bash', 'powershell', 'diff']);

/** Đoạn mã này có nên hiện nút "Áp dụng" (chèn/thay/tạo tệp)? Lệnh shell và diff thì không. */
export function isApplicable(lang: string | undefined): boolean {
  const name = resolveLang(lang);
  return name !== null && !SHELL_OR_TEXT.has(name);
}

/** Nhãn ngôn ngữ hiển thị ở đầu khối mã. */
export function langLabel(lang: string | undefined, fallback: string): string {
  const raw = (lang ?? '').trim().split(/[\s{:,]/)[0];
  return raw ? raw.toLowerCase() : fallback;
}

/** HTML đã tô màu (chỉ gồm <span class>), hoặc null để hiển thị văn bản thường. */
export function highlight(code: string, lang: string | undefined): string | null {
  const name = resolveLang(lang);
  if (!name) return null;
  try {
    const html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    // highlight.js đã tự thoát ký tự; DOMPurify là lớp bảo vệ thứ hai, chỉ cho phép <span class>.
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
  } catch {
    return null;
  }
}
