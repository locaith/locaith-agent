import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolDef, ToolResult } from '../../src/core/engine/types';
import { newSession } from '../../src/core/engine/types';
import { NodeToolHost } from '../../src/core/host/nodeHost';
import { writeFileTool } from '../../src/core/tools/fs';
import type { AssistantItem, TItem, ToolBlock } from '../../src/shared/protocol';
import { sanitizeBackupSession } from '../../src/shared/sessionBackup';
import { applyEvent } from '../../src/shared/transcript';
import { formatClock, formatDayLabel, timelineMarks, writeLineCount } from '../../webview/src/timelineCc';
import { makeWorkspace } from '../helpers/harness';

/**
 * Kiểm chứng ĐỐI KHÁNG lane cc-timeline-ui. Mỗi `it` ĐỎ trên mã hiện tại chứng minh một lỗi thật; các `expect` «bối cảnh» xanh
 * chỉ để chỉ ra đường dữ liệu thật dẫn tới lỗi (không phải dữ liệu bịa trong cảnh mẫu).
 */
const W = path.resolve(__dirname, '../../webview/src');
const toolRowSrc = fs.readFileSync(path.join(W, 'components/timeline/ToolRow.tsx'), 'utf8');

function ctxFor(dir: string): ToolContext {
  const host = new NodeToolHost({ roots: [dir] });
  const session = newSession({ id: 's', provider: 'fake', model: 'm' });
  return { signal: new AbortController().signal, session, host, callId: 'c1', assistantId: 'a1', emit: () => undefined, progress: () => undefined, log: () => undefined };
}
async function run<I>(tool: ToolDef<I>, input: I, ctx: ToolContext): Promise<ToolResult> {
  const sem = await tool.validate?.(input, ctx);
  if (sem) return { content: sem, isError: true };
  return tool.execute(input, ctx);
}

describe('D. Dòng Ghi tệp với DỮ LIỆU THẬT của host (không phải cảnh mẫu)', () => {
  it('Write tệp mới: host trả summary «58 dòng» VÀ diff → ToolRow ẩn «58 dòng» (gate `!block.diff`) và vẽ cả xem trước lẫn diff', async () => {
    const dir = makeWorkspace();
    const ctx = ctxFor(dir);
    const content = Array.from({ length: 58 }, (_, i) => `line ${i + 1}`).join('\n');
    const res = await run(writeFileTool, { path: 'src/gate.ts', content }, ctx);

    // Bối cảnh (xanh): kết quả thật của write_file tệp mới mang CẢ summary «58 dòng» lẫn diff — dispatcher.ts chuyển cả hai vào tool_end.
    expect(res.isError).toBeFalsy();
    expect(res.summary).toBe('58 dòng');
    expect(res.diff).toMatchObject({ added: 58, removed: 0, isNew: true });

    let items: TItem[] = applyEvent([], { t: 'assistant_start', id: 'a1', provider: 'p', model: 'm', ts: 1 });
    items = applyEvent(items, { t: 'tool_start', id: 'a1', callId: 'c1', name: 'write_file', args: { path: 'src/gate.ts', content } });
    items = applyEvent(items, { t: 'tool_end', id: 'a1', callId: 'c1', state: 'done', summary: res.summary, output: res.content, diff: res.diff, durationMs: 60 });
    const block = (items[0] as AssistantItem).blocks[0] as ToolBlock;
    expect(block.diff).toBeDefined();
    expect(writeLineCount(block)).toBe(58);

    // ĐỎ: với khối thật (có diff) ToolRow.tsx không hiện «58 dòng» (meta chỉ còn «+58 −0») và thân mở ra vẽ cả FilePreview lẫn DiffView 58 dòng
    // → khác đặc tả D («Write <đường dẫn> · N dòng» + khung xem trước; diff chỉ cho Edit) và khác ảnh chụp cc-3 (cảnh mẫu bỏ `diff` nên không lộ).
    expect(toolRowSrc).not.toMatch(/lineCount !== undefined && !block\.diff/);
  });
});

describe('G. Dấu thời gian: giá trị hữu hạn nhưng ngoài dải Date (dữ liệu phiên/sao lưu không đáng tin)', () => {
  const HUGE = 9e15; // hữu hạn, > 0, nhưng vượt dải Date (8,64e15) → new Date(HUGE) = Invalid Date

  it('bối cảnh: tệp sao lưu với ts = 9e15 đi qua sanitizeBackupSession nguyên vẹn (num() chỉ kiểm hữu hạn)', () => {
    const r = sanitizeBackupSession({ session: { id: 'abc123', messages: [] }, transcript: [{ kind: 'user', id: 'u1', text: 'x', attachments: [], ts: HUGE }] }, 'ws');
    expect(r?.transcript[0]).toMatchObject({ kind: 'user', ts: HUGE });
    // Stamp.tsx:13 gọi `new Date(ts!).toISOString()` cho mọi ts mà formatClock chấp nhận → RangeError lúc render (không có error boundary).
    expect(() => new Date(HUGE).toISOString()).toThrow(RangeError);
  });

  it('ĐỎ: formatClock / formatDayLabel phải trả rỗng (ẩn, không bịa) thay vì «NaN:NaN»; timelineMarks không được đặt mốc giờ cho ts đó', () => {
    expect(formatClock(HUGE, 'vi')).toBe('');
    expect(formatClock(HUGE, 'en')).toBe('');
    expect(formatDayLabel(HUGE, 'vi')).toBe('');
    const marks = timelineMarks([{ kind: 'user', id: 'u', text: 'x', attachments: [], ts: HUGE }]);
    expect(marks.get('u')).toBeUndefined();
  });
});

describe('D. Đường dẫn «màu liên kết, nhấp để mở»', () => {
  it('ĐỎ: phần tử .cc-path có tooltip «Mở tệp: …» nhưng không có onClick mở tệp — bấm vào chỉ gập/mở dòng (sự kiện nổi lên nút tool-head)', () => {
    // Đặc tả D và docs/TIMELINE-SPEC.md §3 («đường dẫn màu liên kết, bấm mở tệp (chỉ VS Code)») hứa bấm đường dẫn là mở tệp.
    expect(toolRowSrc).toMatch(/class="cc-desc cc-path"[^>]*onClick=\{/);
  });
});
