/**
 * (lane:checkpoints-rewind) Kho checkpoint + khôi phục tệp: thuần Node, chạy trên thư mục tạm.
 * Mỗi ca có thể ĐỎ khi hành vi hỏng (đọc lại đĩa thật, không kiểm hằng chuỗi).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlan, insideWorkspace, planRestore, redoRestore, restoreFiles, turnOriginal } from '../src/host/checkpoints/restore';
import { CheckpointStore, countDiff, sessionKey } from '../src/host/checkpoints/store';

let tmp: string;
let ws: string;
let root: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cp-'));
  ws = path.join(tmp, 'ws');
  root = path.join(tmp, 'store');
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const abs = (rel: string) => path.join(ws, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
const exists = (rel: string) => fs.existsSync(abs(rel));

/** Mô phỏng host: ghi tệp thật rồi báo kho (before = nội dung đọc được TRƯỚC khi ghi). */
async function agentWrite(store: CheckpointStore, sid: string, pid: string, rel: string, content: string) {
  const before = exists(rel) ? read(rel) : null;
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content, 'utf8');
  await store.record(sid, pid, { abs: abs(rel), rel, before, after: content });
}

describe('kho checkpoint', () => {
  it('chụp bản gốc ở lần ghi ĐẦU; các lần ghi sau trong cùng lượt chỉ cập nhật bản cuối và số dòng', async () => {
    fs.writeFileSync(abs('a.txt'), 'một\nhai\nba\n');
    const store = new CheckpointStore(root);
    await store.beginTurn('s1', 'p1', [{ id: 't', title: 'việc', status: 'pending' }]);
    await agentWrite(store, 's1', 'p1', 'a.txt', 'một\nHAI\nba\n');
    await agentWrite(store, 's1', 'p1', 'a.txt', 'một\nHAI\nba\nbốn\n');
    const [t] = await store.turns('s1');
    expect(t.files).toHaveLength(1);
    expect(t.files[0]).toMatchObject({ rel: 'a.txt', existed: true, added: 2, removed: 1 });
    expect(await store.readBlob('s1', t.files[0].before!)).toBe('một\nhai\nba\n'); // bản gốc, không phải bản ghi lần hai
    expect(t.todos?.[0].title).toBe('việc');
    expect(store.summarize([t])[0].files[0]).toEqual({ rel: 'a.txt', kind: 'edit', added: 2, removed: 1 });
  });

  it('tệp mới: ghi nhận "chưa tồn tại" (kind create), không có blob gốc', async () => {
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'moi/b.txt', 'xin chào\n');
    const f = (await store.turns('s1'))[0].files[0];
    expect(f.existed).toBe(false);
    expect(f.before).toBeUndefined();
    expect(store.summarize(await store.turns('s1'))[0].files[0].kind).toBe('create');
  });

  it('tệp > 2 MB và nhị phân KHÔNG được chụp nhưng vẫn ghi nhận kèm lý do', async () => {
    fs.writeFileSync(abs('big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
    fs.writeFileSync(abs('bin.dat'), 'ab\u0000cd');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'big.txt', 'nhỏ');
    await agentWrite(store, 's1', 'p1', 'bin.dat', 'text');
    const files = (await store.turns('s1'))[0].files;
    expect(files.find((f) => f.rel === 'big.txt')?.skipped).toBe('too_large');
    expect(files.find((f) => f.rel === 'bin.dat')?.skipped).toBe('binary');
    expect(fs.existsSync(path.join(root, 's1', 'blobs')) ? fs.readdirSync(path.join(root, 's1', 'blobs')).length : 0).toBeLessThanOrEqual(2); // không có blob 2 MB
  });

  it('giữ 30 lượt gần nhất và dọn blob mồ côi', async () => {
    const store = new CheckpointStore(root, { keepTurns: 3 });
    for (let i = 1; i <= 5; i++) {
      await store.beginTurn('s1', `p${i}`);
      await agentWrite(store, 's1', `p${i}`, `f${i}.txt`, `nội dung ${i}`);
    }
    const turns = await store.turns('s1');
    expect(turns.map((t) => t.promptId)).toEqual(['p3', 'p4', 'p5']);
    // p1/p2 chỉ tạo tệp mới (after = "nội dung 1/2") → blob của chúng phải bị xoá
    const blobs = fs.readdirSync(path.join(root, 's1', 'blobs'));
    expect(blobs).toHaveLength(3);
  });

  it('hạn 14 ngày: lượt quá hạn bị bỏ khi mở lượt mới; gc() xoá phiên cũ nhưng giữ phiên còn hạn', async () => {
    let now = 1_000_000_000_000;
    const store = new CheckpointStore(root, { now: () => now });
    await store.beginTurn('old', 'p1');
    now += 20 * 86_400_000;
    await store.beginTurn('fresh', 'q1');
    expect(await store.gc()).toBe(1);
    expect(fs.existsSync(path.join(root, 'old'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'fresh'))).toBe(true);
    // lượt cũ trong cùng phiên cũng bị cắt khi mở lượt mới
    await store.beginTurn('fresh', 'q2');
    now += 15 * 86_400_000;
    await store.beginTurn('fresh', 'q3');
    expect((await store.turns('fresh')).map((t) => t.promptId)).toEqual(['q3']);
  });

  it('sống sót qua tải lại: kho mới đọc lại đúng từ đĩa', async () => {
    const a = new CheckpointStore(root);
    await agentWrite(a, 's1', 'p1', 'x.txt', 'v1');
    const b = new CheckpointStore(root);
    const turns = await b.turns('s1');
    expect(turns[0].files[0].rel).toBe('x.txt');
    expect(await b.readBlob('s1', turns[0].files[0].after!)).toBe('v1');
  });

  it('removeSession xoá cả thư mục; id phiên lạ được băm (không thoát ra ngoài kho)', async () => {
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'x.txt', 'v1');
    await store.removeSession('s1');
    expect(fs.existsSync(path.join(root, 's1'))).toBe(false);
    expect(sessionKey('../../etc')).toMatch(/^h-[0-9a-f]{24}$/);
    await store.beginTurn('../../etc', 'p1');
    expect(fs.readdirSync(root).every((n) => !n.includes('..'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'etc'))).toBe(false);
  });

  it('countDiff đếm dòng thêm/bớt', () => {
    expect(countDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(countDiff('x', 'x')).toEqual({ added: 0, removed: 0 });
  });
});

describe('khôi phục', () => {
  const ctx = (store: CheckpointStore, sid = 's1') => ({ store, sessionId: sid, roots: [ws] });

  it('khôi phục tệp đã sửa về bản gốc, xoá tệp agent tạo mới, tạo lại tệp đã bị xoá', async () => {
    fs.writeFileSync(abs('edit.txt'), 'gốc\n');
    fs.writeFileSync(abs('gone.txt'), 'sẽ bị xoá\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'edit.txt', 'đã sửa\n');
    await agentWrite(store, 's1', 'p1', 'new.txt', 'mới\n');
    await agentWrite(store, 's1', 'p1', 'gone.txt', 'agent sửa\n');
    fs.rmSync(abs('gone.txt')); // bị xoá sau đó (vd. lệnh shell)
    const res = await restoreFiles(ctx(store), 'p1', { overwriteConflicts: true });
    expect(res.restored).toBe(3);
    expect(read('edit.txt')).toBe('gốc\n');
    expect(exists('new.txt')).toBe(false);
    expect(read('gone.txt')).toBe('sẽ bị xoá\n');
    expect(res.plan.entries.map((e) => [e.rel, e.action])).toEqual([
      ['edit.txt', 'restore'],
      ['gone.txt', 'recreate'],
      ['new.txt', 'delete'],
    ]);
  });

  it('XUNG ĐỘT: người dùng sửa tiếp sau agent → bị đánh dấu và KHÔNG ghi đè khi chưa cho phép', async () => {
    fs.writeFileSync(abs('c.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'c.txt', 'agent\n');
    fs.writeFileSync(abs('c.txt'), 'agent\nngười dùng thêm\n');
    const plan = await planRestore(ctx(store), 'p1');
    expect(plan.entries[0]).toMatchObject({ rel: 'c.txt', action: 'restore', conflict: true });
    const res = await applyPlan(ctx(store), plan);
    expect(res.restored).toBe(0);
    expect(res.skipped).toEqual([{ rel: 'c.txt', reason: 'conflict' }]);
    expect(read('c.txt')).toBe('agent\nngười dùng thêm\n'); // còn nguyên
    // cho phép đúng tệp đã thấy cảnh báo
    const ok = await applyPlan(ctx(store), plan, { allowConflicts: new Set(['c.txt']) });
    expect(ok.restored).toBe(1);
    expect(read('c.txt')).toBe('gốc\n');
  });

  it('không xung đột khi đĩa đúng bản agent đã ghi', async () => {
    fs.writeFileSync(abs('d.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'd.txt', 'agent\n');
    const plan = await planRestore(ctx(store), 'p1');
    expect(plan.entries[0].conflict).toBeUndefined();
  });

  it('kế hoạch cũ: đĩa đổi giữa lúc xem trước và xác nhận → tệp bị bỏ qua như xung đột', async () => {
    fs.writeFileSync(abs('e.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'e.txt', 'agent\n');
    const plan = await planRestore(ctx(store), 'p1');
    fs.writeFileSync(abs('e.txt'), 'ai đó sửa vào giây chót\n');
    const res = await applyPlan(ctx(store), plan);
    expect(res.restored).toBe(0);
    expect(read('e.txt')).toBe('ai đó sửa vào giây chót\n');
  });

  it('phạm vi "from": quay lại điểm cũ khôi phục về bản gốc của lượt ĐẦU chạm vào tệp; "turn": chỉ lượt đó', async () => {
    fs.writeFileSync(abs('f.txt'), 'v0\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'f.txt', 'v1\n');
    await agentWrite(store, 's1', 'p2', 'f.txt', 'v2\n');
    await agentWrite(store, 's1', 'p2', 'g.txt', 'g2\n');
    // chỉ lượt p2 → về v1 (người dùng thấy xung đột? không: đĩa = v2 = bản agent ghi ở p2)
    const turn = await restoreFiles(ctx(store), 'p2', { scope: 'turn' });
    expect(read('f.txt')).toBe('v1\n');
    expect(exists('g.txt')).toBe(false);
    expect(turn.restored).toBe(2);
    // từ p1 trở đi → về v0
    fs.writeFileSync(abs('f.txt'), 'v2\n');
    const from = await restoreFiles(ctx(store), 'p1', { scope: 'from', overwriteConflicts: true });
    expect(read('f.txt')).toBe('v0\n');
    expect(from.plan.turnIds).toEqual(['p1', 'p2']);
  });

  it('chỉ khôi phục các tệp được chọn (files)', async () => {
    fs.writeFileSync(abs('h1.txt'), 'a\n');
    fs.writeFileSync(abs('h2.txt'), 'b\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'h1.txt', 'A\n');
    await agentWrite(store, 's1', 'p1', 'h2.txt', 'B\n');
    await restoreFiles(ctx(store), 'p1', { files: ['h2.txt'] });
    expect(read('h1.txt')).toBe('A\n');
    expect(read('h2.txt')).toBe('b\n');
  });

  it('HOÀN TÁC rồi LÀM LẠI một lần: về đúng trạng thái trước khi khôi phục; sửa thêm sau khi khôi phục thì không bị đè', async () => {
    fs.writeFileSync(abs('r.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'r.txt', 'agent\n');
    await agentWrite(store, 's1', 'p1', 'n.txt', 'tạo mới\n');
    const undo = await restoreFiles(ctx(store), 'p1');
    expect(read('r.txt')).toBe('gốc\n');
    expect(exists('n.txt')).toBe(false);
    const redo = await redoRestore(ctx(store), undo.journal);
    expect(redo.restored).toBe(2);
    expect(read('r.txt')).toBe('agent\n');
    expect(read('n.txt')).toBe('tạo mới\n');

    // làm lại bị chặn nếu người dùng đã sửa tệp sau khi hoàn tác
    const undo2 = await restoreFiles(ctx(store), 'p1', { overwriteConflicts: true });
    fs.writeFileSync(abs('r.txt'), 'người dùng viết tiếp\n');
    const redo2 = await redoRestore(ctx(store), undo2.journal);
    expect(redo2.skipped).toContainEqual({ rel: 'r.txt', reason: 'conflict' });
    expect(read('r.txt')).toBe('người dùng viết tiếp\n');
  });

  it('sau hoàn tác (markUndone) lần quay lại SAU không bị coi là xung đột giả', async () => {
    fs.writeFileSync(abs('u.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'u.txt', 'agent\n');
    const r = await restoreFiles(ctx(store), 'p1');
    expect(r.restored).toBe(1);
    await store.markUndone('s1', ['p1'], true);
    const again = await planRestore(ctx(store), 'p1');
    expect(again.entries).toEqual([]); // đã đúng bản gốc: không có gì để làm
    fs.writeFileSync(abs('u.txt'), 'gốc\n');
    expect((await store.turns('s1'))[0].undone).toBe(true);
  });

  it('NGOÀI workspace bị từ chối kể cả khi kho bị sửa tay; path traversal và ký tự NUL bị từ chối', async () => {
    const outside = path.join(tmp, 'ngoai.txt');
    fs.writeFileSync(outside, 'không được đụng\n');
    const store = new CheckpointStore(root);
    await store.beginTurn('s1', 'p1');
    // kho bị giả mạo: bản ghi trỏ ra ngoài workspace
    const turns = await store.turns('s1');
    const bad = await store.record('s1', 'p1', { abs: outside, rel: 'ngoai.txt', before: 'gốc\n', after: 'x' });
    expect(bad.abs).toBe(outside);
    const trav = await store.record('s1', 'p1', { abs: path.join(ws, 'a', '..', '..', 'zzz.txt'), rel: '../zzz.txt', before: 'gốc\n', after: 'x' });
    expect(trav.rel).toBe('../zzz.txt');
    void turns;
    const res = await restoreFiles(ctx(store), 'p1', { overwriteConflicts: true });
    expect(res.restored).toBe(0);
    expect(res.skipped.every((s) => s.reason === 'outside')).toBe(true);
    expect(res.skipped).toHaveLength(2);
    expect(fs.readFileSync(outside, 'utf8')).toBe('không được đụng\n');
    expect(await insideWorkspace(path.join(ws, 'a', '..', '..', 'ngoai.txt'), [ws])).toBe(false);
    expect(await insideWorkspace(path.join(ws, 'a\u0000b'), [ws])).toBe(false);
    expect(await insideWorkspace('tuong/doi.txt', [ws])).toBe(false);
    expect(await insideWorkspace(path.join(ws, 'sâu', 'mới.txt'), [ws])).toBe(true);
  });

  it('symlink trong workspace trỏ ra ngoài không cho ghi xuyên qua', async () => {
    const outDir = path.join(tmp, 'outdir');
    fs.mkdirSync(outDir);
    try {
      fs.symlinkSync(outDir, abs('link'), 'junction');
    } catch {
      return; // môi trường không cho tạo liên kết — bỏ qua
    }
    expect(await insideWorkspace(abs('link/x.txt'), [ws])).toBe(false);
  });

  it('tệp bị bỏ qua (quá lớn) hiện ra trong kế hoạch với lý do và không bị động tới', async () => {
    fs.writeFileSync(abs('big.txt'), 'y'.repeat(2 * 1024 * 1024 + 5));
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'big.txt', 'nhỏ');
    const plan = await planRestore(ctx(store), 'p1');
    expect(plan.entries[0]).toMatchObject({ rel: 'big.txt', action: 'skip', reason: 'too_large' });
    const res = await applyPlan(ctx(store), plan, { overwriteConflicts: true });
    expect(res.restored).toBe(0);
    expect(read('big.txt')).toBe('nhỏ');
  });

  it('blob gốc bị mất → skip missing_blob, không ghi gì', async () => {
    fs.writeFileSync(abs('m.txt'), 'gốc\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'm.txt', 'agent\n');
    const before = (await store.turns('s1'))[0].files[0].before!;
    fs.rmSync(path.join(root, 's1', 'blobs', before));
    const plan = await planRestore(ctx(store), 'p1');
    expect(plan.entries[0]).toMatchObject({ action: 'skip', reason: 'missing_blob' });
  });

  it('nhiều lượt liên tiếp: mỗi lượt có bản gốc riêng và turnOriginal trả đúng bản của lượt đó', async () => {
    fs.writeFileSync(abs('k.txt'), 'v0\n');
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'k.txt', 'v1\n');
    await agentWrite(store, 's1', 'p2', 'k.txt', 'v2\n');
    await agentWrite(store, 's1', 'p3', 'k2.txt', 'm\n');
    expect(await turnOriginal(store, 's1', 'p1', 'k.txt')).toBe('v0\n');
    expect(await turnOriginal(store, 's1', 'p2', 'k.txt')).toBe('v1\n');
    expect(await turnOriginal(store, 's1', 'p3', 'k2.txt')).toBeNull();
    expect(await turnOriginal(store, 's1', 'p3', 'khong.txt')).toBeUndefined();
  });

  it('dropFrom bỏ lượt đó và mọi lượt sau; blob không còn ai dùng bị dọn', async () => {
    const store = new CheckpointStore(root);
    await agentWrite(store, 's1', 'p1', 'a.txt', 'A');
    await agentWrite(store, 's1', 'p2', 'b.txt', 'B');
    await store.dropFrom('s1', 'p2');
    expect((await store.turns('s1')).map((t) => t.promptId)).toEqual(['p1']);
    expect(fs.readdirSync(path.join(root, 's1', 'blobs'))).toHaveLength(1);
  });
});
