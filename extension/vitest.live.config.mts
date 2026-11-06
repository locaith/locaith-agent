// Kiểm thử THẬT với mô hình Locaith (khoá DeepSeek thật đứng sau cổng thử). KHÔNG nằm trong `npx vitest run` thường:
//   1) chạy máy chủ thử cổng (xác thực giả):  backend\.venv\Scripts\python.exe <scratchpad>\live_locaith_server.py   (cổng 8671)
//   2) npx vitest run --config vitest.live.config.mts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'md-as-text',
      transform(code, id) {
        if (id.split('?')[0].endsWith('.md')) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return null;
      },
    },
  ],
  test: { include: ['test/live/**/*.live.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 60_000, pool: 'forks', fileParallelism: false },
});
