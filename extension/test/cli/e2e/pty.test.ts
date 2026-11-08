/**
 * e2e THẬT: chạy bundle demo (TUI + MockRuntime) trong pty (@lydell/node-pty, ConPTY trên Windows), gõ phím, đọc màn hình qua xterm headless.
 * Nặng/chậm → mặc định bỏ qua; bật bằng  LOCAITH_E2E_PTY=1 npx vitest run test/cli/e2e
 * BẮT BUỘC useConptyDll:false + đường dẫn node tuyệt đối (xem scripts/cli-lib.mjs), nếu không bị treo.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — thư viện .mjs không có kiểu
import { PtySession, buildDemo, sleep } from '../../../scripts/cli-lib.mjs';

const RUN = process.env.LOCAITH_E2E_PTY === '1';
const d = RUN ? describe : describe.skip;

d('e2e pty', () => {
  let bundle = '';
  let dir = '';
  const sessions: Array<{ kill(): void }> = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locaith-e2e-'));
    bundle = await buildDemo(dir);
  }, 60000);

  afterAll(() => {
    for (const s of sessions) s.kill();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* bỏ qua */
    }
  });

  const open = async (o: { cols?: number; rows?: number; args?: string[]; env?: Record<string, string | undefined> } = {}) => {
    const s = new PtySession({ cols: o.cols ?? 100, rows: o.rows ?? 32, args: ['--speed', '0.3', ...(o.args ?? [])], env: o.env ?? {}, bundle });
    await s.start();
    sessions.push(s);
    await s.waitFor((x: any) => x.text().includes('Nhập việc cần làm') || x.text().includes('Type a task'), 30000);
    return s;
  };

  it('khởi động: khung chào, logo, ô nhập, dải trạng thái; không rác', async () => {
    const s = await open();
    const t = s.text();
    expect(t).toContain('Locaith CLI');
    expect(t).toContain('locaith-v5-flash');
    expect(t).toMatch(/[▀▄█]/);
    expect(t).toContain('? phím tắt');
    s.write('\x03'); // Ctrl+C: có chữ? không → nhắc
    await s.waitFor((x: any) => x.text().includes('nhấn Ctrl+C lần nữa để thoát'));
    s.write('\x03');
    expect(await s.exit()).toBe(0);
    // terminal được khôi phục
    expect(s.raw).toContain('\x1b[?25h');
    expect(s.raw).toContain('\x1b[?2004l');
    expect(s.text()).toContain('Hẹn gặp lại');
  }, 60000);

  it('gõ tiếng Việt, gửi, nhận markdown + công cụ; Ctrl+D thoát êm', async () => {
    const s = await open();
    s.write('Chào bạn, xem giúp mình dự án');
    await s.waitFor((x: any) => x.text().includes('Chào bạn, xem giúp mình dự án'));
    s.write('\r');
    await s.waitFor((x: any) => x.text().includes('Bạn muốn mình làm luôn không?'), 30000);
    const t = s.text();
    expect(t).toContain('● List(.)');
    expect(t).toContain('╭─ ts');
    await sleep(500);
    s.write('\x04');
    expect(await s.exit()).toBe(0);
  }, 90000);

  it('hộp xin quyền + diff trong pty thật; chấp nhận bằng Enter', async () => {
    const s = await open({ args: ['--speed', '0.2'] });
    s.write('hãy sửa parseArgs');
    s.write('\r');
    await s.waitFor((x: any) => x.text().includes('Cho phép sửa src/cli.ts?'), 30000);
    expect(s.text()).toContain('1. Có');
    expect(s.text()).toContain('--no-color');
    s.write('\r');
    await s.waitFor((x: any) => x.text().includes('Đã cập nhật.'), 30000);
    expect(s.text()).toContain('● Update(src/cli.ts)');
    s.write('\x04');
    await s.exit();
  }, 90000);

  it('đổi cỡ cửa sổ khi đang chạy: vẽ lại sạch', async () => {
    const s = await open({ cols: 100 });
    s.write('xin chào');
    await s.waitFor((x: any) => x.text().includes('xin chào'));
    s.resize(60, 32);
    await s.settle(600);
    s.resize(110, 32);
    await s.settle(600);
    const lines = s.all();
    // đúng một ô nhập (không lặp do vẽ sai chỗ)
    expect(lines.filter((l: string) => l.includes('xin chào')).length).toBe(1);
    expect(lines.filter((l: string) => l.startsWith('╭') && l.endsWith('╮')).length).toBeLessThanOrEqual(2); // khung chào + ô nhập
    s.write('\x04');
    await s.exit();
  }, 60000);

  it('SIGINT/kill không để terminal hỏng: Ctrl+C giữa lượt chạy dừng lượt, không thoát', async () => {
    const s = await open({ args: ['--speed', '1'] });
    s.write('viết một câu trả lời dài giúp mình');
    s.write('\r');
    await s.waitFor((x: any) => x.text().includes('esc để dừng'), 30000);
    s.write('\x03'); // Ctrl+C khi đang chạy → dừng lượt
    await s.waitFor((x: any) => !x.text().includes('esc để dừng'), 30000);
    expect(s.exited).toBe(false);
    s.write('\x04');
    expect(await s.exit()).toBe(0);
  }, 90000);

  it('NO_COLOR + ASCII: không có mã màu, không ký tự ngoài ASCII trong khung', async () => {
    const s = await open({ args: ['--no-color', '--ascii'], env: { NO_COLOR: '1', LOCAITH_ASCII: '1' } });
    const t = s.text();
    expect(t).toContain('+-');
    expect(t).toContain('|');
    expect(s.raw).not.toMatch(/\x1b\[(3[0-7]|9[0-7]|38;|48;)/);
    s.write('\x04');
    await s.exit();
  }, 60000);
});
