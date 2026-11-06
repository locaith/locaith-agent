import { defineConfig } from 'vitest/config';

// Kiểm thử đầu-cuối bản trình duyệt: mở Edge/Chrome THẬT (headless) với tiện ích đã nạp. Chạy riêng: npm run test:browser-e2e
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
  test: {
    include: ['test/browser-e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
