import { describe, expect, it } from 'vitest';
import { repairOrphanToolCalls } from '../src/core/engine/engine';
import { newSession, type SessionState } from '../src/core/engine/types';
import type { ChatMessage } from '../src/core/types';
import type { AssistantItem, TItem, UserItem } from '../src/shared/protocol';
import { forkCut, forkSession, forkTitle } from '../src/shared/sessionFork';
import { rebuildTranscript } from '../src/shared/transcriptRebuild';

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (text: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (id: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a.ts' } }] });
const result = (id: string): ChatMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, name: 'read_file', content: 'ok' }] });

/** 3 lượt: (1) hỏi-đáp thường, (2) có vòng công cụ, (3) hỏi-đáp thường. */
function threeTurns(): { s: SessionState; tr: TItem[] } {
  const s = newSession({ id: 'p1', provider: 'fake', model: 'm', title: 'Sửa lỗi đăng nhập' });
  s.messages = [user('lượt một'), asst('đáp một'), user('lượt hai'), call('t1'), result('t1'), asst('đáp hai'), user('lượt ba'), asst('đáp ba')];
  s.approvals = ['run:npm test'];
  s.readFiles = { '/x/a.ts': 'h1' };
  s.todos = [{ id: '1', content: 'việc', status: 'pending' } as never];
  s.usageTotals = { input: 900, output: 100 };
  s.lastContextTokens = 5000;
  s.mode = 'bypass';
  return { s, tr: rebuildTranscript(s.messages) };
}
const opts = (atUserItemId?: string) => ({ atUserItemId, newId: 'f1', now: 1234, lang: 'vi' as const, repair: repairOrphanToolCalls });
const users = (tr: TItem[]) => tr.filter((i): i is UserItem => i.kind === 'user');

describe('rẽ nhánh phiên: tiền tố hợp lệ', () => {
  it('rẽ sau lượt hai: nhánh chứa đúng hai lượt đầu (cả vòng công cụ), không rò lượt ba', () => {
    const { s, tr } = threeTurns();
    const r = forkSession(s, tr, opts(users(tr)[1].id));
    expect(r.session.messages).toEqual(s.messages.slice(0, 6));
    expect(JSON.stringify(r.session.messages)).not.toContain('lượt ba');
    expect(users(r.transcript).map((u) => u.text)).toEqual(['lượt một', 'lượt hai']);
    expect(r.approximate).toBe(false);
  });

  it('không bao giờ có tool_use mồ côi trong nhánh, ở mọi điểm rẽ', () => {
    const { s, tr } = threeTurns();
    for (const u of users(tr)) {
      const r = forkSession(s, tr, opts(u.id));
      const ms = r.session.messages;
      ms.forEach((m, i) => {
        for (const b of m.content) {
          if (b.type !== 'tool_use') continue;
          const next = ms[i + 1];
          const answered = next?.content.some((x) => x.type === 'tool_result' && x.toolUseId === b.id);
          expect(answered, `tool_use ${b.id} phải có kết quả ngay sau`).toBe(true);
        }
      });
    }
  });

  it('điểm rẽ nằm giữa vòng công cụ dở dang: tool_use mồ côi được vá bằng kết quả "đã huỷ"', () => {
    const s = newSession({ id: 'p2', provider: 'fake', model: 'm' });
    s.messages = [user('một'), asst('đáp'), user('hai'), call('x9')]; // lượt cuối dừng giữa chừng
    const r = forkSession(s, rebuildTranscript(s.messages), opts());
    const last = r.session.messages[r.session.messages.length - 1];
    expect(last.content.some((b) => b.type === 'tool_result' && b.toolUseId === 'x9')).toBe(true);
  });

  it('không đưa id nào vào = rẽ từ cuối; id lạ cũng rẽ từ cuối', () => {
    const { s, tr } = threeTurns();
    expect(forkSession(s, tr, opts()).session.messages).toHaveLength(8);
    expect(forkSession(s, tr, opts('khong-co')).session.messages).toHaveLength(8);
  });

  it('phiên gốc không bị đụng tới (sao chép sâu)', () => {
    const { s, tr } = threeTurns();
    const before = JSON.stringify({ s, tr });
    const r = forkSession(s, tr, opts(users(tr)[0].id));
    r.session.messages.push(user('thêm'));
    r.session.todos.length = 0;
    (r.transcript[0] as UserItem).text = 'đã sửa';
    expect(JSON.stringify({ s, tr })).toBe(before);
  });
});

describe('rẽ nhánh phiên: trạng thái', () => {
  it('id/tiêu đề/thời điểm mới; quyền "cho phép phiên này", vân tay tệp, số liệu dùng token KHÔNG thừa hưởng; bypass hạ về mặc định', () => {
    const { s, tr } = threeTurns();
    const r = forkSession(s, tr, opts());
    expect(r.session.id).toBe('f1');
    expect(r.session.title).toBe('Sửa lỗi đăng nhập (nhánh)');
    expect(r.session.createdAt).toBe(1234);
    expect(r.session.approvals).toEqual([]);
    expect(r.session.readFiles).toEqual({});
    expect(r.session.usageTotals).toEqual({ input: 0, output: 0 });
    expect(r.session.lastContextTokens).toBe(0);
    expect(r.session.mode).toBe('default');
    expect(r.session.todos).toHaveLength(1); // todo được chép
  });

  it('dòng liên kết ngược nằm cuối transcript nhánh, mang mã + tiêu đề cuộc gốc', () => {
    const { s, tr } = threeTurns();
    const r = forkSession(s, tr, opts());
    const last = r.transcript[r.transcript.length - 1];
    expect(last.kind).toBe('notice');
    if (last.kind === 'notice') {
      expect(last.fork).toEqual({ fromId: 'p1', fromTitle: 'Sửa lỗi đăng nhập' });
      expect(last.text).toContain('Sửa lỗi đăng nhập');
    }
  });

  it('chỉ chép artifact được tiền tố transcript nhắc tới', () => {
    const { s, tr } = threeTurns();
    s.artifacts = { a1: { id: 'a1' } as never, a2: { id: 'a2' } as never };
    const items = tr.map((it) => ({ ...it })) as TItem[];
    const firstAsst = items.find((i): i is AssistantItem => i.kind === 'assistant')!;
    firstAsst.blocks = [...firstAsst.blocks, { type: 'artifact', artifactId: 'a1' } as never];
    const lateAsst = [...items].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
    lateAsst.blocks = [...lateAsst.blocks, { type: 'artifact', artifactId: 'a2' } as never];
    const r = forkSession(s, items, opts(users(items)[0].id));
    expect(Object.keys(r.session.artifacts)).toEqual(['a1']);
  });
});

describe('rẽ nhánh phiên: lượt đã bị nén khỏi lịch sử model', () => {
  it('lượt được chọn nằm trong phần đã nén: nhánh chỉ giữ bản tóm tắt, KHÔNG rò các lượt sau điểm rẽ, đánh dấu approximate', () => {
    const s = newSession({ id: 'p3', provider: 'fake', model: 'm' });
    // transcript hiển thị có 4 lượt; lịch sử model chỉ còn tóm tắt + lượt 3, 4 (lượt 1, 2 đã nén)
    s.messages = [user('[tóm tắt] ...'), user('lượt ba'), asst('đáp ba'), user('lượt bốn'), asst('đáp bốn')];
    const tr: TItem[] = ['một', 'hai', 'ba', 'bốn'].flatMap((t, i) => [
      { kind: 'user', id: `u${i}`, text: `lượt ${t}`, attachments: [], ts: i } as UserItem,
      { kind: 'assistant', id: `a${i}`, blocks: [{ type: 'text', text: `đáp ${t}` }], done: true, ts: i } as unknown as AssistantItem,
    ]);
    const r = forkSession(s, tr, opts('u0'));
    expect(r.approximate).toBe(true);
    expect(JSON.stringify(r.session.messages)).not.toContain('lượt bốn');
    expect(JSON.stringify(r.session.messages)).not.toContain('lượt ba');
    expect(users(r.transcript).map((u) => u.id)).toEqual(['u0']);
  });

  it('forkCut: đếm từ cuối nên nén đầu lịch sử không làm lệch điểm cắt', () => {
    const ms = [user('x'), asst('y'), user('z'), asst('w')];
    expect(forkCut(ms, 2, 1).cut).toBe(4); // lượt cuối → giữ hết
    expect(forkCut(ms, 2, 0).cut).toBe(2); // sau lượt đầu → cắt trước lượt hai
    expect(forkCut(ms, 5, 3).cut).toBe(2); // 5 lượt hiển thị, chỉ 2 còn trong lịch sử; rẽ sau lượt 4 → cắt trước lượt cuối
    expect(forkCut(ms, 5, 4).cut).toBe(4); // rẽ sau lượt 5 (cuối) → giữ hết
  });
});

describe('forkTitle', () => {
  it('thêm hậu tố theo ngôn ngữ và không chồng "(nhánh)(nhánh)"', () => {
    expect(forkTitle('Việc A', 'vi')).toBe('Việc A (nhánh)');
    expect(forkTitle('Việc A (nhánh)', 'vi')).toBe('Việc A (nhánh)');
    expect(forkTitle('Task', 'en')).toBe('Task (branch)');
    expect(forkTitle('', 'vi')).toBe('Cuộc trò chuyện (nhánh)');
  });
});
