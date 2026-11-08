import { describe, expect, it } from 'vitest';
import { TYPE_TIMING, roundOrder, typeFrame, type TypeFrame, type TypeTiming } from '../src/shared/typewriter';

const VERBS = ['Working', 'Thinking', 'Reading code', 'Tracing', 'Pondering', 'Composing', 'Assembling', 'Reviewing', 'Crunching', 'Sorting it out'];
const VI = ['Đang xử lý', 'Đang suy nghĩ', 'Đang đọc mã', 'Đang lần dấu vết', 'Đang cân nhắc', 'Đang soạn trả lời', 'Đang ráp các mảnh', 'Đang rà soát', 'Đang tính toán', 'Đang sắp xếp ý'];
const T: TypeTiming = { charMs: 50, holdMs: 1000, eraseMs: 20, gapMs: 100 };
const total = (len: number, t: TypeTiming = T): number => len * t.charMs + t.holdMs + len * t.eraseMs + t.gapMs;

describe('typeFrame — một từ', () => {
  const one = ['Working']; // 7 chữ
  it('gõ từng chữ: 0 chữ lúc đầu (chỉ con trỏ), thêm một chữ mỗi charMs, đủ chữ thì chuyển sang giữ', () => {
    expect(typeFrame(one, 0, 0, T)).toMatchObject({ text: '', phase: 'type', verb: 'Working', verbIndex: 0 });
    expect(typeFrame(one, 49, 0, T).text).toBe('');
    expect(typeFrame(one, 50, 0, T).text).toBe('W');
    expect(typeFrame(one, 149, 0, T).text).toBe('Wo');
    expect(typeFrame(one, 150, 0, T).text).toBe('Wor');
    expect(typeFrame(one, 349, 0, T)).toMatchObject({ text: 'Workin', phase: 'type' });
    expect(typeFrame(one, 350, 0, T)).toMatchObject({ text: 'Working', phase: 'hold' });
  });

  it('giữ nguyên holdMs, rồi xoá nhanh từng chữ, rồi nghỉ, rồi gõ lại', () => {
    const typeEnd = 7 * T.charMs; // 350
    expect(typeFrame(one, typeEnd + T.holdMs - 1, 0, T)).toMatchObject({ text: 'Working', phase: 'hold' });
    expect(typeFrame(one, typeEnd + T.holdMs, 0, T)).toMatchObject({ text: 'Working', phase: 'erase' }); // chưa quá eraseMs
    expect(typeFrame(one, typeEnd + T.holdMs + 20, 0, T).text).toBe('Workin');
    expect(typeFrame(one, typeEnd + T.holdMs + 7 * 20 - 1, 0, T).text).toBe('W');
    const gapStart = typeEnd + T.holdMs + 7 * 20;
    expect(typeFrame(one, gapStart, 0, T)).toMatchObject({ text: '', phase: 'gap' });
    expect(typeFrame(one, gapStart + T.gapMs - 1, 0, T).phase).toBe('gap');
    expect(typeFrame(one, total(7), 0, T)).toMatchObject({ text: '', phase: 'type' }); // vòng mới
    expect(typeFrame(one, total(7) + 100, 0, T).text).toBe('Wo');
  });

  it('nextMs đúng: bước đúng nextMs thì luôn thấy trạng thái KHÁC, và dãy chữ tăng dần 1 chữ rồi giảm dần 1 chữ', () => {
    let t = 0;
    const seen: TypeFrame[] = [];
    for (let i = 0; i < 16; i++) {
      // đúng MỘT vòng của «Working»: 7 khung gõ + 1 giữ + 7 xoá + 1 nghỉ
      const f = typeFrame(one, t, 0, T);
      seen.push(f);
      expect(f.nextMs).toBeGreaterThan(0);
      expect(Number.isFinite(f.nextMs)).toBe(true);
      t += f.nextMs + 0.0001;
    }
    const lens = seen.map((f) => f.text.length);
    // 0,1,…,7 (gõ) · 7 (giữ) · 7(xoá, trước chữ đầu tiên bị xoá) … xuống 0 (nghỉ) · rồi 0,1… của vòng mới
    const typing = seen.filter((f) => f.phase === 'type').map((f) => f.text.length);
    expect(typing.slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seen.filter((f) => f.phase === 'hold')).toHaveLength(1);
    const erasing = seen.filter((f) => f.phase === 'erase').map((f) => f.text.length);
    expect(erasing).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(seen.find((f) => f.phase === 'gap')!.text).toBe('');
    // không bao giờ dài hơn từ, không bao giờ có hai khung liền giống hệt nhau
    expect(Math.max(...lens)).toBe(7);
    for (let i = 1; i < seen.length; i++) expect(`${seen[i]!.phase}|${seen[i]!.text}`).not.toBe(`${seen[i - 1]!.phase}|${seen[i - 1]!.text}`);
  });

  it('mặc định TYPE_TIMING: từ gõ xong dưới 1 giây và giữ lâu đủ để đọc', () => {
    expect(TYPE_TIMING.charMs * 'Đang suy nghĩ'.length).toBeLessThan(1000);
    expect(TYPE_TIMING.holdMs).toBeGreaterThanOrEqual(2000);
    expect(TYPE_TIMING.eraseMs).toBeLessThan(TYPE_TIMING.charMs);
  });
});

describe('typeFrame — nhiều từ', () => {
  it('lần chạy đầu luôn bắt đầu bằng nhãn gốc (chỉ số 0), với mọi hạt giống', () => {
    for (const seed of [0, 1, 7, 12345, 0xffffffff, 987654321]) {
      expect(typeFrame(VERBS, 0, seed).verbIndex).toBe(0);
      expect(typeFrame(VERBS, 1500, seed).verb).toBe('Working');
    }
  });

  it('mỗi vòng là một hoán vị (đủ mọi từ đúng một lần); vòng 0 mở đầu bằng từ 0', () => {
    for (const n of [3, 4, 5, 10, 12]) {
      for (const seed of [0, 3, 99, 4242]) {
        for (let round = 0; round < 25; round++) {
          const o = roundOrder(n, seed, round);
          expect([...o].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
        }
        expect(roundOrder(n, seed, 0)[0]).toBe(0);
      }
    }
  });

  it('KHÔNG BAO GIỜ hai lần liền cùng một từ — kể cả chỗ nối giữa hai vòng (200 vòng, nhiều hạt giống, nhiều kích cỡ)', () => {
    for (const n of [2, 3, 4, 7, 10]) {
      for (const seed of [0, 1, 5, 31337, 0xdeadbeef]) {
        let prev = -1;
        for (let round = 0; round < 200; round++) {
          for (const i of roundOrder(n, seed, round)) {
            expect(i, `n=${n} seed=${seed} round=${round}`).not.toBe(prev);
            prev = i;
          }
        }
      }
    }
  });

  it('cùng hạt giống → cùng chuỗi từ (render lại không đổi); khác hạt giống → thứ tự khác', () => {
    const order = (seed: number) => roundOrder(10, seed, 0).join(',');
    expect(order(5)).toBe(order(5));
    const distinct = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(order));
    expect(distinct.size).toBeGreaterThan(4);
    expect(typeFrame(VERBS, 123456, 9)).toEqual(typeFrame(VERBS, 123456, 9));
  });

  it('theo dõi theo thời gian: dãy từ xuất hiện = thứ tự của roundOrder, vòng 0 rồi vòng 1…', () => {
    const t = T;
    const seed = 21;
    const lens = VERBS.map((v) => Array.from(v).length);
    const round = lens.reduce((s, l) => s + total(l, t), 0);
    const seen: number[] = [];
    for (let ms = 0; ms < round * 2; ms += 25) {
      const f = typeFrame(VERBS, ms, seed, t);
      if (seen[seen.length - 1] !== f.verbIndex) seen.push(f.verbIndex);
    }
    const expected = [...roundOrder(VERBS.length, seed, 0), ...roundOrder(VERBS.length, seed, 1)];
    expect(seen.slice(0, expected.length)).toEqual(expected.slice(0, seen.length));
    expect(seen.length).toBeGreaterThanOrEqual(VERBS.length * 2 - 1);
  });

  it('phần đã gõ luôn là TIỀN TỐ của từ (cả tiếng Việt có dấu), không bao giờ dài hơn từ', () => {
    for (const list of [VERBS, VI]) {
      for (let ms = 0; ms < 90_000; ms += 37) {
        const f = typeFrame(list, ms, 17);
        const v = f.verb.normalize('NFC');
        expect(v.startsWith(f.text), `${ms}: «${f.text}» không phải tiền tố của «${v}»`).toBe(true);
        expect(list[f.verbIndex]).toBe(f.verb);
      }
    }
  });

  it('dấu tiếng Việt: từ ở dạng tách dấu (NFD) vẫn cắt theo CHỮ trọn vẹn, không để lại dấu mồ côi', () => {
    const nfd = ['Đang xử lý'.normalize('NFD')];
    const marks = /[̀-ͯ]/;
    for (let ms = 0; ms < 3000; ms += 10) {
      const f = typeFrame(nfd, ms, 0, T);
      expect(marks.test(f.text), `ms=${ms} «${f.text}»`).toBe(false);
      expect(f.verb).toBe(nfd[0]); // verb nguyên văn, chỉ phần text được chuẩn hoá
    }
    expect(typeFrame(nfd, 350, 0, T).text.normalize('NFC')).toBe('Đang xử'.normalize('NFC').slice(0, 7));
  });

  it('khoảng thời gian rất dài vẫn trả ngay và hợp lệ (đồng hồ chạy hàng giờ)', () => {
    const t0 = Date.now();
    for (const ms of [3_600_000, 86_400_000, 1e12]) {
      const f = typeFrame(VERBS, ms, 4);
      expect(f.nextMs).toBeGreaterThan(0);
      expect(f.verb.length).toBeGreaterThan(0);
    }
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('đầu vào xấu: rỗng, âm, NaN, Infinity không ném và cho khung hợp lệ', () => {
    expect(typeFrame([], 100)).toMatchObject({ text: '', verb: '', nextMs: Infinity });
    expect(typeFrame(VERBS, -50, 1).text).toBe('');
    expect(typeFrame(VERBS, Number.NaN, 1).verbIndex).toBe(0);
    expect(typeFrame(VERBS, Number.POSITIVE_INFINITY, 1).verb.length).toBeGreaterThan(0);
  });
});

describe('typeFrame — once (chỉ gõ một lần rồi giữ)', () => {
  it('gõ từ đầu rồi giữ nguyên mãi mãi, không xoá, nextMs = Infinity', () => {
    expect(typeFrame(VERBS, 0, 3, T, true)).toMatchObject({ text: '', phase: 'type', verbIndex: 0 });
    expect(typeFrame(VERBS, 100, 3, T, true).text).toBe('Wo');
    const done = 'Working'.length * T.charMs;
    for (const ms of [done, done + 1, done + 5_000, 3_600_000, 1e12]) {
      expect(typeFrame(VERBS, ms, 3, T, true)).toMatchObject({ text: 'Working', verb: 'Working', phase: 'hold', nextMs: Infinity });
    }
  });
});
