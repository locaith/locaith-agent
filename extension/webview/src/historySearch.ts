/**
 * (lane:sessions-ux) Tìm toàn văn lịch sử từ màn Lịch sử: gõ → chờ ngắt nhịp → hỏi host (`search_sessions`) → nhận kết quả dần theo lô
 * (`session_search`). Mỗi truy vấn có `reqId` riêng; kết quả của truy vấn cũ bị bỏ.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { HostMessage, SessionSearchHit } from '../../src/shared/protocol';
import { post } from './vscode';

export const SEARCH_DEBOUNCE_MS = 220;

export interface HistorySearchState {
  hits: ReadonlyMap<string, SessionSearchHit>;
  /** Host còn đang quét các lô tiếp theo. */
  searching: boolean;
  /** Truy vấn (đã cắt khoảng trắng) mà `hits` ứng với; rỗng = không tìm. */
  query: string;
}

const EMPTY: HistorySearchState = { hits: new Map(), searching: false, query: '' };

export function useHistorySearch(rawQuery: string): HistorySearchState {
  const [state, setState] = useState<HistorySearchState>(EMPTY);
  const reqRef = useRef(0);
  const q = rawQuery.trim();

  useEffect(() => {
    if (!q) {
      reqRef.current++; // bỏ mọi kết quả còn bay về
      setState(EMPTY);
      return;
    }
    const reqId = ++reqRef.current;
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, searching: true, query: q }));
      post({ type: 'search_sessions', reqId, query: q });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      const m = e.data;
      if (!m || m.type !== 'session_search' || m.reqId !== reqRef.current) return;
      setState({ hits: new Map(m.hits.map((h) => [h.id, h])), searching: !m.done, query: m.query });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return state;
}
