import { describe, expect, it } from 'vitest';
import { renderSprite, SPRITE_AFTER_MS } from '../../../src/cli/tui/sprite';
import { DOG_FRAMES } from '../../../src/cli/tui/spriteArt';
import { detectCaps, makeTheme } from '../../../src/cli/tui/theme';
import { stringWidth } from '../../../src/cli/tui/width';

const th = (env: Record<string, string>) => makeTheme(detectCaps({ env: env as NodeJS.ProcessEnv }));

describe('sprite', () => {
  it('có đủ khung hình, cùng chiều cao', () => {
    expect(DOG_FRAMES.length).toBe(8);
    expect(new Set(DOG_FRAMES.map((f) => f.length)).size).toBe(1);
  });
  it('chỉ hiện sau 8 s', () => {
    const t = th({ COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' });
    expect(renderSprite(t, SPRITE_AFTER_MS - 1, 100, {})).toEqual([]);
    expect(renderSprite(t, SPRITE_AFTER_MS + 500, 100, {}).length).toBeGreaterThan(3);
  });
  it('tắt khi NO_COLOR / ASCII / LOCAITH_NO_SPRITE', () => {
    expect(renderSprite(th({ NO_COLOR: '1', LANG: 'en_US.UTF-8' }), 20000, 100, {})).toEqual([]);
    expect(renderSprite(th({ COLORTERM: 'truecolor', LOCAITH_ASCII: '1' }), 20000, 100, {})).toEqual([]);
    expect(renderSprite(th({ COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }), 20000, 100, { LOCAITH_NO_SPRITE: '1' })).toEqual([]);
  });
  it('luôn vừa chiều rộng ở mọi thời điểm và mọi cỡ cửa sổ', () => {
    const t = th({ COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' });
    for (const w of [40, 60, 100]) for (let ms = 8000; ms < 30000; ms += 777) for (const l of renderSprite(t, ms, w, {})) expect(stringWidth(l)).toBeLessThanOrEqual(w - 1);
    expect(renderSprite(t, 20000, 20, {})).toEqual([]); // quá hẹp: không vẽ
  });
});
