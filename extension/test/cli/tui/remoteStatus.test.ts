/**
 * Giao diện terminal khi Remote đang bật: dải trạng thái luôn cho chủ máy biết (và làm NỔI khi có trình duyệt đang điều khiển),
 * hành động `open_url` chỉ mở địa chỉ của locaith.ai, và cờ `--remote` biến thành `/remote` lúc khởi động.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../../../src/cli/args';
import { KEY, boot, type Booted } from './helpers/boot';

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

describe('dải trạng thái Remote', () => {
  it('Remote tắt → không hiện gì về Remote', async () => {
    b = await boot();
    expect(b.screenText()).not.toMatch(/Remote ·/);
  });

  it('đang nối / đã nối / xếp hàng / có trình duyệt điều khiển: mỗi trạng thái một dòng rõ ràng, có chấm trạng thái', async () => {
    b = await boot();
    const rt = b.rt as unknown as { setRemote(r: { link: 'connecting' | 'online' | 'queued'; sessions: number } | undefined): void };
    rt.setRemote({ link: 'connecting', sessions: 0 });
    await b.until(() => b!.screenText().includes('Remote · đang nối…'));
    expect(b.screenText()).toMatch(/[●*] Remote · đang nối…/);
    rt.setRemote({ link: 'online', sessions: 0 });
    await b.until(() => b!.screenText().includes('Remote · đã nối locaith.ai'));
    expect(b.screenText()).not.toContain('đang nối…');
    rt.setRemote({ link: 'queued', sessions: 0 });
    await b.until(() => b!.screenText().includes('Remote · relay quá tải, đang xếp hàng'));
    rt.setRemote({ link: 'online', sessions: 2 });
    await b.until(() => b!.screenText().includes('Remote · 2 trình duyệt đang điều khiển'));
    expect(b.screenText()).toContain('/remote off để ngắt'); // nói luôn cách ngắt
  });

  it('có trình duyệt điều khiển được tô MÀU KHÁC trạng thái bình thường (cảnh báo) để chủ máy không bỏ sót', async () => {
    b = await boot();
    const rt = b.rt as unknown as { setRemote(r: { link: 'online'; sessions: number } | undefined): void };
    /** Màu chữ của ô «R» trong «Remote ·» ở khung nhìn hiện tại (-1 nếu không thấy). */
    const colorOfRemote = (): number => {
      const rows = b!.vt.screen();
      for (let y = 0; y < rows.length; y++) {
        const x = rows[y].indexOf('Remote ·');
        if (x >= 0) return b!.vt.cell(x, y).fg;
      }
      return -1;
    };
    rt.setRemote({ link: 'online', sessions: 0 });
    await b.until(() => b!.screenText().includes('Remote · đã nối locaith.ai'));
    const calm = colorOfRemote();
    rt.setRemote({ link: 'online', sessions: 1 });
    await b.until(() => b!.screenText().includes('Remote · 1 trình duyệt đang điều khiển'));
    const loud = colorOfRemote();
    expect(calm).not.toBe(-1);
    expect(loud).not.toBe(-1);
    expect(loud).not.toBe(calm);
  });

  it('tắt Remote → dòng biến mất', async () => {
    b = await boot();
    const rt = b.rt as unknown as { setRemote(r: { link: 'online'; sessions: number } | undefined): void };
    rt.setRemote({ link: 'online', sessions: 0 });
    await b.until(() => b!.screenText().includes('Remote · đã nối locaith.ai'));
    rt.setRemote(undefined);
    await b.until(() => !b!.screenText().includes('Remote ·'));
  });

  it('cùng dòng với «tác vụ nền / tệp đã đổi», ngăn cách gọn (không đẩy tràn khung hẹp)', async () => {
    b = await boot({ cols: 50 });
    const rt = b.rt as unknown as { setRemote(r: { link: 'online'; sessions: number } | undefined): void };
    rt.setRemote({ link: 'online', sessions: 3 });
    await b.until(() => b!.screenText().includes('Remote ·'));
    for (const line of b.screenText().split('\n')) expect(line.length).toBeLessThanOrEqual(50);
  });
});

describe('hành động open_url (từ /remote)', () => {
  it('mở địa chỉ https://locaith.ai/… bằng hàm mở trình duyệt; KHÔNG mở địa chỉ khác (runtime không bắt được terminal mở trang tuỳ ý)', async () => {
    const opened: string[] = [];
    b = await boot({ app: { openUrl: (u: string) => (opened.push(u), true) } });
    const rt = b.rt as unknown as { fireAction(a: string, p?: string): void };
    rt.fireAction('open_url', 'https://locaith.ai/#remote?h=AAAAAAAAAAAAAAAAAAAAAA');
    rt.fireAction('open_url', 'https://locaith.ai');
    rt.fireAction('open_url', 'https://evil.example/locaith.ai/');
    rt.fireAction('open_url', 'https://locaith.ai.evil.example/');
    rt.fireAction('open_url', 'http://locaith.ai/');
    rt.fireAction('open_url', 'file:///C:/Windows/System32/calc.exe');
    rt.fireAction('open_url', 'javascript:alert(1)');
    rt.fireAction('open_url', '');
    rt.fireAction('open_url');
    expect(opened).toEqual(['https://locaith.ai/#remote?h=AAAAAAAAAAAAAAAAAAAAAA', 'https://locaith.ai']);
  });

  it('gõ /remote trong giao diện thử (MockRuntime không có lệnh) không làm vỡ giao diện', async () => {
    b = await boot();
    await b.type('/remote');
    await b.type(KEY.enter);
    expect(b.screenText()).toContain('Nhập việc cần làm');
  });
});

describe('cờ --remote', () => {
  const p = (a: string[]) => parseArgs(a);

  it('--remote đứng riêng hoặc cùng việc đầu: command=chat, remote=true', () => {
    expect(p(['--remote']).remote).toBe(true);
    expect(p(['--remote']).command).toBe('chat');
    expect(p(['--remote', 'làm gì đó']).remote).toBe(true);
    expect(p(['--remote', 'làm gì đó']).prompt).toBe('làm gì đó');
    expect(p(['-c', '--remote']).remote).toBe(true);
    expect(p(['--model', 'locaith-v5-si', '--remote']).remote).toBe(true);
  });

  it('không có --remote thì remote không đặt', () => {
    expect(p([]).remote).toBeUndefined();
  });

  it('--remote với -p hoặc lệnh con → báo lỗi dùng sai, nói rõ vì sao', () => {
    for (const a of [['-p', '--remote', 'x'], ['--remote', '-p', 'x'], ['--remote', 'sessions'], ['sessions', '--remote'], ['--remote', 'update']]) {
      expect(() => p(a), a.join(' ')).toThrow(UsageError);
    }
    try {
      p(['-p', '--remote', 'x']);
    } catch (e) {
      expect((e as Error).message).toMatch(/--remote chỉ dùng với giao diện tương tác/);
    }
  });
});
