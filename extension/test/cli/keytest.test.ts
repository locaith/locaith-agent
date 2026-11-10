import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advise, keytest, showChunk, type KeytestFindings } from '../../src/cli/keytest';
import { parseArgs } from '../../src/cli/args';
import { helpTopicText, usageText } from '../../src/cli/help';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fakeStdin(tty = true) {
  const e = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (m: boolean) => unknown; setEncoding: () => unknown; resume: () => unknown; pause: () => unknown; raw: boolean };
  e.isTTY = tty;
  e.raw = false;
  e.setRawMode = (m: boolean) => ((e.raw = m), e);
  e.setEncoding = () => e;
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

const empty = (): KeytestFindings => ({ chunks: 1, sawBs08: false, sawBs7f: false, sawBsBurst: false, lone08: 0, bsRuns: 0, wordDeletes: 0, sawStandaloneMark: false, sawReplacementChar: false, escLetters: 0, sawPaste: false });

describe('locaith keytest', () => {
  it('là lệnh con hợp lệ và có trong trang trợ giúp (cả hai ngôn ngữ) + mục xử lý sự cố', () => {
    expect(parseArgs(['keytest']).command).toBe('keytest');
    expect(usageText('0.4.10', 'vi')).toContain('locaith keytest');
    expect(usageText('0.4.10', 'en')).toContain('locaith keytest');
    expect(helpTopicText('troubleshooting', 'vi')).toContain('keytest');
    expect(helpTopicText('troubleshooting', 'en')).toContain('keytest');
  });

  it('không có terminal (ống/CI) → báo rõ và mã 2, không treo', async () => {
    const lines: string[] = [];
    const code = await keytest({ version: '0.4.10', lang: 'vi', env: {}, platform: 'linux', stdin: fakeStdin(false) as never, out: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('terminal');
  });

  it('ghi từng gói, mô phỏng ô nhập như CLI thật, kết thúc bằng Ctrl+C và lưu tệp bản ghi', async () => {
    const stdin = fakeStdin();
    const lines: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const run = keytest({ version: '0.4.10', lang: 'vi', env: { WT_SESSION: 'x' }, platform: 'win32', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 30 });
    await sleep(20);
    expect(stdin.raw).toBe(true);
    stdin.emit('data', 'vie');
    stdin.emit('data', '\x08ê'); // Vietkey: xoá «e» rồi gõ «ê» (Windows Terminal: CLI hiểu 0x08 là Ctrl+Backspace NẾU đứng một mình — ở đây có chữ theo sau)
    stdin.emit('data', 't');
    stdin.emit('data', '\x03');
    expect(await run).toBe(0);
    expect(stdin.raw).toBe(false);
    const all = lines.join('\n');
    expect(all).toContain('ô nhập: viê');
    expect(all).toContain('ô nhập: viêt');
    expect(all).toContain('08 c3 aa'); // byte thật của gói «\b ê»
    expect(all).toContain('\\bê');
    expect(all).toContain('Ô nhập cuối cùng: viêt');
    expect(all).toContain('Backspace và chữ đến cùng một gói');
    const file = path.join(home, '.locaith', 'keytest.txt');
    const saved = fs.readFileSync(file, 'utf8');
    expect(saved).toContain('Locaith CLI 0.4.10 — keytest');
    expect(saved).toContain('08 c3 aa');
    expect(saved).toContain('"viêt"');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('dấu RỜI (Unicode tổ hợp) được ghép và nhận xét nêu đúng bảng mã; Backspace 0x7f được nhận ra', async () => {
    const stdin = fakeStdin();
    const lines: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const run = keytest({ version: '0.4.10', lang: 'vi', env: {}, platform: 'linux', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 30 });
    await sleep(20);
    stdin.emit('data', 'Vie');
    stdin.emit('data', '̂'); // mũ rời
    stdin.emit('data', '̣'); // chấm dưới rời
    stdin.emit('data', '\x7f'); // bỏ chấm
    stdin.emit('data', '\x03');
    expect(await run).toBe(0);
    const all = lines.join('\n');
    expect(all).toContain('Ô nhập cuối cùng: Viê');
    expect(all).toContain('DẤU RỜI');
    expect(all).toContain('0x7f');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('Windows Terminal đã gửi 0x7f cho Backspace thường: 0x08 đứng một mình được quyết sau thời gian chờ (Ctrl+Backspace thật) và hiện "hết hạn chờ"', async () => {
    const stdin = fakeStdin();
    const lines: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const run = keytest({ version: '0.4.11', lang: 'vi', env: { WT_SESSION: 'x' }, platform: 'win32', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 30 });
    await sleep(20);
    stdin.emit('data', 'tiếng việt');
    stdin.emit('data', '\x7f'); // Backspace thường: terminal chứng tỏ gửi 0x7f
    stdin.emit('data', '\x08');
    await sleep(160);
    stdin.emit('data', '\x03');
    expect(await run).toBe(0);
    const all = lines.join('\n');
    expect(all).toContain('hết hạn chờ');
    expect(all).toContain('ctrl+backspace');
    expect(all).toContain('Ô nhập cuối cùng: tiếng ');
    expect(all).toContain('đứng một mình');
    expect(all).toContain('CLI đã xoá cả từ 1 lần');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('0.4.11 — Windows Terminal + bộ gõ gửi Backspace thành 0x08 đứng một mình (chưa thấy 0x7f): xoá đúng 1 chữ mỗi lần, nhận xét giải thích', async () => {
    const stdin = fakeStdin();
    const lines: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const run = keytest({ version: '0.4.11', lang: 'vi', env: { WT_SESSION: 'x' }, platform: 'win32', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 30 });
    await sleep(20);
    stdin.emit('data', 'tiếng việt');
    stdin.emit('data', '\x08');
    stdin.emit('data', '\x08');
    stdin.emit('data', '\x03');
    expect(await run).toBe(0);
    const all = lines.join('\n');
    expect(all).toContain('ô nhập: tiếng việ');
    expect(all).toContain('Ô nhập cuối cùng: tiếng vi');
    expect(all).toContain('Có 2 gói 0x08 đứng một mình');
    expect(all).toContain('coi là Backspace thường');
    expect(all).not.toContain('CLI đã xoá cả từ');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('0.4.11 — bộ gõ bù N Backspace (nhiều Backspace trong MỘT gói) cho chữ có dấu rời: mỗi lần nhấn mất đúng 1 chữ và nhận xét nêu rõ', async () => {
    const stdin = fakeStdin();
    const lines: string[] = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const run = keytest({ version: '0.4.11', lang: 'vi', env: { WT_SESSION: 'x' }, platform: 'win32', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 30 });
    await sleep(20);
    stdin.emit('data', 'Vie');
    stdin.emit('data', '̂');
    stdin.emit('data', '̣'); // ệ = e + mũ + chấm (3 điểm mã)
    stdin.emit('data', 'tn');
    stdin.emit('data', '\x08'); // n
    stdin.emit('data', '\x08'); // t
    stdin.emit('data', '\x08\x08\x08'); // bộ gõ bù 3 Backspace cho ệ
    stdin.emit('data', '\x03');
    expect(await run).toBe(0);
    const all = lines.join('\n');
    expect(all).toContain('Ô nhập cuối cùng: Vi');
    expect(all).toContain('Có 1 gói gồm nhiều Backspace liền nhau');
    expect(all).toContain('ĐIỂM MÃ');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('hết thời gian im lặng thì tự kết thúc (không treo vô hạn)', async () => {
    const stdin = fakeStdin();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-keytest-'));
    const lines: string[] = [];
    const t0 = Date.now();
    const code = await keytest({ version: '0.4.10', lang: 'en', env: {}, platform: 'linux', stdin: stdin as never, out: (l) => lines.push(l), home, idleSeconds: 0.15 });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(lines.join('\n')).toContain('No keys received');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('showChunk: điều khiển và dấu kết hợp đọc được', () => {
    expect(showChunk('\x08ê')).toBe('\\bê');
    expect(showChunk('\x7f')).toBe('<DEL>');
    expect(showChunk('\x1bb')).toBe('<ESC>b');
    expect(showChunk('ê')).toBe('e◌̂');
  });

  it('advise: nêu từng dấu hiệu, tiếng Anh cũng có', () => {
    expect(advise({ ...empty(), sawBs08: true }, 'ctrl-backspace', 'vi').join(' ')).toContain('0x08');
    expect(advise({ ...empty(), sawBs08: true, lone08: 2 }, 'backspace', 'en').join(' ')).toContain('plain Backspace');
    expect(advise({ ...empty(), sawBs08: true, sawBs7f: true, lone08: 1 }, 'ctrl-backspace', 'en').join(' ')).toContain('LOCAITH_CTRL_H=backspace');
    expect(advise({ ...empty(), bsRuns: 2 }, 'ctrl-backspace', 'en').join(' ')).toContain('CODE POINT');
    expect(advise({ ...empty(), wordDeletes: 3 }, 'ctrl-backspace', 'en').join(' ')).toContain('whole word 3 time');
    expect(advise({ ...empty(), sawReplacementChar: true }, 'backspace', 'vi').join(' ')).toContain('TCVN3');
    expect(advise({ ...empty(), escLetters: 3 }, 'backspace', 'en').join(' ')).toContain('Alt');
    expect(advise({ ...empty(), sawPaste: true }, 'backspace', 'en').join(' ')).toContain('paste');
    expect(advise(empty(), 'backspace', 'vi').join(' ')).toContain('Không thấy dấu hiệu');
  });
});
