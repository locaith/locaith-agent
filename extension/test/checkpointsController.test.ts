/**
 * (lane:checkpoints-rewind) ChatController THẬT + engine thật (nhà cung cấp giả) + tệp thật trong workspace tạm:
 * ghi nhận checkpoint qua ToolHost.writeText, thanh thay đổi (view.checkpoints), Quay lại mã / hội thoại / cả hai, Làm lại,
 * điều khiển từ xa phải qua cổng xác nhận.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamRequest } from '../src/core/types';
import type { HostMessage, TItem, WebviewMessage } from '../src/shared/protocol';
import { orphanToolUses } from '../src/shared/rewindConversation';
import { textTurn, toolTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const harnesses: ControllerHarness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.dispose();
});
const make = (o: Parameters<typeof makeControllerHarness>[0]): ControllerHarness => {
  const h = makeControllerHarness({ storage: true, ...o });
  harnesses.push(h);
  return h;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tin từ khung chat trong VS Code (không qua Remote). */
const local = (h: ControllerHarness, m: WebviewMessage): Promise<void> => (h.ctl as unknown as { onMessage(m: WebviewMessage): Promise<void> }).onMessage(m);
const remote = (h: ControllerHarness, m: WebviewMessage): Promise<void> => h.ctl.handleRemote(m, 'điện thoại');
const feature = (h: ControllerHarness) => (h.ctl as unknown as { checkpoints: { flush(): Promise<void> } }).checkpoints;
const rewind = (h: ControllerHarness) => h.view().rewind;
const read = (h: ControllerHarness, rel: string) => fs.readFileSync(path.join(h.dir, rel), 'utf8');
const exists = (h: ControllerHarness, rel: string) => fs.existsSync(path.join(h.dir, rel));
const userIds = (h: ControllerHarness): string[] => h.view().transcript.filter((i: TItem) => i.kind === 'user' && !i.steer).map((i) => i.id);
async function settle(h: ControllerHarness) {
  await h.idle();
  await feature(h).flush();
  await sleep(160); // nhịp đẩy `checkpoints` lên giao diện
}

/**
 * Kịch bản theo NỘI DUNG (không theo thứ tự): cổng hoàn thành của engine có thể thêm lần gọi model, nên không thể đếm bước.
 * Lượt "làm một": đọc a.txt → sửa a.txt + tạo b.txt → nói xong. Lượt "làm hai": sửa a.txt + tạo c.txt → nói xong.
 */
function routed(req: StreamRequest) {
  const msgs = req.messages;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user' && !m.synthetic && !m.content.some((b) => b.type === 'tool_result') && m.content.some((b) => b.type === 'text')) {
      idx = i;
      break;
    }
  }
  const text = idx >= 0 ? msgs[idx].content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
  const k = msgs.slice(idx + 1).filter((m) => m.role === 'assistant').length;
  if (text.includes('làm một')) {
    if (k === 0) return toolTurn([{ id: 'r0', name: 'read_file', input: { path: 'a.txt' } }]);
    if (k === 1) return toolTurn([{ id: 'w1', name: 'write_file', input: { path: 'a.txt', content: 'lượt một\n' } }, { id: 'w2', name: 'write_file', input: { path: 'b.txt', content: 'b mới\n' } }]);
  }
  if (text.includes('làm hai') && k === 0) return toolTurn([{ id: 'w3', name: 'write_file', input: { path: 'a.txt', content: 'lượt hai\n' } }, { id: 'w4', name: 'write_file', input: { path: 'c.txt', content: 'c mới\n' } }]);
  return textTurn('xong');
}

function twoTurns(): Parameters<typeof makeControllerHarness>[0] {
  return { files: { 'a.txt': 'gốc\n' }, script: Array.from({ length: 40 }, () => routed) };
}

async function runTwoTurns(h: ControllerHarness) {
  await remote(h, { type: 'set_mode', mode: 'acceptEdits' });
  await h.send('làm một');
  await settle(h);
  await h.send('làm hai');
  await settle(h);
}

describe('ghi nhận checkpoint qua engine thật', () => {
  it('mỗi lượt có bản ghi riêng với đúng tệp và số dòng; view.checkpoints phản ánh', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1, u2] = userIds(h);
    const cps = h.view().checkpoints!;
    expect(cps.map((c) => c.promptId)).toEqual([u1, u2]);
    expect(cps[0].files.map((f) => [f.rel, f.kind]).sort()).toEqual([['a.txt', 'edit'], ['b.txt', 'create']]);
    expect(cps[1].files.map((f) => [f.rel, f.kind]).sort()).toEqual([['a.txt', 'edit'], ['c.txt', 'create']]);
    expect(cps[0].files.find((f) => f.rel === 'a.txt')).toMatchObject({ added: 1, removed: 1 });
    // bản gốc của lượt hai là KẾT QUẢ lượt một
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
  });

  it('phiên không có kho (không cấp globalStorage) → không có view.checkpoints và không lỗi', async () => {
    const h = makeControllerHarness({ ...twoTurns(), storage: false });
    harnesses.push(h);
    await runTwoTurns(h);
    expect(h.view().checkpoints).toBeUndefined();
    await local(h, { type: 'rewind_open', promptId: userIds(h)[0] });
    expect(rewind(h)).toBeUndefined();
  });
});

describe('Quay lại', () => {
  it('khôi phục MÃ về trước lượt một: xem trước đúng danh sách, xác nhận, rồi Làm lại', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1] = userIds(h);
    await local(h, { type: 'rewind_open', promptId: u1 });
    expect(rewind(h)).toMatchObject({ promptId: u1, stage: 'menu' });
    await local(h, { type: 'rewind_plan', promptId: u1, what: 'code' });
    const plan = rewind(h)!;
    expect(plan.stage).toBe('plan');
    expect(plan.files!.map((f) => `${f.action}:${f.rel}`).sort()).toEqual(['delete:b.txt', 'delete:c.txt', 'restore:a.txt']);
    expect(plan.conflicts).toBe(0);
    // chưa xác nhận → đĩa chưa đổi
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
    const messagesBefore = h.session().messages.length;

    await local(h, { type: 'rewind_apply' });
    expect(rewind(h)).toMatchObject({ stage: 'done', what: 'code', restored: 3, canRedo: true });
    expect(read(h, 'a.txt')).toBe('gốc\n');
    expect(exists(h, 'b.txt')).toBe(false);
    expect(exists(h, 'c.txt')).toBe(false);
    expect(h.session().messages.length).toBe(messagesBefore); // hội thoại nguyên vẹn
    expect(h.view().checkpoints!.every((c) => c.undone)).toBe(true);

    await local(h, { type: 'rewind_redo' });
    expect(rewind(h)).toMatchObject({ stage: 'done', redone: true, restored: 3, canRedo: false });
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
    expect(read(h, 'b.txt')).toBe('b mới\n');
    expect(read(h, 'c.txt')).toBe('c mới\n');
    expect(h.view().checkpoints!.some((c) => c.undone)).toBe(false);
  });

  it('xung đột được báo ở bước xem trước; người dùng xác nhận thì ghi đè đúng tệp đó', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [, u2] = userIds(h);
    fs.writeFileSync(path.join(h.dir, 'a.txt'), 'lượt hai\nngười dùng viết thêm\n');
    await local(h, { type: 'rewind_plan', promptId: u2, what: 'code', scope: 'turn' });
    const plan = rewind(h)!;
    expect(plan.conflicts).toBe(1);
    expect(plan.files!.find((f) => f.rel === 'a.txt')?.conflict).toBe(true);
    // đĩa đổi thêm lần nữa SAU khi xem trước nhưng trước khi xác nhận → tệp đã cảnh báo vẫn được phép (người dùng đã thấy), tệp khác sạch
    await local(h, { type: 'rewind_apply' });
    expect(read(h, 'a.txt')).toBe('lượt một\n'); // bản gốc của LƯỢT HAI
    expect(exists(h, 'c.txt')).toBe(false);
    expect(read(h, 'b.txt')).toBe('b mới\n'); // lượt một không bị đụng
  });

  it('khôi phục HỘI THOẠI về trước lượt hai: cắt phiên + transcript + todo, đưa chữ về ô nhập, tiền tố hợp lệ, gửi tiếp được', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1, u2] = userIds(h);
    const afterTurn1 = h.session().messages.findIndex((m, i) => i > 0 && m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes('làm hai')));
    expect(afterTurn1).toBeGreaterThan(0);
    await local(h, { type: 'rewind_plan', promptId: u2, what: 'conversation' });
    expect(rewind(h)).toMatchObject({ stage: 'plan', what: 'conversation' });
    expect(rewind(h)!.messages).toBeGreaterThan(0);
    await local(h, { type: 'rewind_apply' });

    expect(h.session().messages).toHaveLength(afterTurn1);
    expect(orphanToolUses(h.session().messages)).toEqual([]);
    expect(userIds(h)).toEqual([u1]);
    expect(h.shownUserTexts()).toEqual(['làm một']);
    const draft = h.posted.filter((m: HostMessage) => m.type === 'draft').pop() as Extract<HostMessage, { type: 'draft' }>;
    expect(draft.text).toBe('làm hai');
    expect(rewind(h)).toMatchObject({ stage: 'done', what: 'conversation' });
    // tệp KHÔNG bị đụng; bản ghi checkpoint của lượt hai được giữ để lần quay lại SAU này vẫn khôi phục được
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
    expect(h.view().checkpoints!.map((c) => c.promptId)).toContain(u2);

    // gửi tiếp: model nhận lịch sử hợp lệ
    await h.send('làm hai (sửa)');
    await settle(h);
    const last = h.provider.requests[h.provider.requests.length - 1];
    expect(orphanToolUses(last.messages as never)).toEqual([]);
    expect(h.shownUserTexts()).toEqual(['làm một', 'làm hai (sửa)']);
  });

  it('CẢ HAI về trước lượt một: tệp về như ban đầu, hội thoại rỗng, bản ghi bị bỏ, có thể Làm lại phần tệp', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1] = userIds(h);
    await local(h, { type: 'rewind_plan', promptId: u1, what: 'both' });
    await local(h, { type: 'rewind_apply' });
    expect(read(h, 'a.txt')).toBe('gốc\n');
    expect(exists(h, 'b.txt')).toBe(false);
    expect(h.session().messages).toHaveLength(0);
    expect(h.view().transcript).toHaveLength(0);
    expect(h.view().checkpoints).toEqual([]);
    expect(rewind(h)).toMatchObject({ stage: 'done', what: 'both', restored: 3, canRedo: true });
    await local(h, { type: 'rewind_redo' });
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
  });

  it('todo trở về trạng thái lúc bắt đầu lượt được chọn', async () => {
    const h = make({
      files: { 'a.txt': 'x\n' },
      script: [
        () => textTurn('lượt một'),
        () => toolTurn([{ id: 'td', name: 'todo_write', input: { todos: [{ id: '1', title: 'việc mới', status: 'in_progress' }] } }]),
        () => textTurn('lượt hai'),
      ],
    });
    await h.send('một');
    await settle(h);
    await h.send('hai');
    await settle(h);
    expect(h.session().todos.length).toBeGreaterThan(0);
    await local(h, { type: 'rewind_plan', promptId: userIds(h)[1], what: 'conversation' });
    await local(h, { type: 'rewind_apply' });
    expect(h.session().todos).toEqual([]);
    expect(h.view().todos).toEqual([]);
  });

  it('chặn khi trợ lý đang chạy; điểm không tồn tại báo lỗi gọn thay vì ném', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    await local(h, { type: 'rewind_open', promptId: 'u_khong_co' });
    expect(rewind(h)).toMatchObject({ stage: 'menu', error: expect.any(String) });
    await local(h, { type: 'rewind_cancel' });
    expect(rewind(h)).toBeNull();
  });

  it('tắt cài đặt checkpoints.enabled → không ghi nhận gì', async () => {
    const h = make(twoTurns());
    const ctl = h.ctl as unknown as { d: { config: { get: (k: string, d: unknown) => unknown } } };
    const orig = ctl.d.config.get;
    ctl.d.config.get = (k, d) => (k === 'checkpoints.enabled' ? false : orig(k, d));
    await runTwoTurns(h);
    expect(h.view().checkpoints ?? []).toEqual([]);
    if (h.storageDir) expect(fs.existsSync(path.join(h.storageDir, 'checkpoints'))).toBe(false);
  });
});

describe('Remote', () => {
  it('khôi phục mã từ xa khi chế độ quyền chưa tự nhận sửa tệp bị chặn (cần xác nhận tại máy)', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    await remote(h, { type: 'set_mode', mode: 'default' });
    const [u1] = userIds(h);
    await remote(h, { type: 'rewind_plan', promptId: u1, what: 'code' });
    expect(rewind(h)!.stage).toBe('plan');
    await remote(h, { type: 'rewind_apply' });
    // không có hộp thoại xác nhận (stub) → từ chối; đĩa nguyên vẹn
    expect(read(h, 'a.txt')).toBe('lượt hai\n');
    expect(rewind(h)).toMatchObject({ stage: 'plan', error: expect.any(String) });
  });

  it('ở chế độ Tự nhận sửa, Remote khôi phục được; thanh thay đổi đi qua bộ lọc Remote', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1] = userIds(h);
    await remote(h, { type: 'rewind_plan', promptId: u1, what: 'code' });
    await remote(h, { type: 'rewind_apply' });
    expect(read(h, 'a.txt')).toBe('gốc\n');
    const { sanitizePatch } = await import('../src/core/remote/sanitize');
    const out = sanitizePatch({ checkpoints: h.view().checkpoints, rewind: rewind(h) });
    expect(out?.checkpoints?.[0].files.length).toBeGreaterThan(0);
    expect(out?.rewind?.stage).toBe('done');
  });

  it('Remote không mở được diff (cần editor)', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    const [u1] = userIds(h);
    // không ném, không làm gì (diffs là đồ giả; nếu bị gọi sẽ lỗi ở openAgainstFile)
    await expect(remote(h, { type: 'checkpoint_diff', promptId: u1, rel: 'a.txt' })).resolves.toBeUndefined();
  });
});

describe('/rewind', () => {
  it('mở thẻ với các tin gần đây (mới nhất trước) và chọn sẵn tin cuối', async () => {
    const h = make(twoTurns());
    await runTwoTurns(h);
    await h.send('/rewind');
    await h.idle();
    const r = rewind(h)!;
    const [u1, u2] = userIds(h);
    expect(r.stage).toBe('menu');
    expect(r.promptId).toBe(u2);
    expect(r.recent!.map((x) => x.promptId)).toEqual([u2, u1]);
    expect(r.recent![0]).toMatchObject({ text: 'làm hai', files: 2 });
  });
});
