import { describe, expect, it } from 'vitest';
import { createVerifierExtension, type LastRun } from '../../src/core/engine/verifier';
import { makeHarness } from '../helpers/harness';
import { textTurn, toolTurn } from '../helpers/fakeProvider';

/**
 * (blind-verifier · kiểm chứng đối kháng) `/verify` hứa kiểm tra "lần chạy gần nhất", nhưng gói dữ liệu (`onLastRun`) CHỈ được ghi
 * ở móc finalize — lần chạy bị Dừng (hoặc kết thúc bằng lỗi / hết vòng / từ chối) không bao giờ tới finalize, nên `/verify` sau đó
 * âm thầm kiểm tra lần chạy TRƯỚC ĐÓ (yêu cầu khác, tệp khác) mà không nói cho người dùng biết.
 *
 * Chạy: npx vitest run test/adversarial/blind-verifier.staleLastRun.test.ts
 */
describe('adversarial · gói dữ liệu cho /verify phải phản ánh lần chạy gần nhất kể cả khi lần đó bị Dừng', () => {
  it('lần chạy 2 bị Dừng giữa chừng → gói dữ liệu vẫn là của lần chạy 1 (yêu cầu "việc 1")', async () => {
    let last: LastRun | null = null;
    const ext = createVerifierExtension({
      settings: () => ({ mode: 'auto' }),
      registry: () => {
        throw new Error('không tới đây');
      },
      run: async () => {
        throw new Error('không tới đây');
      },
      onLastRun: (l) => {
        last = l;
      },
    });
    const ac = new AbortController();
    const h = makeHarness(
      [
        // lần chạy 1: ghi tệp rồi báo xong (suy luận thấp → auto không kích hoạt, nhưng gói dữ liệu vẫn được lưu)
        () => toolTurn([{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }]),
        () => textTurn('xong việc 1'),
        // lần chạy 2: ghi tệp khác rồi bị Dừng trước khi báo xong
        () => toolTurn([{ name: 'write_file', input: { path: 'b.txt', content: 'y' } }]),
        () => {
          ac.abort();
          return textTurn('đang làm việc 2…');
        },
      ],
      { engineDeps: { extensions: [ext] } },
    );
    h.session.thinkingLevel = 'low';
    expect((await h.run('việc 1')).stopReason).toBe('end_turn');
    expect(last!.bundle.requests).toEqual(['việc 1']);

    expect((await h.run('việc 2', ac.signal)).stopReason).toBe('aborted');
    // Người dùng gõ /verify lúc này: gói dữ liệu phải thuộc "việc 2" (tệp b.txt), không phải "việc 1".
    expect(last!.bundle.requests).toContain('việc 2');
    expect(last!.bundle.changes.map((c) => c.path)).toContain('b.txt');
  });
});
