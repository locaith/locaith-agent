import { describe, expect, it } from 'vitest';
import { OutputBuffer, HEAD_CHARS } from '../../src/core/tasks/backgroundTasks';

describe('bg-tasks adversarial: OutputBuffer.lastLines', () => {
  it('khi đầu ra vừa vượt phần ĐẦU, 5 dòng cuối vẫn phải gồm các dòng thật cuối cùng (không rỗng/cụt)', () => {
    const b = new OutputBuffer();
    // 64k ký tự đầu gồm nhiều dòng ngắn, rồi thêm vài ký tự lọt sang phần đuôi.
    let s = '';
    let i = 0;
    while (s.length < HEAD_CHARS - 3) s += `line ${i++}\n`;
    s = s.slice(0, HEAD_CHARS - 3) + 'END\n'; // 'END' kết thúc head, '\n' nằm trong tail
    b.push(s);
    const last = b.lastLines(5);
    expect(last.join('\n')).toContain('END');
    expect(last.length).toBeGreaterThan(1);
  });
});
