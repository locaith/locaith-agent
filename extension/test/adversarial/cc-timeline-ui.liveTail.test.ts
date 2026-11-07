import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ABlock } from '../../src/shared/protocol';
import { buildSegments, splitWork } from '../../webview/src/timeline';

/**
 * ĐỐI KHÁNG (lane cc-timeline-ui) — hai lỗi có bằng chứng:
 *
 * 1. Lượt ĐANG CHẠY bị gấp (≥ 3 đoạn trước câu chữ cuối) → phần ĐUÔI (`split.tail`) được vẽ với `live=false`.
 *    Khối suy nghĩ đang stream ở đuôi vì thế hiện nhãn hoàn thành «Đã suy nghĩ N giây» (cc.thought) thay vì «Đang suy nghĩ» + shimmer,
 *    và vì khối cuối là 'thinking' nên cũng KHÔNG có nhãn «Đang xử lý» (needsWorkingIndicator = false) → người dùng thấy giao diện đứng yên
 *    trong khi mô hình đang suy nghĩ. Trước lane, nhãn là «Suy nghĩ» (không khẳng định đã xong) nên lỗi này do nhãn mới của lane gây ra.
 *
 * 2. Đường dẫn tệp trong dòng công cụ (`.cc-path`) có màu liên kết và tooltip «Mở tệp: …» nhưng KHÔNG có onClick: bấm vào chỉ gập/mở dòng
 *    (nút cha `.tool-head`). Đặc tả D: «đường dẫn đầy đủ, màu liên kết xanh, nhấp để mở». Nút `.tool-open` riêng chỉ hiện khi rê chuột.
 */
const W = path.resolve(__dirname, '../../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');

const tool = (id: string, name: string, args: Record<string, unknown>, state: ABlock extends { state: infer S } ? S : 'done' = 'done'): ABlock =>
  ({ type: 'tool', id, name, args, state, startedAt: 1, durationMs: 500, output: 'ok' }) as ABlock;

describe('đuôi của lượt đang chạy bị gấp phải giữ trạng thái sống', () => {
  it('kịch bản thật: nghĩ → chữ → 3 công cụ → chữ → đang nghĩ tiếp: splitWork gấp phần đầu và đặt khối suy nghĩ ĐANG STREAM vào tail', () => {
    const blocks: ABlock[] = [
      { type: 'thinking', id: 'k1', text: 'Cần xem cấu trúc trước.', startedAt: 1000, durationMs: 3000 },
      { type: 'text', id: 't1', text: 'Để em đọc ba tệp liên quan.' },
      tool('c1', 'read_file', { path: 'src/a.ts' }),
      tool('c2', 'read_file', { path: 'src/b.ts' }),
      tool('c3', 'grep', { pattern: 'foo', path: 'src' }),
      { type: 'text', id: 't2', text: 'Đã đọc xong, giờ em cân nhắc cách sửa.' },
      // khối suy nghĩ ĐANG stream (lượt chưa xong): đã có 2 delta nên có durationMs tạm
      { type: 'thinking', id: 'k2', text: 'Có hai hướng…', startedAt: 9000, durationMs: 2000 },
    ];
    const segments = buildSegments(blocks, false, true, true);
    const split = splitWork(segments, blocks, 0, undefined);
    expect(split).not.toBeNull();
    // Điều kiện AssistantTurn dùng để gấp lượt đang chạy (work + kept ≥ 3)
    expect(split!.work.length + split!.kept.length).toBeGreaterThanOrEqual(3);
    const tailThinking = split!.tail.some((s) => s.kind === 'activity' && s.rows.some((r) => r.kind === 'thinking' && r.block.id === 'k2'));
    expect(tailThinking).toBe(true);
  });

  it('AssistantTurn phải truyền trạng thái sống cho đoạn cuối của tail (không được vẽ cứng live=false)', () => {
    const turn = read('components/timeline/AssistantTurn.tsx');
    // Hiện tại: `{split.tail.map((seg) => render(seg, false, false))}` → ThinkingRow live=false → «Đã suy nghĩ 2 giây» trong lúc đang nghĩ.
    expect(turn).not.toMatch(/split\.tail\.map\(\(seg\) => render\(seg, false, false\)\)/);
    // Đoạn cuối của tail phải nhận `live` (như nhánh `runs` đã làm: `live && ri === runs.length - 1`).
    expect(turn).toMatch(/split\.tail\.map\(\(seg, [a-z]+\) => render\(seg,[^)]*live[^)]*\)\)/);
  });
});

describe('đường dẫn màu liên kết phải mở được tệp khi bấm (đặc tả D)', () => {
  it('ToolRow: phần tử .cc-path có onClick gọi openFile (hoặc là <button>/<a>), không chỉ là <span> với tooltip', () => {
    const toolRow = read('components/timeline/ToolRow.tsx');
    const m = /<(span|button|a)\s+class="cc-desc cc-path"[^>]*>/.exec(toolRow);
    expect(m, 'thiếu phần tử .cc-path').not.toBeNull();
    const tag = m![0];
    expect(tag, 'cc-path phải bấm mở tệp: cần onClick → openFile (và chặn nổi bọt để không gập dòng)').toMatch(/onClick=\{[^}]*openFile/);
  });
});
