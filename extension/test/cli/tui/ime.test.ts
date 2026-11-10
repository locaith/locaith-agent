/**
 * Bộ gõ tiếng Việt (UniKey / EVKey / OpenKey / Vietkey…) trong ô nhập của CLI: mô phỏng CÁCH các bộ gõ đẩy phím vào console rồi kiểm ô nhập ra đúng chữ.
 *
 * Bộ gõ trên Windows không dùng vùng soạn thảo (composition) ở console: với mỗi phím nó tính lại «từ đang gõ», so với từ đã hiện, rồi gửi N phím Backspace + phần đuôi mới.
 * Chỗ khác nhau giữa các bộ gõ (và là nguồn của lỗi «gõ có dấu là mất chữ»):
 *   • bảng mã: Unicode DỰNG SẴN (ê = 1 ký tự) hay Unicode TỔ HỢP (ê = e + U+0302; N Backspace tính theo ĐIỂM MÃ, mỗi lần xoá một điểm mã — như Notepad/Word);
 *   • Backspace đến bằng byte 0x7f hay 0x08 (0x08 ở console cổ điển HOẶC khi bộ gõ đẩy WM_CHAR(8) vào Windows Terminal);
 *   • Backspace và chữ mới đến CÙNG một gói hay hai gói liền nhau;
 *   • (0.4.11) khi NGƯỜI DÙNG nhấn Backspace, bộ gõ nuốt phím rồi gửi lại N Backspace (N = số điểm mã của chữ cuối theo cách NÓ đếm: ệ = 1, 2 hoặc 3) — có khi thành 0x08 đứng một mình.
 *     Mỗi lần nhấn phải mất đúng MỘT chữ nhìn thấy; xoá thừa là «một lần nhấn mất cả cụm».
 */
import { afterEach, describe, expect, it } from 'vitest';
import { boot, type Booted } from './helpers/boot';
import { sleep } from './helpers/vt';

type Model = 'dựng-sẵn' | 'dựng-sẵn-gõ-lại-cả-từ' | 'tổ-hợp-chuẩn' | 'tổ-hợp-theo-thứ-tự-gõ' | 'tổ-hợp-chỉ-dấu-thanh';
type Chunking = 'cùng-gói' | 'tách-gói' | 'từng-phím';

/** Từng bước «từ đang hiện» sau mỗi phím Telex. */
const WORDS: Array<{ keys: string; steps: string[] }> = [
  { keys: 'Vieejt', steps: ['V', 'Vi', 'Vie', 'Viê', 'Việ', 'Việt'] },
  { keys: 'tieesng', steps: ['t', 'ti', 'tie', 'tiê', 'tiế', 'tiến', 'tiếng'] },
  { keys: 'dduwowcj', steps: ['d', 'đ', 'đu', 'đư', 'đưo', 'đươ', 'đươc', 'được'] },
  { keys: 'hoafng', steps: ['h', 'ho', 'hoa', 'hoà', 'hoàn', 'hoàng'] },
  // đổi dấu thanh giữa chừng (ế → ề): bộ gõ tổ hợp xoá ĐÚNG dấu sắc rồi gõ dấu huyền
  { keys: 'tieesf', steps: ['t', 'ti', 'tie', 'tiê', 'tiế', 'tiề'] },
  { keys: 'nguwowfi', steps: ['n', 'ng', 'ngu', 'ngư', 'ngưo', 'ngươ', 'người'] },
];

const MODS = new Set(['̂', '̆', '̛']); // mũ, trăng, móc — gõ TRƯỚC dấu thanh
const TONES = new Set(['̀', '́', '̉', '̃', '̣']); // huyền, sắc, hỏi, ngã, nặng

/** «Unicode tổ hợp» kiểu UniKey/EVKey: chữ có mũ/trăng/móc (â ê ô ơ ư ă) vẫn DỰNG SẴN, chỉ 5 dấu thanh là dấu rời (ế = ê + ◌́, ệ = ê + ◌̣). */
const compoundTones = (display: string): string[] => {
  const out: string[] = [];
  for (const ch of [...display.normalize('NFC')]) {
    const nfd = [...ch.normalize('NFD')];
    const tones = nfd.filter((c) => TONES.has(c));
    out.push(...[...nfd.filter((c) => !TONES.has(c)).join('').normalize('NFC')], ...tones);
  }
  return out;
};

const sequence = (display: string, model: Model): string[] => {
  if (model === 'dựng-sẵn' || model === 'dựng-sẵn-gõ-lại-cả-từ') return [...display.normalize('NFC')];
  if (model === 'tổ-hợp-chỉ-dấu-thanh') return compoundTones(display);
  const out: string[] = [];
  for (const cp of [...display.normalize('NFD')]) {
    if (/^\p{M}$/u.test(cp)) out.push(cp);
    else out.push(cp);
  }
  if (model === 'tổ-hợp-chuẩn') return out;
  // thứ tự gõ: chữ gốc, các dấu biến âm (mũ/trăng/móc), rồi dấu thanh
  const res: string[] = [];
  let i = 0;
  while (i < out.length) {
    const base = out[i++];
    const marks: string[] = [];
    while (i < out.length && /^\p{M}$/u.test(out[i])) marks.push(out[i++]);
    res.push(base, ...marks.filter((m) => MODS.has(m)), ...marks.filter((m) => !MODS.has(m)));
  }
  return res;
};

/** Bộ gõ: từ hiện trước → từ hiện sau ⇒ [số Backspace, chuỗi gõ thêm]. */
function plan(prev: string, next: string, model: Model): [number, string] {
  const a = sequence(prev, model);
  const b = sequence(next, model);
  if (model === 'dựng-sẵn-gõ-lại-cả-từ') return a.join('') === b.join('') ? [0, ''] : b.join('').startsWith(a.join('')) ? [0, b.join('').slice(a.join('').length)] : [a.length, b.join('')];
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return [a.length - k, b.slice(k).join('')];
}

async function typeWord(b: Booted, w: { keys: string; steps: string[] }, model: Model, bs: string, chunking: Chunking): Promise<void> {
  let prev = '';
  for (const step of w.steps) {
    const [n, add] = plan(prev, step, model);
    const back = bs.repeat(n);
    if (n === 0) {
      if (add) b.inp.type(add);
    } else if (chunking === 'cùng-gói') {
      b.inp.type(back + add);
    } else if (chunking === 'tách-gói') {
      b.inp.type(back);
      await sleep(2);
      if (add) b.inp.type(add);
    } else {
      for (let i = 0; i < n; i++) {
        b.inp.type(bs);
        await sleep(1);
      }
      if (add) for (const ch of [...add]) {
        b.inp.type(ch);
        await sleep(1);
      }
    }
    await sleep(2);
    prev = step;
  }
}

let b: Booted | null = null;
afterEach(async () => {
  if (b) {
    b.app.exit(0);
    await b.done.catch(() => undefined);
    b = null;
  }
});

const MODELS: Model[] = ['dựng-sẵn', 'dựng-sẵn-gõ-lại-cả-từ', 'tổ-hợp-chuẩn', 'tổ-hợp-theo-thứ-tự-gõ', 'tổ-hợp-chỉ-dấu-thanh'];
const CHUNKINGS: Chunking[] = ['cùng-gói', 'tách-gói', 'từng-phím'];

/**
 * Người dùng NHẤN Backspace để xoá một chữ đã gõ. Bộ gõ nuốt phím đó và tự gửi lại đúng số Backspace theo CÁCH NÓ ĐẾM điểm mã của chữ cuối
 * (ệ dựng sẵn = 1; ệ = ê + ◌̣ = 2; ệ = e + ◌̂ + ◌̣ = 3). Ô nhập phải xoá đúng MỘT chữ nhìn thấy mỗi lần nhấn — không xoá thừa chữ đứng trước («mất cả một cụm»).
 */
async function pressBackspaceKey(b: Booted, display: string, model: Model, bs: string, chunking: Chunking): Promise<string> {
  const letters = [...display.normalize('NFC')];
  const last = letters.pop()!;
  const n = sequence(last, model).length;
  if (chunking === 'từng-phím') {
    for (let i = 0; i < n; i++) {
      b.inp.type(bs);
      await sleep(1);
    }
  } else b.inp.type(bs.repeat(n));
  await sleep(4);
  return letters.join('');
}

describe('xoá bằng phím Backspace thật — bộ gõ tự bù số Backspace theo điểm mã của chữ: mỗi lần nhấn mất đúng MỘT chữ', () => {
  const TEXT = [WORDS[0], WORDS[1]]; // «Việt tiếng»
  for (const ctrlH of ['backspace', 'ctrl-backspace'] as const) {
    for (const bs of ['\x7f', '\x08']) {
      for (const model of MODELS.filter((m) => m !== 'dựng-sẵn-gõ-lại-cả-từ')) {
        for (const chunking of ['cùng-gói', 'từng-phím'] as const) {
          it(`${model} · Backspace=${bs === '\x7f' ? '0x7f' : '0x08'} · terminal hiểu 0x08 là ${ctrlH} · ${chunking}`, async () => {
            b = await boot({ app: { ctrlH } });
            let shown = '';
            for (const w of TEXT) {
              await typeWord(b, w, model, bs, 'cùng-gói');
              shown += w.steps[w.steps.length - 1];
              if (w !== TEXT[TEXT.length - 1]) {
                b.inp.type(' ');
                shown += ' ';
                await sleep(2);
              }
            }
            await sleep(100);
            expect(b.app.editor.text.normalize('NFC')).toBe(shown.normalize('NFC'));
            while (shown.length) {
              const before = shown;
              shown = await pressBackspaceKey(b, shown, model, bs, chunking);
              expect(b.app.editor.text.normalize('NFC'), `sau khi nhấn Backspace trên «${before}»`).toBe(shown.normalize('NFC'));
            }
            await sleep(120); // mọi quyết định chờ (nếu có) đã hết hạn: vẫn phải rỗng
            expect(b.app.editor.text).toBe('');
          }, 20000);
        }
      }
    }
  }
});

describe('bộ gõ tiếng Việt kiểu «Backspace + chữ mới» — mọi kiểu bảng mã × byte Backspace × cách chia gói', () => {
  for (const ctrlH of ['backspace', 'ctrl-backspace'] as const) {
    for (const bs of ['\x7f', '\x08']) {
      for (const model of MODELS) {
        for (const chunking of CHUNKINGS) {
          it(`${model} · Backspace=${bs === '\x7f' ? '0x7f' : '0x08'} · terminal hiểu 0x08 là ${ctrlH} · ${chunking}`, async () => {
            b = await boot({ app: { ctrlH, escTimeoutMs: 800 } }); // chờ lâu: kết quả không phụ thuộc máy CI chậm (chữ luôn đến trước hạn chờ)
            const words: string[] = [];
            for (const w of WORDS) {
              await typeWord(b, w, model, bs, chunking);
              words.push(w.steps[w.steps.length - 1]);
              b.inp.type(' ');
              await sleep(2);
              words.push(' ');
            }
            await sleep(70);
            expect(b.app.editor.text.normalize('NFC')).toBe(words.join('').normalize('NFC'));
          }, 20000);
        }
      }
    }
  }
});
