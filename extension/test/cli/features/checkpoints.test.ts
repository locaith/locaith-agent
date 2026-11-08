import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointFeatureOf, checkpointsFeature } from '../../../src/cli/runtime/features/checkpoints';
import { FakeFeatureContext, writeFile } from './helpers';

let ctx: FakeFeatureContext;
afterEach(async () => {
  await ctx?.dispose();
  ctx?.cleanup();
});

/** Mô phỏng một lượt: tin người dùng + (extension.begin) + trợ lý ghi tệp qua host + trả lời. */
async function turn(c: FakeFeatureContext, text: string, writes: Record<string, string> = {}): Promise<void> {
  c.session().messages.push({ role: 'user', content: [{ type: 'text', text }] } as never);
  c.begin(c.scope({ input: [{ type: 'text', text }] }));
  for (const [rel, content] of Object.entries(writes)) await c.host.writeText(path.join(c.cwd, rel), content);
  c.session().messages.push({ role: 'assistant', content: [{ type: 'text', text: `đã làm: ${text}` }] } as never);
  await checkpointFeatureOf(c)!.flush();
  await checkpointFeatureOf(c)!.recount();
}

const read = (c: FakeFeatureContext, rel: string) => fs.readFileSync(path.join(c.cwd, rel), 'utf8');
const exists = (c: FakeFeatureContext, rel: string) => fs.existsSync(path.join(c.cwd, rel));
const turnsOf = (c: FakeFeatureContext) => checkpointFeatureOf(c)!.store.turns(c.session().id);

async function setup(over: ConstructorParameters<typeof FakeFeatureContext>[0] = {}) {
  ctx = new FakeFeatureContext(over);
  writeFile(path.join(ctx.cwd, 'a.txt'), 'goc-a');
  writeFile(path.join(ctx.cwd, 'b.txt'), 'goc-b');
  await ctx.attach(checkpointsFeature);
}

describe('checkpoints + /rewind', () => {
  it('chụp bản gốc → sửa → /rewind code khôi phục, xoá tệp trợ lý tạo mới; status.changedFiles đếm đúng', async () => {
    await setup();
    await turn(ctx, 'sửa a và tạo c', { 'a.txt': 'moi-a', 'c.txt': 'moi-c' });
    expect(ctx.status().changedFiles).toBe(2);
    await turn(ctx, 'sửa b', { 'b.txt': 'moi-b' });
    expect(ctx.status().changedFiles).toBe(1);

    const turns = await turnsOf(ctx);
    ctx.askAnswers = [turns[0].promptId, 'code', true];
    const out = await ctx.runSlash('rewind');
    expect(out).toContain('a.txt');
    expect(read(ctx, 'a.txt')).toBe('goc-a');
    expect(read(ctx, 'b.txt')).toBe('goc-b'); // "từ điểm này về sau" gồm cả lượt 2
    expect(exists(ctx, 'c.txt')).toBe(false);
    expect(ctx.asks[0]).toMatchObject({ kind: 'pick', searchable: true });
    expect((ctx.asks[0] as { items: { label: string }[] }).items.map((i) => i.label)).toEqual(['sửa b', 'sửa a và tạo c']);
    expect(ctx.session().messages).toHaveLength(4); // hội thoại không đổi
  });

  it('tệp bị sửa SAU lần trợ lý ghi: không ghi đè khi từ chối; ghi đè khi đồng ý sau cảnh báo', async () => {
    await setup();
    await turn(ctx, 'sửa a', { 'a.txt': 'moi-a' });
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'nguoi-dung-sua-tiep');
    const id = (await turnsOf(ctx))[0].promptId;

    ctx.askAnswers = [id, 'code', false, true]; // chọn lượt, code, KHÔNG ghi đè xung đột, xác nhận
    const out = await ctx.runSlash('rewind');
    expect(out).toMatch(/đã bị sửa sau đó/);
    expect(read(ctx, 'a.txt')).toBe('nguoi-dung-sua-tiep');
    const conflictAsk = ctx.asks[2] as { kind: string; danger?: boolean; detail?: string };
    expect(conflictAsk.kind).toBe('confirm');
    expect(conflictAsk.danger).toBe(true);
    expect(conflictAsk.detail).toContain('a.txt');

    ctx.asks.length = 0;
    ctx.askAnswers = [id, 'code', true, true]; // đồng ý ghi đè
    await ctx.runSlash('rewind');
    expect(read(ctx, 'a.txt')).toBe('goc-a');
  });

  it('khôi phục hội thoại: cắt messages, phát replay reason rewind, trả tin về ô nhập, giữ tệp', async () => {
    await setup();
    await turn(ctx, 'lượt một', { 'a.txt': 'a1' });
    await turn(ctx, 'lượt hai', { 'b.txt': 'b2' });
    await turn(ctx, 'lượt ba', {});
    const turns = await turnsOf(ctx);
    ctx.askAnswers = [turns[1].promptId, 'conversation', true];
    const out = await ctx.runSlash('rewind');
    expect(ctx.session().messages).toHaveLength(2); // chỉ còn lượt một (user + assistant)
    const replay = ctx.events.find((e) => e.t === 'replay') as { items: { kind: string; text?: string }[]; reason: string };
    expect(replay.reason).toBe('rewind');
    expect(replay.items.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['lượt một']);
    expect(ctx.saved).toBe(1);
    expect(ctx.events.filter((e) => e.t === 'action')).toEqual([{ t: 'action', action: 'insert', payload: 'lượt hai' }]); // tin trả về ô nhập
    expect(ctx.replaced.map((r) => r.opts?.reason)).toEqual(['rewind']); // lõi cập nhật transcript + phát replay
    expect(ctx.replaced[0].next).toBe(ctx.session()); // cùng đối tượng phiên, sửa tại chỗ
    expect(out).toContain('lượt hai');
    expect(read(ctx, 'b.txt')).toBe('b2'); // chỉ hội thoại: tệp giữ nguyên
    // lượt mới sau khi cắt vẫn cắt tiếp được đúng chỗ (các lượt đã cắt không bị tính)
    await turn(ctx, 'lượt bốn', { 'a.txt': 'a4' });
    const t2 = await turnsOf(ctx);
    ctx.askAnswers = [t2[t2.length - 1].promptId, 'conversation', true];
    await ctx.runSlash('rewind');
    expect(ctx.session().messages.map((m) => (m.content[0] as { text: string }).text)).toEqual(['lượt một', 'đã làm: lượt một']);
  });

  it('hội thoại đã nén: chỉ khôi phục mã và báo rõ, không cắt', async () => {
    await setup();
    await turn(ctx, 'một', { 'a.txt': 'a1' });
    await turn(ctx, 'hai', { 'b.txt': 'b2' });
    const turns = await turnsOf(ctx);
    ctx.session().messages.splice(0, 2); // giả lập nén: lượt một biến mất khỏi messages
    ctx.askAnswers = [turns[0].promptId, 'both', true];
    const out = await ctx.runSlash('rewind');
    expect(out).toMatch(/nén|không khớp/);
    expect(read(ctx, 'a.txt')).toBe('goc-a');
    expect(read(ctx, 'b.txt')).toBe('goc-b');
    expect(ctx.session().messages).toHaveLength(2);
    expect(ctx.events.some((e) => e.t === 'replay')).toBe(false);
  });

  it('cả hai khi còn nguyên: khôi phục mã + cắt hội thoại và bỏ bản ghi checkpoint của các lượt đó', async () => {
    await setup();
    await turn(ctx, 'một', { 'a.txt': 'a1' });
    await turn(ctx, 'hai', { 'b.txt': 'b2' });
    const turns = await turnsOf(ctx);
    ctx.askAnswers = [turns[1].promptId, 'both', true];
    await ctx.runSlash('rewind');
    expect(read(ctx, 'b.txt')).toBe('goc-b');
    expect(read(ctx, 'a.txt')).toBe('a1');
    expect(ctx.session().messages).toHaveLength(2);
    expect((await turnsOf(ctx)).map((t) => t.promptId)).toEqual([turns[0].promptId]);
  });

  it('/rewind last hoàn tác lượt gần nhất; /rewind redo làm lại', async () => {
    await setup();
    await turn(ctx, 'sửa a', { 'a.txt': 'moi-a' });
    ctx.askAnswers = [true];
    await ctx.runSlash('rewind', 'last');
    expect(read(ctx, 'a.txt')).toBe('goc-a');
    expect(ctx.status().changedFiles).toBeUndefined(); // lượt đã hoàn tác
    expect(await ctx.runSlash('rewind', 'last')).toMatch(/không đổi tệp|đã hoàn tác/);
    const out = await ctx.runSlash('rewind', 'redo');
    expect(out).toMatch(/làm lại/i);
    expect(read(ctx, 'a.txt')).toBe('moi-a');
    expect(await ctx.runSlash('rewind', 'redo')).toMatch(/không còn gì/i);
  });

  it('không tương tác thì không đổi gì; huỷ ở bước xác nhận thì không đổi gì', async () => {
    await setup({ interactive: false });
    await turn(ctx, 'sửa a', { 'a.txt': 'moi-a' });
    expect(await ctx.runSlash('rewind')).toMatch(/tương tác/);
    expect(read(ctx, 'a.txt')).toBe('moi-a');
    ctx.interactive = true;
    const id = (await turnsOf(ctx))[0].promptId;
    ctx.askAnswers = [id, 'code', false];
    expect(await ctx.runSlash('rewind')).toMatch(/Đã huỷ/);
    expect(read(ctx, 'a.txt')).toBe('moi-a');
  });

  it('tắt checkpoints.enabled thì không chụp gì', async () => {
    ctx = new FakeFeatureContext({ user: { 'checkpoints.enabled': false } });
    writeFile(path.join(ctx.cwd, 'a.txt'), 'goc');
    await ctx.attach(checkpointsFeature);
    await turn(ctx, 'x', { 'a.txt': 'moi' });
    expect(ctx.status().changedFiles).toBeUndefined();
    expect(await ctx.runSlash('rewind')).toMatch(/Chưa bật/);
    expect(fs.existsSync(path.join(ctx.home, '.locaith', 'checkpoints', ctx.session().id, 'turns.json'))).toBe(false);
  });

  it('thư mục chưa tin cậy: không khôi phục mã; tệp ngoài thư mục làm việc không được theo dõi', async () => {
    await setup({ trusted: false });
    await turn(ctx, 'sửa a', { 'a.txt': 'moi-a' });
    const id = (await turnsOf(ctx))[0].promptId;
    ctx.askAnswers = [id, 'code', true];
    expect(await ctx.runSlash('rewind')).toMatch(/chưa được tin cậy/);
    expect(read(ctx, 'a.txt')).toBe('moi-a');

    const outside = path.join(ctx.home, 'ngoai.txt');
    await ctx.host.writeText(outside, 'x');
    await checkpointFeatureOf(ctx)!.flush();
    const files = (await turnsOf(ctx)).flatMap((t) => t.files.map((f) => f.rel));
    expect(files).toEqual(['a.txt']);
  });
});

describe('checkpoints khi lõi thiếu điểm móc', () => {
  it('không có onFileWrite → bọc host.writeText vẫn chụp được; không có replaceSession → tự phát replay', async () => {
    ctx = new FakeFeatureContext();
    (ctx as unknown as { onFileWrite: undefined }).onFileWrite = undefined;
    (ctx as unknown as { replaceSession: undefined }).replaceSession = undefined;
    writeFile(path.join(ctx.cwd, 'a.txt'), 'goc-a');
    await ctx.attach(checkpointsFeature);
    await turn(ctx, 'lượt một', { 'a.txt': 'a1' });
    await turn(ctx, 'lượt hai', { 'a.txt': 'a2' });
    const turns = await turnsOf(ctx);
    expect(turns.map((t) => t.files.length)).toEqual([1, 1]);
    ctx.askAnswers = [turns[1].promptId, 'both', true];
    await ctx.runSlash('rewind');
    expect(read(ctx, 'a.txt')).toBe('a1');
    expect(ctx.session().messages).toHaveLength(2);
    expect(ctx.events.some((e) => e.t === 'replay' && (e as { reason: string }).reason === 'rewind')).toBe(true);
    expect(ctx.saved).toBe(1);
  });
});
