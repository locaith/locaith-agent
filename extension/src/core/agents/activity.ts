/**
 * Một dòng ngắn mô tả việc agent con đang làm («Đang đọc src/a.ts», «Đang suy nghĩ…») cho dòng tiến độ sống ở giao diện.
 *
 * Sinh ở host theo ngôn ngữ của phiên: engine không biết bảng chuỗi của webview, và agent con không có khối công cụ riêng trong luồng chính
 * (chỉ kết quả cuối) nên giao diện không tự dựng được dòng này. Che khoá/bí mật (đối số công cụ có thể chứa token trong URL hay lệnh) và cắt
 * còn một dòng ≤ 120 ký tự — số liệu hiển thị, không phải nhật ký.
 */

import type { Lang } from '../engine/strings';
import { redactSecrets } from '../providers/http';

export const ACTIVITY_MAX = 120;

type Key = 'starting' | 'thinking' | 'writing' | 'read' | 'list' | 'glob' | 'grep' | 'search' | 'fetch' | 'run' | 'edit' | 'write' | 'use';

const TABLE: Record<Lang, Record<Key, string>> = {
  vi: {
    starting: 'Đang bắt đầu…',
    thinking: 'Đang suy nghĩ…',
    writing: 'Đang soạn báo cáo…',
    read: 'Đang đọc {x}',
    list: 'Đang xem thư mục {x}',
    glob: 'Đang tìm tệp {x}',
    grep: 'Đang tìm trong mã “{x}”',
    search: 'Đang tìm trên web “{x}”',
    fetch: 'Đang đọc trang {x}',
    run: 'Đang chạy lệnh: {x}',
    edit: 'Đang sửa {x}',
    write: 'Đang ghi {x}',
    use: 'Đang dùng công cụ {x}',
  },
  en: {
    starting: 'Starting…',
    thinking: 'Thinking…',
    writing: 'Writing the report…',
    read: 'Reading {x}',
    list: 'Listing {x}',
    glob: 'Finding files {x}',
    grep: 'Searching the code for “{x}”',
    search: 'Searching the web for “{x}”',
    fetch: 'Reading {x}',
    run: 'Running: {x}',
    edit: 'Editing {x}',
    write: 'Writing {x}',
    use: 'Using tool {x}',
  },
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Dòng đầu, một khoảng trắng giữa các từ, cắt có dấu … (ký tự điều khiển bị bỏ để không phá bố cục). */
function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const first = (s.split('\n')[0] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Cụm từ cố định cho các giai đoạn không phải lệnh công cụ. */
export function agentPhase(lang: Lang, kind: 'starting' | 'thinking' | 'writing'): string {
  return (TABLE[lang] ?? TABLE.vi)[kind];
}

/** Mô tả một lệnh gọi công cụ của agent con. */
export function agentActivity(lang: Lang, tool: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const T = TABLE[lang] ?? TABLE.vi;
  const fill = (key: Key, x: string): string => T[key].replace('{x}', x).trim();
  let text: string;
  switch (tool) {
    case 'read_file':
      text = fill('read', str(a.path));
      break;
    case 'list_dir':
      text = fill('list', str(a.path) || '.');
      break;
    case 'glob':
      text = fill('glob', str(a.pattern));
      break;
    case 'grep':
      text = fill('grep', str(a.pattern));
      break;
    case 'web_search':
      text = fill('search', str(a.query));
      break;
    case 'fetch_url':
      text = fill('fetch', str(a.url));
      break;
    case 'run_command':
      text = fill('run', oneLine(str(a.command), 80));
      break;
    case 'edit_file':
      text = fill('edit', str(a.path));
      break;
    case 'write_file':
      text = fill('write', str(a.path));
      break;
    default:
      text = fill('use', tool);
  }
  // Che khoá TRƯỚC khi cắt: cắt giữa một khoá sẽ làm mẫu che không còn khớp.
  return oneLine(redactSecrets(text), ACTIVITY_MAX);
}

/**
 * Ước lượng (số thực, không làm tròn) token của một đoạn chữ đang stream — cộng dồn nhiều đoạn nhỏ không bị "làm tròn lên" từng đoạn.
 * Cùng hệ số với engine/tokens.ts (ASCII ≈ 3,8 ký tự/token; ký tự có dấu ≈ 1,4).
 */
export function streamTokenEstimate(delta: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < delta.length; i++) {
    if (delta.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return ascii / 3.8 + other / 1.4;
}
