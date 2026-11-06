// Đóng gói: extension host (Node, CJS) + webview (trình duyệt, IIFE) + font/ảnh đi kèm.
//   node esbuild.mjs                    build cả hai
//   node esbuild.mjs --only=webview     chỉ webview   (cũng có: --only=extension)
//   node esbuild.mjs --production       nén, không sourcemap
//   node esbuild.mjs --watch            theo dõi thay đổi
//   node esbuild.mjs --clean            xoá dist/ trước khi build
import * as esbuild from 'esbuild';
import { rm } from 'node:fs/promises';

const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');
const clean = args.includes('--clean');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
  // Kỹ năng và prompt dựng sẵn nằm dưới dạng .md → nhúng thẳng vào bundle, không đọc đĩa lúc chạy.
  loader: { '.md': 'text' },
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'bufferutil', 'utf-8-validate'], // hai phụ thuộc tuỳ chọn của `ws` (tăng tốc, có thể vắng)
  mainFields: ['module', 'main'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...common,
  entryPoints: { main: 'webview/src/index.tsx' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { ...common.loader, '.woff2': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
  assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

const targets = [];
if (!only || only === 'extension') targets.push(extension);
if (!only || only === 'webview') targets.push(webview);

if (clean) await rm('dist', { recursive: true, force: true });
else if (!watch) {
  // Chỉ dọn phần sắp build lại, để không xoá nhầm kết quả của phần còn lại.
  if (targets.includes(webview)) await rm('dist/webview', { recursive: true, force: true });
}

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] đang theo dõi thay đổi…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
