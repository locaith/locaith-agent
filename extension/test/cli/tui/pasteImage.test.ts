/**
 * Dán ảnh vào CLI. Nguyên nhân gốc trên Windows: Windows Terminal gắn Ctrl+V với «dán chữ» nên ảnh trong clipboard không bao giờ gửi được phím Ctrl+V tới ứng dụng,
 * mà giao diện lại chỉ ghi «Ctrl+V dán ảnh». Các test dưới đây khoá những đường vào còn lại: Alt+V, lệnh /paste, «dán» rỗng, dán đường dẫn ảnh.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Attachment } from '../../../src/cli/runtime/contract';
import type { ClipboardImageResult } from '../../../src/cli/tui/clipboard';
import { pickTip } from '../../../src/cli/tui/welcome';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { renderShortcuts } from '../../../src/cli/tui/widgets';
import { stripAnsi } from '../../../src/cli/tui/width';
import { KEY, boot, type Booted } from './helpers/boot';
import { makePng } from './helpers/png';

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-image-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const att = (name = 'clipboard-test.png'): Attachment => ({ kind: 'image', name, mediaType: 'image/png', data: makePng(64, 48).toString('base64') });
const CHIP = (n: number, name = 'clipboard-test.png'): RegExp => new RegExp(`\\[(🖼|img)${n} ${name.replace('.', '\\.')}\\]`);

async function start(result: ClipboardImageResult | (() => Promise<ClipboardImageResult>)): Promise<{ b: Booted; calls: { n: number } }> {
  const calls = { n: 0 };
  const booted = await boot({
    app: {
      readImageResult: async () => {
        calls.n++;
        return typeof result === 'function' ? result() : result;
      },
    },
  });
  b = booted;
  return { b: booted, calls };
}

const submits = (x: Booted) => x.rt.calls.filter((c) => c.fn === 'submit');

describe('các đường đưa ảnh clipboard vào tin nhắn', () => {
  it('Alt+V đính kèm ảnh: chip trong ô nhập + thông báo có kích thước điểm ảnh và dung lượng', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type('\x1bv', 150);
    await x.until(() => x.screenText().includes('Đã đính kèm ảnh clipboard-test.png'));
    const t = x.screenText();
    expect(t).toMatch(/\(64×48, \d+ KB\)/);
    expect(t).toMatch(CHIP(1));
    expect(calls.n).toBe(1);
    expect(x.app.editor.text).toBe(''); // phím không rơi xuống ô nhập thành chữ «v»
  });

  it('Alt+Shift+V cũng được (chữ V hoa)', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type('\x1bV', 150);
    await x.until(() => calls.n === 1);
    await x.until(() => CHIP(1).test(x.screenText()));
  });

  it('Ctrl+V vẫn hoạt động ở terminal chuyển được phím này tới ứng dụng', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type(KEY.ctrl('v'), 150);
    await x.until(() => CHIP(1).test(x.screenText()));
    expect(calls.n).toBe(1);
  });

  it('«dán» rỗng (terminal gửi khi clipboard chỉ có ảnh) → đọc ảnh thay vì bỏ qua', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type(KEY.paste(''), 150);
    await x.until(() => CHIP(1).test(x.screenText()));
    expect(calls.n).toBe(1);
  });

  it('dán chữ thường vẫn là chữ: không đọc clipboard ảnh', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type(KEY.paste('xin chào'), 150);
    expect(x.app.editor.text).toBe('xin chào');
    expect(calls.n).toBe(0);
  });

  it('/paste (chọn từ menu, Enter) đính kèm ảnh và KHÔNG gửi dòng lệnh lên runtime', async () => {
    const { b: x, calls } = await start({ ok: true, attachment: att() });
    await x.type('/pas');
    expect(x.screenText()).toContain('/paste');
    await x.type(KEY.enter, 150);
    await x.until(() => CHIP(1).test(x.screenText()));
    expect(calls.n).toBe(1);
    expect(submits(x)).toHaveLength(0);
    expect(x.app.editor.text).toBe('');
  });

  it('/image là bí danh của /paste; /paste thứ hai thêm ảnh thứ hai, ảnh thứ nhất không bị gửi đi cùng dòng lệnh', async () => {
    const { b: x, calls } = await start(async () => ({ ok: true, attachment: att(`anh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`) }));
    await x.type('\x1bv', 150);
    await x.until(() => calls.n === 1 && /\[(🖼|img)1 /.test(x.screenText()));
    await x.type('/image');
    await x.type(KEY.enter, 150);
    await x.until(() => calls.n === 2 && /\[(🖼|img)2 /.test(x.screenText()));
    expect(submits(x)).toHaveLength(0);
  });

  it('dán đường dẫn một tệp ảnh có thật (kéo-thả vào terminal) → đính kèm, không đọc clipboard', async () => {
    const file = path.join(tmp, 'Ảnh chụp.png');
    fs.writeFileSync(file, makePng(30, 20));
    const { b: x, calls } = await start({ ok: false, reason: 'none' });
    await x.type(KEY.paste(`"${file}"`), 150);
    await x.until(() => x.screenText().includes('Đã đính kèm ảnh Ảnh chụp.png'));
    expect(x.screenText()).toMatch(/\(30×20, \d+ KB\)/);
    expect(calls.n).toBe(0);
    expect(x.app.editor.text).toBe('');
  });

  it('bấm Alt+V liên tục khi đang đọc: chỉ đọc một lần và không chèn chữ «v»', async () => {
    const { b: x, calls } = await start(async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, attachment: att() };
    });
    await x.type('\x1bv', 20);
    await x.type('\x1bv', 20);
    await x.type('\x1bv', 20);
    await x.until(() => CHIP(1).test(x.screenText()));
    expect(calls.n).toBe(1);
    expect(x.app.editor.text).toBe('');
  });

  it('có thông báo «đang đọc» trong lúc chờ (PowerShell khởi động mất khoảng một giây)', async () => {
    const { b: x } = await start(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, attachment: att() };
    });
    await x.type('\x1bv', 80);
    expect(x.screenText()).toContain('Đang đọc ảnh từ clipboard');
    await x.until(() => CHIP(1).test(x.screenText()));
  });
});

describe('thất bại thì nói rõ lý do và cách xử lý', () => {
  it.each([
    ['không có ảnh', { ok: false, reason: 'none' } as ClipboardImageResult, 'Clipboard không có ảnh'],
    ['ảnh quá lớn', { ok: false, reason: 'too_large' } as ClipboardImageResult, 'Ảnh quá lớn'],
    ['thiếu công cụ', { ok: false, reason: 'no_tool', detail: 'xclip' } as ClipboardImageResult, 'Thiếu công cụ đọc clipboard: xclip'],
    ['lỗi công cụ', { ok: false, reason: 'error', detail: 'Add-Type bị chặn' } as ClipboardImageResult, 'Không đọc được ảnh trong clipboard: Add-Type bị chặn'],
  ])('%s', async (_name, result, text) => {
    const { b: x } = await start(result);
    await x.type('\x1bv', 150);
    await x.until(() => x.screenText().includes(text));
    expect(x.screenText()).not.toMatch(/\[(🖼|img)1 /); // không đính kèm gì
  });

  it('lỗi ném ra từ bộ đọc không làm sập giao diện', async () => {
    const { b: x } = await start(async () => {
      throw new Error('hỏng bất ngờ');
    });
    await x.type('\x1bv', 150);
    await x.until(() => x.screenText().includes('Không đọc được ảnh trong clipboard: hỏng bất ngờ'));
    await x.type('vẫn gõ được');
    expect(x.app.editor.text).toBe('vẫn gõ được');
  });
});

describe('gửi tin có ảnh', () => {
  it('chỉ có ảnh, chưa gõ chữ: Enter vẫn gửi, kèm câu mặc định (trước đây Enter không làm gì)', async () => {
    const { b: x } = await start({ ok: true, attachment: att() });
    await x.type('\x1bv', 150);
    await x.until(() => CHIP(1).test(x.screenText()));
    await x.type(KEY.enter);
    await x.until(() => submits(x).length === 1);
    const [text, opts] = submits(x)[0].args as [string, { attachments: Attachment[] }];
    expect(text).toBe('Hãy xem ảnh đính kèm.');
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].name).toBe('clipboard-test.png');
    expect(x.screenText()).not.toMatch(CHIP(1)); // đã gửi thì chip biến mất
  });

  it('có chữ + ảnh: gửi đúng chữ đã gõ, kèm ảnh', async () => {
    const { b: x } = await start({ ok: true, attachment: att() });
    await x.type('ảnh này lỗi gì vậy');
    await x.type('\x1bv', 150);
    await x.until(() => CHIP(1).test(x.screenText()));
    await x.type(KEY.enter);
    await x.until(() => submits(x).length === 1);
    const [text, opts] = submits(x)[0].args as [string, { attachments: Attachment[] }];
    expect(text).toBe('ảnh này lỗi gì vậy');
    expect(opts.attachments).toHaveLength(1);
  });

  it('không có ảnh và không có chữ: Enter vẫn không gửi gì', async () => {
    const { b: x } = await start({ ok: false, reason: 'none' });
    await x.type(KEY.enter);
    expect(submits(x)).toHaveLength(0);
  });
});

describe('gợi ý cho người dùng biết phím nào dùng được', () => {
  const th = makeTheme(detectCaps({ env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' } }));
  const panel = (platform: NodeJS.Platform): string => renderShortcuts(th, 100, platform).map(stripAnsi).join('\n');

  it('Windows: bảng phím tắt nêu Alt+V và /paste, không hứa Ctrl+V', () => {
    const t = panel('win32');
    expect(t).toContain('Alt+V · /paste  dán ảnh');
    expect(t).not.toContain('Ctrl+V');
  });

  it('hệ điều hành khác: nêu cả Ctrl+V lẫn Alt+V', () => {
    expect(panel('linux')).toContain('Ctrl+V/Alt+V · /paste  dán ảnh');
    expect(panel('darwin')).toContain('Ctrl+V/Alt+V · /paste  dán ảnh');
  });

  it('? trong giao diện thật hiện dòng dán ảnh', async () => {
    b = await boot();
    await b.type('?');
    expect(b.screenText()).toMatch(/(Alt\+V|Ctrl\+V\/Alt\+V) · \/paste\s+dán ảnh/);
  });

  it('có một mẹo khởi động nhắc /paste', () => {
    expect(pickTip(6)).toContain('/paste');
  });
});
