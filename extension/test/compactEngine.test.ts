import { beforeEach, describe, expect, it } from 'vitest';
import { estimateMessagesTokens } from '../src/core/engine/tokens';
import { isClearedResult } from '../src/core/engine/toolResultClearing';
import { DEFAULT_ENGINE_SETTINGS } from '../src/core/engine/types';
import { ConfigService } from '../src/host/config';
import type { ToolResultBlock } from '../src/core/types';
import type { CompactInfo, UiEvent } from '../src/shared/protocol';
import { textTurn, toolTurn, type Step } from './helpers/fakeProvider';
import { eventsOf, makeHarness } from './helpers/harness';
import { settingsStub } from './helpers/vscode-stub';

const FILE = 'const x = 1;\n'.repeat(500); // read_file đánh số dòng → ≈ 2400 token mỗi lần đọc

/** `n` tệp khác nhau (engine gộp các lần đọc lặp lại cùng một tệp thành kết quả ngắn, nên phải khác tệp). */
const files = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`big${i}.ts`, FILE]));

/** Kịch bản: `n` vòng read_file (mỗi vòng một tệp) rồi một câu trả lời. */
function readingScript(n: number): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) steps.push(() => toolTurn([{ id: `r${i}`, name: 'read_file', input: { path: `big${i}.ts` } }]));
  steps.push(() => textTurn('Đã đọc xong.'));
  return steps;
}

const compactNotices = (events: UiEvent[]) => eventsOf(events, 'notice').filter((e) => e.compact) as Array<Extract<UiEvent, { t: 'notice' }> & { compact: CompactInfo }>;

describe('engine thật + fakeProvider: ngữ cảnh gọn qua nhiều vòng', () => {
  it('lược kết quả cũ giữ payload dưới ngưỡng; thông báo có số liệu thật; 8 kết quả gần nhất và bước đang chờ nguyên văn', async () => {
    const N = 24;
    const h = makeHarness(readingScript(N), {
      files: files(N),
      settings: { contextWindow: 100_000, compactAt: 0.8, clearToolResultsAtPercent: 40 },
    });
    const r = await h.run('Đọc hết các tệp big*.ts');
    expect(r.stopReason).toBe('end_turn');
    // Không lược thì 24 × 2400 ≈ 58k token kết quả; có lược: payload gửi model chưa bao giờ vượt 45k và không hề tóm tắt (không gọi complete)
    const sizes = h.provider.rawRequests.map((q) => estimateMessagesTokens(q.messages));
    const oneResult = estimateMessagesTokens([h.session.messages.at(-2)!]);
    expect(oneResult).toBeGreaterThan(2000);
    expect(N * oneResult).toBeGreaterThan(55_000);
    expect(Math.max(...sizes)).toBeLessThan(45_000);
    expect(h.provider.completes).toHaveLength(0);

    const notices = compactNotices(h.events);
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) {
      expect(n.compact.mode).toBe('auto');
      expect(n.compact.clearedResults).toBeGreaterThan(1); // mỗi đợt lược nhiều kết quả, không lược từng cái
      expect(n.compact.tokensFreed).toBeGreaterThan(4000);
      expect(n.text).toBe(`Đã lược ${n.compact.clearedResults} kết quả công cụ cũ để giữ ngữ cảnh gọn — đọc lại được khi cần`);
    }
    // Theo đợt, không lắt nhắt: 24 vòng nhưng chỉ vài đợt lược
    expect(notices.length).toBeLessThanOrEqual(3);

    const results = h.session.messages.flatMap((m) => m.content).filter((b): b is ToolResultBlock => b.type === 'tool_result');
    expect(results).toHaveLength(N);
    expect(results.slice(-8).every((b) => !isClearedResult(b))).toBe(true);
    expect(results.slice(0, 4).every(isClearedResult)).toBe(true);
    expect(results[0].content).toContain('read_file big0.ts');
    expect(results[0].content).toContain('gọi lại read_file big0.ts nếu cần');
    expect(h.session.contextStats?.clearedResults).toBe(results.filter(isClearedResult).length);
    expect(h.session.contextStats?.compactions).toBe(0);
    // thanh đo: số kết quả đã lược khớp tổng các thông báo
    expect(notices.reduce((s, n) => s + (n.compact.clearedResults ?? 0), 0)).toBe(h.session.contextStats?.clearedResults);
  });

  it('cửa sổ nhỏ hơn nữa: sau khi lược vẫn đầy → tóm tắt có cấu trúc giữa lần chạy, giữ yêu cầu gốc nguyên văn, chạy tiếp bình thường', async () => {
    const N = 14;
    const h = makeHarness(readingScript(N), {
      files: files(N),
      settings: { contextWindow: 12_000, compactAt: 0.5, clearToolResultsAtPercent: 40, keepRecentMessages: 6 },
    });
    h.provider.completeImpl = async () => '## Quyết định & lý do\n- đọc theo từng phần\n## Việc còn lại\n- tổng hợp';
    const r = await h.run('YÊU CẦU GỐC: đọc các tệp big*.ts rồi tóm tắt kiến trúc');
    expect(r.stopReason).toBe('end_turn');
    expect(h.provider.completes.length).toBeGreaterThan(0);
    const summarized = compactNotices(h.events).filter((n) => (n.compact.summarizedMessages ?? 0) > 0);
    expect(summarized.length).toBeGreaterThan(0);
    const first = summarized[0];
    expect(first.text).toMatch(/^Đã nén cuộc trò chuyện · tự động · giải phóng \d+k? token$/);
    expect(first.compact.tokensFreed).toBeGreaterThan(0);
    expect(first.compact.summary).toContain('«YÊU CẦU GỐC: đọc các tệp big*.ts rồi tóm tắt kiến trúc»');
    expect(first.compact.summary).toContain('read_file big0.ts');
    // tin đầu của lịch sử là bản tóm tắt mang yêu cầu gốc (qua nhiều lần nén liên tiếp); model vẫn nhận được nó ở các lượt sau
    const head = (h.session.messages[0].content[0] as { text: string }).text;
    expect(head).toContain('«YÊU CẦU GỐC: đọc các tệp big*.ts rồi tóm tắt kiến trúc»');
    const lastReq = h.provider.rawRequests.at(-1)!;
    expect(JSON.stringify(lastReq.messages)).toContain('YÊU CẦU GỐC');
    expect(h.session.contextStats?.compactions).toBe(summarized.length);
    // payload không phình: mọi yêu cầu đều nhỏ hơn cửa sổ, dù 14 × 2400 token kết quả vượt xa 12k
    const sizes = h.provider.rawRequests.map((q) => estimateMessagesTokens(q.messages));
    expect(Math.max(...sizes)).toBeLessThan(12_000);
  });

  it('compactWith (/compact <hướng dẫn>): chế độ manual, chỉ dẫn vào prompt tóm tắt, trả dòng + CompactInfo', async () => {
    const h = makeHarness([() => textTurn('a'), () => textTurn('b'), () => textTurn('c')]);
    await h.run('một');
    await h.run('hai');
    await h.run('ba');
    h.provider.completeImpl = async () => '## Quyết định & lý do\n- ok\n## Việc còn lại\n- không';
    const r = await h.engine.compactWith(h.session, new AbortController().signal, { instructions: 'giữ lại chi tiết về auth' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/^Đã nén cuộc trò chuyện · thủ công · giải phóng \d+ token$/);
    expect(r!.compact.mode).toBe('manual');
    expect(r!.compact.summarizedMessages).toBeGreaterThan(0);
    expect(r!.compact.summary).toContain('«một»');
    expect(h.provider.completes[0].system).toContain('«giữ lại chi tiết về auth»');
    // compactNow cũ vẫn trả dòng chữ (tương thích)
    expect(await h.engine.compactNow(h.session, new AbortController().signal)).toBeNull(); // không còn gì để nén
  });

  it('tiếng Anh: dòng «Compacted chat · manual · N tokens freed»', async () => {
    const h = makeHarness([() => textTurn('a'), () => textTurn('b'), () => textTurn('c')], { settings: { language: 'en' } });
    await h.run('one');
    await h.run('two');
    await h.run('three');
    h.provider.completeImpl = async () => '## Decisions & reasons\n- ok\n## Remaining work\n- none';
    const r = await h.engine.compactWith(h.session, new AbortController().signal);
    expect(r!.text).toMatch(/^Compacted chat · manual · \d+ tokens freed$/);
    expect(r!.compact.summary).toContain('## User requests (verbatim)\n1. «one»');
  });
});

describe('cài đặt mới (config.ts)', () => {
  beforeEach(() => settingsStub.reset());

  it('mặc định an toàn: 40 / 20 / 0, compactAtUserSet = false', () => {
    const e = new ConfigService().engine();
    expect(e.clearToolResultsAtPercent).toBe(40);
    expect(e.keepRecentMessages).toBe(20);
    expect(e.compactAtTokens).toBe(0);
    expect(e.compactAtUserSet).toBe(false);
    expect(DEFAULT_ENGINE_SETTINGS.clearToolResultsAtPercent).toBe(40);
  });

  it('đọc giá trị người dùng, kẹp miền; compactAtPercent đặt ở bất kỳ cấp → compactAtUserSet', () => {
    settingsStub.global = { 'agent.clearToolResultsAtPercent': 120, 'agent.keepRecentMessages': 2, 'agent.compactAtTokens': 250_000 };
    settingsStub.workspace = { 'agent.compactAtPercent': 90 };
    const e = new ConfigService().engine();
    expect(e.clearToolResultsAtPercent).toBe(90);
    expect(e.keepRecentMessages).toBe(4);
    expect(e.compactAtTokens).toBe(250_000);
    expect(e.compactAt).toBe(0.9);
    expect(e.compactAtUserSet).toBe(true);
  });
});
