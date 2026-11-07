import { describe, expect, it } from 'vitest';
import { createChromeTool, friendlyChromeError, type ChromeCaller, type ChromeInput } from '../src/core/chrome/tools';
import { newSession, type ToolContext } from '../src/core/engine/types';
import { NodeToolHost } from '../src/core/host/nodeHost';
import { createTerminalTool } from '../src/core/tools/terminal';
import { makeWorkspace } from './helpers/harness';

/**
 * Các bản sửa rút ra từ phân tích lỗi của Locaith-v5-flash/SI (nhật ký cổng 04–05/11/2026 + kho phiên của extension).
 * Báo cáo: F:\Locaith-AI-Local-finetune\Loi-Locaith-v5-flash\02-phan-tich. Bản sửa do DeepSeek V4.1 Flash đề xuất, người duyệt chỉnh (03-de-xuat-sua\applied.json).
 */
const ctxFor = (host: unknown): ToolContext => ({
  signal: new AbortController().signal,
  session: newSession({ id: 's', provider: 'p', model: 'm' }),
  host: host as never,
  callId: 'c1',
  assistantId: 'a1',
  emit: () => undefined,
  progress: () => undefined,
  log: () => undefined,
});

describe('chrome: trang Chrome cấm điều khiển → thông báo rõ, không thử lại (2 lần «extensions gallery cannot be scripted» trong phiên Locaith-v5-flash)', () => {
  it('nhận ra đúng 3 cụm là giới hạn cứng của Chrome', () => {
    for (const raw of ['The extensions gallery cannot be scripted.', 'Cannot access a chrome:// URL', 'Cannot access an edge:// URL', 'THE EXTENSIONS GALLERY CANNOT BE SCRIPTED']) {
      const m = friendlyChromeError(raw);
      expect(m, raw).toMatch(/GIỚI HẠN CỦA CHROME/);
      expect(m, raw).toMatch(/Đừng thử lại/);
    }
  });

  it('KHÔNG nuốt lỗi có thể khắc phục: thiếu quyền trang, mạng chập chờn, tab đã đóng', () => {
    for (const raw of ['Cannot access contents of url "https://x.vn/". Extension manifest must request permission to access this host.', 'The tab is showing error page', 'No tab with id: 5', 'Hết thời gian chờ Chrome', '']) {
      expect(friendlyChromeError(raw), raw).toBeNull();
    }
  });

  it('execute: lỗi bị cấm → nội dung tiếng Việt + isError; lỗi khác giữ NGUYÊN VĂN', async () => {
    const make = (msg: string) => {
      const caller: ChromeCaller = { call: async () => Promise.reject(new Error(msg)) };
      return createChromeTool(caller);
    };
    const input: ChromeInput = { action: 'read', tab_id: 3 };
    const blocked = await make('The extensions gallery cannot be scripted.').execute(input, ctxFor({}));
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toMatch(/GIỚI HẠN CỦA CHROME/);
    expect(blocked.content).not.toBe('The extensions gallery cannot be scripted.');
    const other = await make('No tab with id: 3').execute(input, ctxFor({}));
    expect(other).toEqual({ content: 'No tab with id: 3', isError: true });
  });
});

describe('run_command: hết giờ mà không có đầu ra → gợi ý «có thể shell khởi động chậm» (9/10 lần hết giờ trong nhật ký không có byte đầu ra)', () => {
  const timedOut = (output: string, extra: Record<string, unknown> = {}) => {
    const host = new NodeToolHost({ roots: [makeWorkspace()] });
    host.runCommand = async () => ({ exitCode: null, output, timedOut: true, aborted: false, truncated: false, ...extra });
    return { tool: createTerminalTool(host), host };
  };

  it('đầu ra rỗng (kể cả chỉ khoảng trắng/ANSI): thêm gợi ý nói «có thể», không khẳng định nguyên nhân', async () => {
    for (const out of ['', '  \n', '\u001b[0m']) {
      const { tool, host } = timedOut(out);
      const r = await tool.execute({ command: 'Write-Output ok', timeout_seconds: 30 }, ctxFor(host));
      expect(r.isError, JSON.stringify(out)).toBe(true);
      expect(r.summary).toBe('hết giờ');
      expect(r.content).toMatch(/^Lệnh bị dừng sau 30 giây \(hết thời gian\)\./);
      expect(r.content).toMatch(/Gợi ý: chưa nhận được đầu ra nào — có thể shell khởi động chậm, hoặc lệnh không in gì/);
      expect(r.content).toMatch(/MỘT lần với timeout_seconds lớn hơn \(≥ 120\)/);
      expect(r.content).not.toMatch(/chứ không phải lệnh treo/);
    }
  });

  it('đã có đầu ra (lệnh chạy lâu thật): giữ nguyên thông báo cũ, KHÔNG có gợi ý', async () => {
    const { tool, host } = timedOut('zip : đã nén 1,2 GB');
    const r = await tool.execute({ command: 'Compress-Archive …', timeout_seconds: 180 }, ctxFor(host));
    expect(r.content).toContain('Lệnh bị dừng sau 180 giây (hết thời gian).\nzip : đã nén 1,2 GB');
    expect(r.content).not.toContain('khởi động chậm'); // không có gợi ý «shell chậm»
    expect(r.content).toContain('background:true'); // (lane:bg-tasks) chỉ đường sang chạy nền
    expect(r.isError).toBe(true);
  });

  it('không đụng nhánh khác: bị dừng theo yêu cầu, thành công, mã thoát khác 0', async () => {
    const host = new NodeToolHost({ roots: [makeWorkspace()] });
    const tool = createTerminalTool(host);
    host.runCommand = async () => ({ exitCode: null, output: '', timedOut: false, aborted: true, truncated: false });
    expect((await tool.execute({ command: 'x' }, ctxFor(host))).summary).toBe('đã dừng');
    host.runCommand = async () => ({ exitCode: 0, output: 'ok', timedOut: false, aborted: false, truncated: false });
    expect(await tool.execute({ command: 'x' }, ctxFor(host))).toMatchObject({ content: 'Mã thoát: 0\nok', isError: false, summary: 'thành công' });
    host.runCommand = async () => ({ exitCode: 3, output: '', timedOut: false, aborted: false, truncated: false });
    expect(await tool.execute({ command: 'x' }, ctxFor(host))).toMatchObject({ isError: true, summary: 'mã 3' });
  });
});
