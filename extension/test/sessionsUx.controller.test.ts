/**
 * (lane:sessions-ux) ChatController THẬT + kho phiên thật (bộ nhớ): rẽ nhánh, tìm toàn văn, ghim, xoá hàng loạt, /fork /context /cost,
 * và số liệu đồng hồ trong ViewState.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, type StoreIO } from '../src/host/sessionStore';
import type { HostMessage, SessionSearchHit } from '../src/shared/protocol';
import { parseCommand } from '../src/core/remote/protocol';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';
import { textTurn } from './helpers/fakeProvider';

function memoryIO(): StoreIO {
  const files = new Map<string, Uint8Array>();
  return {
    async read(name) {
      const f = files.get(name);
      if (!f) throw new Error('ENOENT');
      return f;
    },
    async write(name, data) {
      files.set(name, data);
    },
    async remove(name) {
      files.delete(name);
    },
    async names() {
      return [...files.keys()];
    },
  };
}

let h: ControllerHarness;
afterEach(() => h?.dispose());

function withStore(script: Parameters<typeof makeControllerHarness>[0]['script']): SessionStore {
  h = makeControllerHarness({ script });
  const store = new SessionStore(undefined, 'ws-test', memoryIO());
  (h.ctl as unknown as { d: { store: SessionStore } }).d.store = store;
  return store;
}
const lastInit = (): { sessionId: string; title: string; transcript: Array<{ kind: string; text?: string; fork?: unknown }> } => {
  const msgs = h.posted.filter((m): m is Extract<HostMessage, { type: 'init' }> => m.type === 'init');
  return msgs[msgs.length - 1].state as never;
};
const noticeTexts = () => h.view().transcript.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text);

describe('rẽ nhánh qua controller', () => {
  it('fork_session sau lượt đầu: cuộc mới có lịch sử tới đó + tiêu đề (nhánh) + liên kết ngược; cuộc gốc còn nguyên trong kho', async () => {
    const store = withStore([() => textTurn('đáp một'), () => textTurn('đáp hai')]);
    await h.send('câu hỏi một');
    await h.idle();
    await h.send('câu hỏi hai');
    await h.idle();
    const parentId = h.session().id;
    const firstUser = h.view().transcript.find((i) => i.kind === 'user')!;

    await h.ctl.handleRemote({ type: 'fork_session', itemId: firstUser.id });

    const forkedId = h.session().id;
    expect(forkedId).not.toBe(parentId);
    expect(h.session().title).toMatch(/\(nhánh\)$/);
    expect(h.shownUserTexts()).toEqual(['câu hỏi một']); // lượt hai không rò sang nhánh
    const msgsText = JSON.stringify(h.session().messages);
    expect(msgsText).toContain('đáp một');
    expect(msgsText).not.toContain('câu hỏi hai');
    const back = h.view().transcript.find((i) => i.kind === 'notice' && (i as { fork?: unknown }).fork);
    expect(back).toMatchObject({ fork: { fromId: parentId } });

    const parent = await store.load(parentId);
    expect(parent!.session.messages.length).toBeGreaterThanOrEqual(4); // cuộc gốc vẫn đủ hai lượt
    expect(JSON.stringify(parent!.session.messages)).toContain('câu hỏi hai');
    expect(await store.load(forkedId)).not.toBeNull();
    expect((await store.list()).map((s) => s.id).sort()).toEqual([parentId, forkedId].sort());
  });

  it('đang chạy thì không rẽ nhánh (báo bận), phiên không đổi', async () => {
    withStore([() => new Promise(() => undefined)]);
    void h.send('treo');
    await new Promise((r) => setTimeout(r, 50));
    const before = h.session().id;
    await h.ctl.handleRemote({ type: 'fork_session' });
    expect(h.session().id).toBe(before);
    h.stop();
  });

  it('/fork là lệnh gạch chéo; cuộc trống thì báo chưa có gì để rẽ', async () => {
    withStore([() => textTurn('ok')]);
    await h.send('/fork');
    expect(noticeTexts().join('\n')).toMatch(/chưa có gì để rẽ nhánh/);
    await h.send('xin chào');
    await h.idle();
    const before = h.session().id;
    await h.send('/fork');
    expect(h.session().id).not.toBe(before);
  });
});

describe('/context, /cost và đồng hồ trong ViewState', () => {
  it('sau một lượt: view.meter có token vào/ra thật; /context in bảng; /cost nói không có giá (provider giả không có bảng giá)', async () => {
    withStore([() => textTurn('xin chào bạn', { inputTokens: 1200, outputTokens: 80 })]);
    await h.send('chào');
    await h.idle();
    const meter = h.view().meter!;
    expect(meter.inputTokens).toBe(1200);
    expect(meter.outputTokens).toBe(80);
    expect('costUsd' in meter).toBe(false);

    await h.send('/context');
    const ctxText = noticeTexts().find((t) => t.includes('Ngữ cảnh của cuộc trò chuyện'))!;
    expect(ctxText).toContain('System prompt');
    expect(ctxText).toMatch(/Định nghĩa công cụ \(\d+\)/); // engine đã đo số công cụ ở lần gọi trước
    expect(ctxText).not.toContain('chưa đo');

    await h.send('/cost');
    const costText = noticeTexts().find((t) => t.includes('Chi phí cuộc trò chuyện'))!;
    expect(costText).toContain('1.200');
    expect(costText).toContain('không có giá');
  });

  it('có bảng giá trong danh mục model → view.meter.costUsd và /cost in ước tính', async () => {
    withStore([() => textTurn('ok', { inputTokens: 1_000_000, outputTokens: 100_000 })]);
    // giả danh mục có giá cho model hiện tại (đường dữ liệu thật: ViewState.providers[].models[].pricing)
    const ctl = h.ctl as unknown as { view: { providers: unknown[] }; session: { provider: string; model: string } };
    ctl.view.providers = [{ id: ctl.session.provider, models: [{ id: ctl.session.model, pricing: { inputPerM: 1, outputPerM: 4 } }] }];
    await h.send('chào');
    await h.idle();
    expect(h.view().meter!.costUsd).toBeCloseTo(1.4, 6);
    await h.send('/cost');
    expect(noticeTexts().find((t) => t.includes('Chi phí'))).toContain('$1.40');
  });
});

describe('tìm toàn văn, ghim, xoá hàng loạt', () => {
  async function seed(store: SessionStore) {
    const { newSession } = await import('../src/core/engine/types');
    const mk = (id: string, title: string, text: string, updatedAt: number) => {
      const s = newSession({ id, provider: 'fake', model: 'm', title, updatedAt });
      s.messages = [{ role: 'user', content: [{ type: 'text', text }] }];
      return { s, tr: [{ kind: 'user', id: `u_${id}`, text, attachments: [], ts: updatedAt }] as never };
    };
    for (const [i, [id, title, text]] of ([
      ['old1', 'Việc cũ', 'cần soạn Hợp đồng lao động cho nhân viên mới'],
      ['old2', 'Khác', 'sửa lỗi nút bấm'],
      ['old3', 'Đặng Văn A', 'không liên quan'],
    ] as const).entries()) {
      const { s, tr } = mk(id, title, text, 1000 + i);
      await store.save(s, tr);
    }
  }

  it('search_sessions: tìm không dấu trong NỘI DUNG và TIÊU ĐỀ, gửi kết quả có trích đoạn + chữ khớp, kết thúc done=true, gắn đúng reqId', async () => {
    const store = withStore([]);
    await seed(store);
    await h.ctl.handleRemote({ type: 'search_sessions', reqId: 7, query: 'hop dong' });
    const replies = h.posted.filter((m): m is Extract<HostMessage, { type: 'session_search' }> => m.type === 'session_search');
    const last = replies[replies.length - 1];
    expect(last.reqId).toBe(7);
    expect(last.done).toBe(true);
    expect(last.hits.map((x: SessionSearchHit) => x.id)).toEqual(['old1']);
    expect(last.hits[0].snippet).toContain('Hợp đồng');
    expect(last.hits[0].marks!.length).toBeGreaterThan(0);

    await h.ctl.handleRemote({ type: 'search_sessions', reqId: 8, query: 'dang van' });
    const r2 = h.posted.filter((m): m is Extract<HostMessage, { type: 'session_search' }> => m.type === 'session_search' && m.reqId === 8);
    expect(r2[r2.length - 1].hits.map((x: SessionSearchHit) => x.id)).toEqual(['old3']);
    expect(r2[r2.length - 1].hits[0].inTitle).toBe(true);
  });

  it('pin_session: cuộc được ghim hiện pinned trong danh sách, bỏ ghim thì mất; mã lạ bị bỏ qua', async () => {
    const store = withStore([]);
    await seed(store);
    await h.ctl.handleRemote({ type: 'pin_session', id: 'old2', pinned: true });
    expect((await store.list()).find((s) => s.id === 'old2')!.pinned).toBe(true);
    expect((await store.list()).find((s) => s.id === 'old1')!.pinned).toBeUndefined();
    await h.ctl.handleRemote({ type: 'pin_session', id: 'old2', pinned: false });
    expect((await store.list()).find((s) => s.id === 'old2')!.pinned).toBeUndefined();
    await h.ctl.handleRemote({ type: 'pin_session', id: '../../etc', pinned: true });
    expect((await store.list()).some((s) => s.pinned)).toBe(false);
  });

  it('delete_sessions: chuyển cả nhóm vào Thùng rác (khôi phục được), KHÔNG xoá cuộc đang mở', async () => {
    const store = withStore([() => textTurn('ok')]);
    await seed(store);
    await h.send('đang mở');
    await h.idle();
    const cur = h.session().id;
    await h.ctl.handleRemote({ type: 'delete_sessions', ids: ['old1', 'old2', cur, '../x'] });
    const left = (await store.list()).map((s) => s.id);
    expect(left).toContain(cur);
    expect(left).toContain('old3');
    expect(left).not.toContain('old1');
    expect((await store.listTrash()).map((t) => t.id).sort()).toEqual(['old1', 'old2']);
    expect(await store.restore('old1')).toBeTruthy();
  });
});

describe('Remote: lệnh rẽ nhánh / ghim qua parseCommand', () => {
  it('chấp nhận mã hợp lệ, từ chối mã/kiểu sai', () => {
    expect(parseCommand({ type: 'fork_session' }, { canBypass: false })).toEqual({ ok: true, cmd: { type: 'fork_session' } });
    expect(parseCommand({ type: 'fork_session', itemId: 'u_12ab' }, { canBypass: false })).toEqual({ ok: true, cmd: { type: 'fork_session', itemId: 'u_12ab' } });
    expect(parseCommand({ type: 'fork_session', itemId: '../x y' }, { canBypass: false }).ok).toBe(false);
    expect(parseCommand({ type: 'pin_session', id: 'abc', pinned: true }, { canBypass: false }).ok).toBe(true);
    expect(parseCommand({ type: 'pin_session', id: 'abc', pinned: 'yes' }, { canBypass: false }).ok).toBe(false);
    expect(parseCommand({ type: 'delete_sessions', ids: ['a'] }, { canBypass: false }).ok).toBe(false); // xoá hàng loạt KHÔNG mở cho Remote
  });
});

describe('đồng hồ khi đổi phiên', () => {
  it('load_session: meter.compactions lấy từ transcript của phiên vừa mở, không phải phiên trước', async () => {
    const store = withStore([]);
    const { newSession } = await import('../src/core/engine/types');
    const s = newSession({ id: 'cmp1', provider: 'fake', model: 'm', title: 'Đã nén', updatedAt: 5 });
    s.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const tr = [
      { kind: 'user', id: 'u1', text: 'hi', attachments: [], ts: 5 },
      { kind: 'notice', id: 'n1', level: 'info', text: 'đã nén', ts: 6, compact: { clearedResults: 4 } },
    ] as never;
    await store.save(s, tr);
    expect(h.view().meter?.compactions ?? 0).toBe(0);
    await h.ctl.handleRemote({ type: 'load_session', id: 'cmp1' } as never);
    expect(h.view().meter!.compactions).toBe(1);
    expect(h.view().meter!.clearedResults).toBe(4);
    await h.ctl.handleRemote({ type: 'new_session' });
    expect(h.view().meter!.compactions).toBe(0);
    expect(h.view().meter!.clearedResults).toBe(0);
  });
});
