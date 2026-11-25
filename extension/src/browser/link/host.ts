/**
 * Phía khung chat của cầu nối VS Code: nói chuyện với dịch vụ nền (linkSw.ts) bằng chrome.runtime.sendMessage.
 * Engine nằm ở dịch vụ nền để VS Code vẫn điều khiển được Chrome khi khung chat đóng; khung chat chỉ bật/tắt, đọc trạng thái và thu hồi trang.
 * Quyền `tabs` (tuỳ chọn) được xin ở đây vì phải nằm trong cú bấm của người dùng.
 */

import type { VscodeLinkView } from '../../shared/protocol';
import { permPattern } from './origin';

export interface BrowserLinkHost {
  view(): Promise<VscodeLinkView>;
  toggle(on: boolean): Promise<void>;
  /** Thu hồi một trang đã cho phép (xoá khỏi danh sách và thu hồi quyền trang của Chrome nếu không còn origin nào cùng tên miền). */
  forget(origin: string): Promise<void>;
  /** Đăng ký nghe thay đổi từ dịch vụ nền; trả về hàm huỷ. */
  onChange(cb: () => void): () => void;
}

interface RawStatus {
  paired: boolean;
  on: boolean;
  connected: boolean;
  pairing: VscodeLinkView['pairing'];
  allowed: string[];
  session: string[];
  apps?: { kind: string; name: string; connected: boolean }[];
  lost?: string[];
}

export function chromeLinkHost(): BrowserLinkHost {
  const send = <T>(m: unknown): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;
  const view = async (): Promise<VscodeLinkView> => {
    const s = await send<RawStatus>({ type: 'nd-link-status' });
    return {
      paired: s.paired,
      on: s.on,
      connected: s.connected,
      pairing: s.pairing,
      allowed: s.allowed ?? [],
      session: s.session ?? [],
      // tên rỗng = token từ bản ≤ 0.7.19 chưa rõ của ứng dụng nào (giao diện hiện «ứng dụng trên máy»)
      apps: (s.apps ?? []).map((a) => ({ kind: String(a.kind), name: String(a.name ?? '').slice(0, 40), connected: a.connected === true })),
      lost: (s.lost ?? []).map((x) => String(x).slice(0, 40)),
    };
  };
  return {
    view,
    async toggle(on) {
      // Xin «tabs» TRƯỚC (cần cử chỉ người dùng): để thấy địa chỉ/tên tab khi hỏi duyệt từng trang. Từ chối vẫn dùng được (tab.open + trang đã duyệt), chỉ hạn chế danh sách tab.
      if (on) {
        try {
          if (!(await chrome.permissions.contains({ permissions: ['tabs'] }))) await chrome.permissions.request({ permissions: ['tabs'] });
        } catch {
          /* không xin được: bỏ qua */
        }
      }
      await send({ type: 'nd-link-toggle', on });
    },
    async forget(origin) {
      const before = await view();
      await send({ type: 'nd-link-forget', origin });
      try {
        // Thu hồi luôn quyền trang của Chrome — trừ khi còn một origin khác (khác cổng) cùng tên miền đang được cho phép.
        const u = new URL(origin);
        const rest = [...new Set([...before.allowed, ...before.session])].filter((x) => x !== origin && new URL(x).hostname === u.hostname);
        if (rest.length === 0) await chrome.permissions.remove({ origins: [permPattern(origin)] });
      } catch {
        /* không thu hồi được quyền trang: danh sách duyệt đã xoá, đủ để trợ lý bị chặn */
      }
    },
    onChange(cb) {
      const l = (m: unknown, sender: chrome.runtime.MessageSender): void => {
        if (sender.id === chrome.runtime.id && (m as { type?: unknown } | null)?.type === 'nd-link-changed') cb();
      };
      chrome.runtime.onMessage.addListener(l);
      return () => chrome.runtime.onMessage.removeListener(l);
    },
  };
}
