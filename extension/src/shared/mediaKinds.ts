/**
 * (0.6.3) Đuôi tệp xem trước được trong khung chat — dùng chung cho webview (tìm đường dẫn trong câu trả lời) và host
 * (kiểm đường dẫn trước khi đụng đĩa). Thuần tuý: không import node, chạy được trong webview.
 */
import type { MediaKind } from './protocol';

export const MEDIA_KIND_BY_EXT: Readonly<Record<string, MediaKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  avif: 'image',
  ico: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  opus: 'audio',
  weba: 'audio',
  html: 'doc',
  htm: 'doc',
  pdf: 'doc',
  docx: 'doc',
  xlsx: 'doc',
  pptx: 'doc',
};

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

export function mediaExt(p: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/** Loại xem trước theo đuôi tệp; null = không phải loại xem trước được. */
export function mediaKindOf(p: string): MediaKind | null {
  return MEDIA_KIND_BY_EXT[mediaExt(p)] ?? null;
}

/** MIME của ảnh (cho data: khi ảnh nằm ngoài các thư mục webview đọc được). */
export function imageMime(p: string): string {
  return IMAGE_MIME[mediaExt(p)] ?? 'application/octet-stream';
}
