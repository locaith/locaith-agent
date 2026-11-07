import { describe, expect, it } from 'vitest';
import constitution from '../src/core/prompts/constitution.md';
import { offerOptionsTool } from '../src/core/tools/meta';
import { newSession } from '../src/core/engine/types';
import type { ToolContext } from '../src/core/engine/types';
import { eventsOf, makeHarness } from './helpers/harness';
import { textTurn, toolTurn } from './helpers/fakeProvider';

/**
 * `offer_options` là câu hỏi LÀM RÕ ở ĐẦU việc — không phải menu «làm gì tiếp» sau khi đã xong.
 * Bộ luật này giữ đúng ý chủ dự án: mơ hồ thì hỏi một lần rồi dừng; rõ ràng thì tự quyết và làm trọn.
 */
describe('offer_options — hỏi lúc bắt đầu, không phải đề xuất sau khi xong', () => {
  it('mô tả công cụ nói rõ: dùng TRƯỚC khi làm, và KHÔNG dùng sau khi xong', () => {
    const d = offerOptionsTool.description;
    expect(d).toMatch(/BEFORE you start/i);
    expect(d).toMatch(/NEVER call this after/i);
    expect(d).toMatch(/STOP/i);
    // phải nêu rõ phương án tự quyết khi không thật sự mơ hồ
    expect(d).toMatch(/state the assumption/i);
  });

  it('bộ luật: hỏi ở đầu, dừng lại chờ chọn, và không trả việc đã xong kèm câu hỏi', () => {
    expect(constitution).toMatch(/Clarify at the START/);
    expect(constitution).toMatch(/Never hand the finished work back with a question/);
    expect(constitution).toMatch(/No "what next\?" buttons/);
    // không còn luật cũ "End with a button" (đã bị thay)
    expect(constitution).not.toMatch(/End with a button, not a paragraph/);
  });

  it('công cụ: gắn lựa chọn vào phiên, phát sự kiện `options`, và trả lời "DỪNG Ở ĐÂY"', async () => {
    const session = newSession({ id: 's1', provider: 'fake', model: 'm' });
    const events: unknown[] = [];
    const ctx = {
      signal: new AbortController().signal,
      session,
      emit: (ev: unknown) => events.push(ev),
      progress: () => undefined,
      log: () => undefined,
      host: {},
      callId: 'c1',
      assistantId: 'a1',
    } as unknown as ToolContext;

    const r = await offerOptionsTool.execute(
      {
        options: [
          { label: 'Bản đầy đủ', prompt: 'Viết skill.md đầy đủ rồi kiểm thử.' },
          { label: 'Bản gọn', prompt: 'Viết skill.md gọn 120 dòng.' },
        ],
      },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('DỪNG Ở ĐÂY');
    expect(session.options?.map((o) => o.label)).toEqual(['Bản đầy đủ', 'Bản gọn']);
    expect(events.some((e) => (e as { t: string }).t === 'options')).toBe(true);
  });

  it('engine DỪNG lượt ngay sau khi hỏi — không tự làm tiếp theo một cách hiểu chưa được chọn', async () => {
    const h = makeHarness([
      () =>
        toolTurn([{ id: 'c1', name: 'offer_options', input: { options: [{ label: 'A', prompt: 'Làm A' }, { label: 'B', prompt: 'Làm B' }] } }]),
      // Nếu engine chạy tiếp, lượt thứ 2 này sẽ được dùng và lượt chạy sẽ có 2 vòng.
      () => textTurn('Đã làm theo cách hiểu A.'),
    ]);
    const r = await h.run('làm cái gì đó mơ hồ');
    expect(r.stopReason).toBe('end_turn');
    expect(r.turns).toBe(1);
    expect(h.session.options?.map((o) => o.label)).toEqual(['A', 'B']);
    expect(eventsOf(h.events, 'options')).toHaveLength(1);
  }, 20_000);

  it('lượt sau: người dùng bấm chọn → lựa chọn cũ bị thu hồi và việc được làm trọn', async () => {
    const h = makeHarness([
      () => toolTurn([{ id: 'c1', name: 'offer_options', input: { options: [{ label: 'A', prompt: 'Làm A' }, { label: 'B', prompt: 'Làm B' }] } }]),
      () => textTurn('Xong A.'),
    ]);
    await h.run('mơ hồ');
    expect(h.session.options).toBeDefined();
    const r2 = await h.run('Làm A');
    expect(r2.stopReason).toBe('end_turn');
    // Nút của lượt trước phải biến mất khi bắt đầu lượt mới.
    expect(eventsOf(h.events, 'options').at(-1)?.options).toEqual([]);
    expect(h.session.options).toBeUndefined();
  }, 20_000);

  it('ĐÃ sửa tệp rồi thì KHÔNG được hỏi nữa: offer_options bị chặn và mô hình được yêu cầu làm nốt', async () => {
    const h = makeHarness([
      () => toolTurn([{ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'x' } }]),
      () => toolTurn([{ id: 'c2', name: 'offer_options', input: { options: [{ label: 'A', prompt: 'Làm A' }, { label: 'B', prompt: 'Làm B' }] } }]),
      () => textTurn('Đã xong.'),
      () => textTurn('Đã xong và đã kiểm chứng.'),
    ]);
    const r = await h.run('viết tệp a.txt rồi làm nốt');
    expect(r.stopReason).toBe('end_turn');
    // Nút không được tạo ra; công cụ bị chặn kèm lý do rõ ràng.
    expect(h.session.options).toBeUndefined();
    expect(eventsOf(h.events, 'options')).toHaveLength(0);
    const blocked = eventsOf(h.events, 'tool_end').find((e) => e.state === 'error' && e.output?.includes('đừng hỏi người dùng chọn hướng'));
    expect(blocked, 'phải có tool_end báo bị chặn').toBeTruthy();
    // Lượt chạy đi tiếp (không dừng ở câu hỏi) tới câu trả lời cuối.
    expect(r.turns).toBeGreaterThanOrEqual(3);
  }, 20_000);
});
