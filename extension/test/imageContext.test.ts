import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_IMAGES_IN_CONTEXT, IMAGE_TRIMMED_NOTE, countContextImages, limitImagesInContext } from '../src/core/engine/imageContext';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import type { ChatMessage, ContentBlock } from '../src/core/types';
import { textTurn } from './helpers/fakeProvider';
import { makeHarness } from './helpers/harness';

/** (0.7.2) Ảnh cũ ngoài N ảnh gần nhất → dòng chữ TRONG BẢN GỬI; lịch sử lưu giữ nguyên; cặp tool_use/tool_result không vỡ. */
const NOTE = IMAGE_TRIMMED_NOTE.vi;
const img = (tag: string): ContentBlock => ({ type: 'image', mediaType: 'image/png', data: `data-${tag}` });
const userImg = (tag: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: `ảnh ${tag}` }, img(tag)] });
const asst = (text: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolUse = (id: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'screenshot', input: {} }] });
const toolRes = (id: string, tags: string[]): ChatMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, name: 'screenshot', content: `chụp ${id}`, images: tags.map((t) => ({ type: 'image', mediaType: 'image/png', data: `data-${t}` })) }],
});
const imagesOf = (ms: readonly ChatMessage[]): string[] =>
  ms.flatMap((m) => m.content).flatMap((b) => (b.type === 'image' ? [b.data] : b.type === 'tool_result' ? (b.images ?? []).map((i) => i.data) : []));

describe('limitImagesInContext', () => {
  it('mặc định 8; không vượt ngưỡng → trả đúng mảng gốc (không sao chép)', () => {
    expect(DEFAULT_MAX_IMAGES_IN_CONTEXT).toBe(8);
    expect(DEFAULT_ENGINE_SETTINGS.maxImagesInContext).toBe(8);
    const msgs = [userImg('1'), asst('ok'), userImg('2')];
    expect(limitImagesInContext(msgs, 8)).toBe(msgs);
    expect(limitImagesInContext(msgs, 2)).toBe(msgs);
  });

  it('0 / không phải số = không giới hạn', () => {
    const msgs = [userImg('1'), userImg('2'), userImg('3')];
    expect(limitImagesInContext(msgs, 0)).toBe(msgs);
    expect(limitImagesInContext(msgs, undefined)).toBe(msgs);
    expect(limitImagesInContext(msgs, Number.NaN)).toBe(msgs);
  });

  it('giữ N ảnh GẦN NHẤT, ảnh cũ hơn thành dòng chữ; không sửa tin gốc', () => {
    const msgs = [userImg('1'), asst('a'), userImg('2'), asst('b'), userImg('3'), asst('c'), userImg('4')];
    const snapshot = JSON.stringify(msgs);
    const out = limitImagesInContext(msgs, 2);
    expect(imagesOf(out)).toEqual(['data-3', 'data-4']);
    expect(out[0].content[1]).toEqual({ type: 'text', text: NOTE });
    expect(out[2].content[1]).toEqual({ type: 'text', text: NOTE });
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(JSON.stringify(msgs)).toBe(snapshot); // lịch sử lưu giữ nguyên
    expect(countContextImages(msgs)).toBe(4);
  });

  it('kết quả công cụ có ảnh: bỏ ảnh, giữ chữ, thêm dòng báo; cặp tool_use ↔ tool_result còn nguyên id', () => {
    const msgs = [userImg('u1'), toolUse('t1'), toolRes('t1', ['a', 'b']), toolUse('t2'), toolRes('t2', ['c']), asst('xong'), userImg('u2')];
    const out = limitImagesInContext(msgs, 2);
    expect(imagesOf(out)).toEqual(['data-c', 'data-u2']);
    const r1 = out[2].content[0];
    expect(r1.type).toBe('tool_result');
    if (r1.type === 'tool_result') {
      expect(r1.toolUseId).toBe('t1');
      expect(r1.images).toBeUndefined();
      expect(r1.content).toContain('chụp t1');
      expect(r1.content).toContain(NOTE);
    }
    // mọi tool_result vẫn đi sau tool_use cùng id
    const uses = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    const results = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b as { toolUseId: string }).toolUseId);
    expect(results).toEqual(uses);
  });

  it('ranh giới đúng giữa một kết quả nhiều ảnh: bỏ vài ảnh đầu, giữ phần còn lại của CÙNG kết quả', () => {
    const msgs = [toolUse('t1'), toolRes('t1', ['a', 'b', 'c', 'd'])];
    const out = limitImagesInContext(msgs, 3);
    expect(imagesOf(out)).toEqual(['data-b', 'data-c', 'data-d']);
    const r = out[1].content[0];
    if (r.type === 'tool_result') expect(r.images).toHaveLength(3);
  });

  it('bản tiếng Anh dùng câu tiếng Anh; ảnh không thuộc tin nào khác bị đụng', () => {
    const out = limitImagesInContext([userImg('1'), userImg('2')], 1, 'en');
    expect(out[0].content[1]).toEqual({ type: 'text', text: IMAGE_TRIMMED_NOTE.en });
    expect(out[1].content[1]).toMatchObject({ type: 'image' });
  });
});

describe('engine: bản gửi model được lược, lịch sử lưu thì không', () => {
  it('có 5 ảnh, maxImagesInContext = 2 → provider chỉ nhận 2 ảnh; session.messages vẫn đủ 5 ảnh', async () => {
    const h = makeHarness([() => textTurn('đã xem')], { settings: { maxImagesInContext: 2 } });
    for (const t of ['1', '2', '3', '4']) {
      h.session.messages.push(userImg(t), asst('ok'));
    }
    const r = await h.engine.run({ session: h.session, content: [{ type: 'text', text: 'ảnh cuối' }, img('5')], signal: new AbortController().signal });
    expect(r.stopReason).toBeDefined();
    const sent = h.provider.requests[0].messages;
    expect(imagesOf(sent)).toEqual(['data-4', 'data-5']);
    expect(imagesOf(h.session.messages)).toEqual(['data-1', 'data-2', 'data-3', 'data-4', 'data-5']);
  });
});
