import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import type { ChatMessage } from '../src/core/types';
import type { AssistantItem, TItem, UserItem } from '../src/shared/protocol';
import { BaseSessionStore, type StoreIO } from '../src/shared/sessionStore';
import { imageKey, isTurnStart, reconcileTranscript, rebuildTranscript, stripWrappers, userTurnCount } from '../src/shared/transcriptRebuild';

const u = (text: string, ts = 1): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }], ts });
const a = (text: string, ts = 2): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }], provider: 'p', model: 'm', ts });
const call = (id: string, name: string, ts = 2): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { path: 'a.ts' } }], provider: 'p', model: 'm', ts });
const res = (id: string, content: string, isError = false, extra: ChatMessage['content'] = []): ChatMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, name: 'x', content, ...(isError ? { isError: true } : {}) }, ...extra], ts: 3 });

const CONVO: ChatMessage[] = [
  u('<ide_context>\nActive file: a.ts\n</ide_context>\n\nCâu hỏi 1', 100),
  call('t1', 'read_file', 101),
  res('t1', 'nội dung tệp'),
  a('Trả lời 1', 103),
  { role: 'user', synthetic: true, content: [{ type: 'text', text: 'Hãy tiếp tục.' }], ts: 104 },
  { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA'.repeat(10) }, { type: 'text', text: 'Câu hỏi 2 kèm ảnh' }], ts: 200 },
  call('t2', 'grep', 201),
  res('t2', 'lỗi rồi', true),
  a('Trả lời 2', 203),
  call('t3', 'list_dir', 300),
  res('t3', 'ok', false, [{ type: 'text', text: '[Người dùng vừa gửi thêm tin nhắn trong lúc bạn đang làm việc — xem bên dưới.]' }, { type: 'text', text: 'Chen giữa nhé' }]),
  a('Trả lời 3', 305),
];

describe('dựng lại transcript từ messages', () => {
  it('bóc khối bao quanh nhưng không đụng vào XML người dùng tự gõ', () => {
    expect(stripWrappers('<ide_context>\nx\n</ide_context>\n\n<attached_file path="a">\nbody\n</attached_file>\n\nHỏi gì đó')).toBe('Hỏi gì đó');
    expect(stripWrappers('<tep_tai_len id="1" ten="a.txt" loai="txt">\nnội dung\n</tep_tai_len>\n\nTóm tắt giúp')).toBe('Tóm tắt giúp');
    expect(stripWrappers('<div>chữ của tôi</div> sửa giúp')).toBe('<div>chữ của tôi</div> sửa giúp');
  });

  it('đếm đúng lượt người dùng: bỏ tin tổng hợp và tin kết quả công cụ', () => {
    expect(userTurnCount(CONVO)).toBe(2);
    expect(isTurnStart(CONVO[2])).toBe(false);
    expect(isTurnStart(CONVO[4])).toBe(false);
  });

  it('dựng user / assistant / công cụ / ảnh / tin chen giữa đúng thứ tự', () => {
    const items = rebuildTranscript(CONVO);
    expect(items.map((i) => (i.kind === 'user' ? (i.steer ? 'user*' : 'user') : i.kind))).toEqual(['user', 'assistant', 'user', 'assistant', 'user*', 'assistant']);
    const [u1, a1, u2, a2, st, a3] = items as [UserItem, AssistantItem, UserItem, AssistantItem, UserItem, AssistantItem];
    expect(u1.text).toBe('Câu hỏi 1');
    expect(a1.blocks.map((b) => b.type)).toEqual(['tool', 'text']);
    expect(a1.blocks[0]).toMatchObject({ type: 'tool', name: 'read_file', state: 'done', output: 'nội dung tệp' });
    expect(u2.text).toBe('Câu hỏi 2 kèm ảnh');
    expect(u2.attachments).toEqual([{ kind: 'image', label: 'Ảnh 1', mediaType: 'image/png', imgKey: imageKey('AAAA'.repeat(10)) }]);
    expect(a2.blocks[0]).toMatchObject({ type: 'tool', name: 'grep', state: 'error' });
    expect(st.text).toBe('Chen giữa nhé');
    expect(a2.blocks.map((b) => b.type)).toEqual(['tool', 'text', 'tool']); // công cụ gọi TRƯỚC tin chen giữa vẫn thuộc đoạn cũ
    expect(a3.blocks.map((b) => b.type)).toEqual(['text']); // tin chen giữa mở đoạn trả lời mới
    expect(items.every((i) => i.kind !== 'assistant' || i.done)).toBe(true);
  });

  it('lệnh gọi không có kết quả thành "đã huỷ"', () => {
    const items = rebuildTranscript([u('xin chào'), call('x', 'run_command')]);
    expect((items[1] as AssistantItem).blocks[0]).toMatchObject({ state: 'cancelled' });
  });

  it('imageKey ổn định và phân biệt ảnh khác nhau', () => {
    expect(imageKey('abc'.repeat(5000))).toBe(imageKey('abc'.repeat(5000)));
    expect(imageKey('abc'.repeat(5000))).not.toBe(imageKey('abd'.repeat(5000)));
  });
});

describe('reconcileTranscript — hàn gắn transcript bị thiếu', () => {
  const full = rebuildTranscript(CONVO);

  it('transcript đủ lượt → giữ nguyên (cùng tham chiếu, không ghi lại)', () => {
    const r = reconcileTranscript(CONVO, full);
    expect(r.rebuilt).toBe(false);
    expect(r.items).toBe(full);
  });

  it('transcript NHIỀU lượt hơn messages (đã nén ngữ cảnh) → giữ nguyên, không bao giờ cắt bớt', () => {
    const compacted: ChatMessage[] = [{ role: 'user', synthetic: true, content: [{ type: 'text', text: 'tóm tắt' }] }, u('Câu hỏi 2 kèm ảnh', 200), a('Trả lời 2', 203)];
    const r = reconcileTranscript(compacted, full);
    expect(r.rebuilt).toBe(false);
    expect(r.items).toBe(full);
  });

  it('chỉ còn lượt cuối trong transcript → dựng lại phần đầu, giữ NGUYÊN các mục đuôi (cùng tham chiếu)', () => {
    const tail = full.slice(2); // từ "Câu hỏi 2" trở đi
    const r = reconcileTranscript(CONVO, tail);
    expect(r.rebuilt).toBe(true);
    expect(r.added).toBe(1);
    expect(r.items.length).toBe(full.length);
    expect(r.items.slice(0, 2).map((i) => i.kind)).toEqual(['user', 'assistant']);
    tail.forEach((it, i) => expect(r.items[2 + i]).toBe(it));
  });

  it('không nối được (khác chữ) → dùng bản dựng lại hoàn toàn', () => {
    const odd: TItem[] = [{ kind: 'user', id: 'x', text: 'một câu hoàn toàn khác', attachments: [], ts: 5 }];
    const r = reconcileTranscript(CONVO, odd);
    expect(r.rebuilt).toBe(true);
    expect(r.items.filter((i) => i.kind === 'user' && !i.steer)).toHaveLength(2);
  });

  it('transcript rỗng → dựng lại toàn bộ', () => {
    const r = reconcileTranscript(CONVO, []);
    expect(r.rebuilt).toBe(true);
    expect(r.items).toHaveLength(full.length);
  });
});

function memIO(): StoreIO & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (n) => {
      const v = files.get(n);
      if (!v) throw new Error('ENOENT');
      return v;
    },
    write: async (n, d) => void files.set(n, d),
    remove: async (n) => void files.delete(n),
    names: async () => [...files.keys()],
  };
}

describe('kho phiên: hiện cuộc trò chuyện ở mọi thư mục', () => {
  const mk = (id: string, updatedAt: number) => newSession({ id, provider: 'p', model: 'm', title: `Phiên ${id}`, updatedAt, messages: [u('xin chào'), a('chào')] });
  const tr: TItem[] = [];

  it('list() chỉ của thư mục hiện tại; listAll() có cả thư mục khác kèm cờ other + tên thư mục', async () => {
    const io = memIO();
    const A = new BaseSessionStore(io, 'wsA', 'du-an-A');
    const B = new BaseSessionStore(io, 'wsB', 'du-an-B');
    await A.save(mk('s_a', 10), tr);
    await B.save(mk('s_b', 20), tr);
    expect((await B.list()).map((s) => s.id)).toEqual(['s_b']);
    const all = await B.listAll();
    expect(all.map((s) => s.id)).toEqual(['s_b', 's_a']);
    expect(all[0].other).toBeUndefined();
    expect(all[1]).toMatchObject({ id: 's_a', other: true, workspaceName: 'du-an-A' });
    expect(all[1]).not.toHaveProperty('workspace');
  });

  it('sao lưu "tất cả" gồm cả cuộc ở thư mục khác', async () => {
    const io = memIO();
    const A = new BaseSessionStore(io, 'wsA');
    const B = new BaseSessionStore(io, 'wsB');
    await A.save(mk('s_a', 10), tr);
    await B.save(mk('s_b', 20), tr);
    expect((await B.exportSessions()).map((x) => x.session.id).sort()).toEqual(['s_a', 's_b']);
  });

  it('backupRaw giữ bản gốc MỘT lần, không lộ ra như một cuộc trò chuyện, không bị ghi đè lần hai', async () => {
    const io = memIO();
    const S = new BaseSessionStore(io, 'ws');
    await S.save(mk('s_x', 10), tr);
    const before = new TextDecoder().decode(io.files.get('s_x.json')!);
    await S.backupRaw('s_x');
    expect(new TextDecoder().decode(io.files.get('s_x.healbak.json')!)).toBe(before);
    await S.save({ ...mk('s_x', 11), title: 'đổi tên' }, tr);
    await S.backupRaw('s_x'); // lần hai: KHÔNG ghi đè bản gốc
    expect(new TextDecoder().decode(io.files.get('s_x.healbak.json')!)).toBe(before);
    expect((await S.listAll()).map((s) => s.id)).toEqual(['s_x']);
  });
});
