import { THUMB_MAX_B64, b64Bytes, fitWithin, planShrink, shrinkWorthIt, thumbLadder, thumbSpec } from '../../src/shared/imageShrink';
import { readFileAsBase64 } from './util';

/**
 * (0.7.2) Thu nhỏ ảnh đính kèm bằng canvas (kế hoạch thuần nằm ở src/shared/imageShrink.ts, có test).
 * Mọi lỗi (định dạng trình duyệt không giải mã được…) đều rơi về ảnh gốc: việc thu nhỏ chỉ là tối ưu, không bao giờ chặn việc gửi.
 */

export interface ShrunkImage {
  /** base64 không tiền tố. */
  data: string;
  mediaType: string;
  /** Dung lượng nhị phân. */
  bytes: number;
  /** Ảnh đã được vẽ lại (false = giữ nguyên byte gốc). */
  changed: boolean;
}

/** Ảnh có điểm trong suốt không — lấy mẫu trên bản thu nhỏ 96 px (vùng trong suốt dù nhỏ vẫn làm alpha trung bình < 255). */
function detectAlpha(bmp: ImageBitmap): boolean {
  try {
    const k = Math.min(1, 96 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return true; // không kiểm được → coi như có alpha (giữ PNG, an toàn)
    ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
    return false;
  } catch {
    return true;
  }
}

function canvasToBase64(c: HTMLCanvasElement, mime: string, quality?: number): string {
  const url = c.toDataURL(mime, quality);
  return url.slice(url.indexOf(',') + 1);
}

/** Thu nhỏ một ảnh người dùng dán/chọn trước khi đính kèm. */
export async function shrinkImage(file: Blob): Promise<ShrunkImage> {
  const original = async (): Promise<ShrunkImage> => ({ data: await readFileAsBase64(file), mediaType: file.type || 'image/png', bytes: file.size, changed: false });
  try {
    const bmp = await createImageBitmap(file);
    try {
      const plan = planShrink({
        width: bmp.width,
        height: bmp.height,
        bytes: file.size,
        mime: file.type || 'image/png',
        hasAlpha: file.type === 'image/jpeg' ? false : detectAlpha(bmp),
      });
      if (plan.action === 'keep') return await original();
      const c = document.createElement('canvas');
      c.width = plan.width;
      c.height = plan.height;
      const ctx = c.getContext('2d');
      if (!ctx) return await original();
      if (plan.mime === 'image/jpeg') {
        ctx.fillStyle = '#fff'; // JPEG không có alpha: nền trắng thay vì đen
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const data = canvasToBase64(c, plan.mime, plan.quality);
      const bytes = b64Bytes(data);
      // Chỉ nén lại (không đổi kích thước) mà không nhẹ hơn → giữ bản gốc. Đã đổi kích thước thì dùng bản mới (ảnh quá khổ không giúp gì cho model).
      if (!shrinkWorthIt(file.size, bytes) && plan.width === bmp.width && plan.height === bmp.height) return await original();
      return { data, mediaType: plan.mime, bytes, changed: true };
    } finally {
      bmp.close?.();
    }
  } catch {
    return await original();
  }
}

/** Bản xem trước JPEG nhỏ (≤ 480 px, ≤ ~60 KB; chế độ nhẹ: 320 px, ≤ ~30 KB) cho tin đã gửi / transcript. */
export async function makeThumb(file: Blob, lite = false): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    try {
      const limit = Math.min(thumbSpec(lite).maxB64, THUMB_MAX_B64);
      let best: string | undefined;
      for (const step of thumbLadder(lite)) {
        const { width, height } = fitWithin(bmp.width, bmp.height, step.edge);
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        if (!ctx) return undefined;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bmp, 0, 0, width, height);
        best = canvasToBase64(c, 'image/jpeg', step.quality);
        if (best.length <= limit) return best;
      }
      return best && best.length <= THUMB_MAX_B64 ? best : undefined;
    } finally {
      bmp.close?.();
    }
  } catch {
    return undefined; // định dạng trình duyệt không giải mã được (hiếm): vẫn gửi được, chỉ thiếu bản thu nhỏ
  }
}
