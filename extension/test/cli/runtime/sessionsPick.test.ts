/**
 * `/sessions` và `/resume` ở tầng runtime. Trước đây `/sessions` chỉ in một bảng mã (không chọn được, không nói làm gì tiếp), `locaith sessions` cắt mã còn 8 ký tự
 * (các phiên tạo gần nhau chung 8 ký tự đầu nên không dùng được), và chỉ có `/resume` mới có hộp chọn — mà chỗ nào cũng không nhắc tới.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../../src/cli/runtime';
import { textTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, tmpDir, type Harness } from './harness';
import { writeFixtureSessions } from './sessionFixtures';

afterEach(() => cleanupDirs());

interface AskItem {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  current?: boolean;
}
type AskEvent = Extract<RuntimeEvent, { t: 'ask' }>;
type PickAsk = { id: string; kind: string; title: string; hint?: string; searchable?: boolean; items: AskItem[] };

async function boot(o: { interactive?: boolean; emptyHere?: boolean; script?: NonNullable<Parameters<typeof harness>[0]>['script'] } = {}): Promise<{ h: Harness; other: string; cwd: string }> {
  const home = tmpDir('lc-home-');
  const sessionsCwd = tmpDir('lc-cwd-');
  const other = tmpDir('lc-other-');
  writeFixtureSessions(home, sessionsCwd, other);
  // emptyHere: chạy ở một thư mục KHÁC thư mục của các phiên → thư mục này chưa có phiên nào
  const cwd = o.emptyHere ? tmpDir('lc-empty-') : sessionsCwd;
  const h = await harness({ home, cwd, script: o.script ?? [], ...(o.interactive === false ? { interactive: false } : {}) });
  return { h, other, cwd };
}

const asks = (h: Harness): PickAsk[] => h.events.filter((e): e is AskEvent => e.t === 'ask').map((e) => e.ask as unknown as PickAsk);
const lastAsk = (h: Harness): PickAsk => {
  const a = asks(h).pop();
  if (!a) throw new Error('chưa có hộp chọn nào');
  return a;
};
const lastOutput = (h: Harness): string => h.outputs().pop() ?? '';

describe('/sessions — hộp chọn thay cho bảng mã không chọn được', () => {
  it('mở HỘP CHỌN (có ô tìm, có câu hướng dẫn), mới nhất trước; không in bảng', async () => {
    const { h } = await boot();
    await h.rt.submit('/sessions');
    const a = lastAsk(h);
    expect(a.kind).toBe('pick');
    expect(a.searchable).toBe(true);
    expect(a.hint).toMatch(/Enter/);
    expect(a.hint).toMatch(/lọc/);
    expect(a.items.map((i) => i.id)).toEqual(['cli_mw7yd9w31u', 'cli_mw7yb2k4zz', 'cli_mw7xk2p8qa', 'cli_mw6zt4h1bc']);
    expect(a.items[0].label).toBe('Sửa lỗi đăng nhập trang quản trị');
    expect(h.outputs().join('\n')).not.toContain('| ID |');
    h.rt.answer(a.id, null);
    await h.rt.idle();
    await h.cleanup();
  });

  it('hàng hiện «2 giờ trước · model · N tin» (nhìn là biết phiên nào vừa dùng); chỉ một thư mục thì không chia nhóm', async () => {
    const { h } = await boot();
    await h.rt.submit('/sessions');
    const a = lastAsk(h);
    expect(a.items[0].detail).toBe('2 giờ trước · locaith-v5-flash · 2 tin');
    expect(a.items[1].detail).toMatch(/^5 giờ trước/);
    expect(a.items[2].detail).toMatch(/^hôm qua/);
    expect(a.items[3].detail).toMatch(/^3 ngày trước/);
    expect(a.items.every((i) => i.group === undefined)).toBe(true);
    h.rt.answer(a.id, null);
    await h.rt.idle();
    await h.cleanup();
  });

  it('chọn một phiên → mở lại phiên đó: replay hội thoại, đổi sessionId, báo «Đã mở lại phiên: …»', async () => {
    const { h } = await boot();
    await h.rt.submit('/sessions');
    h.rt.answer(lastAsk(h).id, 'cli_mw7xk2p8qa');
    await h.rt.idle();
    expect(h.rt.status().sessionId).toBe('cli_mw7xk2p8qa');
    const replay = h.events.filter((e) => e.t === 'replay').pop() as { reason: string; items: unknown[] };
    expect(replay.reason).toBe('resume');
    expect(JSON.stringify(replay.items)).toContain('Viết test cho module thanh toán');
    expect(h.toasts().join('|')).toContain('Đã mở lại phiên: Viết test cho module thanh toán');
    await h.cleanup();
  });

  it('Esc (huỷ) không đổi gì', async () => {
    const { h } = await boot();
    const before = h.rt.status().sessionId;
    await h.rt.submit('/sessions');
    h.rt.answer(lastAsk(h).id, null);
    await h.rt.idle();
    expect(h.rt.status().sessionId).toBe(before);
    expect(h.events.some((e) => e.t === 'replay' && (e as { reason: string }).reason === 'resume')).toBe(false);
    await h.cleanup();
  });

  it('`/sessions all` gồm cả thư mục khác: phiên của thư mục này lên trước, mỗi nhóm có tiêu đề, hàng của thư mục khác ghi tên thư mục', async () => {
    const { h, other } = await boot();
    await h.rt.submit('/sessions all');
    const a = lastAsk(h);
    expect(a.title).toMatch(/mọi thư mục/);
    expect(a.items.map((i) => i.id)).toEqual(['cli_mw7yd9w31u', 'cli_mw7yb2k4zz', 'cli_mw7xk2p8qa', 'cli_mw6zt4h1bc', 'cli_mw4ww1n7ee']);
    expect(a.items.map((i) => i.group)).toEqual(['Thư mục này', 'Thư mục này', 'Thư mục này', 'Thư mục này', 'Thư mục khác']);
    expect(a.items[4].detail).toContain(path.basename(other));
    h.rt.answer(a.id, null);
    await h.rt.idle();
    await h.cleanup();
  });

  it('thư mục này CHƯA có phiên nào nhưng nơi khác có: vẫn hiện danh sách (tiêu đề nói «mọi thư mục»), không báo «chưa có phiên»', async () => {
    const { h } = await boot({ emptyHere: true });
    await h.rt.submit('/sessions');
    const a = lastAsk(h);
    expect(a.title).toMatch(/mọi thư mục/);
    expect(a.items).toHaveLength(5);
    h.rt.answer(a.id, null);
    await h.rt.idle();
    expect(h.outputs().join('\n')).not.toContain('Chưa có phiên nào');
    await h.cleanup();
  });

  it('chưa có phiên nào ở đâu cả → nói rõ, không mở hộp chọn rỗng', async () => {
    const h = await harness({ script: [] });
    await h.rt.submit('/sessions');
    expect(lastOutput(h)).toContain('Chưa có phiên nào được lưu');
    expect(asks(h)).toHaveLength(0);
    await h.cleanup();
  });
});

describe('/sessions list — bảng cho ai muốn sao chép mã', () => {
  it('có cột số thứ tự, mã ĐẦY ĐỦ (không cắt) và chân bảng nói rõ cách mở lại; không mở hộp chọn', async () => {
    const { h } = await boot();
    await h.rt.submit('/sessions list');
    const out = lastOutput(h);
    expect(out).toContain('| # | ID |');
    expect(out).toContain('| 1 | `cli_mw7yd9w31u` |');
    expect(out).toContain('| 4 | `cli_mw6zt4h1bc` |');
    expect(out).toContain('Sửa lỗi build trên CI');
    expect(out).not.toContain('cli_mw4ww1n7ee'); // thư mục khác: chỉ khi `all`
    // chân bảng: cách mở lại, có ví dụ bằng mã thật của dòng đầu
    expect(out).toMatch(/\/resume/);
    expect(out).toContain('locaith -r cli_mw7yd9w31u');
    expect(out).toContain('locaith -c');
    expect(asks(h)).toHaveLength(0);
    await h.cleanup();
  });

  it('`list all`: gồm thư mục khác; KHÔNG đánh số (số chỉ có nghĩa với danh sách của thư mục này)', async () => {
    const { h } = await boot();
    await h.rt.submit('/sessions list all');
    const out = lastOutput(h);
    expect(out).toContain('`cli_mw4ww1n7ee`');
    expect(out).not.toContain('| # |');
    expect(out).not.toContain('/resume 2');
    expect(out).toContain('/resume all');
    await h.cleanup();
  });

  it('không có giao diện tương tác (-p): /sessions và /resume đều in bảng kèm hướng dẫn, không bao giờ chờ hộp chọn', async () => {
    const { h } = await boot({ interactive: false });
    await h.rt.submit('/sessions');
    expect(lastOutput(h)).toContain('| 1 | `cli_mw7yd9w31u` |');
    expect(lastOutput(h)).toContain('locaith -r cli_mw7yd9w31u');
    await h.rt.submit('/resume');
    expect(lastOutput(h)).toContain('| # | ID |');
    expect(asks(h)).toHaveLength(0);
    await h.cleanup();
  });
});

describe('/resume — chọn bằng hộp chọn, số, từ khoá hoặc mã', () => {
  it('không đối số: hộp chọn như /sessions (cùng danh sách, cùng câu hướng dẫn)', async () => {
    const { h } = await boot();
    await h.rt.submit('/resume');
    const a = lastAsk(h);
    expect(a.title).toBe('Mở lại phiên đã lưu');
    expect(a.hint).toMatch(/Enter/);
    expect(a.items).toHaveLength(4);
    h.rt.answer(a.id, null);
    await h.rt.idle();
    await h.cleanup();
  });

  it('theo SỐ: `/resume 2` mở thẳng phiên thứ hai (không hỏi); `#3` cũng được', async () => {
    const one = await boot();
    await one.h.rt.submit('/resume 2');
    await one.h.rt.idle();
    expect(one.h.rt.status().sessionId).toBe('cli_mw7yb2k4zz');
    expect(asks(one.h)).toHaveLength(0);
    await one.h.cleanup();
    const two = await boot();
    await two.h.rt.submit('/resume #3');
    await two.h.rt.idle();
    expect(two.h.rt.status().sessionId).toBe('cli_mw7xk2p8qa');
    await two.h.cleanup();
  });

  it('số vượt danh sách → báo lỗi nêu rõ số phiên hiện có (không mở nhầm phiên nào)', async () => {
    const { h } = await boot();
    const before = h.rt.status().sessionId;
    await h.rt.submit('/resume 9');
    expect(lastOutput(h)).toMatch(/Không có phiên số 9 — danh sách chỉ có 4 phiên/);
    expect(h.rt.status().sessionId).toBe(before);
    await h.cleanup();
  });

  it('theo TỪ KHOÁ trong tiêu đề, gõ không dấu cũng được: `/resume thanh toan`', async () => {
    const { h } = await boot();
    await h.rt.submit('/resume thanh toan');
    await h.rt.idle();
    expect(h.rt.status().sessionId).toBe('cli_mw7xk2p8qa');
    expect(h.toasts().join('|')).toContain('Đã mở lại phiên: Viết test cho module thanh toán');
    await h.cleanup();
  });

  it('từ khoá khớp NHIỀU phiên → hộp chọn chỉ gồm các phiên khớp (tiêu đề nói rõ có mấy phiên), chọn xong mở lại', async () => {
    const { h } = await boot();
    await h.rt.submit('/resume build');
    const a = lastAsk(h);
    expect(a.title).toBe('Có 2 phiên khớp «build» — chọn một');
    expect(a.items.map((i) => i.id)).toEqual(['cli_mw7yb2k4zz', 'cli_mw6zt4h1bc']);
    h.rt.answer(a.id, 'cli_mw6zt4h1bc');
    await h.rt.idle();
    expect(h.rt.status().sessionId).toBe('cli_mw6zt4h1bc');
    await h.cleanup();
  });

  it('đầu mã dùng chung (cli_mw7y) → hộp chọn giữa các phiên khớp; đầu mã đủ dài thì mở thẳng', async () => {
    const a = await boot();
    await a.h.rt.submit('/resume cli_mw7y');
    expect(lastAsk(a.h).items.map((i) => i.id)).toEqual(['cli_mw7yd9w31u', 'cli_mw7yb2k4zz']);
    a.h.rt.answer(lastAsk(a.h).id, null);
    await a.h.rt.idle();
    await a.h.cleanup();
    const b = await boot();
    await b.h.rt.submit('/resume cli_mw7yb');
    await b.h.rt.idle();
    expect(b.h.rt.status().sessionId).toBe('cli_mw7yb2k4zz');
    expect(asks(b.h)).toHaveLength(0);
    await b.h.cleanup();
  });

  it('nhiều phiên khớp mà không có giao diện chọn (-p) → liệt kê mã để chọn, không đoán bừa', async () => {
    const { h } = await boot({ interactive: false });
    const before = h.rt.status().sessionId;
    await h.rt.submit('/resume cli_mw7y');
    const out = lastOutput(h);
    expect(out).toContain('Có 2 phiên khớp «cli_mw7y»');
    expect(out).toContain('cli_mw7yd9w31u');
    expect(out).toContain('cli_mw7yb2k4zz');
    expect(h.rt.status().sessionId).toBe(before);
    await h.cleanup();
  });

  it('không thấy → nói rõ và chỉ cách xem danh sách', async () => {
    const { h } = await boot();
    await h.rt.submit('/resume khong-co-phien-nay');
    expect(lastOutput(h)).toContain('Không thấy phiên «khong-co-phien-nay»');
    expect(lastOutput(h)).toContain('/sessions');
    await h.cleanup();
  });

  it('`/resume all` mở hộp chọn mọi thư mục', async () => {
    const { h } = await boot();
    await h.rt.submit('/resume all');
    expect(lastAsk(h).items).toHaveLength(5);
    expect(lastAsk(h).title).toMatch(/mọi thư mục/);
    h.rt.answer(lastAsk(h).id, null);
    await h.rt.idle();
    await h.cleanup();
  });

  it('rt.resume() (dùng cho `locaith -r <…>` lúc khởi động) hiểu cả số và từ khoá, lỗi có hướng dẫn', async () => {
    const { h } = await boot();
    await h.rt.resume('3');
    expect(h.rt.status().sessionId).toBe('cli_mw7xk2p8qa');
    await h.rt.resume('đăng nhập trang');
    expect(h.rt.status().sessionId).toBe('cli_mw7yd9w31u');
    await expect(h.rt.resume('cli_mw7y')).rejects.toThrow(/Có 2 phiên khớp «cli_mw7y».*locaith -r/);
    await expect(h.rt.resume('khong-co')).rejects.toThrow(/Không thấy phiên «khong-co».*locaith sessions/);
    await h.cleanup();
  });
});

describe('/sessions khi trợ lý đang trả lời', () => {
  it('chỉ cho XEM (bảng + lý do), không mở hộp chọn — vì mở lại một phiên phải đợi trợ lý rảnh', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { h } = await boot({
      script: [
        async () => {
          await gate;
          return textTurn('xong');
        },
      ],
    });
    await h.rt.submit('hãy làm một việc dài'); // bắt đầu lượt chạy (đang chờ gate)
    expect(h.rt.status().running).toBe(true);
    await h.rt.submit('/sessions');
    expect(asks(h)).toHaveLength(0);
    const out = lastOutput(h);
    expect(out).toContain('Trợ lý đang chạy nên chưa mở lại phiên được');
    expect(out).toContain('| 1 | `cli_mw7yd9w31u` |');
    release();
    await h.rt.idle();
    await h.cleanup();
  });
});
