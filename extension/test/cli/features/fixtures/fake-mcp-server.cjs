// Server MCP giả (stdio, JSON-RPC theo dòng) cho kiểm thử. Ghi dấu khởi động vào MARK_FILE nếu có.
const fs = require('node:fs');
if (process.env.MARK_FILE) fs.appendFileSync(process.env.MARK_FILE, 'started\n');
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1.0.0' }, instructions: 'Dùng echo để lặp lại chữ.' } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'get_echo', description: 'Lặp lại chữ', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'write_thing', description: 'Ghi thứ gì đó', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (m.method === 'tools/call') {
      const a = m.params.arguments || {};
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name + ':' + (a.text ?? '') + ':' + (process.env.FAKE_TOKEN || '') }] } });
    } else if (m.method === 'prompts/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { prompts: [{ name: 'greet', description: 'Chào ai đó', arguments: [{ name: 'who', required: true }] }] } });
    } else if (m.method === 'prompts/get') {
      send({ jsonrpc: '2.0', id: m.id, result: { messages: [{ role: 'user', content: { type: 'text', text: 'Xin chào ' + (m.params.arguments || {}).who } }] } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
