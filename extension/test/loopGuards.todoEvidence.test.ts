import { describe, expect, it } from 'vitest';
import { autoCloseTodos } from '../src/core/engine/guards/todoClose';
import { resumeInstruction } from '../src/core/engine/resume';
import { newTrace } from '../src/core/engine/seams';

const call = (command: string) => ({ name: 'run_command', risk: 'exec', ok: true, input: { command } }) as any;

describe('todoClose: bằng chứng đặc trưng', () => {
  it('git commit thật → "Commit" completed; npm test → "Chạy test" completed', () => {
    const tr = newTrace();
    tr.calls.push(call('git commit -m "x"'), call('npm test'));
    const r = autoCloseTodos([{ id: '1', title: 'Commit thay đổi', status: 'pending' }, { id: '2', title: 'Chạy test', status: 'pending' }] as any, tr, 'vi');
    expect(r.completed).toEqual(['Commit thay đổi', 'Chạy test']);
  });
  it('chữ "commit" trong lệnh khác không tính; việc không bằng chứng → blocked', () => {
    const tr = newTrace();
    tr.calls.push(call('git log --grep commit'), call('npm run build'));
    const r = autoCloseTodos([{ id: '1', title: 'Commit thay đổi', status: 'pending' }, { id: '2', title: 'Chạy test', status: 'pending' }] as any, tr, 'vi');
    expect(r.completed).toEqual([]);
    expect(r.blocked).toHaveLength(2);
    expect(r.todos.every((x) => x.status === 'blocked')).toBe(true);
  });
  it('lệnh "tiếp tục" không liệt kê việc blocked như còn mở', () => {
    const out = resumeInstruction('tiếp tục', [{ title: 'Việc A', status: 'blocked' }, { title: 'Việc B', status: 'pending' }] as any, 'vi') ?? '';
    expect(out).toContain('Việc B');
    expect(out).toContain('Còn tồn (1)'); // chỉ việc B tính là mở
    expect(out.split('Đã bị chặn trước đó')[0]).not.toContain('Việc A'); // việc A chỉ nằm ở mục riêng 'đã bị chặn'
  });
});
