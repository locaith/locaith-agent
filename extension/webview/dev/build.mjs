// Build cho harness: webview chính (qua esbuild.mjs → dist/webview) + gói harness/icons riêng ở webview/dev/.build
// (nằm ngoài dist/ để không lọt vào file .vsix).
//   node webview/dev/build.mjs
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);

execFileSync(process.execPath, ['esbuild.mjs', '--only=webview'], { stdio: 'inherit' });

await esbuild.build({
  entryPoints: { harness: 'webview/dev/harness.ts', icons: 'webview/dev/icons.tsx' },
  outdir: 'webview/dev/.build',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: false,
  logLevel: 'info',
  loader: { '.woff2': 'file', '.svg': 'dataurl' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"development"' },
});
