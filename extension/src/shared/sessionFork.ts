/**
 * (lane:sessions-ux) Rẽ nhánh một cuộc trò chuyện: tạo phiên MỚI chứa lịch sử tới một tin nhắn người dùng (kèm câu trả lời của lượt đó).
 *
 * Bất biến cần giữ (kiểm thử ở test/sessionFork.test.ts):
 *  - `messages` của nhánh là một TIỀN TỐ của phiên gốc, cắt đúng ở ranh giới lượt (ngay trước tin mở đầu lượt kế tiếp) — nên
 *    không bao giờ có `tool_use` mồ côi giữa chừng; nếu lượt cuối của tiền tố bị ngắt giữa vòng công cụ thì vá bằng
 *    `repairOrphanToolCalls` (kết quả "đã huỷ") để lịch sử hợp lệ với mọi hãng;
 *  - phiên gốc KHÔNG bị đụng tới (sao chép sâu);
 *  - quyền "cho phép trong phiên này" và dấu vân tay tệp đã đọc KHÔNG được thừa hưởng (nhánh mới phải xin lại quyền, đọc lại tệp);
 *  - todo, kỹ năng đã nạp, scratchpad được chép; artifact chỉ chép những cái mà tiền tố transcript có nhắc tới.
 *
 * Không import `vscode` hay `node:*` — dùng chung cho bản VS Code, trình duyệt và CLI.
 */

import type { Lang } from '../core/engine/strings';
import type { SessionState } from '../core/engine/types';
import type { ChatMessage } from '../core/types';
import type { NoticeItem, TItem, UserItem } from './protocol';
import { isTurnStart } from './transcriptRebuild';

export interface ForkResult {
  session: SessionState;
  transcript: TItem[];
  /** Lượt được chọn đã bị nén khỏi lịch sử gửi model: nhánh chỉ còn bản tóm tắt (giao diện vẫn đủ). */
  approximate: boolean;
  /** Số tin nhắn (lịch sử model) được giữ. */
  keptMessages: number;
}

export interface ForkOptions {
  /** Id tin nhắn người dùng (transcript) để rẽ nhánh SAU lượt của nó. Thiếu/không thấy = rẽ từ cuối cuộc trò chuyện. */
  atUserItemId?: string;
  newId: string;
  now: number;
  lang: Lang;
  /**
   * Vá `tool_use` mồ côi ở đuôi tiền tố (truyền `repairOrphanToolCalls` của engine). Tiêm vào thay vì import vì shared/ không được kéo
   * engine.ts (nó import tệp .md và node:crypto) vào bản webview.
   */
  repair: (session: SessionState, lang: Lang) => unknown;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function forkTitle(title: string, lang: Lang): string {
  const base = (title || (lang === 'vi' ? 'Cuộc trò chuyện' : 'Conversation')).replace(/\s*\((nhánh|branch)\)\s*$/i, '');
  return `${base.slice(0, 100)} ${lang === 'vi' ? '(nhánh)' : '(branch)'}`;
}

/** Vị trí cắt lịch sử model (exclusive) ứng với "sau lượt của tin người dùng thứ `p`" trong `userCount` tin hiển thị. */
export function forkCut(messages: readonly ChatMessage[], userCount: number, p: number): { cut: number; approximate: boolean } {
  const starts: number[] = [];
  messages.forEach((m, i) => {
    if (isTurnStart(m)) starts.push(i);
  });
  const r = userCount - 1 - p; // số lượt người dùng SAU lượt được chọn
  if (r <= 0) return { cut: messages.length, approximate: false };
  // Đếm từ CUỐI: nén ngữ cảnh làm mất các lượt đầu khỏi `messages` nhưng transcript vẫn còn đủ.
  const j = starts.length - r; // chỉ số (trong starts) của tin mở đầu lượt kế tiếp
  // j ≤ 0: chính lượt được chọn đã bị nén → chỉ giữ phần trước lượt đầu còn lại (bản tóm tắt); không có lượt nào còn → không giữ gì
  // (giữ cả lịch sử sẽ để lọt thông tin của các lượt SAU điểm rẽ vào nhánh).
  if (j <= 0) return { cut: starts.length ? starts[0] : 0, approximate: true };
  return { cut: starts[j], approximate: false };
}

export function forkSession(parent: SessionState, transcript: readonly TItem[], o: ForkOptions): ForkResult {
  const users = transcript
    .map((it, i) => ({ it, i }))
    .filter((x): x is { it: UserItem; i: number } => x.it.kind === 'user' && !x.it.steer);
  let p = o.atUserItemId ? users.findIndex((u) => u.it.id === o.atUserItemId) : -1;
  if (p < 0) p = users.length - 1;
  const { cut, approximate } = users.length ? forkCut(parent.messages, users.length, p) : { cut: parent.messages.length, approximate: false };
  const tCut = p + 1 < users.length ? users[p + 1].i : transcript.length;
  const items = clone(transcript.slice(0, tCut)) as TItem[];

  const artifactIds = new Set<string>();
  for (const it of items) if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'artifact') artifactIds.add(b.artifactId);
  const artifacts: SessionState['artifacts'] = {};
  for (const [k, v] of Object.entries(parent.artifacts ?? {})) if (artifactIds.has(k)) artifacts[k] = clone(v);

  const session: SessionState = {
    ...clone(parent),
    id: o.newId,
    title: forkTitle(parent.title, o.lang),
    createdAt: o.now,
    updatedAt: o.now,
    messages: clone(parent.messages.slice(0, cut)),
    options: undefined,
    approvals: [],
    readFiles: {},
    artifacts,
    historyEdited: false,
    promptFingerprint: undefined,
    lastContextTokens: 0,
    usageTotals: { input: 0, output: 0 },
  };
  if (session.mode === 'bypass') session.mode = 'default';
  o.repair(session, o.lang);

  const backlink: NoticeItem = {
    kind: 'notice',
    id: `fork_${o.newId}`,
    level: 'info',
    text: o.lang === 'vi' ? `Rẽ nhánh từ «${parent.title}»` : `Branched from “${parent.title}”`,
    ts: o.now,
    fork: { fromId: parent.id, fromTitle: parent.title.slice(0, 120) },
  };
  items.push(backlink);
  return { session, transcript: items, approximate, keptMessages: session.messages.length };
}
