import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import type { ChatMessage } from '../src/core/types';
import { BACKUP_FORMAT, backupFileName, makeBackup, parseBackup } from '../src/shared/sessionBackup';
import { BaseSessionStore, TRASH_DAYS, type StoreIO } from '../src/shared/sessionStore';
import type { TItem } from '../src/shared/protocol';
import { wrapUploaded } from '../src/shared/docWrap';

const DAY = 24 * 60 * 60 * 1000;
const dec = new TextDecoder();
const enc = new TextEncoder();

function memoryIO(files: Map<string, Uint8Array> = new Map()): StoreIO & { files: Map<string, Uint8Array> } {
  return {
    files,
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

const BRIEF = 'BRIEF: ngân sách 40 triệu, đối tượng nữ 25–34 tuổi.';
const msg = (role: 'user' | 'assistant', text: string): ChatMessage => ({ role, content: [{ type: 'text', text }] });
const transcript = (text: string): TItem[] => [{ kind: 'user', id: 'u1', text, attachments: [{ kind: 'doc', label: 'brief.pdf', doc: { kind: 'pdf', pages: 2 } }], ts: 1 }];

/** Một phiên "quảng cáo" có tệp bối cảnh ở tin nhắn đầu. */
const adSession = (id: string, over: Partial<ReturnType<typeof newSession>> = {}) => {
  const s = newSession({ id, provider: 'fake', model: 'm', title: `Phiên quảng cáo ${id}`, ...over });
  s.messages.push(msg('user', `${wrapUploaded('brief.pdf', 'pdf', BRIEF, { pages: 2 })}\n\nLên ý tưởng quảng cáo`), msg('assistant', 'Đây là 3 ý tưởng.'));
  return s;
};

describe('lịch sử không tự biến mất', () => {
  it('KHÔNG còn tự xoá các cuộc cũ nhất khi quá 200 cuộc (trước đây âm thầm mất hẳn)', async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    for (let i = 0; i < 205; i++) await store.save(adSession(`s${i}`, { updatedAt: i + 1 }), transcript('x'));
    const list = await store.list();
    expect(list).toHaveLength(205);
    expect(list.at(-1)?.id).toBe('s0'); // cuộc cũ nhất vẫn còn
    expect(io.files.has('s0.json')).toBe(true);
  });
});

describe('Thùng rác: xoá = chuyển vào thùng, khôi phục được, giữ nguyên tệp bối cảnh', () => {
  it('moveToTrash: biến khỏi danh sách nhưng còn nguyên nội dung (kể cả tệp bối cảnh) trong thùng; restore đưa về y nguyên', async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    await store.save(adSession('a1', { updatedAt: 10 }), transcript('Lên ý tưởng quảng cáo'));
    await store.save(adSession('a2', { updatedAt: 20 }), transcript('khác'));
    const before = await store.load('a1');

    expect(await store.moveToTrash('a1')).toBe(true);
    expect((await store.list()).map((s) => s.id)).toEqual(['a2']);
    expect(io.files.has('a1.json')).toBe(false);
    expect(io.files.has('trash.a1.json')).toBe(true);
    const trash = await store.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: 'a1', title: 'Phiên quảng cáo a1', messageCount: 2 });
    expect(trash[0].deletedAt).toBeGreaterThan(Date.now() - 5000);
    expect(JSON.stringify(JSON.parse(dec.decode(io.files.get('trash.a1.json')!)).session.messages)).toContain('ngân sách 40 triệu'); // tệp bối cảnh còn trong bản thùng

    expect(await store.restore('a1')).toBe(true);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(['a1', 'a2']);
    expect(await store.listTrash()).toEqual([]);
    expect(io.files.has('trash.a1.json')).toBe(false);
    expect(await store.load('a1')).toEqual(before); // y nguyên từng chữ
  });

  it('purge / emptyTrash xoá vĩnh viễn; emptyTrash chỉ đụng tới thùng của workspace hiện tại', async () => {
    const io = memoryIO();
    const a = new BaseSessionStore(io, 'ws-a');
    const b = new BaseSessionStore(io, 'ws-b');
    for (const id of ['a1', 'a2', 'a3']) await a.save(adSession(id), []);
    await b.save(adSession('b1'), []);
    for (const id of ['a1', 'a2', 'a3']) await a.moveToTrash(id);
    await b.moveToTrash('b1');
    expect((await a.listTrash()).map((s) => s.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect((await b.listTrash()).map((s) => s.id)).toEqual(['b1']);

    await a.purge('a1');
    expect((await a.listTrash()).map((s) => s.id).sort()).toEqual(['a2', 'a3']);
    expect(io.files.has('trash.a1.json')).toBe(false);
    expect(await a.emptyTrash()).toBe(2);
    expect(await a.listTrash()).toEqual([]);
    expect((await b.listTrash()).map((s) => s.id)).toEqual(['b1']); // thùng của cửa sổ khác còn nguyên
  });

  it(`quá ${TRASH_DAYS} ngày thì được dọn hẳn; chưa quá hạn thì còn`, async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    await store.save(adSession('old'), []);
    await store.save(adSession('fresh'), []);
    await store.moveToTrash('old');
    await store.moveToTrash('fresh');
    // lùi ngày xoá của "old" về 31 ngày trước, "fresh" về 29 ngày trước (sửa cả chỉ mục lẫn tệp như thể đã trôi qua từng ấy ngày)
    const age = (id: string, days: number) => {
      const p = JSON.parse(dec.decode(io.files.get(`trash.${id}.json`)!));
      p.deletedAt = Date.now() - days * DAY;
      io.files.set(`trash.${id}.json`, enc.encode(JSON.stringify(p)));
      const idx = JSON.parse(dec.decode(io.files.get('trash.index.json')!));
      idx.find((e: { id: string }) => e.id === id).deletedAt = p.deletedAt;
      io.files.set('trash.index.json', enc.encode(JSON.stringify(idx)));
    };
    age('old', TRASH_DAYS + 1);
    age('fresh', TRASH_DAYS - 1);
    expect((await store.listTrash()).map((s) => s.id)).toEqual(['fresh']);
    expect(io.files.has('trash.old.json')).toBe(false);
    expect(io.files.has('trash.fresh.json')).toBe(true);
  });

  it('gián đoạn giữa chừng không làm mất: còn cả bản sống lẫn bản trong thùng → bản sống thắng; tệp thùng mất chỉ mục thì dựng lại', async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    await store.save(adSession('x1', { updatedAt: 5 }), []);
    await store.moveToTrash('x1');
    // (1) mô phỏng "khôi phục dở dang": bản sống đã ghi nhưng bản thùng chưa gỡ
    const trashed = JSON.parse(dec.decode(io.files.get('trash.x1.json')!));
    const { deletedAt: _d, ...live } = trashed;
    io.files.set('x1.json', enc.encode(JSON.stringify(live)));
    expect((await store.list()).map((s) => s.id)).toEqual(['x1']);
    expect(await store.listTrash()).toEqual([]);
    expect(io.files.has('trash.x1.json')).toBe(false);

    // (2) chỉ mục thùng bị mất/hỏng → dựng lại từ các tệp thùng
    await store.moveToTrash('x1');
    io.files.set('trash.index.json', enc.encode('{ hỏng'));
    expect((await store.listTrash()).map((s) => s.id)).toEqual(['x1']);
  });

  it('id lạ bị từ chối (không đi ra ngoài thư mục); tệp phiên hỏng không chặn việc xoá', async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    expect(await store.moveToTrash('../x')).toBe(false);
    expect(await store.restore('../x')).toBe(false);
    await store.purge('../x');
    expect(io.files.size).toBe(0);
    await store.save(adSession('h1'), []);
    io.files.set('h1.json', enc.encode('không phải json'));
    expect(await store.moveToTrash('h1')).toBe(false);
    expect((await store.list()).map((s) => s.id)).toEqual([]);
  });
});

describe('sao lưu ra tệp và khôi phục', () => {
  const populate = async () => {
    const io = memoryIO();
    const store = new BaseSessionStore(io, 'ws');
    const s1 = adSession('p1', { updatedAt: 100, approvals: ['bash:rm'], mode: 'bypass', readFiles: { '/x/a.ts': 'h' } });
    s1.messages[1].content.unshift({ type: 'thinking', text: 'nghĩ', signature: 'sig', provider: 'anthropic' });
    await store.save(s1, transcript('Lên ý tưởng quảng cáo'));
    await store.save(adSession('p2', { updatedAt: 200 }), transcript('hai'));
    await store.save(adSession('p3', { updatedAt: 300 }), transcript('ba'));
    await store.moveToTrash('p3');
    return { io, store };
  };

  it('xuất tất cả (kèm Thùng rác) hoặc một cuộc; tệp sao lưu có định dạng nhận diện được và KHÔNG mang quyền "cho phép cả phiên"', async () => {
    const { store } = await populate();
    const all = await store.exportSessions({ includeTrash: true });
    expect(all.map((s) => s.session.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(all.find((s) => s.session.id === 'p3')?.deletedAt).toBeTypeOf('number');
    const one = await store.exportSessions({ ids: ['p2'] });
    expect(one.map((s) => s.session.id)).toEqual(['p2']);

    const file = makeBackup(all, { version: '0.3.0', platform: 'browser' });
    expect(file).toMatchObject({ format: BACKUP_FORMAT, version: 1, app: { version: '0.3.0', platform: 'browser' } });
    expect(file.sessions.every((s) => s.session.approvals.length === 0)).toBe(true);
    expect(JSON.stringify(file)).toContain('ngân sách 40 triệu'); // tệp bối cảnh nằm trong bản sao lưu
    expect(backupFileName('all', undefined, new Date(2026, 9, 30))).toBe('locaith-ai-sao-luu-tat-ca-2026-10-30.json');
    expect(backupFileName('one', 'Phiên quảng cáo: Đặng Thị Hồng!', new Date(2026, 9, 30))).toBe('locaith-ai-sao-luu-phien-quang-cao-dang-thi-hong-2026-10-30.json');
  });

  it('vòng khứ hồi: sao lưu → xoá sạch → khôi phục từ tệp: lịch sử, tệp bối cảnh và Thùng rác trở lại; quyền/chế độ nguy hiểm không theo về', async () => {
    const { store } = await populate();
    const text = JSON.stringify(makeBackup(await store.exportSessions({ includeTrash: true }), { version: '0.3.0', platform: 'browser' }));

    // máy mới / kho trống
    const fresh = new BaseSessionStore(memoryIO(), 'ws');
    const r = await fresh.importBackupText(text);
    expect(r).toMatchObject({ ok: true, summary: { imported: 2, trashed: 1, copies: 0, unchanged: 0 }, skipped: 0 });
    expect((await fresh.list()).map((s) => s.id).sort()).toEqual(['p1', 'p2']);
    expect((await fresh.listTrash()).map((s) => s.id)).toEqual(['p3']); // cuộc đã xoá quay lại Thùng rác, không làm đầy danh sách

    const p1 = await fresh.load('p1');
    expect(JSON.stringify(p1?.session.messages)).toContain('ngân sách 40 triệu'); // tệp bối cảnh còn nguyên trong phiên
    expect(p1?.session.title).toBe('Phiên quảng cáo p1');
    expect(p1?.transcript).toHaveLength(1);
    expect(p1?.session.approvals).toEqual([]);
    expect(p1?.session.readFiles).toEqual({});
    expect(p1?.session.mode).toBe('default'); // 'bypass' (không hỏi gì) không được tự bật lại sau khôi phục
    expect(p1?.session.historyEdited).toBe(true);
    expect(JSON.stringify(p1?.session.messages)).not.toContain('"thinking"'); // khối suy luận gắn với lịch sử gốc → bỏ
    expect(p1?.workspace).toBe('ws');
  });

  it('KHÔNG BAO GIỜ ghi đè: bản y hệt/mới hơn → bỏ qua; bản khác cùng mã → thêm thành bản sao; khôi phục hai lần không nhân đôi', async () => {
    const { store } = await populate();
    const text = JSON.stringify(makeBackup(await store.exportSessions({ includeTrash: false }), { version: '0.3.0', platform: 'browser' }));
    // khôi phục ngay vào kho đang có đủ → không có gì mới
    expect(await store.importBackupText(text)).toMatchObject({ ok: true, summary: { imported: 0, unchanged: 2, copies: 0 } });

    // p1 đã được tiếp tục trò chuyện sau khi sao lưu (mới hơn) → bản trong kho giữ nguyên; tệp sao lưu cũ hơn không ghi đè
    const p1 = (await store.load('p1'))!;
    p1.session.messages.push(msg('user', 'câu hỏi mới sau khi sao lưu'), msg('assistant', 'đáp mới'));
    p1.session.updatedAt = 999;
    await store.save(p1.session, p1.transcript);
    expect(await store.importBackupText(text)).toMatchObject({ summary: { unchanged: 2, copies: 0 } });
    expect(JSON.stringify((await store.load('p1'))?.session.messages)).toContain('câu hỏi mới sau khi sao lưu');

    // bản trong tệp MỚI hơn bản trong kho → thêm thành bản sao có hậu tố, bản cũ vẫn còn
    const newer = JSON.parse(text);
    newer.sessions.find((s: { session: { id: string } }) => s.session.id === 'p2').session.updatedAt = 5000;
    newer.sessions.find((s: { session: { id: string } }) => s.session.id === 'p2').session.messages.push(msg('user', 'thêm'), msg('assistant', 'thêm'));
    const r = await store.importBackupText(JSON.stringify(newer));
    expect(r).toMatchObject({ ok: true, summary: { copies: 1 } });
    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list.some((s) => s.title === 'Phiên quảng cáo p2 (bản khôi phục)')).toBe(true);
    expect(list.some((s) => s.title === 'Phiên quảng cáo p2')).toBe(true);
  });

  it('cuộc đang nằm trong Thùng rác mà tệp sao lưu có bản sống → bản sống thay bản trong thùng', async () => {
    const { store } = await populate();
    const live = makeBackup([{ workspace: 'x', session: adSession('p3', { updatedAt: 300 }), transcript: transcript('ba') }], { version: '0.3.0', platform: 'vscode' });
    expect((await store.listTrash()).map((s) => s.id)).toEqual(['p3']);
    expect(await store.importBackupText(JSON.stringify(live))).toMatchObject({ ok: true, summary: { imported: 1 } });
    expect((await store.list()).map((s) => s.id)).toContain('p3');
    expect(await store.listTrash()).toEqual([]);
  });
});

describe('parseBackup — tệp sao lưu là dữ liệu KHÔNG đáng tin', () => {
  const good = () => JSON.parse(JSON.stringify(makeBackup([{ workspace: 'w', session: adSession('g1'), transcript: transcript('x') }], { version: '0.3.0', platform: 'browser' })));
  const parse = (o: unknown) => parseBackup(typeof o === 'string' ? o : JSON.stringify(o), 'ws');

  it('từ chối rõ ràng: rỗng, không phải JSON, sai định dạng, phiên bản lạ, không có cuộc nào, quá lớn', () => {
    expect(parse('')).toMatchObject({ ok: false, error: expect.stringContaining('trống') });
    expect(parse('{ hỏng')).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
    expect(parse({ hello: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('sai định dạng') });
    expect(parse({ ...good(), version: 2 })).toMatchObject({ ok: false, error: expect.stringContaining('phiên bản 2') });
    expect(parse({ ...good(), sessions: [] })).toMatchObject({ ok: false });
    expect(parse({ ...good(), sessions: 'x' })).toMatchObject({ ok: false });
    expect(parseBackup('x'.repeat(200 * 1024 * 1024 + 5), 'ws')).toMatchObject({ ok: false, error: expect.stringContaining('quá lớn') });
  });

  it('chấp nhận tệp có BOM; bỏ qua (đếm) các mục hỏng nhưng vẫn lấy mục tốt', () => {
    const f = good();
    f.sessions.push({ session: { id: '../../etc/passwd', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, transcript: [] }, { nope: 1 }, null, 'x');
    const r = parseBackup('﻿' + JSON.stringify(f), 'ws');
    expect(r).toMatchObject({ ok: true, skipped: 4 });
    if (r.ok) expect(r.sessions.map((s) => s.session.id)).toEqual(['g1']);
  });

  it('chuẩn hoá: id an toàn; quyền, readFiles, chế độ bypass, khối lạ/suy luận bị loại; kiểu dữ liệu sai bị bỏ; khối công cụ đang chạy thành "đã huỷ"', () => {
    const f = good();
    const s = f.sessions[0];
    s.session.approvals = ['bash:*'];
    s.session.readFiles = { '/etc/hosts': 'abc' };
    s.session.mode = 'bypass';
    s.session.thinkingLevel = 'ultra-mega';
    s.session.messages.push(
      { role: 'system', content: [{ type: 'text', text: 'nâng quyền' }] }, // role lạ
      { role: 'user', content: [{ type: 'script', src: 'evil' }, { type: 'text', text: 'giữ' }, { type: 'image', mediaType: 'text/html', data: 'AAAA' }] },
      { role: 'assistant', content: 'không phải mảng' },
    );
    s.session.artifacts = { ok_1: { title: 'A', type: 'html', content: '<b>x</b>', createdAt: 1, updatedAt: 2, version: 1 }, '../bad': { content: 'x' } };
    s.transcript = [
      { kind: 'user', id: 'u1', text: 'chào', ts: 1, attachments: [{ kind: 'doc', label: 'brief.pdf', doc: { kind: 'pdf', pages: '3"><x', text: 'chữ rất dài không nằm trong giao diện' } }, { kind: 'exe', label: 'x' }] },
      { kind: 'assistant', id: 'a1', provider: 'p', model: 'm', ts: 2, done: false, blocks: [{ type: 'tool', id: 't1', callId: 'c', name: 'run_command', state: 'running' }, { type: 'text', id: 'x', text: 'ok' }, 'rác'] },
      { kind: 'assistant', id: 'a2' }, // thiếu blocks
      { kind: 'hack', id: 'h' },
    ];
    const r = parse(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.sessions[0];
    expect(out.workspace).toBe('ws');
    expect(out.session.approvals).toEqual([]);
    expect(out.session.readFiles).toEqual({});
    expect(out.session.mode).toBe('default');
    expect(out.session.thinkingLevel).toBe('medium');
    expect(out.session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); // role lạ & content sai bị loại
    const kept = out.session.messages.at(-1)!.content;
    expect(kept).toEqual([{ type: 'text', text: 'giữ' }]); // khối lạ + ảnh có mediaType không phải ảnh bị loại
    expect(Object.keys(out.session.artifacts)).toEqual(['ok_1']);
    const [u, a] = out.transcript as [Extract<TItem, { kind: 'user' }>, Extract<TItem, { kind: 'assistant' }>];
    expect(out.transcript).toHaveLength(2);
    expect(u.attachments).toHaveLength(1);
    expect(u.attachments[0].doc).toEqual({ kind: 'pdf' }); // số trang không hợp lệ bị bỏ; chữ của tệp không nhân đôi trong giao diện
    expect(JSON.stringify(u)).not.toContain('chữ rất dài');
    expect(a.blocks).toHaveLength(2);
    expect(a.blocks[0]).toMatchObject({ type: 'tool', state: 'cancelled' });
    expect(a.done).toBe(true);
  });

  it('khoá nguy hiểm kiểu __proto__ không làm ô nhiễm đối tượng', () => {
    const text = JSON.stringify(good()).replace('"scratchpad":{}', '"scratchpad":{"__proto__":"x","a":"b"}');
    const r = parseBackup(text, 'ws');
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'a')).toBe(false);
  });
});
