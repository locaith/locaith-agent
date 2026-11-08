/**
 * Khởi động lại extension giữa lúc trợ lý đang chạy (anh báo 08/11/2026, kèm ảnh):
 *  (1) cuộc trò chuyện đang dở KHÔNG được mở lại — phải vào Lịch sử chọn lại;
 *  (2) chọn lại xong, lượt dở vẫn hiện «Đang xử lý» như đang chạy, và gõ «tiếp tục» làm HAI lượt cùng sáng («cả lệnh cũ lẫn lệnh mới đều chạy»).
 * Chứng minh bằng ChatController THẬT (deps giả): khung bên tự mở lại cuộc trước, lượt dở bị đóng khi nạp, chỉ MỘT lượt sáng.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantItem, TItem } from '../src/shared/protocol';
import { healInterrupted } from '../src/shared/transcriptRebuild';
import { textTurn } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';

const KEY = 'locaithAgent.lastSessionId';
const harnesses: ControllerHarness[] = [];
const make = (...a: Parameters<typeof makeControllerHarness>): ControllerHarness => {
  const h = makeControllerHarness(...a);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.dispose();
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const restored = async (h: ControllerHarness): Promise<void> => {
  await (h.ctl as unknown as { restoring: Promise<void> | null }).restoring;
};
const live = (items: readonly TItem[]): AssistantItem[] => items.filter((i): i is AssistantItem => i.kind === 'assistant' && !i.done);

/** Một cuộc trò chuyện THẬT (do controller tạo) để dùng làm «bản đã lưu». */
async function savedConversation(): Promise<{ session: ReturnType<ControllerHarness['session']>; transcript: TItem[] }> {
  const a = make({ script: [() => textTurn('Đã xong phần một.')] });
  await a.send('làm phần một');
  await a.idle();
  return { session: clone(a.session()), transcript: clone(a.view().transcript) };
}

/** Bản lưu của một lượt BỊ NGẮT giữa chừng: mục trả lời còn `done:false`, công cụ còn «đang chạy», pill còn nhấp nháy. */
function interrupted(transcript: TItem[]): TItem[] {
  const t = clone(transcript);
  const a = [...t].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
  a.done = false;
  delete a.stopReason;
  delete a.endedAt;
  a.blocks.push({ type: 'tool', id: 'call_stale', name: 'run_command', args: { command: 'python long.py' }, state: 'running', startedAt: Date.now() });
  a.blocks.push({ type: 'tool', id: 'call_perm', name: 'write_file', args: { path: 'x.txt' }, state: 'awaiting_permission', startedAt: Date.now() });
  a.blocks.push({ type: 'pill', id: 'pill_stale', text: 'Đang đối chiếu…', kind: 'working', active: true });
  return t;
}

describe('healInterrupted — đóng lượt dở dang (hàm thuần)', () => {
  it('lượt đã xong giữ nguyên tham chiếu; không có gì dở → trả đúng transcript đầu vào', async () => {
    const { transcript } = await savedConversation();
    const r = healInterrupted(transcript);
    expect(r.healed).toBe(0);
    expect(r.items).toBe(transcript);
  });

  it('lượt dở: done=true, stopReason=aborted, công cụ dở → cancelled (bỏ thẻ xin quyền), pill tắt, artifact đang viết → ready; KHÔNG sửa đầu vào', async () => {
    const { transcript } = await savedConversation();
    const stale = interrupted(transcript);
    const art = [...stale].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
    art.blocks.push({ type: 'artifact', id: 'art1', state: 'writing', artifactId: 'a1', title: 'T', artifactType: 'html' } as never);
    const snapshot = JSON.stringify(stale);
    const r = healInterrupted(stale);
    expect(JSON.stringify(stale)).toBe(snapshot); // thuần
    expect(r.healed).toBe(1);
    const a = [...r.items].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
    expect(a.done).toBe(true);
    expect(a.stopReason).toBe('aborted');
    const tools = a.blocks.filter((b) => b.type === 'tool') as Array<{ id: string; state: string; permission?: unknown }>;
    expect(tools.find((b) => b.id === 'call_stale')!.state).toBe('cancelled');
    expect(tools.find((b) => b.id === 'call_perm')!.state).toBe('cancelled');
    expect('permission' in tools.find((b) => b.id === 'call_perm')!).toBe(false);
    expect((a.blocks.find((b) => b.type === 'pill') as { active: boolean }).active).toBe(false);
    expect((a.blocks.find((b) => b.type === 'artifact') as { state: string }).state).toBe('ready');
    expect(live(r.items)).toHaveLength(0);
  });

  it('giữ stopReason đã có; chỉ đóng mục dở, mục khác y nguyên', async () => {
    const { transcript } = await savedConversation();
    const stale = interrupted(transcript);
    const a = [...stale].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
    a.stopReason = 'max_tokens';
    const r = healInterrupted(stale);
    expect((r.items.find((i) => i.id === a.id) as AssistantItem).stopReason).toBe('max_tokens');
    expect(r.items[0]).toBe(stale[0]); // tin người dùng đầu: cùng tham chiếu
  });
});

describe('khung bên tự mở lại cuộc trò chuyện của lần chạy trước', () => {
  it('có dấu nhớ + cuộc còn trong kho → vào lại đúng cuộc đó (lịch sử, id, tiêu đề), không cần vào Lịch sử', async () => {
    const saved = await savedConversation();
    const ws = new Map<string, unknown>([[KEY, saved.session.id]]);
    const h = make({ script: [], surface: 'sidebar', workspaceState: ws, store: { load: async (id: string) => (id === saved.session.id ? { session: clone(saved.session), transcript: clone(saved.transcript), migrated: false } : null) } });
    await restored(h);
    await h.ctl.sendInit();
    expect(h.session().id).toBe(saved.session.id);
    expect(h.shownUserTexts()).toEqual(['làm phần một']);
    expect(h.view().screen).toBe('chat');
    expect(ws.get(KEY)).toBe(saved.session.id); // dấu nhớ còn nguyên sau khi mở lại
  });

  it('khung TAB (cửa sổ chat mới) KHÔNG tự mở lại — luôn bắt đầu trống như thiết kế', async () => {
    const saved = await savedConversation();
    const h = make({ script: [], surface: 'tab', workspaceState: new Map([[KEY, saved.session.id]]), store: { load: async () => ({ session: clone(saved.session), transcript: clone(saved.transcript), migrated: false }) } });
    await restored(h);
    expect(h.shownUserTexts()).toEqual([]);
  });

  it('không có dấu nhớ / cuộc đã bị xoá khỏi kho → để nguyên cuộc trống, KHÔNG báo lỗi, và quên dấu nhớ hỏng', async () => {
    const none = make({ script: [], surface: 'sidebar', workspaceState: new Map() });
    await restored(none);
    expect(none.shownUserTexts()).toEqual([]);

    const ws = new Map<string, unknown>([[KEY, 'phien-da-xoa']]);
    const h = make({ script: [], surface: 'sidebar', workspaceState: ws, store: { load: async () => null } });
    await restored(h);
    await h.ctl.sendInit();
    expect(h.shownUserTexts()).toEqual([]);
    expect(h.posted.some((m) => m.type === 'toast')).toBe(false);
    expect(ws.has(KEY)).toBe(false);
  });

  it('«Cuộc mới» xoá dấu nhớ (khởi động lại sẽ vào cuộc trống); gửi tin ở cuộc mới thì ghi nhớ cuộc mới', async () => {
    const saved = await savedConversation();
    const ws = new Map<string, unknown>([[KEY, saved.session.id]]);
    const h = make({ script: [() => textTurn('ok')], surface: 'sidebar', workspaceState: ws, store: { load: async () => ({ session: clone(saved.session), transcript: clone(saved.transcript), migrated: false }) } });
    await restored(h);
    await h.ctl.startNewSession();
    expect(ws.has(KEY)).toBe(false);
    await h.send('việc mới');
    await h.idle();
    // `store.save` giả không ghi gì nhưng dấu nhớ phải trỏ tới cuộc MỚI (đã có nội dung)
    await new Promise((r) => setTimeout(r, 30));
    expect(ws.get(KEY)).toBe(h.session().id);
    expect(h.session().id).not.toBe(saved.session.id);
  });

  it('thao tác của người dùng chờ việc mở lại xong (không giẫm lên): gửi tin ngay lúc khởi động vẫn vào ĐÚNG cuộc đã mở lại', async () => {
    const saved = await savedConversation();
    const ws = new Map<string, unknown>([[KEY, saved.session.id]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = make({
      script: [() => textTurn('tiếp nối')],
      surface: 'sidebar',
      workspaceState: ws,
      store: {
        load: async () => {
          await gate; // kho đọc chậm
          return { session: clone(saved.session), transcript: clone(saved.transcript), migrated: false };
        },
      },
    });
    const sending = h.ctl.handleRemote({ type: 'send', text: 'làm tiếp phần hai', attachments: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.shownUserTexts()).toEqual([]); // chưa mở lại xong → chưa gửi
    release();
    await sending;
    await h.idle();
    expect(h.session().id).toBe(saved.session.id);
    expect(h.shownUserTexts()).toEqual(['làm phần một', 'làm tiếp phần hai']);
  });
});

describe('lượt dở do khởi động lại: nạp xong KHÔNG còn lượt nào «sáng», «tiếp tục» chỉ có MỘT lượt sáng', () => {
  it('nạp cuộc có lượt dở → lượt đó đã đóng (Đã dừng + Thử lại), bản đã đóng được lưu lại', async () => {
    const saved = await savedConversation();
    const stale = interrupted(saved.transcript);
    expect(live(stale)).toHaveLength(1); // điều kiện: bản lưu thật sự có lượt «sáng» sót lại
    const saves: TItem[][] = [];
    const ws = new Map<string, unknown>([[KEY, saved.session.id]]);
    const h = make({
      script: [],
      surface: 'sidebar',
      workspaceState: ws,
      store: {
        load: async () => ({ session: clone(saved.session), transcript: clone(stale), migrated: false }),
        save: async (_s: unknown, t: TItem[]) => void saves.push(clone(t)),
      },
    });
    await restored(h);
    await h.ctl.sendInit();
    const items = h.view().transcript;
    expect(live(items)).toHaveLength(0);
    const last = [...items].reverse().find((i): i is AssistantItem => i.kind === 'assistant')!;
    expect(last.done).toBe(true);
    expect(last.stopReason).toBe('aborted');
    await new Promise((r) => setTimeout(r, 50));
    expect(saves.length).toBeGreaterThan(0);
    expect(live(saves[saves.length - 1]!)).toHaveLength(0); // đã ghi bản đã đóng
  });

  it('sau khi nạp, gõ «tiếp tục» → đúng MỘT lượt chạy, mọi lượt cũ đều đã xong, không lượt nào sáng trừ lượt mới', async () => {
    const saved = await savedConversation();
    const h = make({
      script: [() => textTurn('Đã làm tiếp.')],
      surface: 'sidebar',
      workspaceState: new Map([[KEY, saved.session.id]]),
      store: { load: async () => ({ session: clone(saved.session), transcript: clone(interrupted(saved.transcript)), migrated: false }) },
    });
    await restored(h);
    await h.ctl.sendInit();
    await h.send('tiếp tục');
    // giữa chừng cũng không bao giờ có hơn một lượt sáng
    expect(live(h.view().transcript).length).toBeLessThanOrEqual(1);
    await h.idle();
    const items = h.view().transcript;
    expect(live(items)).toHaveLength(0); // xong hết
    const assistants = items.filter((i): i is AssistantItem => i.kind === 'assistant');
    expect(assistants.length).toBe(2); // lượt cũ (đã đóng) + lượt mới
    expect(assistants.every((a) => a.done)).toBe(true);
    expect(assistants[0]!.stopReason).toBe('aborted');
    expect(h.provider.requests).toHaveLength(1); // đúng một lần gọi model cho «tiếp tục»
  });
});

describe('webview: chỉ lượt cuối được sáng', () => {
  it('ChatView tính lượt trả lời CUỐI và chỉ truyền live cho nó', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../webview/src/components/ChatView.tsx'), 'utf8');
    expect(src).toMatch(/const lastAssistantIdx = \(\(\) => \{[\s\S]*?kind === 'assistant'\) return i;[\s\S]*?return -1;/);
    expect(src).toContain('live={view.running && !item.done && i === lastAssistantIdx}');
  });
});
