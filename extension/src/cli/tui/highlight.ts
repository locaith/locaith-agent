/**
 * Tô màu từ khoá cơ bản theo từng dòng cho khối mã (js/ts/py/json/sh/diff + họ C: go, rust, java, c, cpp, cs).
 * Không cần bộ phân tích đầy đủ: duyệt tuần tự chuỗi, chuỗi ký tự, chú thích, số, từ khoá, tên hàm (đứng trước `(`), kiểu (Viết Hoa).
 */

import type { Theme } from './theme';

export type LangKind = 'js' | 'py' | 'json' | 'sh' | 'diff' | 'c' | 'plain';

const ALIAS: Record<string, LangKind> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', javascript: 'js', typescript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  py: 'py', python: 'py', python3: 'py',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh', pwsh: 'sh', cmd: 'sh', bat: 'sh', fish: 'sh',
  diff: 'diff', patch: 'diff',
  go: 'c', golang: 'c', rust: 'c', rs: 'c', java: 'c', c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', kotlin: 'c', swift: 'c', php: 'c',
};

export function langKind(lang: string | undefined): LangKind {
  return ALIAS[(lang ?? '').trim().toLowerCase()] ?? 'plain';
}

const w = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const KEYWORDS: Record<Exclude<LangKind, 'plain' | 'diff'>, Set<string>> = {
  js: w('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set interface type enum implements public private protected readonly abstract as is keyof satisfies declare namespace module this super true false null undefined'),
  py: w('def class return if elif else for while in not and or is import from as with try except finally raise lambda yield pass break continue global nonlocal async await None True False self assert del'),
  json: w('true false null'),
  sh: w('if then else elif fi for while do done case esac function in return export local echo cd exit set unset source alias sudo'),
  c: w('func fn let mut const var return if else for while loop match switch case break continue struct enum impl trait interface class public private protected static final void int long float double bool string char new null nil true false import package use mod pub type go defer chan select range extends implements namespace using this self'),
};

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

export interface HlState {
  inBlock: boolean;
}

export function newHlState(): HlState {
  return { inBlock: false };
}

/** Tô màu một dòng mã. Trả về chuỗi có ANSI (nếu theme có màu). */
export function highlightLine(kind: LangKind, line: string, th: Theme, st: HlState = newHlState()): string {
  if (th.caps.color === 'none' || kind === 'plain') return line;
  const S = th.syntax;
  if (kind === 'diff') {
    if (/^(\+\+\+|---|diff |index )/.test(line)) return th.bold(line);
    if (line.startsWith('@@')) return th.brand(line);
    if (line.startsWith('+')) return th.ok(line);
    if (line.startsWith('-')) return th.err(line);
    return line;
  }
  const kw = KEYWORDS[kind];
  const slashComments = kind === 'js' || kind === 'c' || kind === 'json';
  const hashComments = kind === 'py' || kind === 'sh';
  let out = '';
  let i = 0;
  const n = line.length;
  if (st.inBlock) {
    const e = line.indexOf('*/');
    if (e < 0) return S.comment(line);
    out += S.comment(line.slice(0, e + 2));
    i = e + 2;
    st.inBlock = false;
  }
  while (i < n) {
    const c = line[i];
    const rest = line.slice(i);
    if (slashComments && rest.startsWith('//')) {
      out += S.comment(rest);
      break;
    }
    if (hashComments && c === '#' && (kind === 'py' || i === 0 || /\s/.test(line[i - 1]))) {
      out += S.comment(rest);
      break;
    }
    if (slashComments && rest.startsWith('/*')) {
      const e = line.indexOf('*/', i + 2);
      if (e < 0) {
        out += S.comment(rest);
        st.inBlock = true;
        break;
      }
      out += S.comment(line.slice(i, e + 2));
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      const lit = line.slice(i, Math.min(n, j + 1));
      // khoá JSON: chuỗi đứng trước dấu hai chấm
      const isKey = kind === 'json' && /^\s*:/.test(line.slice(j + 1));
      out += isKey ? S.type(lit) : S.string(lit);
      i = Math.min(n, j + 1);
      continue;
    }
    if (/[0-9]/.test(c) && (i === 0 || !isId(line[i - 1]))) {
      const m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(rest);
      if (m) {
        out += S.number(m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (isIdStart(c) || (kind === 'sh' && c === '$')) {
      let j = i + 1;
      while (j < n && isId(line[j])) j++;
      const word = line.slice(i, j);
      if (kind === 'sh' && c === '$') out += S.type(word);
      else if (kw.has(word)) out += S.keyword(word);
      else if (line[j] === '(' ) out += S.fn(word);
      else if (/^[A-Z][A-Za-z0-9]*$/.test(word) && word.length > 1 && kind !== 'sh') out += S.type(word);
      else if (kind === 'sh' && i === 0) out += S.fn(word);
      else out += word;
      i = j;
      continue;
    }
    if (kind === 'sh' && c === '-' && /^-{1,2}[A-Za-z]/.test(rest)) {
      const m = /^-{1,2}[A-Za-z][\w-]*/.exec(rest)!;
      out += S.number(m[0]);
      i += m[0].length;
      continue;
    }
    if (/[{}()[\];,.:=<>+\-*/%&|!?^~]/.test(c)) {
      out += S.punct(c);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
