/**
 * Kho lệnh THỰC cho bộ kiểm tra shell (B06, lane:loop-guards). Hai bất biến:
 *   1. lệnh ĐÚNG với shell đó đi qua nguyên vẹn (không chặn nhầm — kể cả `&&` trong chuỗi nháy, regex, here-string, chú thích);
 *   2. lệnh SAI shell bị phát hiện đúng mã lỗi; `&&`/`||` đơn giản trên PowerShell 5.1 được viết lại đúng ngữ nghĩa (lồng nhau).
 */
import { describe, expect, it } from 'vitest';
import { checkShellCommand, commandSegments, findChainOps, maskPosix, maskPowerShell, rewriteChain, shellFindings } from '../src/core/engine/guards/shellCheck';

const codes = (cmd: string, shell: string): string[] => shellFindings(cmd, shell).findings.map((f) => f.code);
const chain = (cmd: string): number => shellFindings(cmd, 'powershell').chain.length;

// ── Lệnh ĐÚNG trên Windows PowerShell 5.1: không phát hiện gì, không có `&&` mức cao nhất ─────────────────────────────
const PS_OK: string[] = [
  'npm test',
  'npm run build; npm test',
  'Get-ChildItem -Recurse -Filter *.ts | Select-String -Pattern "TODO"',
  'Get-Content package.json -TotalCount 20',
  'Get-Content log.txt -Tail 50',
  '$env:NODE_ENV = "production"; node dist/index.js',
  'Remove-Item -Recurse -Force dist',
  'New-Item -ItemType Directory -Force out',
  'git status --short',
  'git log --oneline -5',
  'git commit -m "fix: head of the list && tail of the list"',
  "git commit -m 'feat: export data || fallback'",
  'echo "a && b"',
  "echo 'rm -rf is dangerous'",
  'Select-String -Pattern \'grep|tail|head\' -Path a.txt',
  'Write-Output "/dev/null is a unix thing"',
  '# grep is not here\nGet-ChildItem',
  '<# cat -n file #> Get-Content file',
  '@"\nexport FOO=1 && echo ok\n"@ | Set-Content x.sh',
  "@'\nrm -rf /\n'@ | Out-File notes.txt",
  'node -e "console.log(process.env.PATH && 1)"',
  'python -c "print(1 and 2)"',
  'npx vitest run test/a.test.ts',
  'if ($?) { npm test }',
  'npm test; if ($?) { npm run build }',
  'cat file.txt',
  'ls',
  'ls src',
  'rm dist\\bundle.js',
  'mkdir out',
  'cd src; Get-ChildItem',
  'curl.exe -s https://example.com',
  'Invoke-WebRequest -Uri https://example.com -UseBasicParsing',
  'Test-Path .\\dist',
  'echo `&`& literal',
  'npm run lint 2>$null',
  '$x = 1; Write-Host "x=$x"',
  'git diff --stat HEAD~1',
  'dotnet build -c Release',
  'Get-Command node | Select-Object -ExpandProperty Source',
  'pip install -r requirements.txt',
  'Measure-Command { npm test }',
  'foreach ($f in Get-ChildItem *.md) { Write-Host $f.Name }',
  '(Get-Content a.txt) -replace "foo", "bar" | Set-Content a.txt',
  'Get-Content a.txt | Select-Object -First 10',
  'where.exe node',
  'tasklist | Select-String node',
];

// ── Lệnh SAI trên PowerShell 5.1: [lệnh, mã lỗi mong đợi] ───────────────────────────────────────────────────────────
const PS_BAD: [string, string][] = [
  ['cat package.json | grep version', 'grep'],
  ['grep -rn "TODO" src', 'grep'],
  ['ls | grep ts', 'grep'],
  ['findstr /i "error" log.txt', 'findstr'],
  ['head -n 20 package.json', 'head-tail'],
  ['tail -f log.txt', 'head-tail'],
  ['cat log.txt | tail -n 50', 'head-tail'],
  ['cat -n file.txt', 'cat-flags'],
  ['which node', 'which'],
  ['touch .env.example', 'touch'],
  ['export NODE_ENV=production', 'export'],
  ['export NODE_ENV=production; node app.js', 'export'],
  ['NODE_ENV=test npm test', 'env-prefix'],
  ['rm -rf dist', 'rm-flags'],
  ['rm -f out.txt', 'rm-flags'],
  ['ls -la', 'ls-flags'],
  ['ls -R src', 'ls-flags'],
  ['mkdir -p out/sub', 'mkdir-p'],
  ['cp -r src dist', 'cp-mv-flags'],
  ['curl -s https://example.com', 'curl-flags'],
  ['wget -q https://example.com/f.zip', 'curl-flags'],
  ['[ -f package.json ] ; echo yes', 'test-bracket'],
  ['test -d dist', 'test-bracket'],
  ['set -e', 'set-e'],
  ['cd /d C:\\proj', 'cd-d'],
  ['sudo npm install -g x', 'sudo'],
  ['apt-get install jq', 'sudo'],
  ['npm test > /dev/null', 'dev-null'],
  ['node x.js 2>/dev/null', 'dev-null'],
  ["cat <<'EOF' > a.txt\nhello\nEOF", 'heredoc'],
  ['cat <<EOF\nhi\nEOF', 'heredoc'],
  ['npm test 2>&1', 'ps51-stderr'],
];

// ── `&&` / `||` trên PowerShell 5.1 ────────────────────────────────────────────────────────────────────────────────
const CHAIN_SIMPLE: [string, string][] = [
  ['npm run build && npm test', 'npm run build; if ($?) { npm test }'],
  ['cd src && npm test', 'cd src; if ($?) { npm test }'],
  ['npm run build && npm test && git status', 'npm run build; if ($?) { npm test; if ($?) { git status } }'],
  ['npm test || echo failed', 'npm test; if (-not $?) { echo failed }'],
  ['npm test | Select-String fail && echo done', 'npm test | Select-String fail; if ($?) { echo done }'],
  ['git add -A && git commit -m "a; b"', 'git add -A; if ($?) { git commit -m "a; b" }'],
];

const CHAIN_COMPLEX: string[] = [
  'npm test && echo ok || echo fail',
  'npm run build; npm test && git status',
  'npm run build &&\nnpm test',
  'if ($x) { a && b }',
  '(npm test && npm run build)',
  'npm test &&',
  '&& npm test',
];

describe('kiểm tra shell — che chuỗi và chú thích', () => {
  it('PowerShell: nháy đơn/kép, here-string, chú thích bị che; mã còn nguyên và cùng độ dài', () => {
    const s = 'echo "a && b" \'c || d\' # grep\nnpm test';
    const m = maskPowerShell(s);
    expect(m.length).toBe(s.length);
    expect(m).not.toContain('&&');
    expect(m).not.toContain('||');
    expect(m).not.toContain('grep');
    expect(m).toContain('npm test');
    expect(m).toContain('echo');
  });

  it('PowerShell: thoát `" và "" trong chuỗi kép, \'\' trong chuỗi đơn', () => {
    expect(maskPowerShell('Write-Host "say `"hi`" && go" ; x')).toMatch(/^Write-Host\s+; x$/);
    expect(maskPowerShell("Write-Host 'it''s && ok'; y")).toMatch(/^Write-Host\s+; y$/);
    expect(maskPowerShell('Write-Host "a""b && c"; z')).toMatch(/^Write-Host\s+; z$/);
  });

  it('bash: chuỗi, chú thích và heredoc bị che', () => {
    const s = "echo 'Get-ChildItem' \"$env:X\" # Select-String\ncat <<EOF\nGet-Item\nEOF\nls";
    const m = maskPosix(s);
    expect(m).not.toContain('Get-ChildItem');
    expect(m).not.toContain('$env:X');
    expect(m).not.toContain('Select-String');
    expect(m).not.toContain('Get-Item');
    expect(m).toContain('ls');
  });

  it('commandSegments: tách đúng tại ; | && || xuống dòng ( {', () => {
    expect(commandSegments('a; b | c && d || e\nf (g) {h}')).toEqual(['a', 'b ', 'c ', 'd ', 'e', 'f ', 'g) ', 'h}']);
  });
});

describe('kiểm tra shell — PowerShell 5.1: lệnh đúng đi qua nguyên vẹn', () => {
  for (const cmd of PS_OK) {
    it(JSON.stringify(cmd), () => {
      expect(codes(cmd, 'powershell'), 'không được báo gì').toEqual([]);
      expect(chain(cmd), 'không có && || mức cao nhất').toBe(0);
      expect(checkShellCommand(cmd, 'powershell', 'rewrite', 'vi')).toEqual({ action: 'ok' });
    });
  }
});

describe('kiểm tra shell — PowerShell 5.1: lệnh sai bị phát hiện đúng mã', () => {
  for (const [cmd, code] of PS_BAD) {
    it(`${JSON.stringify(cmd)} → ${code}`, () => {
      expect(codes(cmd, 'powershell')).toContain(code);
      const r = checkShellCommand(cmd, 'powershell', 'rewrite', 'vi');
      // Lỗi ngoài && || chỉ là GỢI Ý: lệnh gốc vẫn chạy (không cản nhầm nếu người dùng cài Git Bash…)
      expect(r.action).toBe('hint');
      if (r.action === 'hint') {
        expect(r.note).toContain('[kiểm tra shell]');
        expect(r.note).toContain('Windows PowerShell 5.1');
      }
    });
  }

  it('tiếng Anh: nhãn và gợi ý bằng tiếng Anh', () => {
    const r = checkShellCommand('grep x a.txt', 'powershell', 'hint', 'en');
    expect(r.action).toBe('hint');
    if (r.action === 'hint') expect(r.note).toMatch(/^\[shell check\] .*Select-String/s);
  });

  it('mỗi mã lỗi chỉ báo một lần dù xuất hiện nhiều chỗ', () => {
    expect(codes('grep a x | grep b', 'powershell')).toEqual(['grep']);
  });
});

describe('kiểm tra shell — && / || trên PowerShell 5.1', () => {
  for (const [cmd, expected] of CHAIN_SIMPLE) {
    it(`viết lại: ${cmd}`, () => {
      const r = checkShellCommand(cmd, 'powershell', 'rewrite', 'vi');
      expect(r.action).toBe('rewrite');
      if (r.action === 'rewrite') {
        expect(r.command).toBe(expected);
        expect(r.note).toContain(expected);
      }
    });
  }

  for (const cmd of CHAIN_COMPLEX) {
    it(`chặn kèm hướng dẫn (không đoán): ${JSON.stringify(cmd)}`, () => {
      const r = checkShellCommand(cmd, 'powershell', 'rewrite', 'vi');
      expect(r.action).toBe('block');
      if (r.action === 'block') {
        expect(r.message).toContain('CHƯA chạy');
        expect(r.message).toContain('if ($?)');
      }
    });
  }

  it('chế độ hint: không đổi lệnh, chỉ gợi ý (kể cả &&)', () => {
    const r = checkShellCommand('npm run build && npm test', 'powershell', 'hint', 'vi');
    expect(r.action).toBe('hint');
    if (r.action === 'hint') expect(r.note).toContain('`;`');
  });

  it('chế độ off: không làm gì', () => {
    expect(checkShellCommand('grep x && rm -rf /', 'powershell', 'off', 'vi')).toEqual({ action: 'ok' });
  });

  it('&& trong chuỗi, here-string, chú thích KHÔNG bị viết lại', () => {
    for (const cmd of ['echo "a && b"', "git commit -m 'x && y'", '@"\na && b\n"@', 'npm test # && not here']) {
      expect(chain(cmd), cmd).toBe(0);
    }
  });

  it('2>&1 và >&2 không phải &&', () => {
    expect(findChainOps('node x.js 2>&1 | Out-Null')).toEqual([]);
    expect(findChainOps('Write-Error x >&2')).toEqual([]);
  });

  it('rewriteChain trả null cho mọi dạng phức tạp', () => {
    for (const cmd of CHAIN_COMPLEX) {
      const m = maskPowerShell(cmd);
      expect(rewriteChain(cmd, m, findChainOps(m)), cmd).toBeNull();
    }
  });

  it('PowerShell 7 (pwsh): && || hợp lệ → không viết lại, không chặn', () => {
    expect(checkShellCommand('npm run build && npm test', 'pwsh', 'rewrite', 'vi')).toEqual({ action: 'ok' });
    // nhưng thói quen Unix vẫn được gợi ý
    expect(codes('grep x a.txt', 'pwsh')).toContain('grep');
    // và cảnh báo 2>&1 chỉ dành cho 5.1
    expect(codes('npm test 2>&1', 'pwsh')).toEqual([]);
  });
});

describe('kiểm tra shell — bash/zsh: lệnh đúng đi qua, lệnh PowerShell/cmd bị gợi ý', () => {
  const BASH_OK = [
    'npm run build && npm test',
    'grep -rn TODO src | head -20',
    'export NODE_ENV=production && node app.js',
    'rm -rf dist && mkdir -p dist',
    'ls -la',
    'cat file | tail -n 5',
    'echo "Get-ChildItem is powershell"',
    "echo '$env:PATH'",
    'echo "%PATH% literal"',
    'cat <<EOF > a.txt\nGet-Item\n%VAR%\nEOF',
    'which node || echo missing',
    'test -f .env && echo yes',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'curl -s https://example.com | jq .',
    'npm test 2>&1 | tee log.txt',
    'type node',
    'cd src && npm test',
  ];
  for (const cmd of BASH_OK) it(`ok: ${JSON.stringify(cmd)}`, () => expect(checkShellCommand(cmd, 'bash', 'rewrite', 'vi')).toEqual({ action: 'ok' }));

  const BASH_BAD: [string, string][] = [
    ['Get-ChildItem -Recurse', 'cmdlet'],
    ['ls | Select-String foo', 'cmdlet'],
    ['Remove-Item -Recurse -Force dist', 'cmdlet'],
    ['echo $env:HOME', 'env-colon'],
    ['npm test; if ($?) { npm run build }', 'ps-if'],
    ['dir /s *.ts', 'cmd-switch'],
    ['del /q out.txt', 'cmd-switch'],
    ['cd /d C:\\x', 'cmd-switch'],
    ['echo %PATH%', 'percent-var'],
  ];
  for (const [cmd, code] of BASH_BAD) {
    it(`${JSON.stringify(cmd)} → ${code}`, () => {
      expect(codes(cmd, 'bash')).toContain(code);
      expect(codes(cmd, 'zsh')).toContain(code);
      expect(checkShellCommand(cmd, 'bash', 'rewrite', 'vi').action).toBe('hint');
    });
  }
});

describe('kiểm tra shell — cmd.exe', () => {
  it('lệnh cmd đúng đi qua', () => {
    for (const cmd of ['dir /s /b *.ts', 'npm run build && npm test', 'findstr /i error log.txt', 'set NODE_ENV=production && node app.js', 'type package.json', 'echo %PATH%']) {
      expect(checkShellCommand(cmd, 'cmd', 'rewrite', 'vi'), cmd).toEqual({ action: 'ok' });
    }
  });
  it('cmdlet / bash-ism bị gợi ý', () => {
    expect(codes('Get-ChildItem', 'cmd')).toContain('cmdlet');
    expect(codes('export X=1', 'cmd')).toContain('export');
    expect(codes('echo $env:X', 'cmd')).toContain('env-colon');
    expect(codes('grep x file', 'cmd')).toContain('grep');
    expect(codes('rm -rf dist', 'cmd')).toContain('rm-ls');
  });
});

describe('kiểm tra shell — shell lạ / không có shell (bản trình duyệt)', () => {
  it('không biết shell → không làm gì', () => {
    expect(checkShellCommand('grep x && rm -rf /', 'none', 'rewrite', 'vi')).toEqual({ action: 'ok' });
    expect(checkShellCommand('', 'powershell', 'rewrite', 'vi')).toEqual({ action: 'ok' });
  });
});
