// (lane:ide-context) @tệp#L10-20, @problems, chip vùng chọn, ngữ cảnh editor: parser, giải mã nội dung, phạm vi, chống traversal.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSession } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import type { DiagnosticItem } from '../src/core/ide/diagnostics';
import { filterDiagnostics } from '../src/core/ide/diagnostics';
import {
  applyLineMentions,
  hasProblemsMention,
  keepableFrag,
  lineLabel,
  lineMentionSig,
  MAX_LINE_MENTIONS,
  MAX_MENTION_LINES,
  parseLineMentions,
  selectionLineRange,
  splitMentionQuery,
} from '../src/shared/lineMentions';
import type { AttachmentInfo } from '../src/shared/protocol';
import { buildUserContent } from '../src/host/userContent';
import { parseFileRef } from '../webview/src/text';
import { makeWorkspace } from './helpers/harness';

const lines = (n: number, prefix = 'dòng') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('parseLineMentions', () => {
  it('nhận #L10, #L10-20, #L10-L20; đảo ngược khoảng; chặn số 0', () => {
    const ms = parseLineMentions('xem @src/a.ts#L10-20 và @b.md#L7, rồi @c.ts#L30-L25 với @d.ts#L0.');
    expect(ms.map((m) => [m.path, m.start, m.end])).toEqual([
      ['src/a.ts', 10, 20],
      ['b.md', 7, 7],
      ['c.ts', 25, 30],
      ['d.ts', 1, 1],
    ]);
    expect(ms[0].raw).toBe('@src/a.ts#L10-20');
    expect(parseLineMentions('@c.ts#L30-L25')[0].raw).toBe('@c.ts#L30-L25');
  });
  it('không nhận email, #L không có số, đường dẫn thiếu @ ở đầu từ, hay chữ dính liền', () => {
    expect(parseLineMentions('mail me@x.com#L3')).toEqual([]);
    expect(parseLineMentions('@a.ts#Lx @a.ts# @a.ts#L10abc')).toEqual([]);
    expect(parseLineMentions('')).toEqual([]);
  });
  it('có trần số mention trong một tin', () => {
    const text = Array.from({ length: MAX_LINE_MENTIONS + 10 }, (_, i) => `@f${i}.ts#L1`).join(' ');
    expect(parseLineMentions(text)).toHaveLength(MAX_LINE_MENTIONS);
  });
  it('hasProblemsMention: chỉ @problems đứng riêng một từ', () => {
    expect(hasProblemsMention('sửa hết @problems giúp')).toBe(true);
    expect(hasProblemsMention('@problems')).toBe(true);
    expect(hasProblemsMention('@problemsolver')).toBe(false);
    expect(hasProblemsMention('a@problems')).toBe(false);
  });
  it('splitMentionQuery + keepableFrag: giữ phần #L đang gõ dở, bỏ phần rác', () => {
    expect(splitMentionQuery('src/a.ts#L10-2')).toEqual({ path: 'src/a.ts', frag: '#L10-2' });
    expect(splitMentionQuery('src/a.ts')).toEqual({ path: 'src/a.ts', frag: '' });
    for (const ok of ['#', '#L', '#L12', '#L12-', '#L12-30', '#L12-L3']) expect(keepableFrag(ok)).toBe(ok);
    for (const bad of ['#x', '#L1x', 'L12', '#L12-30-4']) expect(keepableFrag(bad)).toBe('');
  });
  it('selectionLineRange: bôi trọn dòng (kết thúc ở cột 0 dòng kế) không đếm thừa dòng', () => {
    expect(selectionLineRange(4, 9, 7)).toEqual([5, 10]);
    expect(selectionLineRange(4, 9, 0)).toEqual([5, 9]);
    expect(selectionLineRange(4, 4, 0)).toEqual([5, 5]);
  });
});

describe('applyLineMentions — chip', () => {
  const file: AttachmentInfo = { kind: 'file', label: 'a.ts', path: 'src/a.ts' };
  it('chip tệp + @tệp#L10-20 → chip vùng chọn «a.ts:10-20» (giữ vị trí, không nhân đôi)', () => {
    const out = applyLineMentions('đọc @src/a.ts#L10-20 đi', [file, { kind: 'folder', label: 'docs', path: 'docs' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'selection', label: 'a.ts:10-20', path: 'src/a.ts', range: [10, 20] });
    expect(out[1].kind).toBe('folder');
    // gọi lại trên kết quả: không thêm chip thứ hai
    expect(applyLineMentions('đọc @src/a.ts#L10-20 đi', out)).toHaveLength(2);
  });
  it('một dòng → «a.ts:7»; khác dấu \\ và / vẫn khớp; không có mention → trả bản sao nguyên', () => {
    expect(lineLabel('src/a.ts', 7, 7)).toBe('a.ts:7');
    expect(applyLineMentions('@src\\a.ts#L7', [file])[0].label).toBe('a.ts:7');
    const same = applyLineMentions('không có gì', [file]);
    expect(same).toEqual([file]);
    expect(same[0]).toBe(file);
  });
  it('addMissing thêm chip cho mention chỉ có chữ; mặc định thì không', () => {
    expect(applyLineMentions('@x.ts#L3-4', [])).toEqual([]);
    expect(applyLineMentions('@x.ts#L3-4', [], { addMissing: true })).toEqual([{ kind: 'selection', label: 'x.ts:3-4', path: 'x.ts', range: [3, 4] }]);
  });
  it('lineMentionSig đổi khi khoảng dòng đổi, không đổi khi chữ khác đổi', () => {
    expect(lineMentionSig('a @f.ts#L1-2 b')).toBe(lineMentionSig('khác hẳn @f.ts#L1-2'));
    expect(lineMentionSig('@f.ts#L1-2')).not.toBe(lineMentionSig('@f.ts#L1-3'));
  });
});

describe('buildUserContent — giải mã mention khoảng dòng', () => {
  const setup = (files: Record<string, string>, diag?: DiagnosticItem[]) => {
    const dir = makeWorkspace(files);
    const host = new NodeToolHost({ roots: [dir] });
    if (diag) (host as unknown as { diagnostics: unknown }).diagnostics = async (q: Parameters<typeof filterDiagnostics>[1]) => filterDiagnostics(diag, q);
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    return { dir, host, session };
  };
  const body = (r: Awaited<ReturnType<typeof buildUserContent>>) => (r.content.at(-1) as { text: string }).text;

  it('chip vùng chọn → nội dung có số dòng đúng khoảng, không kèm phần còn lại của tệp', async () => {
    const { host, session } = setup({ 'src/a.ts': lines(30) });
    const r = await buildUserContent({
      text: 'xem @src/a.ts#L10-12',
      attachments: [{ kind: 'file', label: 'a.ts', path: 'src/a.ts' }],
      host,
      session,
      editor: null,
    });
    const t = body(r);
    expect(t).toContain('<attached_selection path="src/a.ts" lines="10-12">');
    expect(t).toMatch(/\s+10\tdòng 10\n\s+11\tdòng 11\n\s+12\tdòng 12\n<\/attached_selection>/);
    expect(t).not.toContain('dòng 13');
    expect(t).not.toContain('<attached_file');
    expect(r.display[0]).toMatchObject({ kind: 'selection', range: [10, 12] });
    expect(r.warnings).toEqual([]);
  });

  it('tin chỉ có chữ (Remote/Chrome): mention vẫn được giải mã; #L5 một dòng', async () => {
    const { host, session } = setup({ 'src/a.ts': lines(10) });
    const r = await buildUserContent({ text: 'giải thích @src/a.ts#L5', attachments: [], host, session, editor: null });
    expect(body(r)).toContain('<attached_selection path="src/a.ts" lines="5-5">');
    expect(body(r)).toMatch(/\s5\tdòng 5\n<\/attached_selection>/);
  });

  it('dòng bắt đầu ngoài tệp → cảnh báo rõ, KHÔNG đính kèm; dòng kết thúc vượt tệp → cắt về cuối tệp', async () => {
    const { host, session } = setup({ 'a.ts': lines(5) });
    const bad = await buildUserContent({ text: '@a.ts#L9-12', attachments: [], host, session, editor: null });
    expect(body(bad)).not.toContain('<attached_selection');
    expect(bad.warnings[0]).toContain('dòng 9');
    expect(bad.warnings[0]).toContain('5 dòng');
    const clipped = await buildUserContent({ text: '@a.ts#L4-99', attachments: [], host, session, editor: null });
    expect(body(clipped)).toContain('lines="4-5"');
    expect(clipped.warnings).toEqual([]);
  });

  it('tệp có dòng cuối trống do xuống dòng không bị tính là một dòng', async () => {
    const { host, session } = setup({ 'a.ts': 'x\ny\n' });
    const r = await buildUserContent({ text: '@a.ts#L3', attachments: [], host, session, editor: null });
    expect(r.warnings[0]).toContain('2 dòng');
  });

  it('trần số dòng: kéo khoảng quá lớn bị cắt và có ghi chú đọc tiếp', async () => {
    const { host, session } = setup({ 'big.txt': lines(MAX_MENTION_LINES + 500, 'x') });
    const r = await buildUserContent({ text: `@big.txt#L1-${MAX_MENTION_LINES + 400}`, attachments: [], host, session, editor: null });
    const t = body(r);
    expect(t).toContain(`lines="1-${MAX_MENTION_LINES}"`);
    expect(t).toContain(`offset=${MAX_MENTION_LINES + 1}`);
    expect(t).not.toContain(`x ${MAX_MENTION_LINES + 1}\n`);
  });

  it('chống traversal: đường dẫn ra ngoài workspace không được đọc (cả từ chữ lẫn từ chip)', async () => {
    const { dir, host, session } = setup({ 'a.ts': 'ok\n' });
    const outside = path.resolve(dir, '..', 'secret-outside.txt');
    const r1 = await buildUserContent({ text: '@../secret-outside.txt#L1 và @../../etc/passwd#L1-3', attachments: [], host, session, editor: null });
    expect(body(r1)).not.toContain('<attached_selection');
    expect(r1.warnings.length).toBeGreaterThan(0);
    const r2 = await buildUserContent({
      text: 'x',
      attachments: [{ kind: 'selection', label: 'o', path: outside, range: [1, 1] }],
      host,
      session,
      editor: null,
    });
    expect(body(r2)).not.toContain('<attached_selection');
  });

  it('mention chỉ-có-chữ trỏ vào tệp bí mật (.env) không tự đính kèm', async () => {
    const { host, session } = setup({ '.env': 'API_KEY=abc123\n', 'a.ts': 'ok\n' });
    const r = await buildUserContent({ text: '@.env#L1 và @a.ts#L1', attachments: [], host, session, editor: null });
    expect(body(r)).not.toContain('abc123');
    expect(body(r)).toContain('<attached_selection path="a.ts" lines="1-1">');
    expect(r.warnings.some((w) => w.includes('bí mật'))).toBe(true);
  });

  it('@problems đính kèm chẩn đoán hiện tại; host không có IDE → cảnh báo, không đính kèm', async () => {
    const dir = makeWorkspace({ 'a.ts': 'x\n' });
    const diag: DiagnosticItem[] = [{ abs: path.join(dir, 'a.ts'), rel: 'a.ts', line: 3, column: 2, severity: 'error', source: 'ts', code: '2304', message: 'Cannot find name q.' }];
    const ide = new NodeToolHost({ roots: [dir] });
    (ide as unknown as { diagnostics: unknown }).diagnostics = async (q: Parameters<typeof filterDiagnostics>[1]) => filterDiagnostics(diag, q);
    const session = newSession({ id: 's', provider: 'p', model: 'm' });
    const r = await buildUserContent({ text: 'sửa @problems', attachments: [], host: ide, session, editor: null });
    expect(body(r)).toContain('<attached_problems>');
    expect(body(r)).toContain('a.ts:3:2 error [ts 2304] Cannot find name q.');
    const plain = new NodeToolHost({ roots: [dir] });
    const r2 = await buildUserContent({ text: 'sửa @problems', attachments: [], host: plain, session, editor: null });
    expect(body(r2)).not.toContain('<attached_problems>');
    expect(r2.warnings[0]).toContain('@problems');
    // không nhắc @problems → không gọi diagnostics
    let called = 0;
    (ide as unknown as { diagnostics: unknown }).diagnostics = async () => {
      called++;
      return { items: [], total: 0 };
    };
    await buildUserContent({ text: 'không nhắc gì', attachments: [], host: ide, session, editor: null });
    expect(called).toBe(0);
  });

  it('ngữ cảnh editor: bật thì gửi tệp + vùng chọn; tắt (off) thì không gửi gì', async () => {
    const { host, session } = setup({ 'src/a.ts': lines(5) });
    const editor = { file: 'src/a.ts', language: 'typescript', selection: { startLine: 2, endLine: 3, chars: 14 } };
    const on = await buildUserContent({ text: 'hi', attachments: [], host, session, editor, editorSelectionText: 'dòng 2\ndòng 3' });
    expect(body(on)).toContain('Active file in the editor: src/a.ts');
    expect(body(on)).toContain('Selected lines: 2-3');
    expect(body(on)).toContain('Selected text:');
    const off = await buildUserContent({ text: 'hi', attachments: [], host, session, editor: { ...editor, off: true }, editorSelectionText: 'dòng 2\ndòng 3' });
    expect(body(off)).not.toContain('ide_context');
    expect(body(off)).not.toContain('dòng 2');
    expect(body(off).trim()).toBe('hi');
  });
});

describe('parseFileRef — mở đúng dòng', () => {
  it('đường dẫn:dòng, :dòng:cột, :dòng-dòng, #L10-L20, có dấu cách', () => {
    expect(parseFileRef('src/a.ts:10-20')).toEqual({ path: 'src/a.ts', line: 10 });
    expect(parseFileRef('src/a.ts:10–20')).toEqual({ path: 'src/a.ts', line: 10 });
    expect(parseFileRef('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(parseFileRef('docs/Bản giao 2026.md:12-14')).toEqual({ path: 'docs/Bản giao 2026.md', line: 12 });
    expect(parseFileRef('C:\\ws\\Tài liệu\\a b.ts:7:2')).toEqual({ path: 'C:\\ws\\Tài liệu\\a b.ts', line: 7 });
    expect(parseFileRef('a.ts#L3')).toEqual({ path: 'a.ts', line: 3 });
  });
});

describe('/problems', () => {
  it('đăng ký lệnh, in báo cáo chẩn đoán vào khung chat, không cần trợ lý rảnh', async () => {
    const { SlashRegistry } = await import('../src/host/slashRegistry');
    const { registerIdeSlash } = await import('../src/host/ideSlash');
    const reg = new SlashRegistry();
    const items: DiagnosticItem[] = [{ abs: '/ws/a.ts', rel: 'a.ts', line: 2, column: 4, severity: 'error', message: 'boom' }];
    registerIdeSlash(reg, { diagnostics: async (q) => filterDiagnostics(items, q) });
    const cmd = reg.get('problems')!;
    expect(cmd.needsIdle).toBe(false);
    const out: string[] = [];
    await cmd.run({ args: '', lang: 'vi', info: (s) => out.push(s), warn: (s) => out.push('W:' + s), runPrompt: async () => {}, busy: false });
    expect(out[0]).toContain('a.ts:2:4 error boom');
    const fail = new SlashRegistry();
    registerIdeSlash(fail, { diagnostics: async () => Promise.reject(new Error('x')) });
    const out2: string[] = [];
    await fail.get('problems')!.run({ args: '', lang: 'en', info: (s) => out2.push(s), warn: (s) => out2.push('W:' + s), runPrompt: async () => {}, busy: false });
    expect(out2[0]).toMatch(/^W:@problems only works/);
  });
});
