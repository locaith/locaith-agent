/**
 * `locaith keytest` — ghi lại CHÍNH XÁC những gì terminal + bộ gõ (Vietkey, UniKey, EVKey, OpenKey…) gửi tới CLI khi bạn gõ, rồi cho biết ô nhập của CLI sẽ hiện gì.
 *
 * Dùng khi «gõ tiếng Việt bị mất chữ» mà không tái hiện được trên máy khác: mỗi bộ gõ đẩy Backspace / dấu / chữ vào console theo cách riêng (byte 0x08 hay 0x7f, dấu rời hay chữ dựng sẵn,
 * một gói hay nhiều gói), nên chỉ có dữ liệu thật của máy đó mới chỉ ra chỗ hỏng. Chỉ ghi các phím gõ TRONG LÚC chạy lệnh này; không gửi đi đâu — tệp lưu ở ~/.locaith/keytest.txt để người dùng tự đính kèm.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './credentials';
import type { Lang } from './i18n';
import { Editor } from './tui/editor';
import { KeyParser, ctrlHMode, describeKey, type KeyEvent } from './tui/keys';

export interface KeytestOptions {
  version: string;
  lang: Lang;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdin: Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'setEncoding' | 'resume' | 'pause' | 'on' | 'off'>;
  out(line: string): void;
  /** Thư mục nhà (kiểm thử). */
  home?: string;
  /** Hết thời gian im lặng (giây) thì tự kết thúc; mặc định 300. */
  idleSeconds?: number;
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARK = /^\p{M}$/u;

/** Chuỗi hiển thị được cho một gói byte: điều khiển → \b, ESC, ^?, \xNN; dấu kết hợp → ◌ + dấu. */
export function showChunk(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x08) out += '\\b';
    else if (c === 0x7f) out += '<DEL>';
    else if (c === 0x1b) out += '<ESC>';
    else if (c === 0x0d) out += '<CR>';
    else if (c === 0x0a) out += '<LF>';
    else if (c === 0x09) out += '<TAB>';
    else if (c < 0x20) out += `<^${String.fromCharCode(64 + c)}>`;
    else if (MARK.test(ch)) out += `◌${ch}`;
    else out += ch;
  }
  return out;
}

const hex = (s: string): string => [...Buffer.from(s, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const cps = (s: string): string => [...s].map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

export interface KeytestFindings {
  chunks: number;
  sawBs08: boolean;
  sawBs7f: boolean;
  /** 0x08 đến CÙNG GÓI với chữ khác (dấu hiệu bộ gõ «xoá + gõ lại»). */
  sawBsBurst: boolean;
  /** Số gói chỉ gồm ĐÚNG MỘT 0x08 (Backspace của người dùng đi qua bộ gõ, hoặc Ctrl+Backspace thật). */
  lone08: number;
  /** Số gói chỉ gồm ≥ 2 byte Backspace liền nhau (bộ gõ bù N Backspace cho chữ gồm N điểm mã). */
  bsRuns: number;
  /** Số lần CLI hiểu một phím là «xoá cả từ» (Ctrl/Alt+Backspace). */
  wordDeletes: number;
  sawStandaloneMark: boolean;
  sawReplacementChar: boolean;
  /** Số gói ESC + chữ ASCII (Alt dính). */
  escLetters: number;
  sawPaste: boolean;
}

/** Nhận xét tự động từ dữ liệu thu được — cho người dùng đọc ngay và cho người hỗ trợ đọc nhanh. */
export function advise(f: KeytestFindings, mode: 'backspace' | 'ctrl-backspace', lang: Lang): string[] {
  const vi = lang !== 'en';
  const out: string[] = [];
  if (f.chunks === 0) return [vi ? 'Không nhận được phím nào — terminal có thể không chuyển phím vào chương trình (thử cmd.exe / Windows Terminal thường, không qua SSH).' : 'No keys received — the terminal may not be passing keys to programs (try plain cmd.exe / Windows Terminal, not over SSH).'];
  if (f.sawBs08) out.push(vi ? `Backspace đến dưới dạng byte 0x08. CLI đang hiểu 0x08 là «${mode === 'backspace' ? 'Backspace thường' : 'Ctrl+Backspace, trừ khi liền ngay chữ theo sau (bộ gõ)'}».` : `Backspace arrives as byte 0x08. The CLI treats 0x08 as "${mode === 'backspace' ? 'plain Backspace' : 'Ctrl+Backspace unless a character follows right away (an input method)'}".`);
  if (f.sawBs7f) out.push(vi ? 'Backspace đến dưới dạng byte 0x7f (Backspace thường).' : 'Backspace arrives as byte 0x7f (plain Backspace).');
  if (f.lone08 > 0) {
    const how =
      mode === 'backspace'
        ? vi ? 'CLI coi là Backspace thường (xoá 1 chữ).' : 'The CLI treats it as plain Backspace (deletes one character).'
        : f.sawBs7f && !f.sawBsBurst
          ? vi ? 'Terminal cũng gửi 0x7f cho Backspace thường nên CLI hiểu 0x08 đứng một mình là Ctrl+Backspace (xoá cả từ). Nếu chỉ nhấn Backspace mà mất cả từ: đặt LOCAITH_CTRL_H=backspace.' : 'The terminal also sends 0x7f for plain Backspace, so the CLI reads a lone 0x08 as Ctrl+Backspace (deletes a word). If plain Backspace removes whole words, set LOCAITH_CTRL_H=backspace.'
          : vi ? 'Chưa thấy terminal gửi 0x7f (hoặc bộ gõ đã dùng 0x08 làm Backspace) nên CLI coi là Backspace thường (xoá 1 chữ).' : 'The terminal has not sent 0x7f yet (or the input method already uses 0x08 as Backspace), so the CLI treats it as plain Backspace (deletes one character).';
    out.push(vi ? `Có ${f.lone08} gói 0x08 đứng một mình (Backspace vừa nhấn đi qua bộ gõ, hoặc Ctrl+Backspace). ${how}` : `${f.lone08} chunk(s) were a lone 0x08 (the Backspace you pressed passing through the input method, or Ctrl+Backspace). ${how}`);
  }
  if (f.bsRuns > 0) out.push(vi ? `Có ${f.bsRuns} gói gồm nhiều Backspace liền nhau: bộ gõ tính số Backspace theo ĐIỂM MÃ của chữ (chữ có dấu rời = 2–3 điểm mã). CLI xoá đúng từng điểm mã nên mỗi lần nhấn chỉ mất 1 chữ.` : `${f.bsRuns} chunk(s) were several Backspaces in a row: the input method counts Backspaces per CODE POINT of the letter (a letter with loose marks is 2–3 code points). The CLI removes exactly one code point each, so one key press removes one letter.`);
  if (f.wordDeletes > 0) out.push(vi ? `CLI đã xoá cả từ ${f.wordDeletes} lần (Ctrl/Alt+Backspace). Nếu chỉ nhấn Backspace thường thì đây là lỗi: gửi tệp ghi cho em.` : `The CLI deleted a whole word ${f.wordDeletes} time(s) (Ctrl/Alt+Backspace). If you only pressed plain Backspace that is a bug: send the log file.`);
  if (f.sawBsBurst) out.push(vi ? 'Bộ gõ đang dùng kiểu «Backspace rồi gõ lại chữ có dấu» (Backspace và chữ đến cùng một gói).' : 'The input method uses "Backspace, then retype the accented letter" (both arrive in one chunk).');
  if (f.sawStandaloneMark) out.push(vi ? 'Bộ gõ gửi DẤU RỜI (Unicode tổ hợp). CLI ghép lại thành chữ dựng sẵn; nếu vẫn lỗi, đổi bảng mã của bộ gõ sang «Unicode dựng sẵn» (Unicode) rồi thử lại.' : 'The input method sends loose combining marks (decomposed Unicode). The CLI recombines them; if it still fails, switch the input method to precomposed Unicode and retry.');
  if (f.sawReplacementChar) out.push(vi ? 'Có ký tự lỗi «�»: bộ gõ có thể đang ở bảng mã cũ (TCVN3, VNI, VPS…). Đổi sang Unicode.' : 'There are "�" characters: the input method may be on a legacy code table (TCVN3, VNI, VPS…). Switch to Unicode.');
  if (f.escLetters >= 2) out.push(vi ? 'Chữ đến kèm tiền tố ESC (như đang giữ Alt). Phím Alt có thể đang bị kẹt — nhấn rồi nhả Alt, hoặc đổi phím chuyển ngôn ngữ.' : 'Letters arrive with an ESC prefix (as if Alt were held). Alt may be stuck — press and release Alt, or change the language-switch hotkey.');
  if (f.sawPaste) out.push(vi ? 'Có gói được nhận là «dán» (bracketed paste): bộ gõ có thể đưa chữ vào bằng Ctrl+V.' : 'Some input arrived as a paste (bracketed paste): the input method may insert text via Ctrl+V.');
  if (out.length === 0) out.push(vi ? 'Không thấy dấu hiệu bất thường trong các phím vừa gõ.' : 'Nothing unusual in the keys just typed.');
  return out;
}

function winCodePage(platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return undefined;
  try {
    const r = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const m = /(\d{3,5})/.exec(r.stdout ?? '');
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Chạy bài thử. Trả mã thoát (0 = xong; 2 = không có terminal). */
export async function keytest(o: KeytestOptions): Promise<number> {
  const vi = o.lang !== 'en';
  const say = (l: string): void => o.out(l);
  if (!o.stdin.isTTY) {
    say(vi ? '✘ keytest cần chạy trong terminal thật (cmd.exe, PowerShell, Windows Terminal…), không chạy qua ống/CI.' : '✘ keytest needs a real terminal (cmd.exe, PowerShell, Windows Terminal…), not a pipe/CI.');
    return 2;
  }
  const mode = ctrlHMode(o.env, o.platform);
  const strict = (o.env.LOCAITH_CTRL_H ?? '').trim().toLowerCase() === 'ctrl-backspace';
  const codePage = winCodePage(o.platform);
  const header = [
    `Locaith CLI ${o.version} — keytest`,
    `Hệ điều hành: ${o.platform} ${os.release()} · Node ${process.version}`,
    `Terminal: WT_SESSION=${o.env.WT_SESSION ? 'có' : 'không'} · TERM_PROGRAM=${o.env.TERM_PROGRAM ?? '-'} · TERM=${o.env.TERM ?? '-'} · ConEmuPID=${o.env.ConEmuPID ? 'có' : 'không'} · LOCAITH_CTRL_H=${o.env.LOCAITH_CTRL_H ?? '-'}`,
    `CLI hiểu byte 0x08 là: ${mode === 'backspace' ? 'Backspace thường' : strict ? 'Ctrl+Backspace (trừ khi có chữ theo sau)' : 'Backspace thường; chỉ là Ctrl+Backspace khi terminal đã gửi 0x7f cho Backspace và 0x08 đứng một mình'}` + (codePage ? ` · code page console ${codePage}` : ''),
  ];
  for (const l of header) say(l);
  say('');
  say(
    vi
      ? 'Bật bộ gõ tiếng Việt (Vietkey…) rồi gõ vài từ có dấu, ví dụ:  Tieengs Vieetj   dduwowcj   hoafng   (nhớ thử cả sửa dấu: tieesf), rồi NHẤN Backspace vài lần để xoá chính các chữ có dấu vừa gõ.\nMỗi dòng dưới đây là MỘT gói phím terminal gửi tới CLI. Nhấn Ctrl+C khi xong.'
      : 'Turn on your Vietnamese input method and type a few accented words, e.g.  Tieengs Vieetj   dduwowcj   hoafng   (also try a correction: tieesf), then PRESS Backspace a few times to delete those accented letters.\nEach line below is ONE chunk of keys the terminal sent to the CLI. Press Ctrl+C when done.',
  );
  say('');

  const log: string[] = [...header, ''];
  const f: KeytestFindings = { chunks: 0, sawBs08: false, sawBs7f: false, sawBsBurst: false, lone08: 0, bsRuns: 0, wordDeletes: 0, sawStandaloneMark: false, sawReplacementChar: false, escLetters: 0, sawPaste: false };
  const parser = new KeyParser({ ctrlH: mode, deferCtrlH: true, ...(strict ? { strictCtrlH: true } : {}) });
  const ed = new Editor();
  let last = Date.now();
  let finished = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const apply = (e: KeyEvent): string => {
    if (e.type === 'paste') {
      f.sawPaste = true;
      ed.insert(e.text);
      return `dán ${JSON.stringify(e.text)}`;
    }
    const k = e.key;
    if (k.name === 'backspace') {
      if (k.ctrl || k.alt) {
        f.wordDeletes++;
        ed.deleteWordBack();
      } else ed.backspace();
      return describeKey(k);
    }
    if (k.name === 'char') {
      if (k.ctrl && k.text === 'c') {
        finished = true;
        return 'Ctrl+C';
      }
      if (k.ctrl) return `${describeKey(k)} (phím tắt)`;
      const text = k.text ?? '';
      if (k.alt && !NON_ASCII.test(text)) return `${describeKey(k)} (phím tắt Alt, không chèn chữ)`;
      ed.insert(text);
      return `chèn ${JSON.stringify(text)}`;
    }
    return describeKey(k);
  };

  const report = (chunk: string, evs: KeyEvent[]): void => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    const acts = evs.map(apply);
    const shown = ed.text.replace(/\n/g, '⏎');
    // Dòng trên màn hình ngắn (cmd 80 cột vẫn đọc được); bản ghi lưu thêm các điểm mã.
    const core = chunk === '' ? '(hết hạn chờ)' : `${hex(chunk).padEnd(14)} ${showChunk(chunk)}`;
    const tail = `→ ${acts.length ? acts.join(', ') : '(chờ gói sau)'} | ô nhập: ${shown}`;
    say(`+${dt}ms  ${core}  ${tail}`);
    log.push(`+${dt}ms  ${core}  ${chunk === '' ? '' : cps(chunk) + '  '}${tail}`);
  };

  const onData = (d: string | Buffer): void => {
    const chunk = typeof d === 'string' ? d : d.toString('utf8');
    if (finished) return;
    f.chunks++;
    if (chunk === '\x08') f.lone08++;
    if (/^[\x08\x7f]{2,}$/.test(chunk)) f.bsRuns++;
    if (chunk.includes('\x08')) {
      f.sawBs08 = true;
      if (/[^\x08\x7f]/.test(chunk)) f.sawBsBurst = true; // Backspace CÙNG GÓI với chữ khác (nhiều Backspace liền nhau thuần không tính)
    }
    if (chunk.includes('\x7f')) {
      f.sawBs7f = true;
      if (/[^\x08\x7f]/.test(chunk)) f.sawBsBurst = true; // Backspace CÙNG GÓI với chữ khác (nhiều Backspace liền nhau thuần không tính)
    }
    if (/\p{M}/u.test(chunk)) f.sawStandaloneMark = true;
    if (chunk.includes('�')) f.sawReplacementChar = true;
    if (/^\x1b[A-Za-z]$/.test(chunk)) f.escLetters++;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    report(chunk, parser.feed(chunk));
    if (parser.pending) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const evs = parser.flush();
        if (evs.length) report('', evs);
        if (finished) resolveDone();
      }, parser.pendingMs(30));
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finished = true;
      resolveDone();
    }, (o.idleSeconds ?? 300) * 1000);
    if (finished) resolveDone();
  };

  try {
    o.stdin.setRawMode?.(true);
  } catch {
    /* không đặt được raw mode */
  }
  o.stdin.setEncoding?.('utf8');
  o.stdin.on('data', onData);
  o.stdin.resume?.();
  last = Date.now();
  idleTimer = setTimeout(() => {
    finished = true;
    resolveDone();
  }, (o.idleSeconds ?? 300) * 1000);
  await done;
  if (flushTimer) clearTimeout(flushTimer);
  if (idleTimer) clearTimeout(idleTimer);
  o.stdin.off('data', onData);
  try {
    o.stdin.setRawMode?.(false);
  } catch {
    /* bỏ qua */
  }
  o.stdin.pause?.();

  say('');
  const notes = advise(f, mode, o.lang);
  log.push('', vi ? 'Nhận xét tự động:' : 'Automatic notes:', ...notes.map((n) => '  • ' + n), '', `${vi ? 'Ô nhập cuối cùng' : 'Final input box'}: ${JSON.stringify(ed.text)}`, `${vi ? 'Điểm mã' : 'Code points'}: ${cps(ed.text)}`);
  say(vi ? 'Nhận xét tự động:' : 'Automatic notes:');
  for (const n of notes) say('  • ' + n);
  say('');
  say(`${vi ? 'Ô nhập cuối cùng' : 'Final input box'}: ${ed.text}`);
  const file = path.join(o.home ?? homeDir(o.env), '.locaith', 'keytest.txt');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, log.join('\n') + '\n', 'utf8');
    say(vi ? `Đã lưu bản ghi: ${file}\nGửi tệp này khi báo lỗi (chỉ chứa các phím vừa gõ trong bài thử này; không có mật khẩu hay nội dung khác).` : `Saved the log: ${file}\nAttach it when reporting (it only contains the keys you just typed in this test; no passwords or other content).`);
  } catch (err) {
    say((vi ? 'Không ghi được tệp bản ghi: ' : 'Could not write the log file: ') + (err instanceof Error ? err.message : String(err)));
  }
  return 0;
}
