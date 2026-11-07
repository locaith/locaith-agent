/** Chọn chuỗi theo ngôn ngữ (các chuỗi nhỏ của lane hook nằm sát chỗ dùng; chuỗi của engine/giao diện nằm ở strings.ts). */
import type { Lang } from '../engine/strings';

export function bi(lang: Lang | undefined, vi: string, en: string): string {
  return lang === 'en' ? en : vi;
}
