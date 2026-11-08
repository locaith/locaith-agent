import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTOR_KINDS, ACTOR_SECONDS, actorPlan, actorTarget, CYCLE_SEC, cycleOrder, seedFrom, WARMUP_SEC, WIPE_SEC, type ActorKind } from '../../webview/src/brand/actorPlan';
import { ACTOR_FRAMES, ACTOR_SVG, BLINK_FRAME, FRAME_COUNT } from '../../webview/src/brand/sprites';

/**
 * (0.7.2) «Logo Lo biến hình khi chờ lâu»: lịch thuần (actorPlan), khung vẽ tính sẵn, và các bất biến CSS/cài đặt.
 * Phần nhìn (ảnh chụp, đo DOM) nằm ở webview/dev/shoot.mjs (`node webview/dev/shoot.mjs actor-`).
 */
const ROOT = path.resolve(__dirname, '../..');
const W = path.join(ROOT, 'webview/src');
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** Danh sách nhân vật theo thứ tự xuất hiện trong [0, maxSec), mỗi lần xuất hiện một mục (đọc từ pha `char`). */
function appearances(seed: number, maxSec: number): ActorKind[] {
  const out: ActorKind[] = [];
  let last: ActorKind | null = null;
  for (let t = 0; t < maxSec; t += 0.25) {
    const p = actorPlan(t, seed);
    if (p.phase === 'char' && p.actor && p.actor !== last) {
      out.push(p.actor);
      last = p.actor;
    } else if (p.phase === 'logo') last = null;
  }
  return out;
}

describe('actorPlan — lịch', () => {
  it('chu kỳ đúng 80 giây (8 + 12+12+12+18 + 3×6)', () => {
    expect(CYCLE_SEC).toBe(80);
    expect(actorPlan(0, 1)).toEqual(actorPlan(80, 1)); // cùng pha ở đầu chu kỳ kế
    expect(actorPlan(79.9, 5).phase).toBe('wipe-out'); // nhân vật cuối ra sát cuối chu kỳ
  });

  it('0–8 giây luôn là logo, với mọi hạt giống', () => {
    for (const seed of [0, 1, 7, 12345, 0xffffffff]) {
      for (let t = 0; t < WARMUP_SEC; t += 0.1) {
        const p = actorPlan(t, seed);
        expect(p.phase).toBe('logo');
        expect(p.actor).toBeNull();
      }
      expect(actorPlan(80 + 3, seed).phase).toBe('logo'); // đầu chu kỳ sau cũng vậy
    }
  });

  it('chu kỳ đầu đúng bảng đã duyệt: chó 8–20, logo, robot 26–38, logo, drone 44–56, logo, tên lửa 62–80', () => {
    const at = (t: number) => actorPlan(t, 99);
    expect(at(8.2)).toMatchObject({ phase: 'wipe-in', actor: 'dog' });
    expect(at(14)).toMatchObject({ phase: 'char', actor: 'dog' });
    expect(at(19.7)).toMatchObject({ phase: 'wipe-out', actor: 'dog' });
    expect(at(23)).toMatchObject({ phase: 'logo', actor: null });
    expect(at(26.1)).toMatchObject({ phase: 'wipe-in', actor: 'bot' });
    expect(at(32)).toMatchObject({ phase: 'char', actor: 'bot' });
    expect(at(41)).toMatchObject({ phase: 'logo', actor: null });
    expect(at(50)).toMatchObject({ phase: 'char', actor: 'drone' });
    expect(at(59)).toMatchObject({ phase: 'logo', actor: null });
    expect(at(62.2)).toMatchObject({ phase: 'wipe-in', actor: 'rocket' });
    expect(at(70)).toMatchObject({ phase: 'char', actor: 'rocket' });
    expect(at(79.8)).toMatchObject({ phase: 'wipe-out', actor: 'rocket' });
  });

  it('chuyển cảnh dài đúng 0,5 giây ở cả hai đầu, tiến độ chạy 0 → 1', () => {
    const s = 8; // chó vào lúc 8 s
    expect(actorPlan(s, 3).phase).toBe('wipe-in');
    expect(actorPlan(s + WIPE_SEC - 0.01, 3).phase).toBe('wipe-in');
    expect(actorPlan(s + WIPE_SEC, 3).phase).toBe('char');
    expect(actorPlan(s + 0.25, 3).progress).toBeCloseTo(0.5, 5);
    const e = s + ACTOR_SECONDS.dog;
    expect(actorPlan(e - WIPE_SEC - 0.01, 3).phase).toBe('char');
    expect(actorPlan(e - WIPE_SEC, 3).phase).toBe('wipe-out');
    expect(actorPlan(e - 0.01, 3).phase).toBe('wipe-out');
    expect(actorPlan(e, 3).phase).toBe('logo');
  });

  it('không bao giờ có hai nhân vật liền nhau giống nhau (kể cả chỗ nối chu kỳ), với nhiều hạt giống', () => {
    for (let seed = 0; seed < 200; seed++) {
      const seq = appearances(seed * 7919 + 13, CYCLE_SEC * 6);
      expect(seq.length).toBe(24); // 4 nhân vật × 6 chu kỳ
      for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    }
    // thứ tự thuần (không qua lấy mẫu): chỗ nối chu kỳ
    for (let seed = 0; seed < 500; seed++) {
      for (let k = 1; k < 8; k++) expect(cycleOrder(seed, k)[0]).not.toBe(cycleOrder(seed, k - 1)[3]);
    }
  });

  it('mỗi chu kỳ có đủ cả bốn nhân vật đúng một lần; chu kỳ 0 theo thứ tự đã duyệt', () => {
    expect(cycleOrder(42, 0)).toEqual(['dog', 'bot', 'drone', 'rocket']);
    for (let k = 1; k < 12; k++) expect([...cycleOrder(42, k)].sort()).toEqual([...ACTOR_KINDS].sort());
  });

  it('ổn định theo hạt giống: gọi lại / gọi theo thứ tự khác vẫn cho cùng kết quả; hạt giống khác cho thứ tự khác', () => {
    const times = [3, 100, 170, 250, 399, 810];
    const a = times.map((t) => actorPlan(t, 777));
    const b = [...times].reverse().map((t) => actorPlan(t, 777)).reverse();
    expect(b).toEqual(a);
    const orders = new Set<string>();
    for (let seed = 0; seed < 50; seed++) orders.add(cycleOrder(seed, 1).join());
    expect(orders.size).toBeGreaterThan(5);
  });

  it('đầu vào xấu (âm, NaN, vô cực âm) không làm hỏng: coi như 0 giây', () => {
    for (const bad of [-5, Number.NaN, -Infinity]) expect(actorPlan(bad, 1).phase).toBe('logo');
  });

  it('actorTarget: nhân vật hiện ở pha vào + đang chạy; pha ra và logo → về logo', () => {
    expect(actorTarget({ phase: 'logo', actor: null, progress: 0 })).toBeNull();
    expect(actorTarget({ phase: 'wipe-in', actor: 'dog', progress: 0 })).toBe('dog');
    expect(actorTarget({ phase: 'char', actor: 'bot', progress: 0.5 })).toBe('bot');
    expect(actorTarget({ phase: 'wipe-out', actor: 'bot', progress: 0 })).toBeNull();
  });

  it('seedFrom: băm xác định, khác id → khác hạt giống', () => {
    expect(seedFrom('a-1')).toBe(seedFrom('a-1'));
    expect(seedFrom('a-1')).not.toBe(seedFrom('a-2'));
  });
});

describe('sprites — khung tính sẵn', () => {
  it('mỗi nhân vật có đúng 6 khung, là chuỗi SVG tĩnh', () => {
    expect(FRAME_COUNT).toBe(6);
    for (const k of ACTOR_KINDS) {
      expect(ACTOR_FRAMES[k]).toHaveLength(6);
      for (const f of ACTOR_FRAMES[k]) {
        expect(f.startsWith('<g class="lo-fr">')).toBe(true);
        expect(f).not.toMatch(/NaN|undefined/);
      }
      expect(ACTOR_SVG[k]).toBe(ACTOR_FRAMES[k].join(''));
    }
  });

  it('sáu khung của mỗi nhân vật đều khác nhau; khung 4 nháy mắt ở chó và robot người', () => {
    for (const k of ACTOR_KINDS) expect(new Set(ACTOR_FRAMES[k]).size).toBe(6);
    expect(BLINK_FRAME).toBe(3);
    expect(ACTOR_FRAMES.dog[BLINK_FRAME]).toContain('ry="0.45"');
    expect(ACTOR_FRAMES.bot[BLINK_FRAME]).toContain('ry="0.47"');
    expect(ACTOR_FRAMES.dog[0]).toContain('ry="1.5"');
  });

  it('một bảng màu: gradient Locaith + màu mắt; có lớp CSS để chủ đề sáng / tương phản cao đổi màu; không bộ lọc riêng', () => {
    for (const k of ACTOR_KINDS) {
      const s = ACTOR_SVG[k];
      expect(s).toContain('url(#lo-cg)');
      expect(s).toContain('lo-eye');
      expect(s).not.toMatch(/filter=/);
    }
  });
});

describe('CSS & cài đặt', () => {
  const css = read(path.join(W, 'styles/brand.css'));
  const actorCss = css.slice(css.indexOf('Nhân vật chờ ở dòng đang chạy'));
  const comp = read(path.join(W, 'components/LoActor.tsx'));
  const turn = read(path.join(W, 'components/timeline/AssistantTurn.tsx'));

  it('ô 20×20, đệm âm để không đổi chiều cao dòng; aria-hidden; hoạt hoạ khung bằng CSS steps()', () => {
    expect(actorCss).toMatch(/--lo-actor-size:\s*20px/);
    expect(actorCss).toMatch(/margin:\s*-4px 0/);
    expect(actorCss).toMatch(/steps\(1, end\)/);
    expect(comp).toContain('aria-hidden="true"');
  });

  it('giảm chuyển động, tương phản cao, nền sáng, forced-colors đều có phương án; không viền dọc', () => {
    expect(actorCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lo-actor-char/);
    expect(actorCss).toMatch(/@media \(forced-colors: active\)[\s\S]*Highlight/);
    expect(actorCss).toMatch(/body\.vscode-high-contrast \.lo-actor/);
    expect(actorCss).toMatch(/body\.vscode-light \.lo-actor/);
    expect(actorCss).not.toMatch(/border-left/);
    expect(comp).toContain('prefers-reduced-motion');
  });

  it('chỉ MỘT bộ lọc glow trên ô (bản logo bên trong tắt filter của nó)', () => {
    expect(actorCss).toMatch(/\.lo-actor \.lo-spin\s*\{\s*filter:\s*none/);
  });

  it('dòng chờ dùng LoActor khi bật cài đặt, giữ LoSpinner khi tắt', () => {
    expect(turn).toMatch(/settings\.workingCharacters !== false \? <LoActor[^>]*\/> : <LoSpinner size=\{15\} \/>/);
  });

  it('cài đặt locaithAgent.ui.workingCharacters: package.json (mặc định true) + nls vi/en + i18n vi/en + giao thức + hai nơi đọc cấu hình', () => {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    const prop = pkg.contributes.configuration.properties['locaithAgent.ui.workingCharacters'];
    expect(prop).toMatchObject({ type: 'boolean', default: true });
    const key = /%([^%]+)%/.exec(prop.markdownDescription)![1];
    for (const f of ['package.nls.json', 'package.nls.en.json']) expect(JSON.parse(read(path.join(ROOT, f)))[key]).toBeTruthy();
    const i18n = read(path.join(W, 'i18n.ts'));
    expect(i18n.match(/'set\.workingCharacters'/g)).toHaveLength(2);
    expect(read(path.join(ROOT, 'src/shared/protocol.ts'))).toMatch(/workingCharacters: true/);
    expect(read(path.join(ROOT, 'src/host/config.ts'))).toContain("workingCharacters: 'ui.workingCharacters'");
    expect(read(path.join(ROOT, 'src/browser/config.ts'))).toContain('workingCharacters: bool(');
  });
});
