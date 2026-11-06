import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import { SessionStore, type StoreIO } from '../src/host/sessionStore';

/** Kho lưu trữ trong bộ nhớ: nhiều SessionStore (= nhiều cửa sổ VS Code) dùng chung một thư mục. */
function memoryIO(files: Map<string, Uint8Array> = new Map()): StoreIO & { files: Map<string, Uint8Array> } {
  return {
    files,
    async read(name) {
      const f = files.get(name);
      if (!f) throw new Error('ENOENT');
      return f;
    },
    async write(name, data) {
      files.set(name, data);
    },
    async remove(name) {
      files.delete(name);
    },
    async names() {
      return [...files.keys()];
    },
  };
}

const session = (id: string, over: Partial<ReturnType<typeof newSession>> = {}) => {
  const s = newSession({ id, provider: 'fake', model: 'm', title: `Hội thoại ${id}`, ...over });
  s.messages.push({ role: 'user', content: [{ type: 'text', text: `xin chào ${id}` }] });
  return s;
};

describe('SessionStore', () => {
  it('lưu rồi liệt kê, mới nhất lên đầu, chỉ của workspace hiện tại', async () => {
    const io = memoryIO();
    const a = new SessionStore(undefined, 'ws-a', io);
    const b = new SessionStore(undefined, 'ws-b', io);
    await a.save(session('a1', { updatedAt: 1000 }), []);
    await a.save(session('a2', { updatedAt: 2000 }), []);
    await b.save(session('b1', { updatedAt: 3000 }), []);
    expect((await a.list()).map((s) => s.id)).toEqual(['a2', 'a1']);
    expect((await b.list()).map((s) => s.id)).toEqual(['b1']);
  });

  it('hai cửa sổ ghi chồng chéo KHÔNG làm mất mục của nhau (trước đây b1 thành tệp mồ côi)', async () => {
    const io = memoryIO();
    const winA = new SessionStore(undefined, 'ws', io);
    const winB = new SessionStore(undefined, 'ws', io);
    await winA.list(); // cửa sổ A nạp chỉ mục (rỗng) vào bộ nhớ
    await winA.save(session('a1', { updatedAt: 1 }), []);
    await winA.save(session('a2', { updatedAt: 2 }), []);
    await winB.save(session('b1', { updatedAt: 3 }), []);
    await winA.save(session('a1', { updatedAt: 4, title: 'a1 đã đổi tên' }), []);
    const ids = (await winA.list()).map((s) => s.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'b1']);
    expect((await winB.list()).map((s) => s.id).sort()).toEqual(['a1', 'a2', 'b1']);
    expect((await winB.list()).find((s) => s.id === 'a1')?.title).toBe('a1 đã đổi tên');
  });

  it('chỉ mục bị ghi đè thiếu mục (cuộc đua) tự lành ở lần liệt kê sau: tệp mồ côi được thêm lại', async () => {
    const io = memoryIO();
    const s = new SessionStore(undefined, 'ws', io);
    await s.save(session('x1', { updatedAt: 1 }), []);
    await s.save(session('x2', { updatedAt: 2 }), []);
    // Cửa sổ khác ghi chỉ mục cũ chỉ có x1 (mô phỏng cuộc đua)
    io.files.set('index.json', new TextEncoder().encode(JSON.stringify([{ id: 'x1', title: 'Hội thoại x1', updatedAt: 1, provider: 'fake', model: 'm', messageCount: 1, workspace: 'ws' }])));
    expect((await s.list()).map((e) => e.id).sort()).toEqual(['x1', 'x2']);
  });

  it('chỉ mục hỏng hoặc không đọc được → dựng lại từ các tệp phiên, KHÔNG xoá sạch danh sách ở lần lưu kế tiếp', async () => {
    const io = memoryIO();
    const s = new SessionStore(undefined, 'ws', io);
    await s.save(session('k1', { updatedAt: 1 }), []);
    await s.save(session('k2', { updatedAt: 2 }), []);
    io.files.set('index.json', new TextEncoder().encode('{ không phải json'));
    await s.save(session('k3', { updatedAt: 3 }), []); // trước đây: đọc hỏng → [] → ghi đè chỉ còn k3
    expect((await s.list()).map((e) => e.id).sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it('xoá một hội thoại: tệp và mục chỉ mục cùng mất; mục của tệp đã mất bị loại', async () => {
    const io = memoryIO();
    const s = new SessionStore(undefined, 'ws', io);
    await s.save(session('d1', { updatedAt: 1 }), []);
    await s.save(session('d2', { updatedAt: 2 }), []);
    await s.delete('d1');
    expect(io.files.has('d1.json')).toBe(false);
    expect((await s.list()).map((e) => e.id)).toEqual(['d2']);
    io.files.delete('d2.json'); // tệp biến mất ngoài ý muốn
    expect(await s.list()).toEqual([]);
  });

  it('không lưu hội thoại rỗng và từ chối id có ký tự lạ (chống đi ra ngoài thư mục)', async () => {
    const io = memoryIO();
    const s = new SessionStore(undefined, 'ws', io);
    await s.save(newSession({ id: 'rong', provider: 'fake', model: 'm' }), []);
    expect(io.files.size).toBe(0);
    expect(await s.load('../../etc/passwd')).toBeNull();
    await s.delete('../x'); // không ném, không đụng gì
    expect(io.files.size).toBe(0);
  });

  it('đổi tên giữ nguyên nội dung', async () => {
    const io = memoryIO();
    const s = new SessionStore(undefined, 'ws', io);
    await s.save(session('r1', { updatedAt: 5 }), []);
    await s.rename('r1', 'Tên mới có dấu: Đặng Thị Hồng');
    expect((await s.list())[0].title).toBe('Tên mới có dấu: Đặng Thị Hồng');
    expect((await s.load('r1'))?.session.messages).toHaveLength(1);
  });
});
