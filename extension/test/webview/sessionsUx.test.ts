import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeFork, sanitizeItem, sanitizePatch, toRemoteState } from '../../src/core/remote/sanitize';
import type { NoticeItem, ViewState } from '../../src/shared/protocol';
import { contextRatio, formatUsd, meterTone } from '../../src/shared/sessionMeterCalc';

/**
 * (lane:sessions-ux) Giao diện: chip ngữ cảnh ở tiêu đề, menu ⋯ của tin nhắn, rẽ nhánh, lịch sử có tìm toàn văn/ghim/chọn nhiều.
 * Webview chạy trong Node thuần ở bộ test này nên kiểm bằng nguồn (hợp đồng giữa các tệp) và phần logic thuần.
 */
const W = path.resolve(__dirname, '../../webview/src');
const read = (p: string) => fs.readFileSync(path.join(W, p), 'utf8');
const i18n = read('i18n.ts');
const defs = (k: string) => i18n.split(`'${k}':`).length - 1;

describe('chuỗi giao diện: đủ vi + en', () => {
  it('mọi khoá sx.* được dùng trong thành phần đều có đủ hai ngôn ngữ', () => {
    const sources = ['components/MeterChip.tsx', 'components/MessageMenu.tsx', 'components/MessageBranch.tsx', 'components/HistoryView.tsx'].map(read).join('\n');
    const keys = new Set([...sources.matchAll(/'(sx\.[\w.]+)'/g)].map((m) => m[1]));
    // nhóm ngày dựng bằng mẫu `sx.hist.g.${key}`
    for (const g of ['pinned', 'today', 'yesterday', 'week', 'month', 'older']) keys.add(`sx.hist.g.${g}`);
    expect(keys.size).toBeGreaterThan(25);
    for (const k of keys) expect(defs(k), `khoá ${k} phải có đúng 2 bản (vi + en)`).toBe(2);
  });
});

describe('đồng hồ ngữ cảnh (logic hiển thị)', () => {
  it('phần trăm, ngưỡng màu và định dạng USD', () => {
    expect(contextRatio({ usedTokens: 38_000, limitTokens: 100_000 })).toBeCloseTo(0.38, 6);
    expect(contextRatio({ usedTokens: 5, limitTokens: 0 })).toBeNull();
    expect(contextRatio(undefined)).toBeNull();
    expect(contextRatio({ usedTokens: 500, limitTokens: 100 })).toBe(1);
    expect([0.38, 0.61, 0.81].map(meterTone)).toEqual(['ok', 'warn', 'danger']);
    expect(formatUsd(1.4)).toBe('$1.40');
  });

  it('chip chỉ hiện chi phí khi có costUsd, và có nút Thu gọn ở cuối khối mở ra', () => {
    const src = read('components/MeterChip.tsx');
    expect(src).toMatch(/meter\?\.costUsd !== undefined/);
    expect(src).not.toMatch(/costUsd \?\? 0/); // không bịa 0 khi thiếu giá
    const popStart = src.indexOf('meter-pop');
    expect(src.indexOf("t('act.collapse')", popStart)).toBeGreaterThan(src.indexOf('meter-note', popStart));
    expect(src).toContain('useDismiss'); // Esc / bấm ngoài để đóng
  });

  it('Header nhận context + meter và App truyền xuống', () => {
    expect(read('components/Header.tsx')).toMatch(/<MeterChip context=\{context\} meter=\{meter\} \/>/);
    expect(read('App.tsx')).toMatch(/context=\{view\.context\}\s+meter=\{view\.meter\}/);
  });
});

describe('thao tác tin nhắn', () => {
  it('UserMessage dùng menu ⋯; menu có Sao chép, Sửa và gửi lại (chỉ tin cuối), Rẽ nhánh từ đây (thành phần riêng)', () => {
    expect(read('components/timeline/UserMessage.tsx')).toContain('<MessageMenu');
    const menu = read('components/MessageMenu.tsx');
    expect(menu).toContain('copyText(text)');
    expect(menu).toMatch(/canEdit && \(/);
    expect(menu).toContain("type: 'edit_last'");
    expect(menu).toContain('<BranchMenuItem');
    expect(read('components/MessageBranch.tsx')).toContain("type: 'fork_session'");
  });

  it('dòng đầu cuộc nhánh mở lại cuộc gốc; hiện qua StandaloneNotice', () => {
    expect(read('components/MessageBranch.tsx')).toMatch(/type: 'load_session', id: fork\.fromId/);
    expect(read('components/timeline/AssistantTurn.tsx')).toContain('if (item.fork) return <BranchBacklink');
  });
});

describe('Lịch sử: tìm toàn văn, ghim, chọn nhiều', () => {
  const src = read('components/HistoryView.tsx');
  it('gõ tìm → hook gửi search_sessions (có ngắt nhịp + reqId); nhận session_search và bỏ kết quả của truy vấn cũ', () => {
    const hook = read('historySearch.ts');
    expect(hook).toContain("type: 'search_sessions'");
    expect(hook).toMatch(/m\.reqId !== reqRef\.current/);
    expect(hook).toContain('SEARCH_DEBOUNCE_MS');
    expect(src).toContain('useHistorySearch(query)');
    expect(src).toContain('<Marked');
  });
  it('ghim và xoá hàng loạt đi qua protocol; cuộc đang mở không chọn được; xoá hàng loạt hỏi lại', () => {
    expect(src).toContain("type: 'pin_session'");
    expect(src).toContain("type: 'delete_sessions'");
    expect(src).toMatch(/disabled=\{current\}/);
    expect(src).toContain('confirmBulk');
  });
  it('style: tôn trọng giảm chuyển động / tương phản cao và có dòng nhóm ngày', () => {
    const css = read('styles/sessions-ux.css');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('forced-colors');
    expect(css).toContain('.hist-group');
    expect(read('styles/main.css')).toContain("@import './sessions-ux.css'");
    expect(css).not.toMatch(/background:\s*var\(--accent\)/); // không tô nền kín
  });
});

describe('Remote: những gì gửi ra ngoài được lọc', () => {
  const baseView = { transcript: [], sessions: [], providers: [], queued: [], todos: [], provider: 'p', model: 'm', mode: 'default', thinkingLevel: 'medium', running: false, sessionId: 's', title: 't', allowBypass: false, context: { usedTokens: 1, limitTokens: 10 }, meter: { inputTokens: 5.7, outputTokens: -1, compactions: 1, clearedResults: 2, costUsd: 0.25 } } as unknown as ViewState;

  it('meter đi qua snapshot và patch (đã ép về số hợp lệ)', () => {
    const st = toRemoteState(baseView, { name: 'PC', vscode: '1', ext: '1', platform: 'x' }, { canBypass: false } as never);
    expect(st.meter).toEqual({ inputTokens: 5, outputTokens: 0, compactions: 1, clearedResults: 2, costUsd: 0.25 });
    expect(sanitizePatch({ meter: { inputTokens: 1, outputTokens: 2, compactions: 0, clearedResults: 0 } })).toEqual({ meter: { inputTokens: 1, outputTokens: 2, compactions: 0, clearedResults: 0 } });
  });

  it('notice nhánh: giữ chữ (Remote cũ vẫn đọc được) + liên kết ngược đã lọc; mã sai thì bỏ liên kết', () => {
    const n = (fork: NoticeItem['fork']): NoticeItem => ({ kind: 'notice', id: 'n', level: 'info', text: 'Rẽ nhánh từ «A»', ts: 1, fork });
    const ok = sanitizeItem(n({ fromId: 'abc-1', fromTitle: 'x'.repeat(500) })) as NoticeItem;
    expect(ok.text).toBe('Rẽ nhánh từ «A»');
    expect(ok.fork!.fromId).toBe('abc-1');
    expect(ok.fork!.fromTitle.length).toBeLessThan(200);
    const bad = sanitizeItem(n({ fromId: '../../x', fromTitle: 'y' })) as NoticeItem;
    expect(bad.fork).toBeUndefined();
    expect(bad.text).toBe('Rẽ nhánh từ «A»');
    expect(sanitizeFork(undefined)).toBeUndefined();
  });
});
