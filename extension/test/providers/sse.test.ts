import { describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from '../../src/core/providers/sse';
import { ProviderError } from '../../src/core/types';

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else if (!opts.hang) controller.close();
      else return new Promise(() => undefined);
    },
  });
}

async function all(body: ReadableStream<Uint8Array>, signal?: AbortSignal, idleTimeoutMs?: number): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of parseSse(body, { signal, idleTimeoutMs, providerId: 't' })) out.push(m);
  return out;
}

describe('parseSse', () => {
  it('đọc event/data cơ bản, bỏ comment và retry', async () => {
    const text = ': keep-alive\n\nevent: a\ndata: {"x":1}\n\nretry: 100\nid: 7\ndata: hello\n\n';
    const got = await all(streamOf([enc.encode(text)]));
    expect(got).toEqual([{ event: 'a', data: '{"x":1}' }, { data: 'hello', id: '7' }]);
  });

  it('nối nhiều dòng data bằng \\n, và chịu CRLF', async () => {
    const got = await all(streamOf([enc.encode('data: dòng một\r\ndata: dòng hai\r\n\r\ndata: tiếp\r\n\r\n')]));
    expect(got.map((m) => m.data)).toEqual(['dòng một\ndòng hai', 'tiếp']);
  });

  it('chịu \\r đơn lẻ làm ký tự xuống dòng', async () => {
    const got = await all(streamOf([enc.encode('data: a\r\rdata: b\r\r')]));
    expect(got.map((m) => m.data)).toEqual(['a', 'b']);
  });

  it('dừng ở [DONE] và không trả nó ra ngoài', async () => {
    const got = await all(streamOf([enc.encode('data: 1\n\ndata: [DONE]\n\ndata: 2\n\n')]));
    expect(got.map((m) => m.data)).toEqual(['1']);
  });

  it('trả sự kiện cuối dù thiếu dòng trống kết thúc', async () => {
    const got = await all(streamOf([enc.encode('data: cuối')]));
    expect(got.map((m) => m.data)).toEqual(['cuối']);
  });

  it('bỏ BOM đầu luồng và khoảng trắng đầu giá trị', async () => {
    const got = await all(streamOf([enc.encode('﻿data:  hai khoảng\n\n')]));
    expect(got[0].data).toBe(' hai khoảng');
  });

  it('tiếng Việt sống sót qua MỌI điểm cắt byte (kể cả giữa ký tự nhiều byte)', async () => {
    const payload = JSON.stringify({
      text: 'Nguyễn Thị Thuỷ Tiên đã cấu hình tệp tin quảng cáo — ướ ữ ặ ổ ỡ ệ ừ ẫ ể ₫ 😀',
    });
    const full = enc.encode(`event: delta\ndata: ${payload}\n\ndata: ${payload}\n\n`);
    for (let cut = 0; cut <= full.length; cut++) {
      const got = await all(streamOf([full.slice(0, cut), full.slice(cut)]));
      expect(got.map((m) => m.data)).toEqual([payload, payload]);
      expect(got[0].event).toBe('delta');
    }
  });

  it('tiếng Việt sống sót khi nhận từng byte một', async () => {
    const payload = 'Đặng Thị Hồng Nhung ở Hà Nội — dấu ngã ẫ, hỏi ể, nặng ặ';
    const full = enc.encode(`data: ${payload}\n\n`);
    const chunks = Array.from(full, (b) => new Uint8Array([b]));
    const got = await all(streamOf(chunks));
    expect(got.map((m) => m.data)).toEqual([payload]);
  });

  it('\\r\\n bị tách giữa hai khúc vẫn là một dấu xuống dòng', async () => {
    const got = await all(streamOf([enc.encode('data: a\r'), enc.encode('\n\r'), enc.encode('\ndata: b\r\n\r\n')]));
    expect(got.map((m) => m.data)).toEqual(['a', 'b']);
  });

  it('hết thời gian chờ không có dữ liệu → ProviderError timeout', async () => {
    const body = streamOf([enc.encode('data: 1\n\n')], { hang: true });
    const promise = all(body, undefined, 60);
    await expect(promise).rejects.toMatchObject({ name: 'ProviderError', kind: 'timeout' });
  });

  it('bị hủy giữa chừng → ProviderError aborted', async () => {
    const ctrl = new AbortController();
    const body = streamOf([enc.encode('data: 1\n\n')], { hang: true });
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of parseSse(body, { signal: ctrl.signal, idleTimeoutMs: 5000, providerId: 't' })) {
        seen.push(m.data);
        ctrl.abort();
      }
    })();
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(seen).toEqual(['1']);
  });
});
