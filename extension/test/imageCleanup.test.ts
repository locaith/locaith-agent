import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import { autoCleanImages, fmtBytes, handleCleanupMessage, type CleanupPort } from '../src/host/cleanup';
import { CheckpointStore } from '../src/host/checkpoints/store';
import { SessionStore, type StoreIO } from '../src/host/sessionStore';
import { IMAGE_REMOVED_NOTE, countImages, stripImages } from '../src/shared/sessionCleanup';
import { DEFAULT_STORAGE_IMAGE_LIMITS, LITE_STORAGE_IMAGE_LIMITS, trimTranscriptForStorage } from '../src/shared/transcript';
import { imageKey, reconcileTranscript, rebuildTranscript } from '../src/shared/transcriptRebuild';
import type { TItem, ToolBlock, UserItem } from '../src/shared/protocol';
import type { ChatMessage } from '../src/core/types';

/**
 * (0.7.2) Dọn bộ nhớ: mọi dữ liệu là giả lập trong bộ nhớ / thư mục tạm — KHÔNG đụng dữ liệu thật của người dùng.
 */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);
const bigB64 = (seed: string, n = 40_000): string => (seed + 'A'.repeat(n)).slice(0, n); // base64 giả, độ dài đủ để thấy chênh lệch

function memoryIO(files: Map<string, Uint8Array> = new Map()): StoreIO & { files: Map<string, Uint8Array> } {
  return {
    files,
    read: async (n) => {
      const f = files.get(n);
      if (!f) throw new Error('ENOENT');
      return f;
    },
    write: async (n, d) => void files.set(n, d),
    remove: async (n) => void files.delete(n),
    names: async () => [...files.keys()],
  };
}

const IMG_USER = bigB64('user');
const IMG_TOOL = bigB64('tool');
const IMG_ONLY_UI = bigB64('onlyui');
const IMG_ONLY_UI2 = bigB64('onlyui2', 41_000);

function sessionWithImages(id: string, updatedAt: number) {
  const s = newSession({ id, provider: 'p', model: 'm', title: `Phiên ${id}`, updatedAt });
  const msgs: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'xem ảnh này giúp em' }, { type: 'image', mediaType: 'image/png', data: IMG_USER }] },
    { role: 'assistant', content: [{ type: 'text', text: 'để anh chụp màn hình' }, { type: 'tool_use', id: 'tu1', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', name: 'screenshot', content: 'đã chụp', images: [{ type: 'image', mediaType: 'image/png', data: IMG_TOOL }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Xong, đây là kết quả.' }] },
  ];
  s.messages.push(...msgs);
  const tool: ToolBlock = { type: 'tool', id: 'tu1', name: 'screenshot', args: {}, state: 'done', startedAt: 1, images: [{ mediaType: 'image/png', data: IMG_TOOL }] };
  const ba: ToolBlock = { type: 'tool', id: 'tu2', name: 'show_before_after', args: { before: 'a.png', after: 'b.png' }, state: 'done', startedAt: 2, images: [{ mediaType: 'image/png', data: IMG_ONLY_UI }, { mediaType: 'image/png', data: IMG_ONLY_UI2 }] };
  const transcript: TItem[] = [
    { kind: 'user', id: 'u1', text: 'xem ảnh này giúp em', ts: 1, attachments: [{ kind: 'image', label: 'Ảnh 1', mediaType: 'image/png', thumb: 'dGh1bWI=', imgKey: imageKey(IMG_USER) }] },
    { kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: 2, done: true, stopReason: 'end_turn', blocks: [{ type: 'text', id: 'a1:t', text: 'Xong' }, tool, ba] } as unknown as TItem,
  ];
  return { session: s, transcript };
}

describe('sessionCleanup: đếm và xoá ảnh (giữ chữ)', () => {
  const raw = () => JSON.parse(JSON.stringify(sessionWithImages('s1', NOW - 100 * DAY))) as Parameters<typeof stripImages>[0];

  it('đếm: ảnh người dùng + ảnh công cụ + ảnh chỉ có ở khung hiển thị; bản sao của cùng ảnh không đếm hai lần', () => {
    const c = countImages(raw());
    expect(c.images).toBe(4); // user + tool (bản sao ở transcript không đếm lại) + hai ảnh Trước|Sau chỉ có ở transcript
    expect(c.chars).toBeGreaterThanOrEqual(IMG_USER.length + IMG_TOOL.length * 2 + IMG_ONLY_UI.length + IMG_ONLY_UI2.length);
  });

  it('xoá: không còn ảnh nào, chữ còn nguyên, có dòng thay thế và đánh dấu historyEdited', () => {
    const r = raw();
    const before = stripImages(r);
    expect(before.images).toBe(4);
    const json = JSON.stringify(r);
    expect(json).not.toContain(IMG_USER);
    expect(json).not.toContain(IMG_TOOL);
    expect(json).not.toContain(IMG_ONLY_UI);
    expect(json).not.toContain(IMG_ONLY_UI2);
    expect(json).toContain('xem ảnh này giúp em');
    expect(json).toContain('Xong, đây là kết quả.');
    expect(json).toContain(IMAGE_REMOVED_NOTE);
    expect(r.session!.historyEdited).toBe(true);
    expect(countImages(r)).toEqual({ images: 0, chars: 0 });
  });

  it('cặp tool_use/tool_result còn nguyên sau khi xoá ảnh (không làm hỏng lịch sử gửi model)', () => {
    const r = raw();
    stripImages(r);
    const msgs = r.session!.messages as ChatMessage[];
    const use = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_use');
    const res = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(use && res && (use as { id: string }).id === (res as { toolUseId: string }).toolUseId).toBe(true);
    expect((res as { images?: unknown }).images).toBeUndefined();
    expect((res as { content: string }).content).toContain('đã chụp');
  });

  it('phiên không có ảnh: không đổi gì (không đánh dấu historyEdited)', () => {
    const r = { session: { messages: [{ role: 'user', content: [{ type: 'text', text: 'chỉ chữ' }] }] }, transcript: [] } as Parameters<typeof stripImages>[0];
    expect(stripImages(r)).toEqual({ images: 0, chars: 0 });
    expect(r.session!.historyEdited).toBeUndefined();
  });

  it('phiên đã xoá ảnh vẫn mở/dựng lại bình thường (reconcile + rebuild không vỡ)', () => {
    const r = raw();
    stripImages(r);
    const msgs = r.session!.messages as ChatMessage[];
    expect(() => rebuildTranscript(msgs)).not.toThrow();
    const rec = reconcileTranscript(msgs, r.transcript as TItem[]);
    expect(rec.rebuilt).toBe(false); // transcript đủ lượt → giữ nguyên
  });
});

describe('transcript chỉ giữ bản xem trước nhỏ', () => {
  const user = (att: Record<string, unknown>): UserItem => ({ kind: 'user', id: 'u', text: 'x', ts: 1, attachments: [{ kind: 'image', label: 'Ảnh', ...att }] as UserItem['attachments'] });
  const withTool = (images: { mediaType: string; data: string }[]): TItem => ({ kind: 'assistant', id: 'a', provider: 'p', model: 'm', ts: 1, done: true, stopReason: 'end_turn', blocks: [{ type: 'tool', id: 't', name: 'screenshot', args: {}, state: 'done', startedAt: 1, images }] }) as unknown as TItem;

  it('ảnh đính kèm: dữ liệu đầy đủ lọt vào transcript bị bỏ; thumb nhỏ giữ, thumb quá nặng bỏ', () => {
    const [a, b, c] = trimTranscriptForStorage([user({ data: bigB64('full', 500_000), thumb: 'c21hbGw=' }), user({ thumb: bigB64('t', 200_000) }), user({ thumb: 'c21hbGw=', imgKey: 'k' })]) as UserItem[];
    expect(a.attachments[0].data).toBeUndefined();
    expect(a.attachments[0].thumb).toBe('c21hbGw=');
    expect(b.attachments[0].thumb).toBeUndefined();
    expect(c.attachments[0]).toMatchObject({ thumb: 'c21hbGw=', imgKey: 'k' });
  });

  it('ảnh công cụ: ảnh vừa trần giữ, quá trần (mặc định ~300 KB) bỏ khỏi bản lưu; chữ/đối số giữ nguyên', () => {
    const small = { mediaType: 'image/png', data: bigB64('s', 100_000) };
    const huge = { mediaType: 'image/png', data: bigB64('h', 3_000_000) };
    const [it] = trimTranscriptForStorage([withTool([small, huge])]);
    const blk = (it as unknown as { blocks: ToolBlock[] }).blocks[0];
    expect(blk.images).toHaveLength(1);
    expect(blk.images![0].data.length).toBe(100_000);
    const [it2] = trimTranscriptForStorage([withTool([huge])]);
    const blk2 = (it2 as unknown as { blocks: ToolBlock[] }).blocks[0];
    expect(blk2.images).toBeUndefined();
    expect(blk2.name).toBe('screenshot');
  });

  it('chế độ nhẹ: không lưu ảnh công cụ, thumb ≤ ~30 KB', () => {
    const [it] = trimTranscriptForStorage([withTool([{ mediaType: 'image/png', data: bigB64('s', 10_000) }])], 4000, LITE_STORAGE_IMAGE_LIMITS);
    expect((it as unknown as { blocks: ToolBlock[] }).blocks[0].images).toBeUndefined();
    const [u] = trimTranscriptForStorage([user({ thumb: bigB64('t', 60_000) })], 4000, LITE_STORAGE_IMAGE_LIMITS) as UserItem[];
    expect(u.attachments[0].thumb).toBeUndefined();
    expect(DEFAULT_STORAGE_IMAGE_LIMITS.attachThumbMaxChars).toBeGreaterThan(LITE_STORAGE_IMAGE_LIMITS.attachThumbMaxChars);
  });

  it('kho phiên áp trần khi lưu và chế độ nhẹ siết hơn; messages (bản cho model) KHÔNG bị đụng', async () => {
    const io = memoryIO();
    const store = new SessionStore(undefined, 'ws', io);
    const { session, transcript } = sessionWithImages('big', NOW);
    (transcript[1] as unknown as { blocks: ToolBlock[] }).blocks[2].images![0].data = bigB64('x', 900_000);
    await store.save(session, transcript);
    let p = await store.load('big');
    expect(JSON.stringify(p!.session.messages)).toContain(IMG_USER); // lịch sử gửi model còn đủ ảnh
    expect(JSON.stringify(p!.session.messages)).toContain(IMG_TOOL);
    const blocks = (p!.transcript[1] as unknown as { blocks: ToolBlock[] }).blocks;
    expect(blocks[1].images![0].data.length).toBe(40_000); // ảnh 40k vừa trần được giữ
    expect(blocks[2].images).toHaveLength(1); // ảnh 900k quá trần bị bỏ khỏi bản lưu, ảnh còn lại giữ
    store.setImageLimits(LITE_STORAGE_IMAGE_LIMITS);
    await store.save(session, transcript);
    p = await store.load('big');
    expect((p!.transcript[1] as unknown as { blocks: ToolBlock[] }).blocks[1].images).toBeUndefined();
    expect(JSON.stringify(p!.session.messages)).toContain(IMG_USER);
  });
});

describe('kho phiên: dọn bộ nhớ', () => {
  let io: ReturnType<typeof memoryIO>;
  let store: SessionStore;
  const put = async (id: string, ageDays: number) => {
    const { session, transcript } = sessionWithImages(id, NOW - ageDays * DAY);
    await store.save(session, transcript);
  };
  beforeEach(async () => {
    io = memoryIO();
    store = new SessionStore(undefined, 'ws', io);
    await put('old', 100);
    await put('mid', 40);
    await put('new', 2);
  });

  it('storageStats: đếm cuộc, byte, ảnh', async () => {
    const st = await store.storageStats();
    expect(st.sessions.count).toBe(3);
    expect(st.sessions.bytes).toBeGreaterThan(300_000);
    expect(st.images.count).toBe(12);
    expect(st.images.bytes).toBeGreaterThan(100_000);
    expect(st.trash.count).toBe(0);
  });

  it('purgeImages dryRun: chỉ tính, không ghi gì', async () => {
    const snapshot = new Map([...io.files].map(([k, v]) => [k, v.byteLength]));
    const r = await store.purgeImages({ olderThanMs: 30 * DAY, now: NOW, dryRun: true });
    expect(r.sessions).toBe(2);
    expect(r.images).toBe(8);
    expect(r.bytes).toBeGreaterThan(50_000);
    expect(new Map([...io.files].map(([k, v]) => [k, v.byteLength]))).toEqual(snapshot);
  });

  it('purgeImages: chỉ cuộc cũ hơn N ngày, trừ cuộc đang mở; chữ còn, updatedAt giữ nguyên, ghi nguyên tử', async () => {
    const sizeBefore = io.files.get('old.json')!.byteLength;
    const r = await store.purgeImages({ olderThanMs: 30 * DAY, exceptIds: ['mid'], now: NOW });
    expect(r.sessions).toBe(1);
    expect(r.images).toBe(4);
    expect(r.bytes).toBeGreaterThan(50_000);
    expect(io.files.get('old.json')!.byteLength).toBeLessThan(sizeBefore - 50_000);
    const old = await store.load('old');
    expect(old!.session.updatedAt).toBe(NOW - 100 * DAY);
    expect(JSON.stringify(old)).not.toContain(IMG_USER);
    expect(JSON.stringify(old)).toContain('xem ảnh này giúp em');
    expect(JSON.stringify(await store.load('mid'))).toContain(IMG_USER); // cuộc đang mở không bị đụng
    expect(JSON.stringify(await store.load('new'))).toContain(IMG_USER); // chưa đủ cũ
  });

  it('purgeImages lần hai không làm gì nữa', async () => {
    await store.purgeImages({ olderThanMs: 30 * DAY, now: NOW });
    const again = await store.purgeImages({ olderThanMs: 30 * DAY, now: NOW });
    expect(again).toEqual({ sessions: 0, images: 0, bytes: 0 });
  });

  it('autoCleanImages: days = 0 tắt; > 0 xoá ảnh cũ và bỏ qua cuộc đang mở', async () => {
    expect(await autoCleanImages(store, 0, [])).toEqual({ images: 0, bytes: 0 });
    // phiên fixture có updatedAt = NOW - n ngày; thời gian thật lớn hơn nhiều → mọi cuộc đều "cũ"
    const r = await autoCleanImages(store, 30, ['new']);
    expect(r.images).toBe(8);
    expect(JSON.stringify(await store.load('new'))).toContain(IMG_USER);
  });

  it('trashStale: chuyển cuộc cũ vào Thùng rác (không ghim, không đang mở); dryRun không làm gì', async () => {
    await store.setPinned('old', true);
    const dry = await store.trashStale({ olderThanMs: 30 * DAY, now: NOW, dryRun: true });
    expect(dry.sessions).toBe(1); // 'old' được ghim nên bỏ; còn 'mid'
    expect((await store.list()).length).toBe(3);
    const r = await store.trashStale({ olderThanMs: 30 * DAY, now: NOW });
    expect(r.sessions).toBe(1);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(['new', 'old']);
    const tr = await store.listTrash();
    expect(tr.map((t) => t.id)).toEqual(['mid']);
    const u = await store.trashUsage();
    expect(u.count).toBe(1);
    expect(u.bytes).toBeGreaterThan(10_000);
    expect(await store.emptyTrash()).toBe(1);
    expect((await store.trashUsage()).count).toBe(0);
  });
});

describe('điểm quay lại: dọn theo ngày', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cp-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('usage + pruneOlderThan (dryRun rồi thật), bỏ qua phiên đang mở', async () => {
    let t = NOW - 20 * DAY;
    const st = new CheckpointStore(dir, { now: () => t });
    for (const sid of ['s-old', 's-open']) {
      await st.beginTurn(sid, 'p1');
      await st.record(sid, 'p1', { abs: path.join(dir, 'f.txt'), rel: 'f.txt', before: 'bản cũ '.repeat(500), after: 'bản mới' });
    }
    t = NOW; // 20 ngày sau
    await st.beginTurn('s-recent', 'p9');
    await st.record('s-recent', 'p9', { abs: path.join(dir, 'g.txt'), rel: 'g.txt', before: 'x'.repeat(2000), after: 'y' });
    const u = await st.usage();
    expect(u.sessions).toBe(3);
    expect(u.bytes).toBeGreaterThan(4000);
    const dry = await st.pruneOlderThan(7, { except: ['s-open'], dryRun: true });
    expect(dry.turns).toBe(1);
    expect(dry.bytes).toBeGreaterThan(1000);
    expect(fs.existsSync(path.join(dir, 's-old'))).toBe(true);
    const real = await new CheckpointStore(dir, { now: () => t }).pruneOlderThan(7, { except: ['s-open'] });
    expect(real.turns).toBe(1);
    expect(fs.existsSync(path.join(dir, 's-old'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 's-open'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 's-recent'))).toBe(true);
  });
});

describe('host: hộp xác nhận ghi rõ dung lượng; webview không tự xoá được gì', () => {
  const win = vscode.window as unknown as { showWarningMessage?: (...a: unknown[]) => Promise<string | undefined> };
  let shown: { title: string; detail: string }[];
  let answer: string | undefined;
  const posted: unknown[] = [];
  const toasts: string[] = [];
  let store: SessionStore;

  const port = (): CleanupPort => ({
    lang: 'vi',
    store,
    openSessionIds: () => ['mid'],
    post: (m) => void posted.push(m),
    toast: (_l, text) => void toasts.push(text),
    refreshListings: async () => undefined,
    autoCleanImagesDays: () => 0,
  });

  beforeEach(async () => {
    shown = [];
    posted.length = 0;
    toasts.length = 0;
    answer = undefined;
    win.showWarningMessage = async (title: unknown, opts: unknown, ...items: unknown[]) => {
      shown.push({ title: String(title), detail: String((opts as { detail?: string }).detail ?? '') });
      return answer ?? (answer === undefined ? undefined : (items[0] as string));
    };
    store = new SessionStore(undefined, 'ws', memoryIO());
    for (const [id, age] of [['old', 100], ['mid', 40]] as const) {
      const { session, transcript } = sessionWithImages(id, Date.now() - age * DAY);
      await store.save(session, transcript);
    }
  });

  it('fmtBytes vi/en', () => {
    expect(fmtBytes(1536, 'vi')).toBe('1,5 KB');
    expect(fmtBytes(1536, 'en')).toBe('1.5 KB');
    expect(fmtBytes(69 * 1048576, 'vi')).toBe('69,0 MB');
    expect(fmtBytes(500, 'vi')).toBe('500 B');
  });

  it('không xác nhận → KHÔNG xoá gì; hộp thoại ghi số ảnh + dung lượng + giữ chữ', async () => {
    answer = undefined; // người dùng đóng hộp thoại
    await handleCleanupMessage(port(), { type: 'cleanup_run', action: 'images', days: 30 });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toMatch(/Xoá \d+ ảnh khỏi cuộc trò chuyện cũ hơn 30 ngày/);
    expect(shown[0].detail).toMatch(/Giải phóng khoảng [\d,]+ (KB|MB)/);
    expect(shown[0].detail).toMatch(/Chữ được giữ nguyên/);
    expect(JSON.stringify(await store.load('old'))).toContain(IMG_USER);
  });

  it('xác nhận → xoá ảnh cuộc cũ (trừ cuộc đang mở), báo kết quả và gửi số liệu mới', async () => {
    answer = 'Xoá ảnh';
    await handleCleanupMessage(port(), { type: 'cleanup_run', action: 'images', days: 30 });
    expect(JSON.stringify(await store.load('old'))).not.toContain(IMG_USER);
    expect(JSON.stringify(await store.load('mid'))).toContain(IMG_USER);
    expect(toasts[0]).toMatch(/Đã xoá 4 ảnh \(giữ chữ\)/);
    const last = posted[posted.length - 1] as { type: string; stats?: { images: { count: number } } };
    expect(last.type).toBe('cleanup_stats');
    expect(last.stats!.images.count).toBe(4); // còn ảnh của cuộc đang mở
  });

  it('không có gì để dọn → không mở hộp thoại', async () => {
    await handleCleanupMessage(port(), { type: 'cleanup_run', action: 'trash' });
    expect(shown).toHaveLength(0);
    expect(toasts[0]).toMatch(/Không có gì để dọn/);
  });

  it('số ngày lạ bị kẹp về mặc định; hành động lạ bị bỏ qua', async () => {
    await handleCleanupMessage(port(), { type: 'cleanup_run', action: 'images', days: -5 });
    expect(shown[0].title).toMatch(/cũ hơn 30 ngày/);
    shown.length = 0;
    await handleCleanupMessage(port(), { type: 'cleanup_run', action: 'rm-rf' as never, days: 1 });
    expect(shown).toHaveLength(0);
  });

  it('cleanup_stats trả số liệu', async () => {
    await handleCleanupMessage(port(), { type: 'cleanup_stats' });
    const last = posted[posted.length - 1] as { stats?: { sessions: { count: number }; images: { count: number } } };
    expect(last.stats!.sessions.count).toBe(2);
    expect(last.stats!.images.count).toBe(8);
  });
});
