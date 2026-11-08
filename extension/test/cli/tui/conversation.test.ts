import { describe, expect, it } from 'vitest';
import { Conversation } from '../../../src/cli/tui/conversation';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { stripAnsi } from '../../../src/cli/tui/width';
import type { PillKind, UiEvent } from '../../../src/shared/protocol';

const theme = makeTheme(detectCaps({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv }));

function make() {
  const printed: string[] = [];
  const conv = new Conversation({
    theme,
    width: () => 80,
    cwd: () => '/work',
    expanded: () => false,
    lang: () => 'vi',
    print: (lines) => printed.push(...lines),
  });
  const feed = (...evs: UiEvent[]) => evs.forEach((e) => conv.ui(e));
  const out = () => printed.map(stripAnsi).join('\n');
  return { conv, feed, out };
}

const ID = 'a1';
const start = (id = ID): UiEvent => ({ t: 'assistant_start', id, provider: 'anthropic', model: 'claude-sonnet-5-5', ts: Date.now() });
const pill = (pillId: string, text: string, kind: PillKind, id = ID): UiEvent => ({ t: 'pill', id, pillId, text, kind });
const text = (delta: string, id = ID): UiEvent => ({ t: 'text', id, delta });
const thinking = (delta: string, id = ID): UiEvent => ({ t: 'thinking', id, delta, ts: 10 });
const end = (id = ID): UiEvent => ({ t: 'assistant_end', id, stopReason: 'end_turn' });

describe('Conversation — câu trả lời luôn được in', () => {
  it('model ra token đầu chậm: dòng «Đang suy nghĩ…» (working) bị gỡ khi chữ tới, câu trả lời VẪN phải hiện', () => {
    // Ca thật của Claude khi ghi bộ nhớ đệm 17k token: >700 ms chưa có token → engine phát pill `working`; chữ tới thì reducer gỡ hẳn pill đó
    // và khối chữ dồn lên chỗ của nó. Con trỏ in đã bước qua pill thì bỏ sót cả khối chữ → màn hình không có gì.
    const { feed, out } = make();
    feed(start(), pill('a1:w1', 'Đang suy nghĩ…', 'working'), text('Chào anh! '), text('Em nghe rõ rồi ạ.'), end());
    expect(out()).toContain('Chào anh! Em nghe rõ rồi ạ.');
  });

  it('thử lại (máy chủ bận) rồi mới có chữ: câu trả lời hiện', () => {
    const { feed, out } = make();
    feed(start(), pill('a1:r1', 'Máy chủ đang bận, thử lại sau 2 giây (lần 1/4)…', 'working'));
    feed(pill('a1:r2', 'Máy chủ đang bận, thử lại sau 4 giây (lần 2/4)…', 'working'));
    feed(text('Xin chào, em đây.'), end());
    expect(out()).toContain('Xin chào, em đây.');
  });

  it('hàng chờ của cổng Locaith (working) rồi tới chữ: câu trả lời hiện', () => {
    const { feed, out } = make();
    feed(start(), pill('a1:queue', 'Đang xếp hàng — vị trí 3', 'working'), pill('a1:queue', 'Đang xếp hàng — vị trí 1', 'working'), text('Tới lượt rồi ạ.'), end());
    expect(out()).toContain('Tới lượt rồi ạ.');
  });

  it('vẫn in dần theo dòng sau khi pill bị gỡ (không đợi hết lượt)', () => {
    const { feed, out } = make();
    feed(start(), pill('a1:w1', 'Đang suy nghĩ…', 'working'), text('Dòng một\nDòng hai đang gõ'));
    expect(out()).toContain('Dòng một'); // dòng đã hoàn chỉnh in ngay
    expect(out()).not.toContain('Dòng hai'); // dòng dở còn nằm ở vùng sống
    feed(text(' xong.'), end());
    expect(out()).toContain('Dòng hai đang gõ xong.');
  });

  it('chữ in đúng MỘT lần (không lặp khi có nhiều sự kiện sau pill)', () => {
    const { feed, out } = make();
    feed(start(), pill('a1:w1', 'Đang suy nghĩ…', 'working'), text('Một lần thôi.'), { t: 'usage', id: ID, usage: { inputTokens: 5, outputTokens: 4 } }, end());
    expect(out().split('Một lần thôi.').length - 1).toBe(1);
  });

  it('suy luận có dòng trạng thái (thinking) rồi chữ: vẫn in «Đã suy nghĩ» một lần + câu trả lời (không đổi so với trước)', () => {
    const { feed, out } = make();
    feed(start(), thinking('Ng'), pill('a1:p1', 'Đang suy nghĩ…', 'thinking'), thinking('ười dùng chào.'), text('Chào anh/chị.'), end());
    const t = out();
    expect(t).toContain('Chào anh/chị.');
    expect(t.split('Đã suy nghĩ').length - 1).toBeGreaterThanOrEqual(1);
  });

  it('lượt kết thúc đột ngột khi dòng trạng thái còn chạy: lượt kế tiếp không bị lỗi và không in rác', () => {
    const { feed, out } = make();
    feed(start(), pill('a1:w1', 'Đang suy nghĩ…', 'working'));
    expect(() => feed({ t: 'user', id: 'u2', text: 'tiếp', attachments: [], ts: 5 }, start('a2'), text('Ổn rồi.', 'a2'), end('a2'))).not.toThrow();
    expect(out()).toContain('Ổn rồi.');
    expect(out()).not.toContain('Đang suy nghĩ');
  });
});
