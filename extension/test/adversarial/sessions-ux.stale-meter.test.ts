/** Đối kháng (lane sessions-ux): đồng hồ ở phiên mới/nhánh không được mang số nén của transcript phiên TRƯỚC. */
import { afterEach, expect, it } from 'vitest';
import { makeControllerHarness, type ControllerHarness } from '../helpers/controllerHarness';
import { textTurn } from '../helpers/fakeProvider';

let h: ControllerHarness;
afterEach(() => h?.dispose());

it('new_session: meter.compactions/clearedResults của phiên mới phải là 0, không thừa hưởng transcript cũ', async () => {
  h = makeControllerHarness({ script: [() => textTurn('ok', { inputTokens: 100, outputTokens: 5 })] });
  await h.send('chào');
  await h.idle();
  (h.view().transcript as unknown[]).push({ kind: 'notice', id: 'n_c', level: 'info', text: 'đã nén', ts: 1, compact: { clearedResults: 7 } });
  await h.ctl.handleRemote({ type: 'new_session' });
  const m = h.view().meter!;
  expect(m.inputTokens).toBe(0);
  expect(m.compactions).toBe(0);
  expect(m.clearedResults).toBe(0);
});
