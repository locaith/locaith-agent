import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/engine/types';
import type { TItem } from '../../src/shared/protocol';
import { PRIVATE_PAGE_TOOLS, REDACTED_NOTE, hasRedactions, redactForStorage, redactTranscript } from '../../src/browser/storageRedact';

const PAGE = 'URL: https://mail.example.com/inbox\nTiêu đề: Hộp thư\nCuộn: 0/900px\n\n<trang_web>\nThư của sếp: mật khẩu wifi là hoa-sen-2026\n</trang_web>';

function sessionWith(contents: any[]) {
  const s = newSession({ id: 's', provider: 'p', model: 'm' });
  s.messages = contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content, ts: i }) as any);
  return s;
}

describe('lược nội dung trang khi lưu hội thoại (quyền riêng tư)', () => {
  it('kết quả công cụ đọc trang chỉ còn vài dòng đầu + ghi chú; ảnh chụp bị bỏ; bản trong bộ nhớ không đổi', () => {
    const s = sessionWith([
      [{ type: 'tool_result', toolUseId: 'a', name: 'page_read', content: PAGE }],
      [{ type: 'tool_result', toolUseId: 'b', name: 'page_screenshot', content: 'Ảnh chụp tab', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] }],
      [{ type: 'tool_result', toolUseId: 'c', name: 'web_search', content: 'Kết quả công khai giữ nguyên' }],
    ]);
    const out = redactForStorage(s);
    const [a, b, c] = out.messages.map((m) => m.content[0] as any);
    expect(a.content).toContain('URL: https://mail.example.com/inbox');
    expect(a.content).toContain(REDACTED_NOTE);
    expect(a.content).not.toContain('hoa-sen-2026');
    expect(b.images).toBeUndefined();
    expect(b.content).toContain(REDACTED_NOTE);
    expect(c.content).toBe('Kết quả công khai giữ nguyên');
    // bản gốc nguyên vẹn
    expect((s.messages[0].content[0] as any).content).toContain('hoa-sen-2026');
    expect(out).not.toBe(s);
    // không có gì để lược → trả về chính đối tượng cũ (không sao chép tốn kém mỗi lần lưu)
    const plain = sessionWith([[{ type: 'text', text: 'xin chào' }]]);
    expect(redactForStorage(plain)).toBe(plain);
  });

  it('nội dung tab đính kèm trong tin nhắn người dùng bị lược, câu hỏi của người dùng giữ nguyên', () => {
    const s = sessionWith([[{ type: 'text', text: '<browser_context>\nTab\n</browser_context>\n\n<attached_tab id="12">\nBí mật nội bộ\n</attached_tab>\n\nTóm tắt giúp tôi' }]]);
    const t = (redactForStorage(s).messages[0].content[0] as any).text as string;
    expect(t).not.toContain('Bí mật nội bộ');
    expect(t).toContain('<attached_tab id="12">');
    expect(t).toContain(REDACTED_NOTE);
    expect(t).toContain('Tóm tắt giúp tôi');
  });

  it('idempotent: lược hai lần không đổi thêm; hasRedactions nhận ra phiên đã bị lược', () => {
    const s = sessionWith([[{ type: 'tool_result', toolUseId: 'a', name: 'page_snapshot', content: PAGE }]]);
    const once = redactForStorage(s);
    const twice = redactForStorage(once);
    expect(twice).toBe(once);
    expect(hasRedactions(once)).toBe(true);
    expect(hasRedactions(s)).toBe(false);
  });

  it('phần xem trước của khối công cụ đọc trang trong giao diện cũng bị lược', () => {
    const items: TItem[] = [
      {
        kind: 'assistant',
        id: 'a',
        provider: 'p',
        model: 'm',
        ts: 1,
        done: true,
        blocks: [
          { type: 'tool', id: 't1', name: 'page_read', args: {}, state: 'done', startedAt: 1, output: PAGE, summary: 'mail.example.com' },
          { type: 'tool', id: 't2', name: 'web_search', args: {}, state: 'done', startedAt: 1, output: 'kết quả công khai' },
        ],
      },
    ];
    const out = redactTranscript(items) as any[];
    expect(out[0].blocks[0].output).toBe(REDACTED_NOTE);
    expect(out[0].blocks[0].summary).toBe('mail.example.com');
    expect(out[0].blocks[1].output).toBe('kết quả công khai');
    expect(items[0] as any).toBe(items[0]);
  });

  it('danh sách công cụ riêng tư gồm đúng các công cụ trả nội dung/ảnh trang', () => {
    expect([...PRIVATE_PAGE_TOOLS].sort()).toEqual(['page_find', 'page_read', 'page_screenshot', 'page_snapshot', 'tabs_list']);
  });
});

describe('ảnh công cụ không bao giờ được lưu', () => {
  it('redactTranscript bỏ images của MỌI khối công cụ (kể cả công cụ không thuộc nhóm đọc trang)', () => {
    const items = [
      {
        kind: 'assistant',
        id: 'a',
        model: 'm',
        provider: 'p',
        ts: 1,
        blocks: [
          { type: 'tool', id: 't1', name: 'page_screenshot', args: {}, state: 'done', output: 'Ảnh chụp tab', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }], startedAt: 1 },
          { type: 'tool', id: 't2', name: 'doc_anh_khac', args: {}, state: 'done', output: 'giữ lại', images: [{ mediaType: 'image/png', data: 'BBBB' }], startedAt: 1 },
        ],
      },
    ] as unknown as TItem[];
    const out = redactTranscript(items) as any[];
    expect(out[0].blocks[0].images).toBeUndefined();
    expect(out[0].blocks[1].images).toBeUndefined();
    expect(out[0].blocks[1].output).toBe('giữ lại'); // công cụ ngoài nhóm đọc trang: chỉ bỏ ảnh
    expect((items[0] as any).blocks[0].images).toHaveLength(1); // bản trong bộ nhớ nguyên vẹn
  });
});
