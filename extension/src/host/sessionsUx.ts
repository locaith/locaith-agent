/**
 * (lane:sessions-ux) Phiên kiểu Claude Code ở phía host: rẽ nhánh, tìm toàn văn lịch sử, ghim, xoá hàng loạt, `/fork` `/context` `/cost`.
 *
 * ChatController chỉ cấp một "cổng" nhỏ (`SessionsUxPort`) và chuyển tiếp vài loại tin nhắn tới `handleSessionsUxMessage`;
 * toàn bộ logic nằm ở đây và trong các tệp thuần `src/shared/session{Fork,Search,Meter}.ts` (dùng lại được ở bản trình duyệt).
 */

import { repairOrphanToolCalls } from '../core/engine/engine';
import { getPromptStats } from '../core/engine/promptStats';
import { t, type Lang } from '../core/engine/strings';
import type { SessionState } from '../core/engine/types';
import type { ModelInfo } from '../core/types';
import type { HostMessage, SessionMeterView, TItem, ViewState, WebviewMessage } from '../shared/protocol';
import { buildMeter, contextReport, costReport } from '../shared/sessionMeter';
import { forkSession } from '../shared/sessionFork';
import { SessionSearchIndex } from '../shared/sessionSearch';
import type { BaseSessionStore } from '../shared/sessionStore';
import { newId } from '../shared/transcript';
import type { SlashRegistry } from './slashRegistry';

export interface SessionsUxPort {
  readonly lang: Lang;
  readonly busy: boolean;
  readonly store: BaseSessionStore;
  session(): SessionState;
  transcript(): readonly TItem[];
  context(): ViewState['context'];
  pricing(): ModelInfo['pricing'] | undefined;
  saveNow(): Promise<void>;
  /** Mở một cuộc trò chuyện (như bấm trong Lịch sử). */
  open(id: string): Promise<void>;
  refreshListings(): Promise<void>;
  post(msg: HostMessage): void;
  notice(level: 'info' | 'warn' | 'error', text: string): void;
  toast(level: 'info' | 'warn' | 'error', text: string): void;
}

export type SessionsUxMessage = Extract<WebviewMessage, { type: 'fork_session' | 'search_sessions' | 'pin_session' | 'delete_sessions' }>;

const SAFE_ID = /^[\w-]{1,200}$/;
const indexes = new WeakMap<BaseSessionStore, SessionSearchIndex>();

function indexFor(store: BaseSessionStore): SessionSearchIndex {
  let idx = indexes.get(store);
  if (!idx) {
    idx = new SessionSearchIndex(async (id) => {
      const p = await store.load(id);
      return p ? { title: p.session.title, transcript: p.transcript } : null;
    });
    indexes.set(store, idx);
  }
  return idx;
}

/** Số liệu cho chip ngữ cảnh/chi phí. */
export function meterOf(port: Pick<SessionsUxPort, 'session' | 'transcript' | 'pricing'>): SessionMeterView {
  return buildMeter(port.session(), port.transcript(), port.pricing());
}

/** Rẽ nhánh cuộc đang mở. Trả về id cuộc mới (hoặc null nếu không làm). */
export async function forkCurrent(port: SessionsUxPort, itemId?: string): Promise<string | null> {
  const lang = port.lang;
  if (port.busy) {
    port.toast('info', t(lang, 'sxForkBusy'));
    return null;
  }
  const parent = port.session();
  const transcript = port.transcript();
  if (parent.messages.length === 0 && !transcript.some((i) => i.kind === 'user')) {
    port.notice('info', t(lang, 'sxForkEmpty'));
    return null;
  }
  await port.saveNow(); // cuộc gốc phải được lưu đủ trước khi rời đi
  const res = forkSession(parent, transcript, { atUserItemId: typeof itemId === 'string' && SAFE_ID.test(itemId) ? itemId : undefined, newId: newId('s'), now: Date.now(), lang, repair: repairOrphanToolCalls });
  await port.store.save(res.session, res.transcript);
  await port.open(res.session.id);
  port.toast('info', t(lang, 'sxForkDone', { title: res.session.title }));
  if (res.approximate) port.notice('warn', t(lang, 'sxForkApprox'));
  return res.session.id;
}

export async function searchSessions(port: SessionsUxPort, reqId: number, query: string): Promise<void> {
  const q = String(query ?? '').slice(0, 200);
  const all = await port.store.listAll();
  const targets = all.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
  await indexFor(port.store).search(targets, q, (hits, done) => port.post({ type: 'session_search', reqId, query: q, hits: hits.slice(0, 200), done }));
}

export async function handleSessionsUxMessage(port: SessionsUxPort, m: SessionsUxMessage): Promise<void> {
  switch (m.type) {
    case 'fork_session':
      await forkCurrent(port, m.itemId);
      return;
    case 'search_sessions':
      return searchSessions(port, typeof m.reqId === 'number' ? m.reqId : 0, String(m.query ?? ''));
    case 'pin_session':
      if (typeof m.id !== 'string' || !SAFE_ID.test(m.id)) return;
      if (m.id === port.session().id) await port.saveNow(); // cuộc mới chưa lưu thì chưa ghim được
      await port.store.setPinned(m.id, m.pinned === true);
      await port.refreshListings();
      return;
    case 'delete_sessions': {
      const cur = port.session().id;
      // Cuộc đang mở không xoá hàng loạt (giao diện không cho chọn): xoá nó đi qua nút Xoá thường để chuyển sang cuộc mới cho đúng.
      const ids = (Array.isArray(m.ids) ? m.ids : []).filter((x): x is string => typeof x === 'string' && SAFE_ID.test(x) && x !== cur).slice(0, 500);
      if (ids.length === 0) return;
      let n = 0;
      for (const id of ids) if (await port.store.moveToTrash(id)) n++;
      await port.refreshListings();
      port.toast('info', t(port.lang, 'sxDeletedMany', { n }));
      return;
    }
  }
}

/** Đăng ký `/fork`, `/context`, `/cost`. `owner` là ChatController (chỉ cần cấp cổng). */
export function registerSessionsSlash(slash: SlashRegistry, owner: { sessionsUxPort(): SessionsUxPort }): void {
  slash.register({
    name: 'fork',
    description: { vi: 'Rẽ nhánh cuộc trò chuyện thành cuộc mới (giữ nguyên cuộc gốc)', en: 'Branch this conversation into a new one (the original is kept)' },
    run: async () => {
      await forkCurrent(owner.sessionsUxPort());
    },
  });
  slash.register({
    name: 'context',
    description: { vi: 'Xem ngữ cảnh đang dùng, chia theo từng phần', en: 'Show context usage, broken down by part' },
    needsIdle: false,
    run: (ctx) => {
      const port = owner.sessionsUxPort();
      const s = port.session();
      ctx.info(contextReport({ lang: ctx.lang, ctx: port.context(), messages: s.messages, stats: getPromptStats(s), meter: meterOf(port) }));
    },
  });
  slash.register({
    name: 'cost',
    description: { vi: 'Xem token đã dùng và ước tính chi phí của cuộc này', en: 'Show tokens used and the estimated cost of this conversation' },
    needsIdle: false,
    run: (ctx) => {
      const port = owner.sessionsUxPort();
      ctx.info(costReport({ lang: ctx.lang, meter: meterOf(port), pricing: port.pricing(), model: port.session().model }));
    },
  });
}
