/**
 * Hook ở lớp ChatController THẬT (deps giả): UserPromptSubmit chặn/ngữ cảnh, /hooks, SessionEnd, Notification,
 * hook dự án qua hộp xác nhận, và việc extension hook đã được nối vào engine của controller.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { textTurn, toolTurn, type Step } from './helpers/fakeProvider';
import { makeControllerHarness, type ControllerHarness } from './helpers/controllerHarness';
import { exits, printsJson, recordStdin, TEST_SHELL, writeProjectHooks } from './helpers/hookKit';
import { window } from './helpers/vscode-stub';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`quá hạn chờ: ${what}`);
    await sleep(15);
  }
}

let h: ControllerHarness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  delete (window as Record<string, unknown>).showWarningMessage;
});

function boot(script: Step[], hooks: unknown, extra: Partial<Parameters<typeof makeControllerHarness>[0]> = {}) {
  h = makeControllerHarness({ script, configValues: { hooks, 'terminal.shell': TEST_SHELL }, ...extra });
  return h;
}
const notices = () => h!.events.filter((e): e is Extract<typeof e, { t: 'notice' }> => e.t === 'notice').map((e) => e.text);

describe('hooks — ChatController', () => {
  it('UserPromptSubmit chặn: tin nhắn không được gửi, model không bị gọi, nội dung quay lại ô nhập kèm lý do', async () => {
    boot([() => textTurn('không bao giờ tới')], { UserPromptSubmit: [{ hooks: [{ command: exits(2, 'từ khoá bị cấm') }] }] });
    await h!.send('đây là bí mật');
    await h!.idle();
    expect(h!.provider.requests).toHaveLength(0);
    expect(h!.shownUserTexts()).toEqual([]);
    expect(notices().join('\n')).toContain('từ khoá bị cấm');
    expect(h!.posted.some((m) => m.type === 'draft' && m.text === 'đây là bí mật')).toBe(true);
  });

  it('ngữ cảnh do hook UserPromptSubmit thêm đi cùng lượt tới model, không hiện như tin người dùng', async () => {
    boot([() => textTurn('ok')], { UserPromptSubmit: [{ hooks: [{ command: printsJson({ additionalContext: 'ghi chú từ hook: đang ở nhánh dev' }) }] }] });
    await h!.send('xin chào');
    await h!.idle();
    expect(JSON.stringify(h!.provider.requests[0].messages)).toContain('[Hook UserPromptSubmit] ghi chú từ hook: đang ở nhánh dev');
    expect(h!.shownUserTexts()).toEqual(['xin chào']);
  });

  it('extension hook đã nối vào engine của controller: PreToolUse chặn write_file, kèm dòng gọn trong lượt', async () => {
    boot([() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong')], {
      PreToolUse: [{ matcher: 'write_file', hooks: [{ command: exits(2, 'cấm ghi'), name: 'khoa' }] }],
    });
    await h!.send('ghi file');
    await h!.idle();
    expect(fs.existsSync(path.join(h!.dir, 'out.txt'))).toBe(false);
    expect(JSON.stringify(h!.provider.requests[1].messages)).toContain('cấm ghi');
    expect(h!.events.some((e) => e.t === 'pill' && /^Hook PreToolUse · khoa ✗ chặn \d+ ms$/.test(e.text))).toBe(true);
  });

  it('/hooks liệt kê hook đang hiệu lực kèm kết quả lần chạy gần nhất', async () => {
    boot([() => textTurn('ok'), () => textTurn('ok2')], { UserPromptSubmit: [{ hooks: [{ command: exits(0), name: 'nhat-ky' }] }] });
    await h!.send('chào');
    await h!.idle();
    await h!.send('/hooks');
    await h!.idle();
    const text = notices().join('\n');
    expect(text).toContain('locaithAgent.hooks');
    expect(text).toContain('nhat-ky');
    expect(text).toMatch(/lần gần nhất.*✓/);
  });

  it('SessionEnd chạy khi mở cuộc trò chuyện mới (một lần cho mỗi phiên)', async () => {
    const out = path.join(require('node:os').tmpdir(), `nd-sessionend-${Date.now()}.txt`);
    boot([() => textTurn('ok')], { SessionEnd: [{ hooks: [{ command: recordStdin(out) }] }], SessionStart: [{ hooks: [{ command: exits(0) }] }] });
    await h!.send('chào');
    await h!.idle();
    const sid = h!.session().id;
    await h!.send('/new');
    await h!.idle();
    await until(() => fs.existsSync(out), 'tệp SessionEnd');
    const ev = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(ev).toMatchObject({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
    fs.rmSync(out, { force: true });
  });

  it('Notification chạy khi có yêu cầu xin quyền', async () => {
    const out = path.join(require('node:os').tmpdir(), `nd-notif-${Date.now()}.txt`);
    boot([() => toolTurn([{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }]), () => textTurn('xong')], {
      Notification: [{ hooks: [{ command: recordStdin(out) }] }],
    });
    const sending = h!.send('ghi file');
    await until(() => fs.existsSync(out), 'tệp Notification');
    const ev = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(ev.hook_event_name).toBe('Notification');
    expect(ev.notification_type).toBe('permission_prompt');
    h!.stop();
    await sending;
    await h!.idle();
    fs.rmSync(out, { force: true });
  });

  it('hook dự án: hộp xác nhận hiện ĐẦY ĐỦ lệnh; được chấp nhận thì chạy, ghi nhớ theo băm', async () => {
    const prompts: Array<{ message: string; detail?: string }> = [];
    (window as Record<string, unknown>).showWarningMessage = async (message: string, opts: { detail?: string }, ...items: string[]) => {
      prompts.push({ message, detail: opts?.detail });
      return items[0];
    };
    const gs = new Map<string, unknown>();
    boot([() => toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'x' } }]), () => textTurn('xong'), () => toolTurn([{ name: 'write_file', input: { path: 'out2.txt', content: 'x' } }]), () => textTurn('xong')], undefined, { globalState: gs });
    const cmd = exits(2, 'dự án cấm ghi');
    writeProjectHooks(h!.dir, { PreToolUse: [{ matcher: 'write_file', hooks: [{ command: cmd }] }] });
    await h!.send('ghi file');
    await h!.idle();
    expect(fs.existsSync(path.join(h!.dir, 'out.txt'))).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].detail).toContain(cmd);
    expect(prompts[0].message).toContain('.locaith/settings.json');
    // lần chạy thứ hai: đã ghi nhớ → không hỏi lại, hook vẫn chạy
    await sleep(1700); // qua thời gian đệm của dịch vụ
    await h!.send('ghi file nữa');
    await h!.idle();
    expect(prompts).toHaveLength(1);
    expect(fs.existsSync(path.join(h!.dir, 'out2.txt'))).toBe(false);
  }, 60_000);

  it('hook dự án bị từ chối trong hộp xác nhận → không chạy', async () => {
    (window as Record<string, unknown>).showWarningMessage = async () => undefined;
    boot([() => toolTurn([{ name: 'read_file', input: { path: 'a.txt' } }]), () => textTurn('xong')], undefined, { globalState: new Map(), files: { 'a.txt': 'NOI-DUNG-A' } });
    writeProjectHooks(h!.dir, { PreToolUse: [{ hooks: [{ command: exits(2, 'chặn') }] }] });
    await h!.send('đọc file');
    await h!.idle();
    expect(JSON.stringify(h!.provider.requests[1].messages)).toContain('NOI-DUNG-A');
    expect(notices().join('\n')).toMatch(/chưa được xác nhận/);
  }, 60_000);
});
