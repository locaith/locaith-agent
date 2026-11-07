import { describe, expect, it } from 'vitest';
import type { TItem } from '../src/shared/protocol';
import { groupSessions } from '../src/shared/sessionGroups';
import { foldKeep, foldQuery, matchDoc, SessionSearchIndex, transcriptText } from '../src/shared/sessionSearch';
import type { SessionSearchHit } from '../src/shared/sessionsUxTypes';

const u = (id: string, text: string): TItem => ({ kind: 'user', id, text, attachments: [], ts: 1 }) as TItem;
const a = (id: string, text: string): TItem => ({ kind: 'assistant', id, blocks: [{ type: 'text', text }], done: true, ts: 1 }) as unknown as TItem;

describe('gập dấu tiếng Việt (giữ độ dài)', () => {
  it('"tai lieu" khớp "Tài liệu"; "dang" khớp "Đặng"; hoa/thường không quan trọng', () => {
    expect(foldKeep('Tài liệu')).toBe('tai lieu');
    expect(foldKeep('Đặng Văn Ơn')).toBe('dang van on');
    expect(matchDoc({ title: 'x', text: 'Gửi TÀI LIỆU cho Đặng' }, foldQuery('tai lieu'))).not.toBeNull();
    expect(matchDoc({ title: 'x', text: 'Gửi tài liệu cho Đặng' }, foldQuery('dang'))).not.toBeNull();
    expect(matchDoc({ title: 'x', text: 'Gửi tài liệu cho Đặng' }, foldQuery('tài liệu'))).not.toBeNull(); // có dấu cũng khớp
  });

  it('mỗi ký tự gập thành đúng một ký tự (mọi chữ cái tiếng Việt có dấu, cả dạng NFD) — vị trí khớp không lệch', () => {
    const s = 'ăâđêôơưÀÁẢÃẠẮẰẲẴẶẤẦẨẪẬÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ';
    expect(foldKeep(s.normalize('NFC')).length).toBe(s.normalize('NFC').length);
    expect(foldKeep(s.normalize('NFC'))).toMatch(/^[a-z]+$/);
    expect(foldQuery('Tài Liệu   Đặng')).toEqual(['tai', 'lieu', 'dang']);
  });

  it('truy vấn rỗng / chỉ khoảng trắng không khớp gì', () => {
    expect(foldQuery('   ')).toEqual([]);
    expect(matchDoc({ title: 'a', text: 'b' }, [])).toBeNull();
  });
});

describe('matchDoc: trích đoạn + làm nổi', () => {
  it('đánh dấu đúng chỗ trong bản GỐC dù khớp không dấu', () => {
    const text = 'Em đã sửa xong phần Đăng nhập, còn lại là kiểm thử.';
    const h = matchDoc({ title: 'Khác', text }, foldQuery('dang nhap'))!;
    expect(h.inTitle).toBe(false);
    expect(h.snippet).toBeDefined();
    const marked = h.marks!.map(([s, e]) => h.snippet!.slice(s, e));
    expect(marked.join('|').toLowerCase()).toBe('đăng|nhập');
  });

  it('văn bản dài: trích đoạn ngắn (≤ ~165 ký tự) có "…" hai đầu và chứa chỗ khớp; đếm số chỗ khớp', () => {
    const text = `${'lorem ipsum '.repeat(80)}CẦU NỐI ${'dolor sit '.repeat(80)} cầu nối nữa`;
    const h = matchDoc({ title: 't', text }, foldQuery('cau noi'))!;
    expect(h.snippet!.length).toBeLessThanOrEqual(170);
    expect(h.snippet!.startsWith('…')).toBe(true);
    expect(h.snippet!.endsWith('…')).toBe(true);
    expect(h.count).toBe(2);
    expect(h.snippet!.slice(...h.marks![0]).toLowerCase()).toBe('cầu');
  });

  it('khớp ở tiêu đề → inTitle; một từ khoá thiếu → không khớp (mọi từ phải có)', () => {
    expect(matchDoc({ title: 'Sửa lỗi đăng nhập', text: '' }, foldQuery('dang nhap'))!.inTitle).toBe(true);
    expect(matchDoc({ title: 'Sửa lỗi', text: 'đăng nhập' }, foldQuery('dang xuat'))).toBeNull();
  });

  it('transcriptText lấy chữ người dùng + chữ trả lời, bỏ khối công cụ', () => {
    const t = transcriptText([u('1', 'xin chào'), { kind: 'assistant', id: 'a', blocks: [{ type: 'text', text: 'đáp' }, { type: 'tool', id: 't1', name: 'x' } as never], done: true, ts: 1 } as never]);
    expect(t).toBe('xin chào\nđáp');
  });
});

describe('SessionSearchIndex: theo lô, không chặn, bỏ truy vấn cũ', () => {
  const store: Record<string, { title: string; transcript: TItem[] }> = {};
  for (let i = 0; i < 30; i++) store[`s${i}`] = { title: `Cuộc ${i}`, transcript: [u('u', i % 10 === 0 ? 'bàn về hợp đồng lao động' : 'chuyện khác'), a('a', 'ok')] };
  const targets = Object.keys(store).map((id, i) => ({ id, title: store[id].title, updatedAt: 1000 + i }));

  it('báo kết quả dần theo lô (nhiều hơn một lần gọi), lần cuối done=true, đủ kết quả', async () => {
    let loads = 0;
    const idx = new SessionSearchIndex(async (id) => (loads++, store[id] ?? null), { batch: 8 });
    const calls: Array<{ n: number; done: boolean }> = [];
    await idx.search(targets, 'hop dong', (hits, done) => calls.push({ n: hits.length, done }));
    expect(calls.length).toBe(4); // 30 cuộc / lô 8
    expect(calls.slice(0, -1).every((c) => !c.done)).toBe(true);
    expect(calls[calls.length - 1]).toEqual({ n: 3, done: true });
    expect(loads).toBe(30);
  });

  it('chỉ mục được giữ: tìm lần hai không đọc lại cuộc chưa đổi; cuộc đổi (updatedAt) thì đọc lại', async () => {
    let loads = 0;
    const idx = new SessionSearchIndex(async (id) => (loads++, store[id] ?? null));
    await idx.search(targets, 'hop dong', () => {});
    expect(loads).toBe(30);
    await idx.search(targets, 'khac', () => {});
    expect(loads).toBe(30);
    const changed = targets.map((t) => (t.id === 's3' ? { ...t, updatedAt: 9999 } : t));
    await idx.search(changed, 'khac', () => {});
    expect(loads).toBe(31);
  });

  it('truy vấn mới bắt đầu thì truy vấn cũ dừng, không gọi onBatch nữa', async () => {
    const idx = new SessionSearchIndex(async (id) => store[id] ?? null, { batch: 2 });
    const old: SessionSearchHit[][] = [];
    const first = idx.search(targets, 'chuyen', (h) => old.push(h));
    const second = idx.search(targets, 'hop dong', () => {});
    await Promise.all([first, second]);
    // truy vấn cũ có thể đã báo vài lô trước khi bị thay, nhưng không bao giờ báo đủ 30 cuộc
    expect(old.length).toBeLessThan(15);
  });

  it('cuộc đã xoá bị loại khỏi chỉ mục; không đọc được thì bỏ qua, không hỏng cả lần tìm', async () => {
    const idx = new SessionSearchIndex(async (id) => (id === 's1' ? Promise.reject(new Error('hỏng')) : store[id] ?? null));
    let last: SessionSearchHit[] = [];
    await idx.search(targets, 'chuyen', (h) => (last = h));
    expect(last.some((h) => h.id === 's1')).toBe(false);
    expect(last.length).toBeGreaterThan(10);
    await idx.search(targets.slice(0, 5), 'chuyen', () => {});
    expect(idx.size).toBeLessThanOrEqual(4);
  });

  it('truy vấn rỗng → không đọc gì, done ngay', async () => {
    let loads = 0;
    const idx = new SessionSearchIndex(async () => (loads++, null));
    const calls: boolean[] = [];
    await idx.search(targets, '  ', (_h, done) => calls.push(done));
    expect(calls).toEqual([true]);
    expect(loads).toBe(0);
  });
});

describe('nhóm lịch sử theo ngày', () => {
  const now = new Date(2026, 10, 7, 15, 0, 0).getTime();
  const day = 24 * 3600 * 1000;
  const at = (daysAgo: number, h = 10) => new Date(2026, 10, 7 - daysAgo, h).getTime();

  it('Hôm nay · Hôm qua · 7 ngày · 30 ngày · Cũ hơn, giữ thứ tự; ghim lên đầu; nhóm rỗng bị bỏ', () => {
    const items = [
      { id: 'a', updatedAt: at(0) },
      { id: 'b', updatedAt: at(0, 8) },
      { id: 'c', updatedAt: at(1) },
      { id: 'd', updatedAt: at(4) },
      { id: 'e', updatedAt: at(20) },
      { id: 'f', updatedAt: at(90), pinned: true },
      { id: 'g', updatedAt: at(200) },
    ];
    const g = groupSessions(items, now);
    expect(g.map((x) => x.key)).toEqual(['pinned', 'today', 'yesterday', 'week', 'month', 'older']);
    expect(g.find((x) => x.key === 'today')!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(g.find((x) => x.key === 'pinned')!.items.map((i) => i.id)).toEqual(['f']);
    expect(groupSessions([{ id: 'x', updatedAt: now - 40 * day }], now).map((x) => x.key)).toEqual(['older']);
  });
});
