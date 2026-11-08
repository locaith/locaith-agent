/**
 * (0.7.2) Dọn bộ nhớ của extension (thẻ «Dọn dẹp bộ nhớ» trong Cài đặt, lệnh `locaithAgent.cleanup`, và tự dọn ảnh cũ ở nền).
 *
 * Nguyên tắc: MỌI việc xoá phải do người dùng bấm VÀ xác nhận (hộp thoại modal của VS Code ghi rõ dung lượng sẽ giải phóng — webview không tự xoá
 * được gì); xoá cuộc trò chuyện đi qua Thùng rác có sẵn (khôi phục 30 ngày); xoá ảnh luôn GIỮ CHỮ; cuộc đang mở trong bất kỳ cửa sổ chat nào
 * không bị đụng tới. Ngoại lệ DUY NHẤT không hỏi từng lần: cài đặt `history.autoCleanImagesDays` (người dùng tự bật) xoá ảnh cũ ở nền khi khởi động.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { CleanupAction, CleanupStatsView, HostMessage, WebviewMessage } from '../shared/protocol';
import type { BaseSessionStore } from '../shared/sessionStore';
import { CheckpointStore } from './checkpoints/store';
import type { Lang } from '../core/engine/strings';

export type CleanupMessage = Extract<WebviewMessage, { type: 'cleanup_stats' | 'cleanup_run' }>;

export interface CleanupPort {
  readonly lang: Lang;
  readonly store: BaseSessionStore;
  /** globalStorage của extension (chứa `checkpoints/`). Vắng = không có điểm quay lại để dọn. */
  readonly storageDir?: string;
  /** Mọi cuộc trò chuyện đang mở trong bất kỳ khung chat nào (không bao giờ bị dọn). */
  openSessionIds(): string[];
  post(msg: HostMessage): void;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
  refreshListings(): Promise<void>;
  autoCleanImagesDays(): number;
}

const DEFAULT_DAYS: Record<CleanupAction, number> = { images: 30, sessions: 90, trash: 0, checkpoints: 7 };
const clampDays = (v: unknown, fallback: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : fallback;
};
const DAY_MS = 86_400_000;

/** 1,5 MB · 340 KB · 69 MB — gọn, dùng dấu phẩy thập phân cho tiếng Việt. */
export function fmtBytes(n: number, lang: Lang): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return `${lang === 'vi' ? s.replace('.', ',') : s} ${units[i]}`;
}

const checkpointStore = (port: CleanupPort): CheckpointStore | undefined => (port.storageDir ? new CheckpointStore(path.join(port.storageDir, 'checkpoints')) : undefined);

export async function collectStats(port: CleanupPort): Promise<CleanupStatsView> {
  const [s, trash, cp] = await Promise.all([port.store.storageStats(), port.store.trashUsage(), checkpointStore(port)?.usage() ?? Promise.resolve({ sessions: 0, bytes: 0 })]);
  return {
    sessions: s.sessions,
    trash,
    checkpoints: cp,
    images: s.images,
    autoCleanImagesDays: port.autoCleanImagesDays(),
  };
}

interface Plan {
  /** Chữ ngắn nói việc sắp làm (đầu hộp xác nhận). */
  title: string;
  /** Giải thích + dung lượng sẽ giải phóng. */
  detail: string;
  bytes: number;
  count: number;
  /** Nhãn nút xác nhận. */
  yes: string;
  run(): Promise<{ bytes: number; summary: string }>;
}

async function plan(port: CleanupPort, action: CleanupAction, days: number): Promise<Plan | null> {
  const vi = port.lang === 'vi';
  const except = port.openSessionIds();
  const olderThanMs = days * DAY_MS;
  switch (action) {
    case 'images': {
      const dry = await port.store.purgeImages({ olderThanMs, exceptIds: except, dryRun: true });
      if (dry.images === 0) return null;
      return {
        title: vi ? `Xoá ${dry.images} ảnh khỏi cuộc trò chuyện cũ hơn ${days} ngày?` : `Remove ${dry.images} images from conversations older than ${days} days?`,
        detail: vi
          ? `Giải phóng khoảng ${fmtBytes(dry.bytes, 'vi')} ở ${dry.sessions} cuộc trò chuyện. Chữ được giữ nguyên; chỗ có ảnh sẽ ghi «[ảnh đã xoá…]». Không hoàn tác được. Cuộc đang mở không bị đụng tới.`
          : `Frees about ${fmtBytes(dry.bytes, 'en')} across ${dry.sessions} conversations. Text is kept; image spots show "[image removed…]". This cannot be undone. Open conversations are not touched.`,
        bytes: dry.bytes,
        count: dry.images,
        yes: vi ? 'Xoá ảnh' : 'Remove images',
        run: async () => {
          const r = await port.store.purgeImages({ olderThanMs, exceptIds: except });
          return { bytes: r.bytes, summary: vi ? `Đã xoá ${r.images} ảnh (giữ chữ), giải phóng ${fmtBytes(r.bytes, 'vi')}.` : `Removed ${r.images} images (text kept), freed ${fmtBytes(r.bytes, 'en')}.` };
        },
      };
    }
    case 'sessions': {
      const dry = await port.store.trashStale({ olderThanMs, exceptIds: except, dryRun: true });
      if (dry.sessions === 0) return null;
      return {
        title: vi ? `Chuyển ${dry.sessions} cuộc trò chuyện cũ hơn ${days} ngày vào Thùng rác?` : `Move ${dry.sessions} conversations older than ${days} days to the Trash?`,
        detail: vi
          ? `Chiếm khoảng ${fmtBytes(dry.bytes, 'vi')}. Vẫn khôi phục được trong 30 ngày (Lịch sử → Thùng rác); sau đó mất hẳn. Cuộc đã ghim và cuộc đang mở được giữ lại. Chỉ tính cuộc của thư mục làm việc này.`
          : `Takes about ${fmtBytes(dry.bytes, 'en')}. Restorable for 30 days (History → Trash), then gone for good. Pinned and open conversations are kept. Only this workspace's conversations are counted.`,
        bytes: dry.bytes,
        count: dry.sessions,
        yes: vi ? 'Chuyển vào Thùng rác' : 'Move to Trash',
        run: async () => {
          const r = await port.store.trashStale({ olderThanMs, exceptIds: except });
          await port.refreshListings();
          return { bytes: 0, summary: vi ? `Đã chuyển ${r.sessions} cuộc vào Thùng rác (${fmtBytes(r.bytes, 'vi')}); dọn Thùng rác để giải phóng hẳn.` : `Moved ${r.sessions} conversations to the Trash (${fmtBytes(r.bytes, 'en')}); empty the Trash to free the space.` };
        },
      };
    }
    case 'trash': {
      const u = await port.store.trashUsage();
      if (u.count === 0) return null;
      return {
        title: vi ? `Dọn Thùng rác (${u.count} cuộc trò chuyện)?` : `Empty the Trash (${u.count} conversations)?`,
        detail: vi ? `Xoá vĩnh viễn, giải phóng khoảng ${fmtBytes(u.bytes, 'vi')}. Không khôi phục được nữa.` : `Deletes permanently and frees about ${fmtBytes(u.bytes, 'en')}. This cannot be undone.`,
        bytes: u.bytes,
        count: u.count,
        yes: vi ? 'Dọn Thùng rác' : 'Empty Trash',
        run: async () => {
          const ids = (await port.store.listTrash()).map((t) => t.id);
          const n = await port.store.emptyTrash();
          const cps = checkpointStore(port);
          if (cps) await Promise.all(ids.map((id) => cps.removeSession(id).catch(() => undefined))); // điểm quay lại của cuộc đã xoá hẳn đi theo
          await port.refreshListings();
          return { bytes: u.bytes, summary: vi ? `Đã dọn Thùng rác: ${n} cuộc, giải phóng ${fmtBytes(u.bytes, 'vi')}.` : `Emptied the Trash: ${n} conversations, freed ${fmtBytes(u.bytes, 'en')}.` };
        },
      };
    }
    case 'checkpoints': {
      const cps = checkpointStore(port);
      if (!cps) return null;
      const dry = await cps.pruneOlderThan(days, { except, dryRun: true });
      if (dry.turns === 0) return null;
      return {
        title: vi ? `Dọn điểm quay lại cũ hơn ${days} ngày?` : `Remove restore points older than ${days} days?`,
        detail: vi
          ? `Bỏ ${dry.turns} điểm quay lại, giải phóng khoảng ${fmtBytes(dry.bytes, 'vi')}. Các tệp trong dự án KHÔNG bị đụng tới; chỉ không còn «quay lại» về những mốc cũ đó được nữa.`
          : `Removes ${dry.turns} restore points, freeing about ${fmtBytes(dry.bytes, 'en')}. Project files are NOT touched; you just can't rewind to those old points anymore.`,
        bytes: dry.bytes,
        count: dry.turns,
        yes: vi ? 'Dọn điểm quay lại' : 'Remove restore points',
        run: async () => {
          const r = await cps.pruneOlderThan(days, { except });
          return { bytes: r.bytes, summary: vi ? `Đã bỏ ${r.turns} điểm quay lại, giải phóng ${fmtBytes(r.bytes, 'vi')}.` : `Removed ${r.turns} restore points, freed ${fmtBytes(r.bytes, 'en')}.` };
        },
      };
    }
  }
}

const ACTIONS: readonly CleanupAction[] = ['images', 'sessions', 'trash', 'checkpoints'];

export async function handleCleanupMessage(port: CleanupPort, m: CleanupMessage): Promise<void> {
  const vi = port.lang === 'vi';
  if (m.type === 'cleanup_stats') {
    port.post({ type: 'cleanup_stats', busy: true });
    try {
      port.post({ type: 'cleanup_stats', stats: await collectStats(port) });
    } catch (e) {
      port.post({ type: 'cleanup_stats', error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (!ACTIONS.includes(m.action)) return;
  const days = clampDays(m.days, DEFAULT_DAYS[m.action]);
  port.post({ type: 'cleanup_stats', busy: true });
  try {
    const p = await plan(port, m.action, days);
    if (!p) {
      port.toast('info', vi ? 'Không có gì để dọn theo mức đã chọn.' : 'Nothing to clean up at the chosen setting.');
      return;
    }
    const pick = await vscode.window.showWarningMessage(p.title, { modal: true, detail: p.detail }, p.yes);
    if (pick !== p.yes) return;
    const r = await p.run();
    port.toast('info', r.summary);
  } catch (e) {
    port.toast('error', (vi ? 'Không dọn được: ' : 'Cleanup failed: ') + (e instanceof Error ? e.message : String(e)));
  } finally {
    try {
      port.post({ type: 'cleanup_stats', stats: await collectStats(port) });
    } catch (e) {
      port.post({ type: 'cleanup_stats', error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * Tự dọn ảnh cũ ở nền khi khởi động (cài đặt `locaithAgent.history.autoCleanImagesDays` > 0). Chỉ xoá ẢNH (luôn giữ chữ), chỉ cuộc KHÔNG đang mở.
 * Trả về số ảnh đã xoá (0 = không làm gì).
 */
export async function autoCleanImages(store: BaseSessionStore, days: number, openIds: readonly string[]): Promise<{ images: number; bytes: number }> {
  if (!Number.isFinite(days) || days < 1) return { images: 0, bytes: 0 };
  const r = await store.purgeImages({ olderThanMs: Math.min(3650, Math.floor(days)) * DAY_MS, exceptIds: openIds });
  return { images: r.images, bytes: r.bytes };
}
