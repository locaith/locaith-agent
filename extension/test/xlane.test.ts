/**
 * Rà soát CHÉO giữa các lane (xlane): lỗi nằm ở chỗ hai lane gặp nhau.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamRequest } from '../src/core/types';
import type { WebviewMessage, TItem } from '../src/shared/protocol';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const harnesses: ControllerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.dispose();
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const local = (h: ControllerHarness, m: WebviewMessage): Promise<void> => (h.ctl as unknown as { onMessage(m: WebviewMessage): Promise<void> }).onMessage(m);
const feature = (h: ControllerHarness) => (h.ctl as unknown as { checkpoints: { flush(): Promise<void> } }).checkpoints;
const userIds = (h: ControllerHarness): string[] => h.view().transcript.filter((i: TItem) => i.kind === 'user' && !i.steer).map((i) => i.id);

function routed(req: StreamRequest) {
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  if (last.role === 'user' && last.content.some((b) => b.type === 'tool_result')) return textTurn('xong, đã ghi tệp theo yêu cầu và mọi thứ đều ổn thỏa như mong đợi của người dùng.');
  const text = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (text.includes('ghi')) return toolTurn([{ id: `w${msgs.length}`, name: 'write_file', input: { path: `f${msgs.length}.txt`, content: 'x\n' } }]);
  return textTurn('xong');
}

describe('xlane: Quay lại hội thoại × số đo ngữ cảnh', () => {
  it('sau khi cắt hội thoại, lastContextTokens không còn là số của lịch sử dài đã bị cắt', async () => {
    const h = makeControllerHarness({ storage: true, files: { 'a.txt': 'a\n' }, script: Array.from({ length: 30 }, () => routed) });
    harnesses.push(h);
    await local(h, { type: 'set_mode', mode: 'acceptEdits' } as WebviewMessage);
    await h.send('ghi một');
    await h.idle();
    await h.send('ghi hai');
    await h.idle();
    await feature(h).flush();
    await sleep(160);
    h.session().lastContextTokens = 150_000; // số của lần gọi model gần nhất (lịch sử dài)
    const [, u2] = userIds(h);
    await local(h, { type: 'rewind_plan', promptId: u2, what: 'conversation' } as WebviewMessage);
    await local(h, { type: 'rewind_apply' } as WebviewMessage);
    expect(h.session().lastContextTokens).toBe(0);
  });
});
