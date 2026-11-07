/**
 * Dòng NGÂN SÁCH VÒNG LẶP (0.6.31): `[vòng N/M · còn K vòng]` do harness gắn vào CUỐI payload của mỗi lần gọi model. Quy tắc cần bảo vệ:
 *   1. model nhận đúng số vòng ở mỗi lần gọi (và lệnh CHỐT VIỆC khi còn ≤ 3 vòng);
 *   2. dòng này CHỈ nằm trong payload gửi đi — không vào lịch sử phiên, không lên giao diện, không vào bản tóm tắt nén;
 *   3. nó là MỘT KHỐI chữ ở cuối tin user cuối (sau mọi tool_result), KHÔNG phải một tin user thứ hai: vai trò vẫn xen kẽ ở mọi hãng
 *      (bất biến của engine — xem chỗ chèn tin xếp hàng) và cặp tool_use/tool_result không bao giờ bị xen vào;
 *   4. không bao giờ gắn vào chỗ làm hỏng hợp đồng của hãng (tin assistant đang chờ kết quả, hay đang tạm dừng `pause_turn`).
 * (Test so sánh lịch sử nguyên văn dùng `provider.requests`, đã lọc dòng này; ở đây dùng `rawRequests` — đúng thứ adapter nhận.)
 */
import { describe, expect, it } from 'vitest';
import { turnBudgetNote, withBudgetNote } from '../src/core/engine/completion';
import { ProviderError, type ChatMessage, type ProviderEvent } from '../src/core/types';
import { budgetNoteOf, stripBudgetNote, textTurn, toolTurn } from './helpers/fakeProvider';
import { makeHarness } from './helpers/harness';

const textOf = (m: ChatMessage): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const LIST = { name: 'list_dir', input: { path: '.' } };
const NOTE = '[vòng 2/8 · còn 6 vòng]';
/** Vai trò xen kẽ user/assistant/user… (không có hai tin cùng vai liền nhau). */
const alternates = (msgs: readonly ChatMessage[]): boolean => msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);

describe('turnBudgetNote', () => {
  it('nói đúng vòng hiện tại và số vòng còn lại', () => {
    expect(turnBudgetNote(1, 8, 'vi')).toBe('[vòng 1/8 · còn 7 vòng]');
    expect(turnBudgetNote(4, 8, 'vi')).toBe('[vòng 4/8 · còn 4 vòng]');
    expect(turnBudgetNote(1, 8, 'en')).toBe('[turn 1/8 · 7 turns left]');
  });

  it('còn ≤ 3 vòng thì kèm mệnh lệnh CHỐT VIỆC (ranh giới đúng ở 3)', () => {
    expect(turnBudgetNote(4, 8, 'vi')).not.toContain('CHỐT VIỆC'); // còn 4
    expect(turnBudgetNote(5, 8, 'vi')).toContain('CHỐT VIỆC'); // còn 3
    expect(turnBudgetNote(8, 8, 'vi')).toContain('còn 0 vòng');
    expect(turnBudgetNote(5, 8, 'en')).toContain('WRAP UP');
  });

  it('không vượt trần và không âm', () => {
    expect(turnBudgetNote(99, 8, 'vi')).toContain('vòng 8/8 · còn 0 vòng');
    expect(turnBudgetNote(-3, 8, 'vi')).toBe('[vòng 0/8 · còn 8 vòng]');
  });

  it('không có trần hợp lệ → không có dòng nào', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(turnBudgetNote(3, bad, 'vi'), String(bad)).toBeNull();
  });
});

describe('withBudgetNote', () => {
  it('không có dòng nào → trả đúng mảng cũ (không sao chép)', () => {
    const msgs = [user('chào')];
    expect(withBudgetNote(msgs, null)).toBe(msgs);
  });

  it('tin cuối là câu hỏi của người dùng → thêm MỘT khối volatile vào CUỐI tin đó; không thêm tin nào, không đụng khối chữ của người dùng', () => {
    const first = user('chào');
    const msgs: ChatMessage[] = [first];
    const out = withBudgetNote(msgs, NOTE);
    expect(out).toHaveLength(1); // vẫn một tin user — không có tin user thứ hai
    expect(out[0].role).toBe('user');
    expect(out[0].content).toEqual([
      { type: 'text', text: 'chào' },
      { type: 'text', text: NOTE, volatile: true },
    ]);
    expect(out[0].synthetic).toBeUndefined(); // vẫn là tin người dùng thật (adapter/demo không coi nó là tin nhắc)
    // lịch sử gốc không bị sửa dù chỉ một byte
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe(first);
    expect(first.content).toEqual([{ type: 'text', text: 'chào' }]);
  });

  it('tin cuối là kết quả công cụ → khối nằm SAU các tool_result trong cùng tin; cặp tool_use/tool_result và vai xen kẽ còn nguyên', () => {
    const msgs: ChatMessage[] = [
      user('đi'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'list_dir', input: {} }, { type: 'tool_use', id: 'c2', name: 'glob', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'list_dir', content: 'ok' }, { type: 'tool_result', toolUseId: 'c2', name: 'glob', content: 'ok' }] },
    ];
    const out = withBudgetNote(msgs, NOTE);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(alternates(out)).toBe(true);
    expect(out[2].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(out[2].content[2]).toMatchObject({ text: NOTE, volatile: true });
    expect(msgs[2].content).toHaveLength(2); // tin gốc không bị sửa
    expect(out[0]).toBe(msgs[0]); // các tin cũ giữ nguyên tham chiếu (tiền tố nguyên vẹn)
    expect(out[1]).toBe(msgs[1]);
  });

  it('tin cuối là assistant đang chờ kết quả công cụ → giữ nguyên', () => {
    const msgs: ChatMessage[] = [user('đi'), { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'list_dir', input: {} }] }];
    expect(withBudgetNote(msgs, NOTE)).toBe(msgs);
  });

  it('tin cuối là assistant đang TẠM DỪNG (pause_turn) → giữ nguyên: lượt kế phải nối tiếp đúng tin đó, không thêm lời người dùng', () => {
    const msgs: ChatMessage[] = [user('tra cứu'), { role: 'assistant', content: [{ type: 'text', text: 'Đang tra cứu…' }] }];
    expect(withBudgetNote(msgs, NOTE)).toBe(msgs);
  });

  it('lịch sử rỗng → không bịa ra payload chỉ có dòng ngân sách', () => {
    const msgs: ChatMessage[] = [];
    expect(withBudgetNote(msgs, NOTE)).toBe(msgs);
  });

  it('helper của test: budgetNoteOf / stripBudgetNote nhận ra và bóc đúng khối, trả lại đúng lịch sử', () => {
    const msgs: ChatMessage[] = [user('hỏi')];
    const out = withBudgetNote(msgs, NOTE);
    expect(budgetNoteOf(out)).toBe(NOTE);
    expect(budgetNoteOf(msgs)).toBeUndefined();
    expect(stripBudgetNote(out)).toEqual(msgs);
    // chữ người dùng tự gõ giống dòng ngân sách (không có cờ volatile) KHÔNG bị nhận nhầm
    expect(budgetNoteOf([user('[vòng 1/8 · còn 7 vòng]')])).toBeUndefined();
  });
});

describe('dòng ngân sách trong engine', () => {
  it('MỖI lần gọi model nhận đúng một dòng ở cuối payload, đúng số vòng — và vai trò vẫn xen kẽ', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => toolTurn([{ id: 'call_2', name: 'glob', input: { pattern: '*.txt' } }]), () => textTurn('Xong.')], {
      files: { 'a.txt': '1' },
      settings: { maxTurns: 8, language: 'vi' },
    });
    const r = await h.run('liệt kê');
    expect(r.turns).toBe(3);
    expect(h.provider.rawRequests).toHaveLength(3);
    h.provider.rawRequests.forEach((req, i) => {
      expect(budgetNoteOf(req.messages), `lần gọi ${i + 1}`).toBe(`[vòng ${i + 1}/8 · còn ${7 - i} vòng]`);
      expect(alternates(req.messages), `lần gọi ${i + 1}: vai xen kẽ`).toBe(true);
      const withNote = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.volatile);
      expect(withNote, `lần gọi ${i + 1}: chỉ một dòng`).toHaveLength(1);
    });
    // lần 1: khối nằm sau câu hỏi của người dùng, câu hỏi còn nguyên
    expect(h.provider.rawRequests[0].messages.at(-1)!.content).toEqual([
      { type: 'text', text: 'liệt kê' },
      { type: 'text', text: '[vòng 1/8 · còn 7 vòng]', volatile: true },
    ]);
    // sau lượt công cụ: [user, assistant(tool_use), user(tool_result… + dòng ngân sách)] — kết quả vẫn ngay sau tool_use của nó
    const second = h.provider.rawRequests[1].messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2].content.map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('`requests` (đã lọc) và `rawRequests` chỉ khác nhau đúng ở dòng ngân sách', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => textTurn('Xong.')], { files: { 'a.txt': '1' }, settings: { maxTurns: 8 } });
    await h.run('đi');
    h.provider.rawRequests.forEach((raw, i) => {
      expect(stripBudgetNote(raw.messages)).toEqual(h.provider.requests[i].messages);
      expect(budgetNoteOf(h.provider.requests[i].messages)).toBeUndefined();
    });
  });

  it('còn ≤ 3 vòng: dòng ngân sách mang lệnh CHỐT VIỆC; trước đó thì không', async () => {
    const step = (i: number) => () => toolTurn([{ id: `call_${i}`, name: 'glob', input: { pattern: `*.${i}` } }]);
    const h = makeHarness([step(1), step(2), step(3), step(4), () => textTurn('Chốt.')], { files: { 'a.txt': '1' }, settings: { maxTurns: 5 } });
    await h.run('đi');
    const notes = h.provider.rawRequests.map((r) => budgetNoteOf(r.messages)!);
    expect(notes[0]).toBe('[vòng 1/5 · còn 4 vòng]');
    expect(notes[1]).toContain('CHỐT VIỆC'); // vòng 2/5: còn 3
    expect(notes[4]).toBe('[vòng 5/5 · còn 0 vòng — CHỐT VIỆC, KHÔNG MỞ VIỆC MỚI]');
  });

  it('CHỈ nằm trong payload: không vào lịch sử phiên, không lên giao diện, không đổi bộ đếm token', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => toolTurn([{ id: 'call_2', name: 'glob', input: { pattern: '*' } }]), () => textTurn('Xong.')], {
      files: { 'a.txt': '1' },
      settings: { maxTurns: 8 },
    });
    await h.run('đi');
    // lịch sử phiên: user, assistant(tool), user(kq), assistant(tool), user(kq), assistant — không khối ngân sách nào, kể cả trong tin kết quả
    expect(h.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(h.session.messages.every((m) => budgetNoteOf([m]) === undefined)).toBe(true);
    expect(JSON.stringify(h.session.messages)).not.toMatch(/vòng \d+\/8|volatile/);
    expect(h.session.messages[2].content.map((b) => b.type)).toEqual(['tool_result']); // tin kết quả chỉ có kết quả
    // giao diện: không sự kiện nào mang dòng đó
    expect(JSON.stringify(h.events)).not.toMatch(/vòng \d+\/8|còn \d+ vòng/);
    // token: tổng cộng đúng bằng số nhà cung cấp báo (3 lần × (100 vào + 20 ra)), dòng ngân sách không được cộng thêm ở đâu cả
    expect(h.session.usageTotals).toEqual({ input: 300, output: 60 });
    // mỗi lần gọi chỉ có ĐÚNG một dòng (lần chèn trước không bị tích tụ)
    expect(h.provider.rawRequests.every((r) => r.messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.volatile).length === 1)).toBe(true);
  });

  it('không lọt vào bản tóm tắt nén (nén chạy trên lịch sử đã lưu, không thấy dòng ngân sách)', async () => {
    const h = makeHarness(
      [
        () => {
          throw new ProviderError('too long', { kind: 'context_length', providerId: 'fake', status: 400 });
        },
        () => textTurn('Đã tiếp tục'),
      ],
      { settings: { maxTurns: 8 } },
    );
    h.provider.completeImpl = async () => 'Tóm tắt: người dùng đã hỏi 4 câu.';
    for (let i = 0; i < 4; i++) {
      h.session.messages.push(user(`câu hỏi ${i}`));
      h.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: `trả lời ${i}` }] });
    }
    const r = await h.run('câu hỏi mới');
    expect(r.stopReason).toBe('end_turn');
    // lần gọi đầu (bị tràn) có dòng ngân sách; lần gọi sau khi nén cũng có — nhưng bản tóm tắt thì không
    expect(budgetNoteOf(h.provider.rawRequests[0].messages)).toMatch(/^\[vòng 1\/8/);
    expect(budgetNoteOf(h.provider.rawRequests[1].messages)).toMatch(/^\[vòng 2\/8/);
    expect(h.provider.completes.length).toBeGreaterThan(0);
    expect(h.provider.completes.every((c) => !/\[vòng \d+\/8/.test(c.prompt))).toBe(true);
    expect(JSON.stringify(h.session.messages)).not.toMatch(/vòng \d+\/8|volatile/);
  });

  it('hết số vòng: lượt tổng kết vẫn có dòng ngân sách "còn 0 vòng", nằm sau lời nhắc tổng kết; lời nhắc tổng kết MỚI là thứ được lưu', async () => {
    const h = makeHarness([() => toolTurn([LIST]), () => toolTurn([{ id: 'call_2', name: 'glob', input: { pattern: '*' } }]), () => textTurn('Đã làm A, còn B.')], {
      files: { 'a.txt': '1' },
      settings: { maxTurns: 2 },
    });
    await h.run('đi');
    const third = h.provider.rawRequests[2];
    expect(third.toolChoice).toBe('none');
    expect(budgetNoteOf(third.messages)).toBe('[vòng 2/2 · còn 0 vòng — CHỐT VIỆC, KHÔNG MỞ VIỆC MỚI]');
    // tin cuối = lời nhắc tổng kết (synthetic, đã lưu) + khối ngân sách (volatile, không lưu)
    const last = third.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'user', synthetic: true });
    expect(last.content.map((b) => b.type)).toEqual(['text', 'text']);
    expect(textOf({ ...last, content: last.content.slice(0, 1) })).toContain('KHÔNG gọi thêm công cụ');
    expect(JSON.stringify(h.session.messages)).not.toMatch(/vòng \d+\/2|volatile/);
  });

  it('tiếng Anh: dòng ngân sách bằng tiếng Anh', async () => {
    const h = makeHarness([() => textTurn('Done.')], { settings: { maxTurns: 8, language: 'en' } });
    await h.run('go');
    expect(budgetNoteOf(h.provider.rawRequests[0].messages)).toBe('[turn 1/8 · 7 turns left]');
  });

  it('pause_turn: lượt kế nối tiếp ĐÚNG tin assistant đang tạm dừng — không có lời "người dùng" nào chen vào sau nó', async () => {
    const paused: ProviderEvent[] = [
      { type: 'text_delta', text: 'Đang tra cứu…' },
      {
        type: 'done',
        stopReason: 'pause_turn',
        usage: { inputTokens: 100, outputTokens: 20 },
        message: { role: 'assistant', content: [{ type: 'text', text: 'Đang tra cứu…' }] },
      },
    ];
    const h = makeHarness([() => paused, () => textTurn('Tra cứu xong.')], { settings: { maxTurns: 8 } });
    const r = await h.run('tra cứu giúp');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.rawRequests).toHaveLength(2);
    // lần 1: bình thường (có dòng ngân sách)
    expect(budgetNoteOf(h.provider.rawRequests[0].messages)).toBeDefined();
    // lần 2: tin cuối là tin assistant tạm dừng, KHÔNG có dòng ngân sách nào trong payload
    const second = h.provider.rawRequests[1].messages;
    expect(second.at(-1)).toMatchObject({ role: 'assistant' });
    expect(second.flatMap((m) => m.content).some((b) => b.type === 'text' && b.volatile)).toBe(false);
  });
});
