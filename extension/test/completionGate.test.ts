import { describe, expect, it } from 'vitest';
import { GATE_MAX_NUDGES, completionGate, type GateInput } from '../src/core/engine/completion';

const base = (over: Partial<GateInput> = {}): GateInput => ({
  stop: 'end_turn',
  text: 'Xong rồi.',
  pendingTodos: [],
  wroteFiles: false,
  execCalls: 0,
  nudges: 0,
  reasons: [],
  wrapUp: false,
  aborted: false,
  ...over,
});

describe('completionGate — cổng hoàn thành do máy phán', () => {
  it('không có gì vướng → cho kết thúc', () => {
    expect(completionGate(base(), 'vi')).toBeNull();
  });

  it('còn việc chưa xong → chặn và nêu đúng tên việc', () => {
    const d = completionGate(base({ pendingTodos: [{ title: 'Chạy test', status: 'pending' }, { title: 'Đóng gói', status: 'in_progress' }], text: '' }), 'vi')!;
    expect(d.reason).toBe('todos');
    expect(d.message).toContain('Chạy test');
    expect(d.message).toContain('Đóng gói');
    expect(d.message).toContain('2 việc');
  });

  it('hỏi lại người dùng vẫn bị chặn khi còn việc (không còn né bằng dấu "?")', () => {
    const d = completionGate(base({ pendingTodos: [{ title: 'Sửa lỗi build', status: 'pending' }], text: 'Bạn muốn mình làm tiếp không?' }), 'vi');
    expect(d?.reason).toBe('todos');
  });

  it('đã sửa tệp mà chưa chạy gì → bắt kiểm chứng', () => {
    const d = completionGate(base({ wroteFiles: true, execCalls: 0 }), 'vi')!;
    expect(d.reason).toBe('verify');
    expect(d.message).toContain('kiểm chứng');
  });

  it('đã sửa tệp VÀ đã chạy lệnh → không chặn', () => {
    expect(completionGate(base({ wroteFiles: true, execCalls: 2 }), 'vi')).toBeNull();
  });

  // (0.6.31) Quy tắc cũ "mỗi lý do chỉ một lần, tổng tối đa 2" làm nhánh "lần thứ ba → báo người dùng" của engine KHÔNG BAO GIỜ chạy tới
  // (nhắc việc dở một lần rồi lượt kết thúc im lặng). Quy tắc mới: mỗi lý do được nói ra ít nhất một lần, việc dở được nhắc LẠI, tổng ≤ 3.
  it('thứ tự: việc dở → kiểm chứng (mỗi thứ nói một lần trước) → việc dở nhắc lại', () => {
    const todos = [{ title: 'A', status: 'pending' as const }];
    expect(completionGate(base({ pendingTodos: todos, wroteFiles: true }), 'vi')?.reason).toBe('todos');
    expect(completionGate(base({ pendingTodos: todos, wroteFiles: true, nudges: 1, reasons: ['todos'] }), 'vi')?.reason).toBe('verify');
    expect(completionGate(base({ pendingTodos: todos, wroteFiles: true, nudges: 2, reasons: ['todos', 'verify'] }), 'vi')?.reason).toBe('todos');
  });

  it('việc dở còn nguyên sau lần nhắc đầu → nhắc lại (model hay lờ lần đầu); kiểm chứng thì KHÔNG lặp', () => {
    const todos = [{ title: 'A', status: 'pending' as const }];
    expect(completionGate(base({ pendingTodos: todos, nudges: 1, reasons: ['todos'] }), 'vi')?.reason).toBe('todos');
    expect(completionGate(base({ pendingTodos: todos, nudges: 2, reasons: ['todos', 'todos'] }), 'vi')?.reason).toBe('todos'); // lần 3 = lần chốt của engine
    expect(completionGate(base({ wroteFiles: true, nudges: 1, reasons: ['verify'] }), 'vi')).toBeNull(); // đã nhắc kiểm chứng rồi, hết việc dở
  });

  it('TRẦN: từ lần can thiệp thứ 4 trở đi không bao giờ chặn nữa, dù còn gì', () => {
    const todos = [{ title: 'A', status: 'pending' as const }];
    expect(completionGate(base({ pendingTodos: todos, wroteFiles: true, nudges: 3, reasons: ['todos', 'verify', 'todos'] }), 'vi')).toBeNull();
    expect(completionGate(base({ pendingTodos: todos, nudges: 9, reasons: [] }), 'vi')).toBeNull();
    expect(GATE_MAX_NUDGES).toBe(3);
    // maxNudges tuỳ chỉnh vẫn được tôn trọng
    expect(completionGate(base({ pendingTodos: todos, nudges: 1, reasons: ['todos'], maxNudges: 1 }), 'vi')).toBeNull();
  });

  it('người dùng bấm Dừng, hoặc đang tổng kết vì chạm trần → không chặn', () => {
    expect(completionGate(base({ aborted: true, pendingTodos: [{ title: 'A', status: 'pending' }] }), 'vi')).toBeNull();
    expect(completionGate(base({ wrapUp: true, pendingTodos: [{ title: 'A', status: 'pending' }] }), 'vi')).toBeNull();
  });

  it('dừng vì lỗi/refusal → không chặn', () => {
    expect(completionGate(base({ stop: 'error', pendingTodos: [{ title: 'A', status: 'pending' }] }), 'vi')).toBeNull();
    expect(completionGate(base({ stop: 'aborted' }), 'vi')).toBeNull();
  });

  it('tiếng Anh dùng đúng chuỗi tiếng Anh', () => {
    const d = completionGate(base({ pendingTodos: [{ title: 'Run tests', status: 'pending' }] }), 'en')!;
    expect(d.message).toContain('unfinished task');
    expect(d.message).toContain('Run tests');
  });

  it('rút gọn danh sách dài: tối đa 5 việc + phần còn lại', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `Việc ${i + 1}`, status: 'pending' as const }));
    const d = completionGate(base({ pendingTodos: many }), 'vi')!;
    expect(d.message).toContain('Việc 5');
    expect(d.message).not.toContain('Việc 6');
    expect(d.message).toContain('+3 việc nữa');
  });
});
