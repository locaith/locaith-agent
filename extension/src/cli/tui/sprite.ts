/** Nhân vật nhỏ (chó robot) chạy ngang khi chờ lâu (> 8 s). Khung từ spriteArt.ts (sinh bởi scripts/cli-gen-sprites.mjs). Tắt khi NO_COLOR/ASCII. */

import { DOG_FRAMES } from './spriteArt';
import type { Theme } from './theme';

export const SPRITE_AFTER_MS = 8000;

export function spriteEnabled(th: Theme, env: NodeJS.ProcessEnv = process.env): boolean {
  return th.caps.color !== 'none' && th.caps.unicode && env.LOCAITH_NO_SPRITE !== '1';
}

/** Các dòng của sprite ở thời điểm `elapsedMs` (rỗng nếu chưa tới lúc / bị tắt). Dòng chưa vượt `width - 1` cột. */
export function renderSprite(th: Theme, elapsedMs: number, width: number, env?: NodeJS.ProcessEnv): string[] {
  if (elapsedMs < SPRITE_AFTER_MS || !spriteEnabled(th, env)) return [];
  const frames = DOG_FRAMES;
  const f = frames[Math.floor(elapsedMs / 110) % frames.length];
  const w = Math.max(...f.map((r) => Array.from(r).length));
  const span = width - 1 - w - 4;
  if (span < 6) return [];
  // chạy từ trái sang phải rồi quay lại đầu
  const x = 2 + (Math.floor((elapsedMs - SPRITE_AFTER_MS) / 70) % span);
  return f.map((row, i) => {
    let out = '';
    for (const ch of row) out += ch === ' ' ? ch : th.gradientFg(Math.min(1, (i + 0.5) / f.length)) + ch;
    return ' '.repeat(x) + out + '\x1b[39m';
  });
}
