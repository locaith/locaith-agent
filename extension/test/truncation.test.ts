import { describe, expect, it } from 'vitest';
import { continuationMarker, continuePartOption, continueWorkOption, trimAssistantTail, trimToBoundary } from '../src/core/engine/truncation';
import type { ChatMessage } from '../src/core/types';

/** (lane:output-timeouts · H05) Cắt đúng ranh giới khi chạm trần đầu ra: câu, mục, khối mã, bảng; an toàn Unicode. */
describe('truncation — lùi về ranh giới câu/mục', () => {
  it('kết thúc giữa câu → bỏ mẩu câu dở, giữ tới dấu kết câu gần nhất', () => {
    const r = trimToBoundary('Câu một đã xong. Câu hai cũng xong! Câu ba đang viết dở thì bị');
    expect(r.text).toBe('Câu một đã xong. Câu hai cũng xong!');
    expect(r.removed).toBe(' Câu ba đang viết dở thì bị'.length);
    expect(r.closedFence).toBe(false);
  });

  it('kết thúc sạch (dấu câu, ngoặc đóng, xuống dòng) → giữ nguyên', () => {
    for (const s of ['Xong rồi.', 'Thật sao?', 'Đúng (xem mục 2).', 'Dòng cuối đã trọn\n', 'Kết: "ổn".']) {
      expect(trimToBoundary(s).removed).toBe(0);
    }
  });

  it('mục danh sách dở → lùi về hết mục trước (ranh giới xuống dòng)', () => {
    const r = trimToBoundary('- Mục một\n- Mục hai\n- Mục ba đang viết nử');
    expect(r.text).toBe('- Mục một\n- Mục hai');
  });

  it('đang trong khối mã → bỏ dòng mã dở và ĐÓNG khối, không lùi ra ngoài khối', () => {
    const r = trimToBoundary('Ví dụ:\n```ts\nconst a = 1;\nconst b = 2;\nconst c = ');
    expect(r.text).toBe('Ví dụ:\n```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(r.closedFence).toBe(true);
    expect(r.appended).toBe('\n```');
    expect(r.removed).toBe('\nconst c = '.length); // bỏ cả dấu xuống dòng trước dòng dở, rồi nối '\n```'
    // khối ~~~ đóng bằng ~~~
    expect(trimToBoundary('~~~\nx = 1\ny = ').text).toBe('~~~\nx = 1\n~~~');
    // dòng mã cuối trọn (có \n) thì giữ cả dòng
    expect(trimToBoundary('```\na\nb\n').text).toBe('```\na\nb\n```');
  });

  it('vừa mở khối mã chưa có dòng nào → bỏ luôn dòng mở (không để khối rỗng)', () => {
    expect(trimToBoundary('Code đây:\n```python').text).toBe('Code đây:');
    expect(trimToBoundary('Code đây:\n```python\n').text).toBe('Code đây:');
  });

  it('hàng bảng Markdown dở → bỏ hàng đó', () => {
    const r = trimToBoundary('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | đang');
    expect(r.text).toBe('| A | B |\n|---|---|\n| 1 | 2 |');
  });

  it('an toàn Unicode: không tách emoji/cặp surrogate hay dấu tiếng Việt; chỉ cắt ở ranh giới câu', () => {
    const r = trimToBoundary('Chúc mừng 🎉🎉. Tiếp theo là phần hai với các ký tự ghép 👨‍👩‍👧 và tiếng Việt đầy đủ dấu đang');
    expect(r.text).toBe('Chúc mừng 🎉🎉.');
    for (const ch of r.text) expect(ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff || ch.length === 2).toBe(true);
    expect([...r.text].join('')).toBe(r.text);
  });

  it('không bỏ quá 35% / 1.200 ký tự (trừ mẩu dưới 400 ký tự): đoạn dài không dấu câu thì giữ nguyên', () => {
    const noPunct = 'một hai ba '.repeat(50).trimEnd(); // ~550 ký tự, > 35% văn bản
    expect(trimToBoundary(`Mở đầu.\n${noPunct}`).removed).toBe(0);
    const longTail = 'x'.repeat(1300);
    expect(trimToBoundary(`Câu đầu xong. ${longTail}`).removed).toBe(0);
    // mẩu dở ngắn (< 400) thì bỏ được dù chiếm phần lớn một câu trả lời ngắn
    expect(trimToBoundary('Xong. Dở dang mất hơn một nửa câu trả lời này rồi đấy nhé').text).toBe('Xong.');
    // mẩu dở dài nhưng dưới 35% của một bài dài → vẫn bỏ
    const long = 'Câu đủ. '.repeat(400);
    expect(trimToBoundary(`${long}${'x'.repeat(1000)}`).text).toBe(long.trimEnd());
  });

  it('chuỗi rỗng / chỉ khoảng trắng → không đổi', () => {
    expect(trimToBoundary('').text).toBe('');
    expect(trimToBoundary('   ').removed).toBe(0);
  });

  it('trimAssistantTail cắt khối chữ CUỐI của tin tại chỗ; tin không có chữ → null', () => {
    const m: ChatMessage = { role: 'assistant', content: [{ type: 'thinking', text: 'nghĩ' }, { type: 'text', text: 'Xong câu một. Dở câu ha' }] };
    const r = trimAssistantTail(m);
    expect(r?.removed).toBeGreaterThan(0);
    expect(m.content[1]).toEqual({ type: 'text', text: 'Xong câu một.' });
    expect(trimAssistantTail({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] })).toBeNull();
  });

  it('dòng đánh dấu phần và nút Chạy tiếp có cả vi và en', () => {
    expect(continuationMarker('vi', 2)).toBe('[tiếp phần 2]');
    expect(continuationMarker('en', 2)).toBe('[continued in part 2]');
    expect(continuationMarker('vi', 2, 3)).toBe('[tiếp phần 2/3]');
    const o = continuePartOption('vi', 3);
    expect(o).toMatchObject({ id: 'continue-part-3', kind: 'continue', label: 'Chạy tiếp phần 3' });
    expect(o.prompt).toMatch(/phần 3/);
    expect(o.prompt).toMatch(/không lặp lại/);
    expect(continuePartOption('en', 3).prompt).toMatch(/part 3/);
    expect(continueWorkOption('en')).toMatchObject({ id: 'continue-work', kind: 'continue', label: 'Continue' });
  });
});

describe('trimToBoundary — dấu đóng khối mã ở cuối chuỗi', () => {
  it('cắt ngay sau ``` hoặc ~~~ đóng (không xuống dòng) → giữ nguyên, không làm hở khối mã', () => {
    for (const text of ['Mã:\n```ts\nconst a = 1;\n```', 'Ví dụ.\n\n~~~bash\nnpm test\n~~~']) {
      const r = trimToBoundary(text);
      expect(r.removed).toBe(0);
      expect(r.text).toBe(text.replace(/[ \t]+$/, ''));
      expect(r.closedFence).toBe(false);
    }
  });

  it('dòng mở khối ```ts ở cuối (số fence lẻ) vẫn bị bỏ như cũ', () => {
    expect(trimToBoundary('Mã:\n```ts').text).toBe('Mã:');
  });
});
