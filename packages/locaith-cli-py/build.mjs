// Dựng gói PyPI `locaith-cli`: bundle lõi Node (esbuild, nén) → locaith_cli/bin/locaith.cjs → wheel + sdist → twine check.
//
//   node build.mjs --extension C:\locaith-agent-wt\<tên>\extension [--python "py -3.11"] [--no-python] [--keep]
//
// KHÔNG đăng PyPI ở đây: đăng là bước riêng, có chủ ý (twine upload) — xem packages/locaith-cli-py/README (mục «Phát hành») và docs/CLI.md.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ext = path.resolve(opt('--extension', path.join(here, '..', '..', 'extension')));
if (!existsSync(path.join(ext, 'src', 'cli', 'index.ts'))) {
  console.error(`Không thấy ${path.join(ext, 'src', 'cli', 'index.ts')} — truyền --extension <thư mục extension>`);
  process.exit(2);
}
const require = createRequire(path.join(ext, 'package.json'));
const esbuild = require('esbuild');

const out = path.join(here, 'locaith_cli', 'bin', 'locaith.cjs');
mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
await esbuild.build({
  entryPoints: [path.join(ext, 'src', 'cli', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  loader: { '.md': 'text' },
  outfile: out,
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  // `vscode` KHÔNG được lọt vào bundle CLI (nếu lọt, esbuild sẽ báo không giải quyết được và build hỏng — đúng ý).
});
const mb = (statSync(out).size / 1e6).toFixed(2);
console.log(`✔ bundle ${out} (${mb} MB, ${Date.now() - t0} ms)`);

if (args.includes('--no-python')) process.exit(0);

if (!args.includes('--keep')) {
  rmSync(path.join(here, 'dist'), { recursive: true, force: true });
  rmSync(path.join(here, 'build'), { recursive: true, force: true });
  rmSync(path.join(here, 'locaith_cli.egg-info'), { recursive: true, force: true });
}
const rootLicense = path.join(here, '..', '..', 'LICENSE');
if (existsSync(rootLicense)) copyFileSync(rootLicense, path.join(here, 'LICENSE'));

const py = opt('--python', 'py -3.11').split(' ');
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { cwd: here, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`✘ ${cmd} ${a.join(' ')} → mã ${r.status}`);
    process.exit(r.status ?? 1);
  }
};
run(py[0], [...py.slice(1), '-m', 'build', '--outdir', 'dist']);
run(py[0], [...py.slice(1), '-m', 'twine', 'check', 'dist/*']);
console.log('✔ wheel + sdist ở', path.join(here, 'dist'), '— CHƯA đăng PyPI.');
