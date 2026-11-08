import { describe, expect, it } from 'vitest';
import { Screen } from '../../../src/cli/tui/screen';
import { VT } from './helpers/vt';

const mk = (cols = 40, rows = 10) => {
  const vt = new VT(cols, rows);
  const scr = new Screen(vt, { minFrameMs: 0 });
  return { vt, scr };
};

describe('Screen — vùng sống', () => {
  it('vẽ vùng sống và cập nhật tại chỗ không để lại rác', async () => {
    const { vt, scr } = mk();
    scr.setLive(['┌ ô nhập ┐', '> abc', 'footer']);
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['┌ ô nhập ┐', '> abc', 'footer']);
    scr.setLive(['┌ ô nhập ┐', '> abcdef', 'footer']);
    scr.flush();
    scr.setLive(['> xyz', 'footer']); // co lại
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['> xyz', 'footer']);
    scr.setLive(['a', 'b', 'c', 'd']); // phình ra
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('in thẳng vào scrollback phía trên vùng sống, đúng thứ tự', async () => {
    const { vt, scr } = mk();
    scr.setLive(['> ', 'status']);
    scr.flush();
    scr.print(['dòng 1', 'dòng 2']);
    scr.flush();
    scr.print(['dòng 3']);
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['dòng 1', 'dòng 2', 'dòng 3', '> ', 'status']);
    expect(vt.cursor().y).toBe(4);
  });

  it('nhiều dòng hơn chiều cao màn hình → vào scrollback, vùng sống vẫn ở đáy', async () => {
    const { vt, scr } = mk(30, 6);
    scr.setLive(['> input', 'status']);
    scr.flush();
    for (let i = 1; i <= 40; i++) scr.print([`dòng ${i}`]);
    scr.flush();
    await vt.settle();
    const all = vt.all();
    expect(all.slice(0, 40)).toEqual(Array.from({ length: 40 }, (_, i) => `dòng ${i + 1}`));
    expect(all.slice(-2)).toEqual(['> input', 'status']);
    expect(all.length).toBe(42);
    expect(vt.screen().slice(-2)).toEqual(['> input', 'status']);
  });

  it('in từng dòng kèm cập nhật vùng sống nhiều lần (stream) không lặp/rác', async () => {
    const { vt, scr } = mk(30, 8);
    scr.setLive(['> ', 'status']);
    const printed: string[] = [];
    for (let i = 0; i < 25; i++) {
      scr.print([`out ${i}`]);
      printed.push(`out ${i}`);
      scr.setLive([`đang viết ${i}…`, '> ', 'status']);
      scr.flush();
    }
    scr.setLive(['> ', 'status']);
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual([...printed, '> ', 'status']);
  });

  it('dòng cuối rộng đúng bằng số cột không mất ký tự', async () => {
    const { vt, scr } = mk(20, 6);
    scr.setLive(['x'.repeat(20), 'y'.repeat(20)]);
    scr.flush();
    scr.setLive(['x'.repeat(20), 'z'.repeat(20)]);
    scr.flush();
    await vt.settle();
    const all = vt.all();
    expect(all[0]).toBe('x'.repeat(20));
    expect(all[1].length).toBe(19); // dòng cuối bị cắt còn cols-1
    expect(all.length).toBe(2);
  });

  it('đổi cỡ: hẹp lại rồi rộng ra, vẽ lại sạch', async () => {
    const { vt, scr } = mk(40, 10);
    const build = (w: number): string[] => ['─'.repeat(w - 1), '> hello', 'footer'];
    scr.onResize = () => scr.setLive(build(vt.columns));
    scr.setLive(build(40));
    scr.print(['lịch sử']);
    scr.flush();
    await vt.settle();
    await vt.resize(20);
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['lịch sử', '─'.repeat(19), '> hello', 'footer']);
    await vt.resize(50);
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['lịch sử', '─'.repeat(49), '> hello', 'footer']);
  });

  it('close() xoá vùng sống và đặt con trỏ ở dòng trống bên dưới nội dung đã in', async () => {
    const { vt, scr } = mk();
    scr.print(['xong']);
    scr.setLive(['> ', 'status']);
    scr.flush();
    scr.close();
    await vt.settle();
    expect(vt.all()).toEqual(['xong']);
    expect(vt.cursor()).toEqual({ x: 0, y: 1 });
  });

  it('clearScreen xoá cả scrollback', async () => {
    const { vt, scr } = mk(20, 5);
    for (let i = 0; i < 12; i++) scr.print([`d${i}`]);
    scr.setLive(['> ']);
    scr.flush();
    scr.clearScreen();
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['> ']);
  });

  it('bọc mỗi khung trong synchronized output và không bao giờ xoá màn hình khi vẽ thường', async () => {
    const { vt, scr } = mk();
    scr.setLive(['a']);
    scr.flush();
    scr.print(['b']);
    scr.flush();
    const raw = vt.raw.join('');
    expect(raw.match(/\x1b\[\?2026h/g)?.length).toBe(2);
    expect(raw.match(/\x1b\[\?2026l/g)?.length).toBe(2);
    expect(raw).not.toContain('\x1b[2J');
  });

  it('vùng sống cao hơn màn hình bị cắt phần trên, giữ phần đáy', async () => {
    const { vt, scr } = mk(20, 5);
    scr.setLive(Array.from({ length: 12 }, (_, i) => `l${i}`));
    scr.flush();
    await vt.settle();
    expect(vt.all()).toEqual(['l8', 'l9', 'l10', 'l11']);
  });

  it('khung không đổi gì thì không ghi lại nội dung các dòng giống hệt', async () => {
    const { vt, scr } = mk();
    scr.setLive(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    scr.flush();
    const before = scr.bytesWritten;
    scr.setLive(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccX']);
    scr.flush();
    const delta = scr.bytesWritten - before;
    expect(delta).toBeLessThan(60);
    await vt.settle();
    expect(vt.all()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccX']);
  });
});
