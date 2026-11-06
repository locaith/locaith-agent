// Server MCP giả (stdio, JSON-RPC theo dòng) dùng cho kiểm thử máy khách MCP.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  { name: 'echo', description: 'Lặp lại văn bản', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Luôn trả lỗi', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Không bao giờ trả lời', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Cho biết biến môi trường', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Làm server thoát', inputSchema: { type: 'object', properties: {} } },
  { name: 'img', description: 'Trả ảnh', inputSchema: { type: 'object', properties: {} } },
];

rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' } } });
  } else if (m.method === 'tools/list') {
    // phân trang giả: trang 1 có 3 công cụ + nextCursor, trang 2 phần còn lại
    if (!m.params?.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(0, 3), nextCursor: 'p2' } });
    else send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(3) } });
  } else if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } });
    else if (name === 'boom') send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'hỏng rồi' }] } });
    else if (name === 'env') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `key=${process.env.OPENAI_API_KEY ?? 'unset'};custom=${process.env.CUSTOM_VAR ?? 'unset'}` }] } });
    else if (name === 'img') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'ảnh đây' }] } });
    else if (name === 'crash') process.exit(3);
    // 'slow': im lặng
  } else if (m.method === 'ping' && m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
