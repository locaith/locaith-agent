/**
 * Ổ cắm WebSocket cho Node (gói `ws`) làm thêm MỘT việc: khi máy chủ từ chối bước bắt tay HTTP (vd. Realtime hết chỗ kết nối đồng thời, hoặc giới hạn tốc độ),
 * đọc thân phản hồi để biết LÝ DO rồi báo như một lỗi thường «HTTP 403: …». Nhờ đó RealtimeLink phân biệt được "relay quá tải" với "mất mạng / sai khoá".
 * (Mặc định `ws` chỉ báo «Unexpected server response: 403» và vứt thân phản hồi.)
 */

import WebSocket from 'ws';
import type { WsLike } from './phoenix';

const MAX_BODY = 2048;

export function nodeSocket(url: string): WsLike {
  const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
  ws.on('unexpected-response', (req, res) => {
    let body = '';
    let done = false;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      if (body.length < MAX_BODY) body += chunk;
    });
    const finish = () => {
      if (done) return;
      done = true;
      ws.emit('error', new Error(`HTTP ${res.statusCode}: ${body.slice(0, 400).replace(/\s+/g, ' ').trim()}`));
      try {
        req.destroy();
        ws.terminate();
      } catch {
        /* đã đóng */
      }
    };
    res.once('end', finish);
    res.once('error', finish);
    res.once('close', finish);
  });
  return ws as unknown as WsLike;
}
