import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { WebviewMessage } from '../../src/shared/protocol';
import { textTurn, toolTurn } from '../helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from '../helpers/controllerHarness';

const hs: ControllerHarness[] = [];
afterEach(() => { while (hs.length) hs.pop()!.dispose(); });
const local = (h: ControllerHarness, m: WebviewMessage) => (h.ctl as unknown as { onMessage(m: WebviewMessage): Promise<void> }).onMessage(m);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

it('«Cả hai» khi một tệp bị bỏ qua (đĩa đổi sau xem trước) không được xoá bản ghi checkpoint', async () => {
  const h = makeControllerHarness({
    storage: true,
    files: { 'a.txt': 'gốc\n' },
    script: Array.from({ length: 20 }, () => (req: any) => {
      const last = req.messages[req.messages.length - 1];
      const hasResult = last.content.some((b: any) => b.type === 'tool_result');
      if (!hasResult) return toolTurn([{ id: 'w', name: 'write_file', input: { path: 'n.txt', content: 'mới\n' } }]);
      return textTurn('xong');
    }),
  });
  hs.push(h);
  await local(h, { type: 'set_mode', mode: 'acceptEdits' } as WebviewMessage);
  await h.send('tạo n');
  await h.idle(); await sleep(300);
  expect((h.view().checkpoints ?? []).length).toBeGreaterThan(0);
  const u1 = h.view().transcript.find((i: any) => i.kind === 'user')!.id;
  await local(h, { type: 'rewind_plan', promptId: u1, what: 'both' } as WebviewMessage);
  fs.writeFileSync(path.join(h.dir, 'n.txt'), 'người dùng sửa sau khi xem trước\n');
  await local(h, { type: 'rewind_apply' } as WebviewMessage);
  await sleep(200);
  expect(fs.existsSync(path.join(h.dir, 'n.txt'))).toBe(true); // bị bỏ qua
  expect((h.view().checkpoints ?? []).length).toBeGreaterThan(0); // vẫn phải còn để khôi phục sau
});
