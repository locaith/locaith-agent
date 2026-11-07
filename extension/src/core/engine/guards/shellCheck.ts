/**
 * Kiểm tra lệnh TRƯỚC khi `run_command` chạy, theo shell THẬT của host (B06, lane:loop-guards).
 *
 * Vì sao có: run_command lỗi 14,7% trong log người dùng Locaith, gấp ~30 lần công cụ khác — gần hết là viết cú pháp bash cho
 * Windows PowerShell 5.1 (`&&`, `grep`, `export`, `rm -rf`, `/dev/null`…). Lời dặn trong prompt không sửa được; một bộ kiểm tra bằng máy
 * thì sửa được: `&&`/`||` đơn giản được VIẾT LẠI thành `; if ($?) { … }`, các lỗi khác được GỢI Ý ngay trong kết quả để model sửa đúng
 * ở lần sau thay vì thử thêm biến thể.
 *
 * Nguyên tắc: KHÔNG được cản lệnh đúng. Mọi phát hiện chỉ nhìn vào phần MÃ của lệnh — chuỗi nháy đơn/kép, here-string, chú thích đã
 * được che (mask) trước — và chỉ xét từ ở VỊ TRÍ LỆNH (đầu dòng, sau `;` `|` `&&` `||` `(` `{`). Nhờ vậy `echo "a && b"`,
 * `Select-String 'grep|tail'`, `git commit -m "head of list"` đều đi qua nguyên vẹn.
 *
 * Hàm thuần: không đụng đĩa, không gọi shell.
 */

import type { Lang } from '../strings';

export type ShellCheckMode = 'off' | 'hint' | 'rewrite';

export type ShellCheckResult =
  | { action: 'ok' }
  /** `&&`/`||` ở mức cao nhất, cấu trúc đơn giản → chạy lệnh đã viết lại; `note` được nối vào đầu kết quả. */
  | { action: 'rewrite'; command: string; note: string }
  /** Vẫn chạy lệnh gốc nhưng nối gợi ý vào đầu kết quả (model thấy ngay cạnh lỗi thật nếu có). */
  | { action: 'hint'; note: string }
  /** Không chạy: lệnh chắc chắn hỏng và không viết lại được an toàn — trả lời có hướng dẫn. */
  | { action: 'block'; message: string };

export interface ShellFinding {
  code: string;
  vi: string;
  en: string;
}

const PS_FAMILY = new Set(['powershell', 'pwsh']);
const POSIX_FAMILY = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

// ─────────────────────────────────────────────────────────────────────────────
// Che chuỗi/chú thích: trả về chuỗi CÙNG ĐỘ DÀI, phần bị che thành khoảng trắng (giữ vị trí để báo lỗi/cắt đoạn đúng chỗ).
// ─────────────────────────────────────────────────────────────────────────────

const isBoundary = (c: string | undefined): boolean => c === undefined || /[\s;|(){}&]/.test(c);

/** PowerShell: '…' (thoát bằng ''), "…" (thoát bằng ` hoặc ""), here-string @"…"@ / @'…'@, chú thích # và <# #>. */
export function maskPowerShell(s: string): string {
  const out = s.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '<' && next === '#') {
      const end = s.indexOf('#>', i + 2);
      const to = end < 0 ? n : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '#' && isBoundary(s[i - 1])) {
      const end = s.indexOf('\n', i);
      const to = end < 0 ? n : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '@' && (next === '"' || next === "'") && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 8))) {
      const close = `\n${next}@`;
      const end = s.indexOf(close, i + 2);
      const to = end < 0 ? n : end + close.length;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '`') {
          j += 2;
          continue;
        }
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Ký tự thoát ngoài chuỗi: `& không phải toán tử.
      blank(i, i + 2);
      i += 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** bash/zsh: '…' (không thoát), "…" (thoát bằng \), $'…', chú thích #, heredoc <<TAG … TAG. */
export function maskPosix(s: string): string {
  const out = s.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '#' && isBoundary(s[i - 1])) {
      const end = s.indexOf('\n', i);
      const to = end < 0 ? n : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const to = end < 0 ? n : end + 1;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      blank(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) {
        const tag = m[2];
        const lineEnd = s.indexOf('\n', i);
        if (lineEnd >= 0) {
          const re = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\n|$)`);
          const rest = s.slice(lineEnd);
          const mm = re.exec(rest);
          const to = mm ? lineEnd + mm.index + mm[0].length : n;
          blank(lineEnd + 1, to);
          i = to;
          continue;
        }
      }
    }
    i++;
  }
  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Toán tử `&&` / `||` ở mức cao nhất (PowerShell 5.1)
// ─────────────────────────────────────────────────────────────────────────────

interface ChainOp {
  index: number;
  op: '&&' | '||';
  depth: number;
}

/** Vị trí các `&&`/`||` trong phần mã (đã che), kèm độ sâu ngoặc tại đó. */
export function findChainOps(masked: string): ChainOp[] {
  const ops: ChainOp[] = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if ((c === '&' || c === '|') && masked[i + 1] === c) {
      // `2>&1`, `>&2` không phải `&&`; `||` thật là hai ký tự liền nhau không có `|` thứ ba.
      ops.push({ index: i, op: c === '&' ? '&&' : '||', depth });
      i++;
    }
  }
  return ops;
}

/**
 * Viết lại `a && b && c` → `a; if ($?) { b; if ($?) { c } }` (và `||` → `if (-not $?)`). Chỉ khi: mọi toán tử ở độ sâu 0, cùng
 * một loại, lệnh một dòng, không có `;` ở mức cao nhất và mỗi đoạn không rỗng. Ngược lại trả `null` (không đoán).
 *
 * Vì sao lồng nhau thay vì nối phẳng: `$?` phản ánh LỆNH CUỐI vừa chạy — sau một `if` không chạy khối, `$?` là của chính câu `if`
 * (đúng), nên dạng phẳng `a; if ($?) { b }; if ($?) { c }` sẽ chạy `c` dù `a` lỗi.
 */
export function rewriteChain(command: string, masked: string, ops: ChainOp[]): string | null {
  if (ops.length === 0) return null;
  if (/\r|\n/.test(masked.trim())) return null;
  if (ops.some((o) => o.depth !== 0)) return null;
  const kind = ops[0].op;
  if (ops.some((o) => o.op !== kind)) return null;
  // `;` ở mức cao nhất → cấu trúc đã phức tạp, để model tự viết.
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return null;
  }
  const parts: string[] = [];
  let from = 0;
  for (const o of ops) {
    parts.push(command.slice(from, o.index).trim());
    from = o.index + 2;
  }
  parts.push(command.slice(from).trim());
  if (parts.some((p) => !p)) return null;
  const cond = kind === '&&' ? '$?' : '-not $?';
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) out = `${parts[i]}; if (${cond}) { ${out} }`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Từ ở vị trí lệnh
// ─────────────────────────────────────────────────────────────────────────────

/** Các đoạn bắt đầu một lệnh: tách phần mã (đã che) tại `;` `|` `&&` `||` xuống dòng `(` `{`. Trả về chuỗi đã cắt đầu. */
export function commandSegments(masked: string): string[] {
  return masked
    .split(/\r?\n|;|\|\||&&|\||\(|\{/)
    .map((seg) => seg.replace(/^[\s&]+/, ''))
    .filter((seg) => seg.length > 0);
}

interface Rule {
  code: string;
  test: (segment: string, masked: string) => boolean;
  vi: string;
  en: string;
}

const first = (seg: string): string => (/^\S+/.exec(seg)?.[0] ?? '').toLowerCase();
const startsWithCmd = (seg: string, names: string[]): boolean => names.includes(first(seg));
const startsWithFlag = (seg: string, name: string): boolean => new RegExp(`^${name}(\\.exe)?\\s+-[a-zA-Z]`, 'i').test(seg);

/** PowerShell (cả 5.1 và 7): thói quen Unix/bash không chạy được, hoặc chạy sai nghĩa vì alias (`rm -rf`, `ls -la`, `curl -s`). */
const PS_RULES: Rule[] = [
  {
    code: 'grep',
    test: (seg) => startsWithCmd(seg, ['grep', 'egrep', 'fgrep']),
    vi: '`grep` không có trong PowerShell — dùng `Select-String -Pattern \'mẫu\'` (thêm `-CaseSensitive` nếu cần), ví dụ `Get-Content file.txt | Select-String \'lỗi\'`.',
    en: '`grep` does not exist in PowerShell — use `Select-String -Pattern \'regex\'`, e.g. `Get-Content file.txt | Select-String \'error\'`.',
  },
  {
    code: 'findstr',
    test: (seg) => startsWithCmd(seg, ['findstr']),
    vi: '`findstr` chạy được nhưng kém chính xác với Unicode/regex — ưu tiên `Select-String \'mẫu\'`.',
    en: '`findstr` works but handles Unicode/regex poorly — prefer `Select-String \'pattern\'`.',
  },
  {
    code: 'head-tail',
    test: (seg) => startsWithCmd(seg, ['head', 'tail']),
    vi: '`head`/`tail` không có trong PowerShell — dùng `Get-Content file -TotalCount N` / `-Tail N`, hoặc `| Select-Object -First N` / `-Last N`.',
    en: '`head`/`tail` do not exist in PowerShell — use `Get-Content file -TotalCount N` / `-Tail N`, or `| Select-Object -First N` / `-Last N`.',
  },
  {
    code: 'cat-flags',
    test: (seg) => startsWithFlag(seg, 'cat'),
    vi: '`cat -n` kiểu Unix không chạy — `cat` là alias của `Get-Content`; dùng `Get-Content file` (đánh số dòng: `Get-Content file | % {$i=1} { "$i`t$_"; $i++ }`).',
    en: 'Unix-style `cat -n` fails — `cat` is an alias of `Get-Content`; use `Get-Content file`.',
  },
  {
    code: 'which',
    test: (seg) => startsWithCmd(seg, ['which', 'whereis']),
    vi: '`which` không có trong PowerShell — dùng `Get-Command tên` (đường dẫn: `(Get-Command tên).Source`).',
    en: '`which` does not exist in PowerShell — use `Get-Command name` (path: `(Get-Command name).Source`).',
  },
  {
    code: 'touch',
    test: (seg) => startsWithCmd(seg, ['touch']),
    vi: '`touch` không có trong PowerShell — dùng `New-Item -ItemType File đường/dẫn` (tệp đã có thì `(Get-Item f).LastWriteTime = Get-Date`).',
    en: '`touch` does not exist in PowerShell — use `New-Item -ItemType File path`.',
  },
  {
    code: 'export',
    test: (seg) => /^export\s+[A-Za-z_][A-Za-z0-9_]*(=|\s|$)/.test(seg),
    vi: '`export NAME=…` là bash — PowerShell dùng `$env:NAME = \'giá trị\'` (chỉ sống trong lệnh này).',
    en: '`export NAME=…` is bash — PowerShell uses `$env:NAME = \'value\'` (lives only for this command).',
  },
  {
    code: 'env-prefix',
    test: (seg) => /^[A-Z_][A-Z0-9_]*=\S*\s+\S/.test(seg),
    vi: 'Gán biến môi trường trước lệnh (`NAME=x lệnh`) là bash — PowerShell: `$env:NAME = \'x\'; lệnh`.',
    en: 'Prefix assignment (`NAME=x cmd`) is bash — PowerShell: `$env:NAME = \'x\'; cmd`.',
  },
  {
    code: 'rm-flags',
    test: (seg) => startsWithFlag(seg, 'rm') || startsWithFlag(seg, 'rmdir'),
    vi: '`rm -rf` không chạy (`rm` là alias của `Remove-Item`, không có tham số `-rf`) — dùng `Remove-Item -Recurse -Force đường/dẫn`.',
    en: '`rm -rf` fails (`rm` is an alias of `Remove-Item`, no `-rf` parameter) — use `Remove-Item -Recurse -Force path`.',
  },
  {
    code: 'ls-flags',
    test: (seg) => startsWithFlag(seg, 'ls'),
    vi: '`ls -la` không chạy (`ls` là alias của `Get-ChildItem`) — dùng `Get-ChildItem -Force` (đệ quy: `-Recurse`).',
    en: '`ls -la` fails (`ls` is an alias of `Get-ChildItem`) — use `Get-ChildItem -Force` (recursive: `-Recurse`).',
  },
  {
    code: 'mkdir-p',
    test: (seg) => /^mkdir\s+-p\b/i.test(seg),
    vi: '`mkdir -p` không chạy — dùng `New-Item -ItemType Directory -Force đường/dẫn`.',
    en: '`mkdir -p` fails — use `New-Item -ItemType Directory -Force path`.',
  },
  {
    code: 'cp-mv-flags',
    test: (seg) => startsWithFlag(seg, 'cp') || startsWithFlag(seg, 'mv'),
    vi: '`cp -r`/`mv -f` kiểu Unix không chạy — dùng `Copy-Item -Recurse` / `Move-Item -Force`.',
    en: 'Unix-style `cp -r`/`mv -f` fail — use `Copy-Item -Recurse` / `Move-Item -Force`.',
  },
  {
    code: 'curl-flags',
    test: (seg) => startsWithFlag(seg, 'curl') || startsWithFlag(seg, 'wget'),
    vi: '`curl -s` trong PowerShell gọi alias `Invoke-WebRequest` và lỗi tham số — dùng `curl.exe -s …` hoặc `Invoke-WebRequest -Uri … -UseBasicParsing`.',
    en: '`curl -s` in PowerShell hits the `Invoke-WebRequest` alias and fails — use `curl.exe -s …` or `Invoke-WebRequest -Uri …`.',
  },
  {
    code: 'test-bracket',
    test: (seg) => /^\[\s+-[a-z]\s/.test(seg) || /^test\s+-[a-z]\s/.test(seg),
    vi: '`[ -f tệp ]`/`test -f` là bash — dùng `Test-Path tệp` (thư mục: `Test-Path tệp -PathType Container`).',
    en: '`[ -f file ]`/`test -f` is bash — use `Test-Path file`.',
  },
  {
    code: 'set-e',
    test: (seg) => /^set\s+-[eux]+\b/.test(seg),
    vi: '`set -e` là bash — PowerShell: `$ErrorActionPreference = \'Stop\'`.',
    en: '`set -e` is bash — PowerShell: `$ErrorActionPreference = \'Stop\'`.',
  },
  {
    code: 'cd-d',
    test: (seg) => /^cd\s+\/d\b/i.test(seg),
    vi: '`cd /d` là cmd.exe — PowerShell: `Set-Location đường/dẫn` (đổi ổ đĩa tự động).',
    en: '`cd /d` is cmd.exe — PowerShell: `Set-Location path`.',
  },
  {
    code: 'sudo',
    test: (seg) => startsWithCmd(seg, ['sudo', 'apt', 'apt-get', 'brew', 'yum']),
    vi: '`sudo`/`apt`/`brew` không có trên Windows — chạy thẳng lệnh, hoặc dùng `winget`/`choco`.',
    en: '`sudo`/`apt`/`brew` do not exist on Windows — run the command directly, or use `winget`/`choco`.',
  },
  {
    code: 'dev-null',
    test: (_seg, masked) => /\/dev\/null/.test(masked),
    vi: '`/dev/null` không tồn tại — dùng `| Out-Null` hoặc `> $null` (lỗi: `2>$null`).',
    en: '`/dev/null` does not exist — use `| Out-Null` or `> $null` (errors: `2>$null`).',
  },
  {
    code: 'heredoc',
    test: (_seg, masked) => /<<-?\s*['"]?[A-Za-z_]\w*/.test(masked),
    vi: 'Heredoc `<<EOF` là bash — PowerShell dùng here-string `@\'` … `\'@` (dòng riêng), hoặc tốt hơn: ghi tệp bằng write_file rồi chạy.',
    en: 'Heredoc `<<EOF` is bash — PowerShell uses here-strings `@\'` … `\'@` on their own lines, or better: write the file with write_file, then run it.',
  },
];

/** Chỉ Windows PowerShell 5.1: `2>&1` với exe gốc bọc stderr thành ErrorRecord (NativeCommandError) và đặt `$?` = false dù exit 0. */
const PS51_RULES: Rule[] = [
  {
    code: 'ps51-stderr',
    test: (_seg, masked) => /2>&1/.test(masked),
    vi: 'Trên PowerShell 5.1, `2>&1` với lệnh exe làm mỗi dòng stderr thành NativeCommandError và `$?` = false dù exit 0 — bỏ `2>&1` (stderr đã được thu sẵn) hoặc thêm `; $LASTEXITCODE` để đọc mã thoát thật.',
    en: 'On PowerShell 5.1, `2>&1` on a native exe wraps each stderr line in NativeCommandError and sets `$?` = false even on exit 0 — drop `2>&1` (stderr is already captured) or append `; $LASTEXITCODE` to read the real exit code.',
  },
];

/** bash/zsh: lệnh PowerShell/cmd ngược lại. */
const POSIX_RULES: Rule[] = [
  {
    code: 'cmdlet',
    test: (seg) => /^(Get|Set|Select|Remove|New|Copy|Move|Test|Invoke|Write|Out|Start|Stop|Where|ForEach|Format|Measure|Sort)-[A-Z][A-Za-z]+\b/.test(seg),
    vi: 'Đây là cmdlet PowerShell — shell này là bash/zsh: dùng `ls`, `grep`, `rm`, `cp`, `cat`, `find`… tương ứng.',
    en: 'That is a PowerShell cmdlet — this shell is bash/zsh: use `ls`, `grep`, `rm`, `cp`, `cat`, `find`… instead.',
  },
  {
    code: 'env-colon',
    test: (_seg, masked) => /\$env:[A-Za-z_]/.test(masked),
    vi: '`$env:NAME` là PowerShell — bash dùng `$NAME` (gán: `export NAME=giá_trị`).',
    en: '`$env:NAME` is PowerShell — bash uses `$NAME` (assign: `export NAME=value`).',
  },
  {
    code: 'ps-if',
    test: (_seg, masked) => /if\s*\(\s*(-not\s+)?\$\?\s*\)/.test(masked),
    vi: '`if ($?) { … }` là PowerShell — bash nối lệnh bằng `&&` / `||`.',
    en: '`if ($?) { … }` is PowerShell — bash chains with `&&` / `||`.',
  },
  {
    code: 'cmd-switch',
    test: (seg) => /^(dir|del|copy|move|rd|rmdir|type|findstr|xcopy|cd)\s+\/[a-z]\b/i.test(seg),
    vi: 'Tham số kiểu cmd.exe (`dir /s`, `del /q`, `cd /d`) không chạy trên bash — dùng `ls -R`, `rm -f`, `cd`.',
    en: 'cmd.exe switches (`dir /s`, `del /q`, `cd /d`) do not work in bash — use `ls -R`, `rm -f`, `cd`.',
  },
  {
    code: 'percent-var',
    test: (_seg, masked) => /%[A-Za-z_][A-Za-z0-9_]*%/.test(masked),
    vi: '`%VAR%` là cmd.exe — bash dùng `$VAR`.',
    en: '`%VAR%` is cmd.exe — bash uses `$VAR`.',
  },
];

/** cmd.exe: cmdlet PowerShell và thói quen bash. */
const CMD_RULES: Rule[] = [
  {
    code: 'cmdlet',
    test: (seg) => /^(Get|Set|Select|Remove|New|Copy|Move|Test|Invoke|Write|Out|Start|Stop)-[A-Z][A-Za-z]+\b/.test(seg),
    vi: 'cmd.exe không có cmdlet PowerShell — dùng `dir`, `findstr`, `del`, `copy`, `type`…, hoặc bọc: `powershell -NoProfile -Command "…"`.',
    en: 'cmd.exe has no PowerShell cmdlets — use `dir`, `findstr`, `del`, `copy`, `type`…, or wrap: `powershell -NoProfile -Command "…"`.',
  },
  {
    code: 'export',
    test: (seg) => /^export\s+[A-Za-z_]/.test(seg),
    vi: '`export` là bash — cmd.exe dùng `set NAME=giá_trị`.',
    en: '`export` is bash — cmd.exe uses `set NAME=value`.',
  },
  {
    code: 'env-colon',
    test: (_seg, masked) => /\$env:[A-Za-z_]/.test(masked),
    vi: '`$env:NAME` là PowerShell — cmd.exe dùng `%NAME%`.',
    en: '`$env:NAME` is PowerShell — cmd.exe uses `%NAME%`.',
  },
  {
    code: 'grep',
    test: (seg) => startsWithCmd(seg, ['grep']),
    vi: '`grep` không có trong cmd.exe — dùng `findstr /i "mẫu" tệp`.',
    en: '`grep` does not exist in cmd.exe — use `findstr /i "pattern" file`.',
  },
  {
    code: 'rm-ls',
    test: (seg) => startsWithFlag(seg, 'rm') || startsWithFlag(seg, 'ls'),
    vi: '`rm -rf`/`ls -la` là Unix — cmd.exe dùng `rmdir /s /q` và `dir /a`.',
    en: '`rm -rf`/`ls -la` are Unix — cmd.exe uses `rmdir /s /q` and `dir /a`.',
  },
];

function applyRules(rules: Rule[], masked: string): ShellFinding[] {
  const out: ShellFinding[] = [];
  const seen = new Set<string>();
  const segments = commandSegments(masked);
  for (const rule of rules) {
    const hit = segments.some((seg) => rule.test(seg, masked));
    if (hit && !seen.has(rule.code)) {
      seen.add(rule.code);
      out.push({ code: rule.code, vi: rule.vi, en: rule.en });
    }
  }
  return out;
}

/** Danh sách phát hiện (chưa quyết định hành động) — dùng cho test và cho `checkShellCommand`. */
export function shellFindings(command: string, shell: string): { masked: string; findings: ShellFinding[]; chain: ChainOp[] } {
  if (PS_FAMILY.has(shell)) {
    const masked = maskPowerShell(command);
    const findings = applyRules(shell === 'powershell' ? [...PS_RULES, ...PS51_RULES] : PS_RULES, masked);
    // `&&`/`||` chỉ là lỗi với Windows PowerShell 5.1; PowerShell 7 có hai toán tử này.
    const chain = shell === 'powershell' ? findChainOps(masked) : [];
    return { masked, findings, chain };
  }
  if (POSIX_FAMILY.has(shell)) {
    const masked = maskPosix(command);
    return { masked, findings: applyRules(POSIX_RULES, masked), chain: [] };
  }
  if (shell === 'cmd') {
    const masked = maskPosix(command);
    return { masked, findings: applyRules(CMD_RULES, masked), chain: [] };
  }
  return { masked: command, findings: [], chain: [] };
}

const LABEL = { vi: '[kiểm tra shell]', en: '[shell check]' } as const;

const SHELL_NAME: Record<string, string> = {
  powershell: 'Windows PowerShell 5.1',
  pwsh: 'PowerShell 7',
  cmd: 'cmd.exe',
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
};

function joinFindings(findings: ShellFinding[], lang: Lang): string {
  return findings.map((f) => `• ${lang === 'en' ? f.en : f.vi}`).join('\n');
}

/**
 * Quyết định cho một lệnh `run_command`. `mode`:
 *   off     → không làm gì;
 *   hint    → chỉ nối gợi ý vào kết quả (kể cả với `&&`), lệnh gốc vẫn chạy;
 *   rewrite → `&&`/`||` đơn giản được viết lại và chạy; `&&`/`||` phức tạp bị CHẶN kèm hướng dẫn; còn lại là gợi ý.
 */
export function checkShellCommand(command: string, shell: string, mode: ShellCheckMode, lang: Lang): ShellCheckResult {
  if (mode === 'off' || !command.trim()) return { action: 'ok' };
  const { masked, findings, chain } = shellFindings(command, shell);
  const label = LABEL[lang];
  const shellName = SHELL_NAME[shell] ?? shell;
  const hints = joinFindings(findings, lang);

  if (chain.length > 0) {
    const chainWhy =
      lang === 'en'
        ? `\`&&\` / \`||\` do not exist in ${shellName} (the command fails to parse). Chain with \`;\`, or \`a; if ($?) { b }\` (\`if (-not $?)\` for \`||\`).`
        : `\`&&\` / \`||\` không có trong ${shellName} (lệnh lỗi ngay khi phân tích). Nối bằng \`;\`, hoặc \`a; if ($?) { b }\` (\`if (-not $?)\` thay cho \`||\`).`;
    if (mode === 'rewrite') {
      const rewritten = rewriteChain(command, masked, chain);
      if (rewritten) {
        const note =
          (lang === 'en'
            ? `${label} Rewrote \`&&\`/\`||\` for ${shellName}; the command that actually ran: ${rewritten}`
            : `${label} Đã tự đổi \`&&\`/\`||\` cho ${shellName}; lệnh thực sự đã chạy: ${rewritten}`) + (hints ? `\n${hints}` : '');
        return { action: 'rewrite', command: rewritten, note };
      }
      const message =
        (lang === 'en'
          ? `${label} The command was NOT run. ${chainWhy} This one could not be rewritten safely (nested, multi-line, mixed operators or \`;\`): rewrite it yourself, or split it into separate run_command calls.`
          : `${label} Lệnh CHƯA chạy. ${chainWhy} Lệnh này không tự viết lại được an toàn (lồng ngoặc, nhiều dòng, trộn toán tử hoặc có \`;\`): hãy tự viết lại, hoặc tách thành nhiều lần run_command.`) +
        (hints ? `\n${hints}` : '');
      return { action: 'block', message };
    }
    return { action: 'hint', note: `${label} ${chainWhy}${hints ? `\n${hints}` : ''}` };
  }

  if (findings.length === 0) return { action: 'ok' };
  const head = lang === 'en' ? `${label} The shell is ${shellName}. If this command failed, this is likely why:` : `${label} Shell đang dùng là ${shellName}. Nếu lệnh lỗi, nhiều khả năng vì:`;
  return { action: 'hint', note: `${head}\n${hints}` };
}
