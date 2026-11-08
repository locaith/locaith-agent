import { afterEach, describe, expect, it } from 'vitest';
import { imageDimensions } from '../../../src/cli/runtime/images';
import { textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, waitFor } from './harness';

afterEach(() => cleanupDirs());

function png(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

describe('kích thước ảnh', () => {
  it('đọc được PNG / GIF / JPEG / WebP từ phần đầu tệp', () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    const gif = Buffer.alloc(32);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(321, 6);
    gif.writeUInt16LE(123, 8);
    expect(imageDimensions(gif.toString('base64'))).toEqual({ width: 321, height: 123 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0xe8, 0x07, 0xd0, 0x01, 0x01, 0x11, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions(jpg.toString('base64'))).toEqual({ width: 2000, height: 1000 });
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(1599, 24, 3);
    webp.writeUIntLE(799, 27, 3);
    expect(imageDimensions(webp.toString('base64'))).toEqual({ width: 1600, height: 800 });
    expect(imageDimensions(Buffer.from('không phải ảnh, chỉ là chữ thôi nhé nhé nhé').toString('base64'))).toBeNull();
  });

  it('ảnh có cạnh > 8000 px bị bỏ kèm cảnh báo; ảnh nhỏ đi qua', async () => {
    const h = await harness({ script: [() => textTurn('ok')] });
    await h.rt.submit('xem ảnh', { attachments: [{ kind: 'image', name: 'khong-lo.png', mediaType: 'image/png', data: png(9000, 100) }, { kind: 'image', name: 'nho.png', mediaType: 'image/png', data: png(100, 100) }] });
    await h.rt.idle();
    const notices = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'notice').map((e) => (e as unknown as { ev: { text: string } }).ev.text);
    expect(notices.some((n) => n.includes('khong-lo.png') && n.includes('8000'))).toBe(true);
    const sent = JSON.stringify(h.provider.requests[0].messages);
    expect(sent).toContain(png(100, 100).slice(0, 30));
    expect(sent).not.toContain(png(9000, 100).slice(0, 30));
    await h.cleanup();
  });
});

describe('tiếp tục sau khi dừng', () => {
  it('dừng giữa lệnh đang chạy: tool bị huỷ, tiến trình dừng; "tiếp tục" thêm chỉ dẫn và lịch sử vẫn hợp lệ', async () => {
    const h = await harness({
      allowedTools: ['run_command(*)'],
      script: [toolTurn([{ id: 'slow1', name: 'run_command', input: { command: 'node -e "setTimeout(()=>{},30000)"' } }]), () => textTurn('đã dừng ở đây'), () => textTurn('làm tiếp')],
    });
    await h.rt.submit('chạy lệnh lâu');
    await waitFor(() => h.events.some((e) => e.t === 'ui' && e.ev.t === 'tool_start'), 8000, 'tool_start');
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    h.rt.interrupt();
    await h.rt.idle();
    expect(Date.now() - t0).toBeLessThan(8000); // lệnh 30 giây đã bị dừng, không chờ hết
    const end = h.events.find((e) => e.t === 'ui' && e.ev.t === 'tool_end') as { ev: { state: string } } | undefined;
    expect(end?.ev.state).toBe('cancelled');
    await h.rt.submit('tiếp tục');
    await h.rt.idle();
    const sent = JSON.stringify(h.provider.requests[h.provider.requests.length - 1].messages);
    expect(sent).toContain('Tiếp tục sau khi dừng');
    expect(sent).toContain('slow1'); // tool_use cũ vẫn có tool_result tương ứng (đã huỷ)
    // người dùng chỉ thấy chữ họ gõ, không thấy chỉ dẫn nội bộ
    const users = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'user').map((e) => (e as unknown as { ev: { text: string } }).ev.text);
    expect(users).toEqual(['chạy lệnh lâu', 'tiếp tục']);
    await h.cleanup();
  }, 30_000);
});
