import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');

/**
 * Ba lỗi mà người rà soát độc lập chỉ ra (bản 0.7.15 đầu):
 *   1. hằng USAGE_DEBOUNCE_MS được khai nhưng KHÔNG dùng → không có gộp 300 ms thật;
 *   2. /usage đọc snapshot CŨ rồi mới đọc lại (fire-and-forget);
 *   3. dropExpiredWindows không được production dùng.
 * Test này ghim HÀNH VI Ở MÃ THẬT để ba lỗi đó không quay lại.
 */
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('usage: không còn hằng số khai mà không dùng', () => {
  it('USAGE_DEBOUNCE_MS được coalescer dùng thật (không chỉ khai báo)', () => {
    const mod = read('core/account/usageRefresh.ts');
    expect(mod).toContain('USAGE_DEBOUNCE_MS');
    // dùng làm giá trị mặc định của lớp gộp → có đường chạy thật
    expect(mod).toMatch(/delayMs\s*=\s*USAGE_DEBOUNCE_MS/);
    expect(mod).toContain('export class UsageCoalescer');
  });

  it('controller dùng UsageCoalescer cho mọi lần đọc', () => {
    const ctl = read('host/chatController.ts');
    expect(ctl).toContain('new UsageCoalescer(');
    expect(ctl).toMatch(/usageCoalescer\.request\(/);
    // lần đọc thật sự ra mạng phải nằm trong readUsageNow (được coalescer gọi)
    expect(ctl).toContain('private async readUsageNow(');
  });
});

describe('/usage phải in số MỚI', () => {
  it('await lần đọc trước khi đọc view', () => {
    const ctl = read('host/chatController.ts');
    // Có HAI `case 'usage'`: một cái là đồng hồ ngữ cảnh trong onMessage (không có `{`), cái cần kiểm là
    // nhánh lệnh gạch chéo trong handleSlash (`case 'usage': {`).
    const i = ctl.indexOf("case 'usage': {");
    expect(i).toBeGreaterThan(0);
    const block = ctl.slice(i, i + 1200);
    // phải await, không được fire-and-forget
    expect(block).toMatch(/await this\.requestUsage\(/);
    const awaitIdx = block.indexOf('await this.requestUsage(');
    const readViewIdx = block.indexOf('this.view.locaith?.usage');
    expect(awaitIdx).toBeGreaterThan(0);
    expect(readViewIdx).toBeGreaterThan(awaitIdx); // đọc view SAU khi chờ xong
  });
});

describe('cửa sổ hết hạn không được hiện số cũ', () => {
  it('view của host lọc bằng dropExpiredWindows', () => {
    const ctl = read('host/chatController.ts');
    expect(ctl).toContain('dropExpiredWindows(');
  });

  it('composer trong webview cũng lọc theo đồng hồ hiện tại', () => {
    const wv = fs.readFileSync(path.resolve(__dirname, '../webview/src/components/composer/Composer.tsx'), 'utf8');
    expect(wv).toContain('dropExpiredWindows');
    // và tự vẽ lại đúng lúc mốc làm mới tới
    expect(wv).toMatch(/setTimeout\(\(\) => setNow\(/);
  });
});
