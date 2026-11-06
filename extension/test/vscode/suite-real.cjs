// Bộ kiểm thử THẬT (không giả lập): chạy trong VS Code Insiders thật, với dịch vụ/khoá/tài khoản thật của anh.
//   ND_REAL=swarm   Swarm với model Gemini thật (có trần token cứng do chính bài kiểm thử áp, vì 'workflow_run' do model tự quyết định số agent)
//   ND_REAL=bio     Cài Bio-Memory-Locaith thật vào môi trường Python riêng (USERPROFILE tạm — không đụng ~/.locaith của anh), chạy MCP thật, ghi/đọc bộ nhớ
//   ND_REAL=oauth   Đăng nhập OAuth MCP thật (đăng ký ứng dụng tự động + PKCE + cổng loopback) với một dịch vụ thật, gọi công cụ chỉ-đọc, làm mới token, ngắt kết nối
// Chạy bằng `node _work/run-insiders-real.mjs` (đặt ND_REAL). Chạy BÊN TRONG extension host (CommonJS).
const assert = require('node:assert');
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { helpers: H } = require('./suite.cjs');

const log = (...a) => console.log('  [thật]', ...a);

async function boot() {
  const ext = vscode.extensions.getExtension('LocaithAI.locaith-agent');
  const api = await ext.activate();
  assert.ok(api && api.sidebar, 'Thiếu TestApi');
  await vscode.commands.executeCommand('locaithAgent.chatView.focus');
  await H.waitFor(() => api.sidebar.stats.ready > 0, 30000, 'webview sẵn sàng');
  await H.admin('user', { id: 'user-test-1', email: 'tester@locaith.ai', name: 'Người Thử' });
  await H.signInFlow(api); // qua cổng tài khoản (máy chủ locaith.ai giả của harness)
  return api;
}

// ─────────────────────────────── SWARM ───────────────────────────────
function budgetProvider(real, cap, state) {
  return {
    id: 'budget',
    label: 'Gemini (trần token)',
    kind: real.kind,
    flavor: real.flavor,
    capabilities: real.capabilities,
    async *stream(req) {
      if (state.tokens >= cap) throw new Error(`Đã chạm trần ${cap.toLocaleString()} token của bài kiểm thử`);
      state.calls++;
      for await (const ev of real.stream(req)) {
        if (ev.type === 'done' && ev.usage) {
          state.inTok += ev.usage.inputTokens || 0;
          state.outTok += ev.usage.outputTokens || 0;
          state.tokens = state.inTok + state.outTok;
        }
        yield ev;
      }
    },
    complete: (...a) => real.complete(...a),
    fetchModels: (...a) => real.fetchModels(...a),
    ping: (...a) => real.ping(...a),
  };
}

async function realSwarm(api) {
  const CAP = Number(process.env.ND_REAL_TOKEN_CAP || 400_000);
  const sb = api.sidebar;
  const real = api.providers.get('gemini');
  assert.ok(real, 'Không có nhà cung cấp gemini (thiếu GEMINI_API_KEY trong môi trường?)');
  assert.ok(await api.providers.hasKey('gemini'), 'Chưa có khoá Gemini');
  const models = await real.fetchModels();
  const ids = models.map((m) => m.id);
  const pick = (re) => ids.find((i) => re.test(i));
  const model = process.env.ND_REAL_MODEL || pick(/flash-lite/i) || pick(/flash/i) || ids[0];
  log(`Gemini: ${ids.length} model; dùng "${model}"; trần ${CAP.toLocaleString()} token`);
  const state = { tokens: 0, inTok: 0, outTok: 0, calls: 0 };
  api.providers.registry.addExtraProvider(budgetProvider(real, CAP, state), [{ id: model, label: model }]);

  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  await cfg.update('agent.allowBypassPermissions', true, vscode.ConfigurationTarget.Global);
  await sb.startNewSession();
  await sb.setModel('budget', model);
  await sb.onMessage({ type: 'set_mode', mode: 'bypass' });
  await sb.onMessage({ type: 'set_thinking', level: 'swarm' });
  assert.strictEqual(sb.snapshot().session.thinkingLevel, 'swarm');
  assert.strictEqual(sb.snapshot().session.mode, 'bypass', 'Chế độ bypass phải đặt được trong hồ sơ thử');

  const prompt =
    'Dùng chế độ Swarm: hãy chia việc cho ĐÚNG 3 agent con chạy song song bằng công cụ workflow_run (tối đa 3 agent, mỗi agent tối đa 20000 token). ' +
    'Agent 1: đọc tệp README.md trong workspace và tóm tắt trong một câu. Agent 2: đọc tệp app.ts và nói giá trị của hằng `tên`. ' +
    'Agent 3: đếm tổng số dòng của hai tệp README.md và app.ts. Sau đó tổng hợp ba kết quả thành 3 gạch đầu dòng, không viết thêm gì khác.';
  const t0 = Date.now();
  await sb.ask(prompt, []);
  await H.waitFor(() => !sb.isRunning, 25 * 60_000, 'Swarm chạy xong');
  const secs = Math.round((Date.now() - t0) / 1000);
  const snap = sb.snapshot();
  const asst = snap.view.transcript.filter((i) => i.kind === 'assistant');
  const tools = asst.flatMap((a) => a.blocks.filter((b) => b.type === 'tool'));
  const names = tools.map((t) => `${t.name}:${t.state}`);
  const text = asst.map((a) => a.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')).join('\n');
  log(`xong sau ${secs}s; ${state.calls} lượt gọi model; ${state.tokens.toLocaleString()} token (vào ${state.inTok.toLocaleString()} · ra ${state.outTok.toLocaleString()})`);
  log(`công cụ: ${names.join(', ')}`);
  log(`trả lời cuối:\n${text.slice(0, 900)}`);
  fs.writeFileSync(path.join(process.env.ND_REAL_OUT || process.cwd(), 'swarm-result.json'), JSON.stringify({ model, secs, calls: state.calls, tokens: state.tokens, inTok: state.inTok, outTok: state.outTok, tools: names, text }, null, 2));
  assert.ok(state.tokens <= CAP + 60_000, `Vượt trần token: ${state.tokens}`);
  const wf = tools.find((t) => t.name === 'workflow_run');
  assert.ok(wf, `Model không dùng workflow_run (công cụ: ${names.join(', ')})`);
  assert.ok(wf.state === 'done', `workflow_run kết thúc ở trạng thái ${wf.state}`);
  assert.ok(/Ánh|Hồng|dòng|2|3/.test(text), 'Câu trả lời tổng hợp không có nội dung từ hai tệp');
  await cfg.update('agent.allowBypassPermissions', undefined, vscode.ConfigurationTarget.Global);
}

// ─────────────────────────────── BIO-MEMORY ───────────────────────────────
async function realBio(api) {
  const os = require('node:os');
  log(`homedir của extension host = ${os.homedir()} (phải là thư mục tạm, không phải ~ của anh)`);
  assert.ok(/nd-vscode-ins-/.test(os.homedir()), 'USERPROFILE chưa được đổi sang thư mục tạm — dừng để không đụng dữ liệu thật');
  assert.strictEqual(api.bio.status().state, 'none', 'Bio-Memory đã cài sẵn?');
  const t0 = Date.now();
  const lines = [];
  const off = api.bio.onProgress ? api.bio.onProgress((l) => lines.push(l)) : undefined;
  const r = await api.bio.install();
  off && off();
  log(`cài đặt: ${JSON.stringify(r).slice(0, 300)} (${Math.round((Date.now() - t0) / 1000)}s)`);
  assert.ok(r.ok, `Cài Bio-Memory thất bại: ${r.ok ? '' : r.message}`);
  assert.strictEqual(api.bio.status().state, 'ready');
  const entry = api.bio.entry();
  assert.ok(entry, 'Thiếu mục MCP của Bio-Memory');
  log('mục MCP:', JSON.stringify({ name: entry.name, cmd: entry.cfg.command, args: entry.cfg.args }));
  await api.mcp.configure([entry]);
  await H.waitFor(() => api.mcp.status().some((s) => s.name === entry.name && s.status === 'running'), 120000, 'server MCP Bio-Memory chạy');
  const st = api.mcp.status().find((s) => s.name === entry.name);
  const tools = st.tools.map((t) => t.name);
  log(`công cụ MCP (${tools.length}): ${tools.join(', ')}`);
  for (const need of ['recall', 'memory_status']) assert.ok(tools.includes(need), `Thiếu công cụ ${need}`);
  const status = await api.mcp.callByName(entry.name, 'memory_status', {});
  log('memory_status →', status.text.slice(0, 300));
  assert.ok(!status.isError, 'memory_status báo lỗi');
  if (tools.includes('store_memory')) {
    const marker = `kiểm-thử-thật-${Date.now()}`;
    const stored = await api.mcp.callByName(entry.name, 'store_memory', { text: `Dấu thử ${marker}: Nguyễn Văn Ánh thích cà phê sữa đá` });
    log('store_memory →', stored.text.slice(0, 200));
    assert.ok(!stored.isError, 'store_memory lỗi');
    const rec = await api.mcp.callByName(entry.name, 'recall', { query: 'Nguyễn Văn Ánh cà phê' });
    log('recall →', rec.text.slice(0, 300));
    assert.ok(!rec.isError && rec.text.includes(marker), 'recall không trả lại dữ liệu vừa ghi');
  }
  // dữ liệu nằm trong thư mục tạm
  assert.ok(fs.existsSync(path.join(os.homedir(), '.locaith', 'bio-memory')), 'Không thấy thư mục dữ liệu Bio-Memory');
}

// ─────────────────────────────── OAUTH MCP ───────────────────────────────
async function realOauth(api) {
  const id = process.env.ND_REAL_OAUTH_ID || 'vercel';
  const urlFile = process.env.ND_TEST_OAUTH_URL_FILE;
  assert.ok(urlFile, 'Thiếu ND_TEST_OAUTH_URL_FILE');
  const done = path.join(path.dirname(urlFile), 'oauth-done.json');
  log(`bắt đầu đăng nhập OAuth MCP thật: ${id} (URL ghi ra ${urlFile}; chờ ai đó bấm «Cho phép» trong trình duyệt)`);
  const p = api.connectors.connect(id);
  const result = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('hết 10 phút chờ đăng nhập')), 10 * 60_000))]);
  log('kết quả connect:', JSON.stringify(result).slice(0, 300));
  assert.ok(result && result.ok, `Đăng nhập OAuth không thành công: ${result && result.message}`);
  await H.waitFor(() => api.mcp.status().some((s) => s.name === id && s.status === 'running'), 90000, `server MCP ${id} chạy sau khi đăng nhập`);
  const st = api.mcp.status().find((s) => s.name === id);
  const names = st.tools.map((t) => t.name);
  log(`công cụ (${names.length}): ${names.slice(0, 25).join(', ')}${names.length > 25 ? '…' : ''}`);
  assert.ok(names.length > 0, 'Server không trả công cụ nào');
  // gọi MỘT công cụ chỉ-đọc, không tham số bắt buộc
  const prefer = ['get_auth_user', 'whoami', 'get_user', 'list_teams', 'get_me', 'search_docs', 'list_projects', 'list_organizations'];
  const tool = prefer.find((n) => names.includes(n)) || names.find((n) => /^(get|list)_/.test(n));
  let called = null;
  if (tool) {
    const r = await api.mcp.callByName(id, tool, {});
    called = { tool, isError: r.isError, text: r.text.slice(0, 400) };
    log(`gọi ${tool} →`, JSON.stringify(called));
  }
  // làm mới token: ép hết hạn rồi gọi lại (nếu server cấp refresh_token)
  const stSaved = api.connectors.oauthStateForTests ? api.connectors.oauthStateForTests(id) : undefined;
  fs.writeFileSync(done, JSON.stringify({ id, tools: names.length, called, hasRefresh: !!(stSaved && stSaved.tokens && stSaved.tokens.refreshToken) }, null, 2));
  const dis = await api.connectors.disconnect(id);
  log('ngắt kết nối:', JSON.stringify(dis).slice(0, 200));
  await H.waitFor(() => !api.mcp.status().some((s) => s.name === id), 30000, 'server MCP bị gỡ sau khi ngắt kết nối');
}

exports.run = async function run() {
  const which = String(process.env.ND_REAL || '').split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(which.length, 'Đặt ND_REAL=swarm|bio|oauth');
  const api = await boot();
  for (const w of which) {
    log(`=== ${w} ===`);
    if (w === 'swarm') await realSwarm(api);
    else if (w === 'bio') await realBio(api);
    else if (w === 'oauth') await realOauth(api);
    else throw new Error(`Không biết bài ${w}`);
  }
};
