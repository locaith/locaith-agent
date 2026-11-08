import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider, textTurn, toolTurn } from '../../helpers/fakeProvider';
import { cleanupDirs, harness, waitFor } from './harness';

afterEach(() => cleanupDirs());

describe('vòng công cụ', () => {
  it('chạy hai lượt: gọi read_file rồi trả lời, phát đủ sự kiện đúng thứ tự', async () => {
    const h = await harness({ script: [toolTurn([{ name: 'read_file', input: { path: 'sample.txt' } }]), textTurn('Tệp có 2 dòng.')] });
    await h.rt.submit('đọc sample.txt');
    await h.rt.idle();
    const ui = h.uiTypes();
    expect(ui[0]).toBe('run_state'); // setRunning(true) trước mọi thứ
    expect(ui).toContain('user');
    expect(ui.indexOf('assistant_start')).toBeGreaterThan(ui.indexOf('user'));
    expect(ui.indexOf('tool_start')).toBeLessThan(ui.indexOf('tool_end'));
    expect(ui.indexOf('tool_end')).toBeLessThan(ui.lastIndexOf('text'));
    expect(h.texts()).toContain('Tệp có 2 dòng.');
    expect(ui[ui.length - 1]).toBe('run_state');
    expect(h.provider.requests).toHaveLength(2);
    const st = h.rt.status();
    expect(st.running).toBe(false);
    expect(st.usage.input).toBeGreaterThan(0);
    expect(st.title).toContain('đọc sample.txt');
    // yêu cầu thứ hai mang kết quả công cụ của tệp thật
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('ALPHA');
    await h.cleanup();
  });

  it('status có ngữ cảnh, model, chế độ và số lần phát bị giới hạn', async () => {
    const h = await harness({ script: [textTurn('xin chào')] });
    await h.rt.submit('chào');
    await h.rt.idle();
    const st = h.rt.status();
    expect(st.version).toBe('9.9.9-test');
    expect(st.model).toBe('test-model');
    expect(st.mode).toBe('default');
    expect(st.context.window).toBeGreaterThan(0);
    expect(st.cwd).toBe(h.cwd);
    const n = h.events.filter((e) => e.t === 'status').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(30);
    await h.cleanup();
  });
});

describe('quyền', () => {
  const writeScript = () => [toolTurn([{ name: 'write_file', input: { path: 'out.txt', content: 'hello' } }]), textTurn('Đã ghi.')];

  it('cho phép: ghi tệp sau khi người dùng trả lời allow', async () => {
    const h = await harness({ script: writeScript(), autoPermission: () => ({ decision: 'allow' }) });
    await h.rt.submit('ghi tệp');
    await h.rt.idle();
    expect(fs.readFileSync(path.join(h.cwd, 'out.txt'), 'utf8')).toBe('hello');
    expect(h.events.some((e) => e.t === 'permission')).toBe(true);
    await h.cleanup();
  });

  it('từ chối: không ghi và model nhận phản hồi từ chối kèm lý do', async () => {
    const h = await harness({ script: writeScript(), autoPermission: () => ({ decision: 'deny', feedback: 'không được' }) });
    await h.rt.submit('ghi tệp');
    await h.rt.idle();
    expect(fs.existsSync(path.join(h.cwd, 'out.txt'))).toBe(false);
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('không được');
    await h.cleanup();
  });

  it('cho trong phiên: lần ghi thứ hai cùng khoá không hỏi lại', async () => {
    const script = [
      toolTurn([{ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: '1' } }]),
      toolTurn([{ id: 'c2', name: 'write_file', input: { path: 'a.txt', content: '2' } }]),
      textTurn('xong'),
    ];
    const h = await harness({ script, autoPermission: () => ({ decision: 'allow_session' }) });
    await h.rt.submit('ghi hai lần');
    await h.rt.idle();
    expect(fs.readFileSync(path.join(h.cwd, 'a.txt'), 'utf8')).toBe('2');
    expect(h.events.filter((e) => e.t === 'permission').length).toBeLessThanOrEqual(2);
    await h.cleanup();
  });

  it('interactive:false từ chối ngay (không treo) và nói rõ cách cho phép', async () => {
    const h = await harness({ script: writeScript(), interactive: false });
    await h.rt.submit('ghi tệp');
    await h.rt.idle();
    expect(fs.existsSync(path.join(h.cwd, 'out.txt'))).toBe(false);
    expect(h.events.some((e) => e.t === 'permission')).toBe(false);
    const sent = JSON.stringify(h.provider.requests[1].messages);
    expect(sent).toMatch(/TỪ CHỐI|DENIED/);
    expect(sent).toContain('--permission-mode');
    await h.cleanup();
  });

  it('acceptEdits tự nhận ghi tệp trong thư mục làm việc mà không hỏi', async () => {
    const h = await harness({ script: writeScript(), permissionMode: 'acceptEdits' });
    await h.rt.submit('ghi tệp');
    await h.rt.idle();
    expect(fs.readFileSync(path.join(h.cwd, 'out.txt'), 'utf8')).toBe('hello');
    expect(h.events.some((e) => e.t === 'permission')).toBe(false);
    await h.cleanup();
  });

  it('--disallowedTools chặn công cụ kể cả khi chế độ cho phép; --allowedTools bỏ câu hỏi lệnh', async () => {
    const h = await harness({
      script: [toolTurn([{ name: 'write_file', input: { path: 'x.txt', content: 'x' } }]), textTurn('ok')],
      permissionMode: 'acceptEdits',
      disallowedTools: ['write_file'],
    });
    await h.rt.submit('ghi');
    await h.rt.idle();
    expect(fs.existsSync(path.join(h.cwd, 'x.txt'))).toBe(false);
    await h.cleanup();

    const h2 = await harness({
      script: [toolTurn([{ name: 'run_command', input: { command: 'echo hi-from-rule' } }]), textTurn('ok')],
      interactive: false,
      allowedTools: ['run_command(echo *)'],
    });
    await h2.rt.submit('chạy');
    await h2.rt.idle();
    expect(JSON.stringify(h2.provider.requests[1].messages)).toContain('hi-from-rule');
    await h2.cleanup();
  });
});

describe('dừng giữa lượt', () => {
  it('interrupt() huỷ lượt đang chạy, từ chối quyền đang chờ và phát permission_cancel', async () => {
    const h = await harness({ script: [toolTurn([{ name: 'write_file', input: { path: 'w.txt', content: 'w' } }]), textTurn('không bao giờ tới'), textTurn('lại chạy được')] });
    await h.rt.submit('ghi');
    await waitFor(() => h.events.some((e) => e.t === 'permission'), 5000, 'yêu cầu quyền');
    h.rt.interrupt();
    await h.rt.idle();
    expect(h.events.some((e) => e.t === 'permission_cancel')).toBe(true);
    expect(fs.existsSync(path.join(h.cwd, 'w.txt'))).toBe(false);
    expect(h.rt.status().running).toBe(false);
    // Lịch sử sau khi dừng giữa vòng công cụ vẫn hợp lệ: lượt kế tiếp chạy được
    await h.rt.submit('tiếp tục');
    await h.rt.idle();
    expect(h.provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(h.rt.status().running).toBe(false);
    await h.cleanup();
  });

  it('hạn giờ mỗi lượt (timeoutSec) dừng lượt treo', async () => {
    const slow = new FakeProvider([
      async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return textTurn('muộn');
      },
    ]);
    const h = await harness({ provider: slow, timeoutSec: 0.3 });
    await h.rt.submit('chậm');
    await h.rt.idle();
    const notices = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'notice').map((e) => (e as { ev: { text: string } }).ev.text);
    expect(notices.some((n) => /quá hạn|ran past/.test(n))).toBe(true);
    await h.cleanup();
  }, 15_000);
});

describe('hàng đợi chen ngang', () => {
  it('tin gửi khi đang chạy được engine lấy ở ranh giới vòng công cụ (steering)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new FakeProvider([
      async () => {
        await gate; // giữ lượt đầu cho tới khi tin thứ hai đã xếp hàng
        return toolTurn([{ name: 'read_file', input: { path: 'sample.txt' } }]);
      },
      () => textTurn('đã đổi hướng'),
    ]);
    const h = await harness({ provider });
    await h.rt.submit('việc thứ nhất');
    await waitFor(() => h.rt.status().running);
    await h.rt.submit('đổi sang việc khác nhé');
    expect(h.rt.status().queued).toEqual(['đổi sang việc khác nhé']);
    release();
    await h.rt.idle();
    expect(h.rt.status().queued).toEqual([]);
    expect(JSON.stringify(h.provider.requests[1].messages)).toContain('đổi sang việc khác nhé');
    const users = h.events.filter((e) => e.t === 'ui' && e.ev.t === 'user').map((e) => (e as unknown as { ev: { text: string; steer?: boolean } }).ev);
    expect(users.map((u) => u.text)).toEqual(['việc thứ nhất', 'đổi sang việc khác nhé']);
    expect(users[1].steer).toBe(true);
    await h.cleanup();
  });

  it('dừng lượt thì tin đang chờ được trả về ô nhập (action insert), không tự gửi', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new FakeProvider([
      async () => {
        await gate;
        return textTurn('x');
      },
    ]);
    const h = await harness({ provider });
    await h.rt.submit('một');
    await waitFor(() => h.rt.status().running);
    await h.rt.submit('hai đang chờ');
    h.rt.interrupt();
    release();
    await h.rt.idle();
    const ins = h.events.find((e) => e.t === 'action' && e.action === 'insert') as { payload?: string } | undefined;
    expect(ins?.payload).toBe('hai đang chờ');
    expect(provider.requests).toHaveLength(1);
    await h.cleanup();
  });
});
