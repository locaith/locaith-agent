import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Khớp với loader `.md` → text của esbuild (kỹ năng dựng sẵn, prompt).
      name: 'md-as-text',
      transform(code, id) {
        if (id.split('?')[0].endsWith('.md')) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // Kiểm thử đầu-cuối mở trình duyệt thật: chạy riêng bằng `npm run test:browser-e2e`.
    exclude: ['**/node_modules/**', 'test/browser-e2e/**'],
    environment: 'node',
    testTimeout: 20_000,
    // Lõi (src/core, src/shared) không import 'vscode'; test của lớp host dùng stub riêng.
  },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/helpers/vscode-stub.ts', import.meta.url)),
    },
  },
});
