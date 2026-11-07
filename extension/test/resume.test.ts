import { describe, expect, it } from 'vitest';
import { RESUME_HEADER, isBareContinue, resumeInstruction } from '../src/core/engine/resume';
import { repairOrphanToolCalls } from '../src/core/engine/engine';
import { newSession } from '../src/core/engine/types';
import type { ToolResultBlock, ToolUseBlock } from '../src/core/types';
import { isTurnStart, rebuildTranscript } from '../src/shared/transcriptRebuild';

describe('isBareContinue — "tiếp tục" trần trụi', () => {
  it('nhận các cách nói tiếp tục', () => {
    for (const s of ['tiếp tục', 'Tiếp tục!', 'chạy tiếp', 'làm tiếp', 'continue', 'Keep going', 'resume']) expect(isBareContinue(s), s).toBe(true);
  });
  it('KHÔNG coi câu có yêu cầu mới là "tiếp tục"', () => {
    for (const s of ['tiếp tục và sửa lỗi build', 'làm tiếp phần PDF', 'continue with the tests', '']) expect(isBareContinue(s), s).toBe(false);
  });

  it('nhận cả khi kèm từ đệm KHÔNG thêm yêu cầu ("tiếp tục đi", "làm tiếp nhé", "continue please")', () => {
    for (const s of ['tiếp tục đi', 'Tiếp tục nhé!', 'làm tiếp đi ạ', 'chạy tiếp nào', 'tiếp đi', 'cứ tiếp tục', 'continue please', 'keep going now', 'Go on.', '  tiếp   tục   đi  ']) expect(isBareContinue(s), s).toBe(true);
  });

  it('từ đệm không mở cửa cho yêu cầu thật; từ na ná cũng không', () => {
    for (const s of ['tiếp tục đi và chạy test', 'tiếp theo là gì', 'tiếp tục lỗi này', 'continue the migration', 'tiếptục', 'discontinue', 'resume.pdf']) expect(isBareContinue(s), s).toBe(false);
  });
});

describe('chỉ dẫn "tiếp tục" không bao giờ hiện lại như lời người dùng', () => {
  it('RESUME_HEADER nhận đúng đầu chỉ dẫn của cả hai ngôn ngữ, có hay không có việc tồn (transcript dựng lại dựa vào nó)', () => {
    for (const lang of ['vi', 'en'] as const) {
      for (const todos of [[], [{ title: 'A', status: 'pending' }]]) expect(RESUME_HEADER.test(resumeInstruction('tiếp tục', todos, lang)!), lang).toBe(true);
    }
    expect(RESUME_HEADER.test('Tiếp tục và sửa lỗi build')).toBe(false);
    expect(RESUME_HEADER.test('[Tiếp tục] nhé')).toBe(false);
  });

  it('transcript dựng lại từ lịch sử chỉ có chữ người dùng gõ; tin vẫn là điểm bắt đầu của một lượt', () => {
    const instruction = resumeInstruction('tiếp tục', [{ title: 'Vá lỗi', status: 'pending' }], 'vi')!;
    const msgs = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'sửa lỗi build' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Đang làm.' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'tiếp tục' }, { type: 'text' as const, text: instruction }] },
    ];
    expect(isTurnStart(msgs[2])).toBe(true);
    const users = rebuildTranscript(msgs).filter((i) => i.kind === 'user') as Array<{ text: string; steer?: boolean }>;
    expect(users.map((u) => u.text)).toEqual(['sửa lỗi build', 'tiếp tục']);
    expect(users.some((u) => u.steer)).toBe(false);
  });
});

describe('resumeInstruction — làm tiếp đúng chỗ dừng, dọn hết việc tồn', () => {
  const todos = [
    { title: 'Bỏ bảng Tasks', status: 'completed' },
    { title: 'Vá lỗi chạy 2 chỗ', status: 'in_progress' },
    { title: 'Phát hành 0.6.31', status: 'pending' },
  ];

  it('câu thường → không gắn gì', () => {
    expect(resumeInstruction('sửa lỗi này', todos, 'vi')).toBeNull();
  });

  it('"tiếp tục" → nêu đúng việc còn tồn và cấm chạy lại lệnh đã huỷ', () => {
    const out = resumeInstruction('tiếp tục', todos, 'vi')!;
    expect(out).toContain('không làm lại từ đầu');
    expect(out).not.toContain('Bỏ bảng Tasks'); // việc đã xong không bị liệt kê
    expect(out).toContain('Còn tồn (2)');
    expect(out).toContain('Vá lỗi chạy 2 chỗ');
    expect(out).toContain('Phát hành 0.6.31');
    expect(out).toContain('đã huỷ');
  });

  it('không còn việc tồn → vẫn bảo làm nốt bước cuối + kiểm chứng', () => {
    const out = resumeInstruction('continue', [{ title: 'x', status: 'completed' }], 'en')!;
    expect(out).toContain('Nothing is left open');
    expect(out).toContain('verify');
  });
});

describe('repairOrphanToolCalls — lịch sử sau khi Dừng không được phát lại lệnh cũ', () => {
  const use = (id: string): ToolUseBlock => ({ type: 'tool_use', id, name: 'run_command', input: { command: 'echo ' + id } });

  it('assistant có tool_use mà không có tool_result → chèn kết quả "đã huỷ"', () => {
    const s = newSession({ id: 's1', provider: 'fake', model: 'm' });
    s.messages = [
      { role: 'user', content: [{ type: 'text', text: 'chạy đi' }] },
      { role: 'assistant', content: [use('c1')] },
    ];
    const n = repairOrphanToolCalls(s);
    expect(n).toBe(1);
    const next = s.messages[2];
    expect(next.role).toBe('user');
    const r = next.content.find((b): b is ToolResultBlock => b.type === 'tool_result')!;
    expect(r.toolUseId).toBe('c1');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('đã dừng');
    expect(s.historyEdited).toBe(true);
  });

  it('idempotent: chạy lần hai không thêm gì', () => {
    const s = newSession({ id: 's1', provider: 'fake', model: 'm' });
    s.messages = [
      { role: 'user', content: [{ type: 'text', text: 'chạy đi' }] },
      { role: 'assistant', content: [use('c1')] },
    ];
    expect(repairOrphanToolCalls(s)).toBe(1);
    expect(repairOrphanToolCalls(s)).toBe(0);
  });

  it('đã có đủ tool_result → không đụng vào', () => {
    const s = newSession({ id: 's1', provider: 'fake', model: 'm' });
    s.messages = [
      { role: 'user', content: [{ type: 'text', text: 'chạy đi' }] },
      { role: 'assistant', content: [use('c1')] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'run_command', content: 'ok' }] },
    ];
    expect(repairOrphanToolCalls(s)).toBe(0);
    expect(s.messages).toHaveLength(3);
  });

  // CẬP NHẬT CÓ CHỦ ĐÍCH (0.6.31, bản đầu gộp kết quả huỷ vào ĐẦU tin người dùng kế tiếp): làm vậy biến lượt mới của người dùng thành "tin kết quả"
  // — `isTurnStart` = false, "Thử lại / Sửa tin cuối" nhắm sai tin, transcript dựng lại hiện nó như tin chen giữa. Nay kết quả huỷ luôn nằm trong
  // MỘT TIN TỔNG HỢP RIÊNG đứng trước tin người dùng (chỉ khi tin kế tiếp vốn là tin kết quả mới bổ sung vào đó). Chi tiết: test/orphanRepair.test.ts.
  it('kết quả huỷ nằm ở tin tổng hợp riêng NGAY TRƯỚC tin người dùng kế tiếp, tin của người dùng còn nguyên', () => {
    const s = newSession({ id: 's1', provider: 'fake', model: 'm' });
    s.messages = [
      { role: 'assistant', content: [use('c1'), use('c2')] },
      { role: 'user', content: [{ type: 'text', text: 'thôi, làm việc khác' }] },
    ];
    expect(repairOrphanToolCalls(s)).toBe(2);
    expect(s.messages).toHaveLength(3);
    expect(s.messages[1]).toMatchObject({ role: 'user', synthetic: true });
    expect(s.messages[1].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(s.messages[2].content).toEqual([{ type: 'text', text: 'thôi, làm việc khác' }]);
    expect(s.messages[2].synthetic).toBeUndefined();
  });
});
