import { describe, expect, it } from 'vitest';
import { makeHarness } from '../helpers/harness';
import { textTurn } from '../helpers/fakeProvider';
import { autoCloseTodos } from '../../src/core/engine/guards/todoClose';
import { newTrace } from '../../src/core/engine/seams';

describe('adversarial loop-guards', () => {
  it("việc 'blocked' do tự đóng KHÔNG được kích hoạt lại cổng nhắc ở lượt kế tiếp", async () => {
    const h = makeHarness([() => textTurn('Chào bạn.'), () => textTurn('x'), () => textTurn('x')]);
    h.session.todos = [{ id: 't1', title: 'Việc cũ không có vết', status: 'blocked', note: 'không có bằng chứng' } as any];
    await h.run('chào');
    const nudges = h.session.messages.filter((m) => m.role === 'user' && m.synthetic);
    expect(nudges).toHaveLength(0);
  });
  it('tự đóng không đánh dấu "Commit" xong chỉ vì chạy git status, "Chạy test" xong chỉ vì npm run build', () => {
    const tr = newTrace();
    tr.calls.push({ name: 'run_command', risk: 'exec', ok: true, input: { command: 'git status' } } as any);
    tr.calls.push({ name: 'run_command', risk: 'exec', ok: true, input: { command: 'npm run build' } } as any);
    const r = autoCloseTodos([{ id: '1', title: 'Commit thay đổi', status: 'pending' }, { id: '2', title: 'Chạy test', status: 'pending' }] as any, tr, 'vi');
    expect(r.completed).toEqual([]);
  });
});
