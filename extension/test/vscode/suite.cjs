// Chạy BÊN TRONG extension host của VS Code (CommonJS vì host nạp bằng require).
const assert = require('node:assert');
const vscode = require('vscode');

const path = require('node:path');
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chụp cả cửa sổ VS Code qua Chrome DevTools Protocol (chỉ khi đặt ND_TEST_SHOTS=<thư mục>). */
async function shot(name) {
  const dir = process.env.ND_TEST_SHOTS;
  if (!dir) return;
  try {
    const puppeteer = require('puppeteer-core');
    fs.mkdirSync(dir, { recursive: true });
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9339', defaultViewport: null });
    const pages = await browser.pages();
    const page = pages.find((p) => /workbench/.test(p.url())) ?? pages[0];
    await page.screenshot({ path: path.join(dir, name + '.png') });
    browser.disconnect();
  } catch (e) {
    console.warn('Không chụp được ảnh', name, e && e.message);
  }
}
async function waitFor(cond, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error(`Hết thời gian chờ: ${what}`);
}

exports.helpers = { sleep, waitFor, shot, get admin() { return admin; }, get signInFlow() { return signInFlow; }, get testAccountGate() { return testAccountGate; }, TEST_USER_ID: 'user-test-1' };

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('LocaithAI.locaith-agent');
  assert.ok(ext, 'Không tìm thấy extension LocaithAI.locaith-agent');
  const api = await ext.activate();
  assert.ok(ext.isActive, 'Extension không kích hoạt được');
  assert.ok(api && api.sidebar, 'Thiếu TestApi (cần ND_AGENT_TEST=1)');

  // 1. Lệnh đã đăng ký
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['locaithAgent.open', 'locaithAgent.openInTab', 'locaithAgent.newChat', 'locaithAgent.setApiKey', 'locaithAgent.addCustomProvider', 'locaithAgent.selectModel', 'locaithAgent.showHistory', 'locaithAgent.exportChat']) {
    assert.ok(cmds.includes(c), `Thiếu lệnh ${c}`);
  }

  // 2. Webview thật nạp được (HTML + CSP + font + script) và bắt tay `ready`
  await vscode.commands.executeCommand('locaithAgent.chatView.focus');
  await waitFor(() => api.sidebar.stats.ready > 0, 30000, 'webview gửi tin nhắn "ready" (script giao diện chưa chạy?)');

  // 2b. (0.5.2) CỔNG TÀI KHOẢN: chưa đăng nhập thì mọi thứ bị khoá; đăng nhập đầy đủ bằng luồng OAuth/PKCE thật (URI handler của VS Code thật)
  await testAccountGate(api);

  // ND_TEST_ONLY=<tên>: chỉ chạy MỘT bước (đã đăng nhập) để chẩn đoán nhanh — remote · relay · bypass · bio · queue
  if (process.env.ND_TEST_ONLY) {
    const fn = { remote: testRemote, relay: testRelay, bypass: testBypassMode, bio: testBioAutoSetup, queue: testQueueFlow, media: testMediaPreview }[process.env.ND_TEST_ONLY];
    if (!fn) throw new Error('ND_TEST_ONLY không hợp lệ: ' + process.env.ND_TEST_ONLY);
    await fn(api);
    return;
  }

  // 3. Chưa có khoá nào → tự chọn chế độ demo
  await api.sidebar.sendInit();
  let snap = api.sidebar.snapshot();
  await sleep(1200);
  await shot('01-welcome');
  // 0.6.0: người đã đăng nhập mà chưa có khoá nào bắt đầu bằng Locaith-v5 (miễn phí, không cần khoá) — sau khi đồng ý thông báo dữ liệu. Phần còn lại của bộ kiểm thử chạy trên chế độ demo (offline, theo kịch bản).
  assert.strictEqual(snap.view.provider, 'locaith', `Chưa có khoá nào thì phải bắt đầu bằng Locaith-v5, nhưng đang là ${snap.view.provider}`);
  assert.ok(snap.view.providers.some((p) => p.id === 'demo'), 'Vẫn phải có chế độ demo');
  await api.sidebar.setModel('demo', 'demo-1');
  snap = api.sidebar.snapshot();
  assert.strictEqual(snap.view.provider, 'demo', `Đổi sang demo không được, đang là ${snap.view.provider}`);
  assert.ok(snap.view.providers.length >= 6, 'Danh sách nhà cung cấp quá ít');
  const ids = snap.view.providers.map((p) => p.id);
  for (const id of ['anthropic', 'openai', 'gemini', 'deepseek', 'xai', 'demo']) assert.ok(ids.includes(id), `Thiếu nhà cung cấp ${id}`);
  assert.ok(snap.view.skills.some((s) => s.name === 'artifacts'), 'Thiếu kỹ năng artifacts');

  // 3b. Tính năng 0.5.0 đã được nối vào extension thật
  assert.ok(cmds.includes('locaithAgent.openMarket'), 'Thiếu lệnh locaithAgent.openMarket');
  assert.ok(ids.includes('locaith-auto'), 'Thiếu nhà cung cấp ảo Locaith Auto');
  assert.ok(snap.view.skills.some((s) => s.name === 'multi-agent'), 'Thiếu kỹ năng multi-agent');
  assert.strictEqual(snap.view.orchestration && snap.view.orchestration.mode, 'off', 'Điều phối phải TẮT theo mặc định');
  for (const a of ['explore', 'plan', 'researcher', 'reviewer', 'general']) assert.ok(api.agents.get(a), `Thiếu agent dựng sẵn ${a}`);
  assert.deepStrictEqual(api.mcp.status(), [], 'Chưa khai báo MCP nào thì danh sách phải rỗng');
  assert.ok(api.sidebar.registry.get('agent'), 'Thiếu công cụ agent');
  assert.ok(api.sidebar.registry.get('workflow_run'), 'Thiếu công cụ workflow_run (ẩn, mở bằng kỹ năng multi-agent)');

  // 4. Chạy trọn kịch bản agent qua engine thật trong VS Code thật
  await api.sidebar.ask('So sánh điểm các model AI và dựng bảng thang điểm', []);
  await waitFor(() => !api.sidebar.isRunning, 90000, 'agent chạy xong');
  snap = api.sidebar.snapshot();
  const assistant = snap.view.transcript.find((i) => i.kind === 'assistant');
  assert.ok(assistant && assistant.done, 'Lượt trả lời chưa kết thúc');
  assert.strictEqual(assistant.stopReason, 'end_turn');
  const kinds = assistant.blocks.map((b) => b.type);
  for (const k of ['tasks', 'skill', 'tool', 'artifact', 'text']) assert.ok(kinds.includes(k), `Thiếu khối ${k} trong transcript`);
  assert.ok(snap.view.todos.length === 3 && snap.view.todos.every((t) => t.status === 'completed'), 'Bảng tác vụ chưa hoàn tất');
  assert.strictEqual(Object.keys(snap.session.artifacts).length, 1, 'Phải có đúng 1 artifact');
  assert.strictEqual(snap.view.running, false);

  // 5. Khung xem trước artifact đã mở thành tab riêng
  await waitFor(
    () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => /Bảng thang điểm/.test(t.label))),
    10000,
    'tab xem trước artifact',
  );

  await sleep(1500);
  await shot('02-demo-done');

  // 6. Hội thoại đã được lưu ra đĩa
  await waitFor(async () => (await api.store.list()).length === 1, 10000, 'lưu hội thoại');
  const saved = await api.store.load(snap.session.id);
  assert.ok(saved && saved.session.messages.length >= 10, 'Hội thoại lưu thiếu tin nhắn');
  assert.ok(saved.transcript.length >= 2);

  // 7. Hội thoại mới → lịch sử vẫn còn, trạng thái sạch
  await api.sidebar.startNewSession();
  snap = api.sidebar.snapshot();
  assert.strictEqual(snap.view.transcript.length, 0);
  assert.strictEqual(snap.view.sessions.length, 1);

  // 8. Cho webview thời gian vẽ xong rồi (tuỳ chọn) chụp ảnh cửa sổ VS Code qua CDP — xem README phần kiểm thử
  await sleep(1200);
  await shot('03-new-chat');

  // 9. Luồng sửa tệp THẬT trong VS Code: xin phép → WorkspaceEdit lên editor đang mở (có thay đổi chưa lưu) → lưu.
  await testEditFlow(api);

  // 9b. (0.6.3) Xem trước kết quả (ảnh/video/âm thanh) + gấp quá trình làm việc — host thật, webview thật, trình xem ảnh của VS Code
  await testMediaPreview(api);

  // 10. Đổi font từ giao diện → ghi vào cài đặt VS Code → host cập nhật lại ViewState (và từ chối giá trị sai kiểu).
  const cfg = () => vscode.workspace.getConfiguration('locaithAgent');
  assert.strictEqual(cfg().get('ui.fontFamily'), 'be-vietnam-pro', 'Font mặc định phải là Be Vietnam Pro');
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'fontFamily', value: 'manrope' });
  await waitFor(() => api.sidebar.snapshot().view.settings.fontFamily === 'manrope', 10000, 'ViewState nhận font Manrope');
  assert.strictEqual(cfg().get('ui.fontFamily'), 'manrope');
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'fontSize', value: 'abc' });
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'khongTonTai', value: 1 });
  await sleep(500);
  assert.strictEqual(cfg().get('ui.fontSize'), 14, 'Giá trị sai kiểu không được ghi');
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'fontFamily', value: 'be-vietnam-pro' });
  await waitFor(() => api.sidebar.snapshot().view.settings.fontFamily === 'be-vietnam-pro', 10000, 'khôi phục font');

  // 11. Màn hình cài đặt (chụp ảnh nếu bật ND_TEST_SHOTS).
  await api.sidebar.showScreen('settings');
  await sleep(1500);
  await shot('05-settings');
  await api.sidebar.showScreen('chat');

  // 12. Chợ + MCP thật trong VS Code thật (0.5.0)
  await api.sidebar.showScreen('market');
  assert.strictEqual(api.sidebar.snapshot().view.screen, 'market');
  const market = await api.sidebar.d.marketService.state();
  assert.ok(market.skills.length > 500, `Chợ phải có hàng trăm kỹ năng, đang có ${market.skills.length}`);
  // 0.5.1: các mẫu MCP dựng sẵn của 0.5.0 được thay bằng kho kết nối (32 mục đã thăm dò thật) + thẻ Bio-Memory-Locaith.
  assert.ok(market.catalog && market.catalog.length >= 25, `Kho kết nối MCP phải có từ 25 mục, đang có ${market.catalog && market.catalog.length}`);
  assert.ok(market.agents.some((a) => a.name === 'reviewer'), 'Thiếu agent reviewer trong Chợ');
  await sleep(1200);
  await shot('06-market');

  // MCP thật: server giả (chạy bằng chính Electron ở chế độ Node) khai báo ở cài đặt người dùng → tự chạy, công cụ vào kho công cụ.
  const fake = require('node:path').join(__dirname, '..', 'fixtures', 'fake-mcp-server.mjs');
  const mcpCfg = vscode.workspace.getConfiguration('locaithAgent');
  await mcpCfg.update('mcp.servers', { fake: { command: process.execPath, args: [fake], env: { ELECTRON_RUN_AS_NODE: '1' } } }, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.mcp.status().some((x) => x.name === 'fake' && x.status === 'running'), 45000, 'server MCP giả chạy (stdio, khởi tạo, liệt kê công cụ)');
  const st = api.mcp.status().find((x) => x.name === 'fake');
  assert.strictEqual(st.tools.length, 6, 'Phải thấy 6 công cụ MCP (có phân trang)');
  assert.ok(api.sidebar.registry.get('mcp__fake__echo'), 'Công cụ MCP chưa vào kho công cụ của cuộc trò chuyện');
  await mcpCfg.update('mcp.servers', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.mcp.status().length === 0, 20000, 'gỡ server MCP khi xoá khỏi cài đặt');
  assert.ok(!api.sidebar.registry.get('mcp__fake__echo'), 'Công cụ MCP phải bị gỡ khỏi kho');
  await api.sidebar.showScreen('chat');

  // 13. Gửi nhiều tin khi trợ lý đang làm việc (0.5.0)
  await testQueueFlow(api);

  // 14. Tính năng của 0.5.1 (Swarm, lịch sử mọi thư mục, hàn gắn transcript, kết nối, Chrome)
  await test051(api);

  // 14a. (0.6.1) "Bỏ qua mọi xác nhận" có sẵn trong danh sách chế độ: bật bằng hộp xác nhận trong khung chat, không phải vào Cài đặt
  await testBypassMode(api);

  // 14a2. (0.6.1) Locaith-v5 tự bật Bio-Memory: dải trong khung chat (đang cài → lỗi kèm lý do → thử lại → xong), không cài hai lần, tôn trọng «Đừng hỏi lại»
  await testBioAutoSetup(api);

  // 14b. Remote BẬT SẴN cho người đã đăng nhập (chỉ đường Internet; 127.0.0.1 tắt), trạng thái hiện trong khung chat, công tắc ở Cài đặt
  await testRemoteDefaultOn(api);

  // 15. Remote (0.5.2): máy chủ điều khiển từ xa chạy trong VS Code thật, ghép đôi + luồng sự kiện + duyệt quyền + thu hồi
  await testRemote(api);

  // 16. Remote qua relay (Supabase Realtime, mã hoá đầu-cuối): VS Code thật ↔ trình duyệt giả dùng đúng mã của trang web
  await testRelay(api);

  // 16b. Relay quá tải (Realtime hết chỗ kết nối): báo rõ "đang xếp hàng" + đếm ngược, không dội thêm kết nối, vào được ngay khi hết quá tải
  await testRelayQueue(api);

  // 17. Phiên bị thu hồi từ phía máy chủ → khoá lại; đăng xuất/đăng nhập lại
  await testAccountLock(api);
};

/**
 * (0.6.3) Xem trước kết quả trong VS Code THẬT:
 *  - host kiểm đường dẫn (có thật / ngoài vùng / ổ mạng / không phải tệp xem trước) và trả địa chỉ webview — CHỈ cho khung chat, không qua Remote;
 *  - «Mở trong VS Code» mở trình xem ảnh của VS Code; đường dẫn chưa được xác nhận thì không mở gì;
 *  - webview thật (CSP media-src + localResourceRoots) phát được video H.264 và hiện ảnh; lượt đã xong gấp quá trình thành một dòng.
 */
async function testMediaPreview(api) {
  const sb = api.sidebar;
  const wv = sb.webview;
  assert.ok(wv, 'Khung chat chưa gắn webview');
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const dir = path.join(ws, 'ket-qua');
  fs.mkdirSync(dir, { recursive: true });
  const media = path.join(__dirname, '..', '..', 'webview', 'dev', 'media');
  fs.copyFileSync(path.join(media, 'cover.png'), path.join(dir, 'anh-bia.png'));
  fs.copyFileSync(path.join(media, 'demo-locaith.mp4'), path.join(dir, 'video demo.mp4'));
  fs.copyFileSync(path.join(media, 'voice.mp3'), path.join(dir, 'nhac.mp3'));

  const captured = [];
  const orig = wv.postMessage;
  wv.postMessage = function (m) {
    captured.push(m);
    return orig.call(this, m);
  };
  const mirrored = [];
  const mirrorSub = sb.addMirror((m) => mirrored.push(m));
  try {
    const outside = path.join(path.parse(ws).root, 'khong-vung-nd-test', 'a.png');
    await sb.onMessage({
      type: 'resolve_media',
      key: 'k-media',
      paths: ['ket-qua/anh-bia.png', 'ket-qua/video demo.mp4', 'ket-qua/nhac.mp3', 'ket-qua/khong-co.png', outside, '\\\\may-chu\\chia-se\\a.png', 'app.ts'],
    });
    const reply = captured.find((m) => m && m.type === 'media_resolved' && m.key === 'k-media');
    assert.ok(reply, 'Host phải trả lời media_resolved');
    const [img, vid, aud, missing, out, unc, code] = reply.items;
    assert.ok(img.ok && img.kind === 'image' && /vscode-(resource|cdn)|vscode-webview/.test(img.src), `Ảnh trong workspace phải có địa chỉ webview: ${JSON.stringify(img)}`);
    assert.ok(vid.ok && vid.kind === 'video' && vid.src && vid.name === 'video demo.mp4', `Video (tên có dấu cách) phải nhúng được: ${JSON.stringify(vid)}`);
    assert.ok(aud.ok && aud.kind === 'audio' && aud.src, 'Âm thanh phải nhúng được');
    assert.strictEqual(missing.ok, false, 'Tệp không có thật → ok:false');
    assert.strictEqual(out.ok, false, 'Ngoài vùng xem → ok:false (không đụng đĩa)');
    assert.strictEqual(unc.ok, false, 'Ổ mạng → ok:false');
    assert.strictEqual(code.ok, false, 'Tệp mã nguồn không phải tệp xem trước');
    assert.ok(!mirrored.some((m) => m && m.type === 'media_resolved'), 'media_resolved KHÔNG được phát lại cho Remote');

    // «Mở trong VS Code»: trình xem ảnh của VS Code
    await sb.onMessage({ type: 'open_media', path: img.abs, how: 'editor' });
    await waitFor(() => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return !!tab && tab.input instanceof vscode.TabInputCustom && /anh-bia\.png$/.test(tab.input.uri.fsPath);
    }, 15000, 'mở ảnh kết quả bằng trình xem ảnh của VS Code');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    // đường dẫn chưa qua resolve_media: không mở gì
    const before = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
    await sb.onMessage({ type: 'open_media', path: path.join(ws, 'app.ts'), how: 'editor' });
    await sleep(600);
    assert.strictEqual(vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0), before, 'open_media không được mở tệp chưa xác nhận');

    // Webview THẬT: một lượt đã xong có quá trình + câu trả lời nhắc tới ảnh, video, âm thanh
    await vscode.commands.executeCommand('locaithAgent.chatView.focus');
    const id = 'a_media_test';
    const t0 = Date.now() - 75_000;
    sb.emit({ t: 'assistant_start', id, provider: 'demo', model: 'demo', ts: t0 });
    sb.emit({ t: 'tool_start', id, callId: 'm1', name: 'read_file', args: { path: 'README.md' } });
    sb.emit({ t: 'tool_end', id, callId: 'm1', state: 'done', summary: '3 dòng', durationMs: 40 });
    sb.emit({ t: 'text', id, delta: 'Đọc xong, giờ dựng video.' });
    sb.emit({ t: 'tool_start', id, callId: 'm2', name: 'run_command', args: { command: 'ffmpeg -i a.mp4 b.mp4' } });
    sb.emit({ t: 'tool_end', id, callId: 'm2', state: 'done', durationMs: 900 });
    sb.emit({ t: 'pill', id, pillId: 'p1', text: 'Đang kiểm tra kết quả…', kind: 'thinking' });
    sb.emit({ t: 'text', id, delta: 'Xong. Video: `ket-qua/video demo.mp4` · ảnh bìa ket-qua/anh-bia.png · nhạc `ket-qua/nhac.mp3`' });
    sb.emit({ t: 'assistant_end', id, stopReason: 'end_turn' });

    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9339', defaultViewport: null });
    try {
      let frame = null;
      const t1 = Date.now();
      while (!frame && Date.now() - t1 < 30000) {
        for (const page of await browser.pages()) {
          for (const f of page.frames()) {
            try {
              // Lượt CUỐI (lượt vừa phát) — các lượt trước trong phiên (vd. luồng sửa tệp ở bước 9) cũng có dòng gấp riêng.
              if (await f.evaluate(() => !!document.querySelector('.app') && !![...document.querySelectorAll('.turn-assistant')].pop()?.querySelector('.work-head'))) frame = f;
            } catch {
              /* khung chưa sẵn sàng / khác nguồn */
            }
            if (frame) break;
          }
          if (frame) break;
        }
        if (!frame) await sleep(400);
      }
      assert.ok(frame, 'Không thấy khung chat (webview) có dòng «Đã làm việc» trong VS Code thật');
      await frame.waitForFunction(
        () => {
          const last = [...document.querySelectorAll('.turn-assistant')].pop();
          const v = last && last.querySelector('video.media-player');
          const i = last && last.querySelector('.media img');
          const a = last && last.querySelector('audio.media-player');
          return v && v.readyState >= 1 && i && i.complete && i.naturalWidth > 0 && a && a.readyState >= 1;
        },
        { timeout: 30000 },
      );
      const info = await frame.evaluate(() => {
        const last = [...document.querySelectorAll('.turn-assistant')].pop();
        const v = last.querySelector('video.media-player');
        return { w: v.videoWidth, h: v.videoHeight, dur: v.duration, work: last.querySelector('.work-head').closest('.work-line').textContent, folded: !last.querySelector('.work-body') };
      });
      assert.strictEqual(info.w, 1280, `Video phải giải mã được (H.264): ${JSON.stringify(info)}`);
      assert.ok(info.dur > 3.5 && info.dur < 4.5, `Thời lượng video ~4 giây: ${info.dur}`);
      assert.match(info.work, /Đã làm việc|Worked for/);
      assert.ok(info.folded, 'Lượt đã xong phải gấp quá trình làm việc');
      await sleep(400);
      await shot('09-media-preview');
      // Vòng quay "đang tải" của trình phát phải tắt sau khi đã có khung hình đầu (preload=metadata không được treo ở trạng thái tải).
      await frame.waitForFunction(() => {
        const v = [...document.querySelectorAll('.turn-assistant')].pop().querySelector('video.media-player');
        return v.readyState >= 2 && v.networkState !== 2;
      }, { timeout: 15000 });
      await sleep(600);
      await shot('09b-media-preview-ready');
    } finally {
      browser.disconnect();
    }
  } finally {
    wv.postMessage = orig;
    mirrorSub.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await sb.startNewSession();
}

/**
 * Locaith-v5 dùng Trí nhớ sinh học MẶC ĐỊNH: chọn model Locaith mà chưa có thì tự cài/bật. Từ 0.6.2 việc này NGẦM hoàn toàn: không dải trạng thái nào trong
 * khung chat (cả lúc đang cài lẫn khi lỗi), lỗi thì không tự thử lại ngay ở mỗi lần chọn/gửi (chờ 5 phút), «Thử lại» chủ động thì bỏ qua thời gian chờ.
 * Dùng bản giả của MarketService.bioEnsure (không cài gì thật vào thư mục người dùng).
 */
async function testBioAutoSetup(api) {
  const sb = api.sidebar;
  const ms = api.marketService;
  const saved = { needed: ms.bioAutoNeeded, declined: ms.bioAutoDeclined, ensure: ms.bioEnsure, decline: ms.bioAutoDecline };
  process.env.ND_TEST_BIO_AUTO = '1';
  let needed = true;
  let declined = false;
  let calls = 0;
  let finish;
  ms.bioAutoNeeded = () => needed && !declined;
  ms.bioAutoDeclined = () => declined;
  ms.bioAutoDecline = async () => void (declined = true);
  ms.bioEnsure = () => {
    calls++;
    return new Promise((r) => (finish = r));
  };
  try {
    await sb.setModel('demo', 'demo-1');
    await sb.startNewSession();
    // 1. chọn Locaith-v5 → bắt đầu cài NGẦM: không có dải nào trong khung chat
    await sb.setModel('locaith', 'locaith-v5-flash');
    await waitFor(() => calls === 1, 5000, 'tự cài Trí nhớ sinh học bắt đầu');
    await sleep(200);
    assert.ok(!sb.snapshot().view.memory, 'Đang cài ngầm: không hiện dải trạng thái');
    // 2. chọn lại / gửi tiếp trong lúc đang cài: không cài lần hai
    await sb.setModel('locaith', 'locaith-v5-si');
    assert.strictEqual(calls, 1, 'Đang cài thì không bắt đầu lần nữa');
    // 3. cài lỗi: vẫn im lặng (không dải lỗi), không tự thử lại ngay khi chọn lại model
    finish({ ok: false, message: 'Không tìm thấy Python 3.10 trở lên.' });
    await sleep(300);
    assert.ok(!sb.snapshot().view.memory, 'Cài lỗi: không hiện dải lỗi trong khung chat');
    await sb.setModel('demo', 'demo-1');
    await sb.setModel('locaith', 'locaith-v5-flash');
    await sleep(300);
    assert.strictEqual(calls, 1, 'Vừa lỗi thì không tự cài lại ở mỗi lần chọn model (chờ 5 phút)');
    // 4. «Thử lại» chủ động bỏ qua thời gian chờ, vẫn ngầm; cài xong không hiện gì
    await sb.onMessage({ type: 'bio_auto_retry' });
    await waitFor(() => calls === 2, 5000, 'thử lại bắt đầu');
    assert.ok(!sb.snapshot().view.memory, 'Thử lại cũng cài ngầm');
    finish({ ok: true, message: '' });
    await sleep(300);
    assert.ok(!sb.snapshot().view.memory, 'Bật xong: không có dải nào');
    // 4b. tin nhắn «Ẩn» của giao diện cũ vẫn được nhận (chỉ dọn dải), không phải từ chối
    await sb.onMessage({ type: 'bio_auto_hide' });
    assert.ok(!sb.snapshot().view.memory);
    assert.strictEqual(declined, false, 'Ẩn KHÔNG phải từ chối vĩnh viễn');
    // 5. «Đừng hỏi lại» (giao diện cũ): không tự cài nữa
    await sb.onMessage({ type: 'bio_auto_decline' });
    assert.strictEqual(declined, true);
    const before = calls;
    await sb.setModel('demo', 'demo-1');
    await sb.setModel('locaith', 'locaith-v5-flash');
    await sleep(300);
    assert.strictEqual(calls, before, 'Đã từ chối thì không tự cài');
    assert.ok(!sb.snapshot().view.memory);
  } finally {
    Object.assign(ms, { bioAutoNeeded: saved.needed, bioAutoDeclined: saved.declined, bioEnsure: saved.ensure, bioAutoDecline: saved.decline });
    delete process.env.ND_TEST_BIO_AUTO;
    await sb.setModel('demo', 'demo-1');
    await sb.startNewSession();
    await sb.showScreen('chat');
  }
}

/**
 * (0.6.1) "Bỏ qua mọi xác nhận" có sẵn trong danh sách chế độ ngay từ đầu. Chọn nó lúc chưa bật thì host KHÔNG tự chuyển (hộp xác nhận ở khung chat quyết định);
 * xác nhận (enable_full_access) thì bật quyền (cài đặt NGƯỜI DÙNG) và chuyển chế độ — không phải vào Cài đặt; chỉ khi tick "ghi nhớ" thì cuộc mới mới bắt đầu ở đó.
 */
async function testBypassMode(api) {
  const sb = api.sidebar;
  const cfgOf = () => vscode.workspace.getConfiguration('locaithAgent');
  const reset = async () => {
    await cfgOf().update('agent.allowBypassPermissions', undefined, vscode.ConfigurationTarget.Global);
    await cfgOf().update('agent.permissionMode', undefined, vscode.ConfigurationTarget.Global);
  };
  await reset();
  await sb.startNewSession();
  await sb.showScreen('chat');
  assert.strictEqual(sb.snapshot().view.allowBypass, false, 'Mặc định chưa bật quyền bypass');
  // Chọn bypass khi chưa bật: host không tự chuyển
  await sb.onMessage({ type: 'set_mode', mode: 'bypass' });
  assert.notStrictEqual(sb.snapshot().view.mode, 'bypass', 'Chưa xác nhận thì không được vào bypass');
  // Xác nhận trong khung chat (KHÔNG ghi nhớ): bật quyền + chuyển chế độ
  await sb.onMessage({ type: 'enable_full_access', remember: false, siteAccess: false });
  const v = sb.snapshot().view;
  assert.strictEqual(v.mode, 'bypass', 'Xác nhận xong phải ở chế độ bypass');
  assert.strictEqual(v.allowBypass, true);
  assert.strictEqual(cfgOf().get('agent.allowBypassPermissions'), true, 'Quyền phải được ghi vào cài đặt người dùng');
  assert.notStrictEqual(cfgOf().get('agent.permissionMode'), 'bypass', 'Không tick ghi nhớ thì cuộc mới KHÔNG bắt đầu ở bypass');
  await sb.startNewSession();
  assert.notStrictEqual(sb.snapshot().view.mode, 'bypass', 'Cuộc mới bắt đầu ở chế độ mặc định');
  // Đã bật quyền rồi: chọn lại là chuyển được ngay, không cần hộp xác nhận
  await sb.onMessage({ type: 'set_mode', mode: 'bypass' });
  assert.strictEqual(sb.snapshot().view.mode, 'bypass');
  // Có tick "ghi nhớ": cuộc mới bắt đầu ở bypass
  await sb.onMessage({ type: 'enable_full_access', remember: true, siteAccess: false });
  assert.strictEqual(cfgOf().get('agent.permissionMode'), 'bypass');
  await sb.startNewSession();
  assert.strictEqual(sb.snapshot().view.mode, 'bypass', 'Có ghi nhớ thì cuộc mới bắt đầu ở bypass');
  // Dọn: trả cài đặt về mặc định để các bước sau (và máy người chạy thử) không bị giữ lại chế độ không hỏi
  await reset();
  await sb.startNewSession();
  assert.notStrictEqual(sb.snapshot().view.mode, 'bypass');
  await sb.showScreen('chat');
}

/** Phần của 0.5.1 chạy trong VS Code THẬT: Swarm, lịch sử mọi thư mục + hàn gắn transcript, ảnh, Chợ plugin/kết nối/Chrome. */
async function test051(api) {
  const sb = api.sidebar;
  const view = () => sb.snapshot().view;
  const store = api.store;

  // ── Swarm: mức thứ 6 + lệnh /thinking swarm ──
  await sb.startNewSession();
  await sb.onMessage({ type: 'set_thinking', level: 'swarm' });
  assert.strictEqual(view().thinkingLevel, 'swarm', 'Mức Swarm phải đặt được');
  assert.strictEqual(sb.snapshot().session.thinkingLevel, 'swarm', 'Phiên phải lưu mức Swarm');
  await sb.onMessage({ type: 'set_thinking', level: 'max' });
  await sb.onMessage({ type: 'send', text: '/thinking swarm', attachments: [] });
  await waitFor(() => view().thinkingLevel === 'swarm', 8000, 'lệnh /thinking swarm đổi mức');
  await sb.onMessage({ type: 'set_thinking', level: 'medium' });

  // ── Lịch sử hiện mọi thư mục; hàn gắn transcript thiếu ──
  const mkSession = (id, turns) => {
    const messages = [];
    for (let i = 1; i <= turns; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `Câu hỏi số ${i} của dự án khác` }], ts: 1000 + i * 10 });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `Trả lời số ${i}` }], provider: 'demo', model: 'demo-1', ts: 1005 + i * 10 });
    }
    return { id, title: `Phiên cũ ${id}`, provider: 'demo', model: 'demo-1', mode: 'default', thinkingLevel: 'medium', messages, todos: [], scratchpad: {}, loadedSkills: [], approvals: [], readFiles: {}, artifacts: {}, usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, createdAt: 1000, updatedAt: Date.now() - 1000 };
  };
  // Một kho thứ hai với KHOÁ THƯ MỤC KHÁC trên cùng thư mục lưu trữ thật = người dùng đã từng mở VS Code ở dự án khác.
  // (importSessions cố ý đưa mọi thứ về thư mục hiện tại nên không dùng được để giả lập.)
  const OtherStore = store.constructor;
  const otherStore = new OtherStore(undefined, 'ws-khac-hoan-toan', store.io, 'du-an-khac');
  await otherStore.save(mkSession('s_thieu', 5), []);
  const all = await store.listAll();
  const it = all.find((s) => s.id === 's_thieu');
  assert.ok(it, 'listAll phải thấy cuộc trò chuyện của thư mục làm việc khác');
  assert.strictEqual(it.other, true, 'Cuộc trò chuyện ở thư mục khác phải được đánh dấu other');
  assert.strictEqual(it.workspaceName, 'du-an-khac', 'Phải kèm tên thư mục đã tạo nó');
  assert.ok(!(await store.list()).some((s) => s.id === 's_thieu'), 'list() (chỉ thư mục hiện tại) không được chứa nó');
  await sb.showScreen('history');
  await sleep(800);
  assert.ok(view().sessions.some((s) => s.id === 's_thieu' && s.other), 'Màn Lịch sử phải hiện cuộc trò chuyện từ thư mục khác');

  // mở phiên có 5 lượt người dùng nhưng transcript rỗng → phải dựng lại đủ, và ghi lại xuống đĩa (kèm bản gốc)
  await sb.onMessage({ type: 'load_session', id: 's_thieu' });
  await waitFor(() => view().sessionId === 's_thieu', 8000, 'mở phiên cũ');
  const users = view().transcript.filter((t) => t.kind === 'user' && !t.steer);
  assert.strictEqual(users.length, 5, `Phải dựng lại đủ 5 lượt người dùng, đang có ${users.length}`);
  assert.strictEqual(users[0].text, 'Câu hỏi số 1 của dự án khác');
  assert.strictEqual(view().transcript.filter((t) => t.kind === 'assistant').length, 5, 'Phải có 5 đoạn trả lời');
  await waitFor(async () => (await store.load('s_thieu')).transcript.filter((t) => t.kind === 'user').length === 5, 10000, 'bản đã hàn gắn được ghi xuống đĩa');
  const dir = require('node:path').join(api.storageDir ?? '', 'sessions');
  if (api.storageDir) assert.ok(require('node:fs').existsSync(require('node:path').join(dir, 's_thieu.healbak.json')), 'Bản gốc phải được giữ (.healbak.json)');
  await store.delete('s_thieu');
  await sb.startNewSession();

  // ── Chợ: plugin + kết nối + Chrome hiện trong trạng thái ──
  await sb.showScreen('market');
  const st = await api.marketService.state();
  assert.ok(st.catalog && st.catalog.length >= 25, `Kho kết nối phải có từ 25 mục, đang có ${st.catalog && st.catalog.length}`);
  assert.ok(st.catalog.some((e) => e.id === 'github' && e.auth === 'github'), 'GitHub phải có trong kho (đăng nhập bằng tài khoản VS Code)');
  assert.ok(st.catalog.filter((e) => e.unsupported).map((e) => e.id).sort().join() === 'asana,slack,square', 'Mục chưa hỗ trợ phải đúng và kèm lý do');
  assert.ok(st.bio && ['none', 'ready', 'error', 'installing'].includes(st.bio.state), 'Thẻ Bio-Memory-Locaith phải có');
  assert.ok(st.chrome && st.chrome.paired === false, 'Chrome mặc định CHƯA ghép đôi');
  assert.ok(st.pluginMarket && st.pluginMarket.source === 'anthropics/claude-plugins-official', 'Chợ plugin phải trỏ marketplace chính thức');
  assert.ok(st.skills.some((s) => s.id), 'Chợ kỹ năng vẫn còn');
  assert.ok(api.skills.get('chrome-bridge'), 'Thiếu kỹ năng chrome-bridge');
  assert.ok(sb.registry.get('chrome'), 'Thiếu công cụ chrome (ẩn, mở bằng kỹ năng chrome-bridge)');

  // Cầu nối Chrome THẬT trong VS Code thật: mở máy chủ, tạo mã ghép đôi, kiểm tra bảo mật cơ bản qua HTTP thật.
  const pair = await api.chrome.pair();
  assert.match(pair.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'Mã ghép đôi 8 ký tự');
  const port = api.chrome.status().port;
  assert.ok(port >= 47615 && port <= 47620, 'Cầu nối phải nghe ở một trong các cổng đã định: ' + port);
  const noAuth = await fetch(`http://127.0.0.1:${port}/v1/ping`);
  assert.strictEqual(noAuth.status, 401, 'Không có token phải 401');
  const evil = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) });
  assert.strictEqual(evil.status, 403, 'Trang web (Origin https) không được chạm vào cầu nối');
  const noOrigin = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) });
  assert.strictEqual(noOrigin.status, 403, 'Không có Origin của extension thì không ghép đôi được');
  assert.strictEqual(api.chrome.status().paired, false, 'Chưa được ghép đôi sau các yêu cầu trái phép');
  await sb.showScreen('chat');
}

/** Provider cho kiểm thử hàng đợi: mỗi lần gọi ngủ `delay` ms (để có thời gian xếp hàng tin), ghi lại mọi yêu cầu. Lần 1 gọi công cụ, các lần sau trả lời chữ. */
function queueProvider(delay = 900) {
  const requests = [];
  const state = { hold: false };
  return {
    requests,
    state,
    id: 'queuetest',
    label: 'QueueTest',
    kind: 'anthropic',
    flavor: 'anthropic',
    capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'whole' },
    async *stream(req) {
      const last = req.messages[req.messages.length - 1];
      // Khối chữ `volatile` = dòng ngân sách vòng lặp do harness gắn vào cuối payload (0.6.31): không phải chữ của người dùng.
      const lastBlocks = last.content.filter((b) => !(b.type === 'text' && b.volatile));
      requests.push({
        roles: req.messages.map((m) => m.role),
        lastTypes: lastBlocks.map((b) => b.type),
        users: last.role === 'user' ? lastBlocks.filter((b) => b.type === 'text').map((b) => b.text) : [],
      });
      // `hold`: giữ lượt này treo tới khi bị Dừng.
      if (state.hold) {
        while (!req.signal.aborted) await sleep(50);
        throw new Error('aborted');
      }
      await sleep(delay);
      if (req.signal.aborted) throw new Error('aborted');
      if (req.messages.length === 1) {
        const id = `qt_${requests.length}`;
        const input = { path: '.' };
        yield { type: 'tool_start', id, name: 'list_dir' };
        yield { type: 'tool_args_delta', id, name: 'list_dir', delta: JSON.stringify(input) };
        yield { type: 'tool_end', id, name: 'list_dir' };
        yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 }, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'list_dir', input }] } };
        return;
      }
      const text = `Đã nhận: ${last.role === 'user' ? lastBlocks.filter((b) => b.type === 'text').map((b) => b.text).join(' | ') : ''}`;
      yield { type: 'text_delta', text };
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 }, message: { role: 'assistant', content: [{ type: 'text', text }] } };
    },
    async complete() {
      return 'Đang xử lý yêu cầu';
    },
    async fetchModels() {
      return [{ id: 'm', label: 'QueueTest' }];
    },
    async ping() {},
  };
}

/** Gửi nhiều tin khi trợ lý đang làm việc (VS Code thật): xếp hàng, xoá tin, tin giao giữa chừng và cuối lượt, Dừng trả tin về ô nhập, hàng đợi đầy. */
async function testQueueFlow(api) {
  const provider = queueProvider(900);
  api.providers.registry.addExtraProvider(provider, [{ id: 'm', label: 'QueueTest' }]);
  await api.sidebar.startNewSession();
  await api.sidebar.setModel('queuetest', 'm');
  const send = (text) => api.sidebar.onMessage({ type: 'send', text, attachments: [] });
  const queued = () => api.sidebar.snapshot().view.queued ?? [];
  assert.strictEqual(api.sidebar.snapshot().view.canQueue, true, 'Bản VS Code phải bật canQueue');

  // ── 1. Xếp hàng, xoá một tin, tin giao GIỮA CHỪNG (sau lượt công cụ) và tin gửi lúc model đang trả lời (giao cuối lượt) ──
  const run = api.sidebar.ask('Việc dài: liệt kê thư mục', []);
  await waitFor(() => api.sidebar.isRunning, 10000, 'bắt đầu chạy');
  await send('Tin thêm 1 (sẽ xoá)');
  await send('Tin thêm 2');
  assert.deepStrictEqual(queued().map((q) => q.text), ['Tin thêm 1 (sẽ xoá)', 'Tin thêm 2'], 'Hai tin phải đang xếp hàng, đúng thứ tự');
  await api.sidebar.onMessage({ type: 'queue_remove', id: queued()[0].id });
  assert.deepStrictEqual(queued().map((q) => q.text), ['Tin thêm 2'], 'Xoá được một tin khỏi hàng đợi');
  await waitFor(() => provider.requests.length >= 2, 20000, 'model được gọi lần 2 (sau lượt công cụ)');
  await send('Tin thêm 3');
  await run;
  await waitFor(() => !api.sidebar.isRunning, 30000, 'lượt kết thúc sau khi giao hết hàng đợi');

  const [r1, r2, r3, r4, r5] = provider.requests;
  // 0.6.31: tin gửi GIỮA CHỪNG (Tin thêm 2) được ghi thành tác vụ chờ; model giả không bao giờ đánh dấu xong nên cổng hoàn thành nhắc CÓ NHÃN: lần 1 (lần gọi thứ 4) và lần 2 (lần gọi thứ 5);
  // lần can thiệp thứ 3 thì thôi nhắc và báo người dùng việc còn lại (không nhắc vô hạn).
  assert.strictEqual(provider.requests.length, 5, `Phải có đúng 5 lần gọi model (3 + hai lời nhắc việc dở có nhãn), đang có ${provider.requests.length}`);
  assert.ok(r4.users.some((t) => t.includes('[nhắc lần 1]') && t.includes('việc chưa xong')), 'Lần gọi thứ 4 phải là lời nhắc [nhắc lần 1] còn việc dở');
  assert.ok(r5.users.some((t) => t.includes('[nhắc lần 2]')), 'Lần gọi thứ 5 phải là lời nhắc [nhắc lần 2]');
  assert.ok(api.sidebar.snapshot().view.transcript.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.type === 'notice' && b.level === 'warn' && b.text.includes('Tin thêm 2'))), 'Lần thứ 3 phải báo người dùng việc còn dở (Tin thêm 2) thay vì nhắc tiếp');
  assert.ok(api.sidebar.snapshot().session.todos.some((x) => x.title === 'Tin thêm 2' && x.status === 'pending'), 'Tin gửi giữa chừng phải nằm trong danh sách tác vụ');
  assert.deepStrictEqual(r2.roles, ['user', 'assistant', 'user'], 'Vai trò phải xen kẽ');
  assert.deepStrictEqual(r2.lastTypes.slice(0, 1), ['tool_result'], 'Tin chèn giữa chừng đi chung tin kết quả công cụ (tool_result đứng trước)');
  assert.ok(r2.users.some((t) => t.includes('trong lúc bạn đang làm việc')), 'Model phải được báo đây là tin gửi thêm');
  assert.ok(r2.users.some((t) => t.includes('Tin thêm 2')), 'Model phải thấy "Tin thêm 2" ngay sau lượt công cụ');
  assert.ok(!JSON.stringify(r2).includes('Tin thêm 1'), 'Tin đã xoá không được tới model');
  assert.deepStrictEqual(r3.roles, ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.ok(r3.users.some((t) => t.endsWith('Tin thêm 3')), 'Tin gửi lúc model đang trả lời phải thành lượt kế tiếp');
  assert.strictEqual(r1.roles.length, 1);
  assert.strictEqual(queued().length, 0, 'Hàng đợi phải rỗng sau khi giao hết');

  const items = api.sidebar.snapshot().view.transcript;
  assert.deepStrictEqual(items.map((i) => (i.kind === 'user' ? (i.steer ? 'user*' : 'user') : i.kind)), ['user', 'assistant', 'user*', 'assistant', 'user', 'assistant'], 'Transcript: tin chèn giữa chừng đánh dấu steer, cuối lượt thì không');
  assert.deepStrictEqual(items.filter((i) => i.kind === 'user').map((i) => i.text), ['Việc dài: liệt kê thư mục', 'Tin thêm 2', 'Tin thêm 3']);
  assert.ok(items.filter((i) => i.kind === 'assistant').every((i) => i.done), 'Mọi đoạn trả lời phải được đóng');
  const roles = api.sidebar.snapshot().session.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'], 'Lịch sử gửi model phải xen kẽ vai trò (kèm hai lời nhắc việc dở ở cuối)');

  // ── 2. Lệnh gạch chéo khi đang chạy: vẫn từ chối (không xếp hàng) ──
  // ── 3. Bấm vào tin chờ để sửa; Dừng thì các tin chưa giao quay về ô nhập, KHÔNG tự gửi ──
  const posted = [];
  const origPost = api.sidebar.post.bind(api.sidebar);
  api.sidebar.post = (m) => {
    posted.push(m);
    return origPost(m);
  };
  try {
    provider.requests.length = 0;
    provider.state.hold = true;
    const run2 = api.sidebar.ask('Việc dài 2', []);
    await waitFor(() => api.sidebar.isRunning, 10000, 'lượt 2 bắt đầu chạy');
    await send('/compact');
    assert.strictEqual(queued().length, 0, 'Lệnh gạch chéo không được xếp hàng');
    await send('Tin A');
    await send('Tin B');
    await sleep(600);
    await shot('07-queue-running'); // ảnh thật: danh sách tin chờ phía trên ô nhập (lượt đang bị giữ treo)
    await api.sidebar.onMessage({ type: 'queue_remove', id: queued()[0].id, edit: true });
    assert.ok(posted.some((m) => m.type === 'insert' && m.text === 'Tin A'), 'Bấm sửa phải đưa "Tin A" về ô nhập');
    assert.deepStrictEqual(queued().map((q) => q.text), ['Tin B']);
    api.sidebar.stop();
    await run2;
    await waitFor(() => !api.sidebar.isRunning, 20000, 'lượt 2 dừng');
    assert.strictEqual(queued().length, 0, 'Sau Dừng hàng đợi phải rỗng');
    assert.ok(posted.some((m) => m.type === 'insert' && m.text === 'Tin B'), 'Dừng: tin chưa giao phải quay về ô nhập');
    assert.ok(!JSON.stringify(provider.requests).includes('Tin B'), 'Dừng: tin chưa giao KHÔNG được tự gửi cho model');

    // ── 4. Hàng đợi đầy: tin thứ 21 bị từ chối và nội dung được trả về ô nhập ──
    posted.length = 0;
    const run3 = api.sidebar.ask('Việc dài 3', []);
    await waitFor(() => api.sidebar.isRunning, 10000, 'lượt 3 bắt đầu chạy');
    for (let i = 1; i <= 21; i++) await send(`Tin đầy ${i}`);
    assert.strictEqual(queued().length, 20, 'Hàng đợi tối đa 20 tin');
    assert.ok(posted.some((m) => m.type === 'insert' && m.text === 'Tin đầy 21'), 'Tin thứ 21 phải được trả về ô nhập, không mất chữ');
    api.sidebar.stop();
    await run3;
    await waitFor(() => !api.sidebar.isRunning, 20000, 'lượt 3 dừng');
    assert.strictEqual(queued().length, 0);

    // ── 5. «Gửi ngay»: dừng bước đang chạy và giao tin được chọn NGAY (không đợi ranh giới vòng lặp); tin còn lại vẫn xếp hàng rồi được giao sau ──
    provider.requests.length = 0;
    provider.state.hold = true;
    const run4 = api.sidebar.ask('Việc dài 4 (bị giữ treo)', []);
    await waitFor(() => api.sidebar.isRunning, 10000, 'lượt 4 bắt đầu chạy');
    await send('Tin gấp');
    await send('Tin sau');
    assert.deepStrictEqual(queued().map((q) => q.text), ['Tin gấp', 'Tin sau'], 'Hai tin phải đang xếp hàng');
    provider.state.hold = false; // sau khi bước treo bị ngắt, các lượt kế tiếp chạy bình thường
    await api.sidebar.onMessage({ type: 'queue_send_now', id: queued()[0].id });
    assert.deepStrictEqual(queued().map((q) => q.text), ['Tin sau'], '«Gửi ngay» rút đúng tin được chọn khỏi hàng đợi, tin kia vẫn chờ');
    await run4;
    await waitFor(() => !api.sidebar.isRunning && provider.requests.some((r) => r.users.some((x) => x.includes('Tin sau'))), 30000, 'tin gấp rồi tin sau đều được giao');
    const urgent = provider.requests.findIndex((r) => r.users.some((x) => x.includes('Tin gấp')));
    const later = provider.requests.findIndex((r) => r.users.some((x) => x.includes('Tin sau')));
    assert.ok(urgent > 0, 'Tin gấp phải tới model ngay sau bước bị ngắt (yêu cầu đầu là bước treo)');
    assert.ok(later > urgent, '«Tin sau» được giao SAU tin gấp');
    assert.strictEqual(queued().length, 0, 'Giao hết thì hàng đợi rỗng');
    const said = api.sidebar.snapshot().view.transcript.filter((i) => i.kind === 'user').map((i) => i.text);
    assert.deepStrictEqual(said.slice(-3), ['Việc dài 4 (bị giữ treo)', 'Tin gấp', 'Tin sau'], 'Transcript: việc dài, rồi tin gấp, rồi tin sau');
  } finally {
    provider.state.hold = false;
    delete api.sidebar.post;
  }
}

/** Provider có kịch bản: đọc tệp → sửa tệp → trả lời. */
function scriptedProvider(newText, oldText = 'Đặng Thị Hồng') {
  const stepOf = (messages) => {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && !m.synthetic && m.content.some((b) => b.type === 'text' && !b.volatile)) {
        idx = i;
        break;
      }
    }
    return messages.slice(idx + 1).filter((m) => m.role === 'assistant').length;
  };
  const plan = [
    [{ name: 'read_file', input: { path: 'app.ts' } }],
    [{ name: 'edit_file', input: { path: 'app.ts', old_string: oldText, new_string: newText } }],
  ];
  let n = 0;
  return {
    id: 'scripted',
    label: 'Scripted',
    kind: 'anthropic',
    flavor: 'anthropic',
    capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'whole' },
    async *stream(req) {
      const step = stepOf(req.messages);
      const calls = plan[step] ?? [];
      const content = [];
      if (calls.length === 0) {
        yield { type: 'text_delta', text: 'Đã xử lý xong.' };
        content.push({ type: 'text', text: 'Đã xử lý xong.' });
      }
      for (const c of calls) {
        const id = `sc_${++n}`;
        yield { type: 'tool_start', id, name: c.name };
        yield { type: 'tool_args_delta', id, name: c.name, delta: JSON.stringify(c.input) };
        yield { type: 'tool_end', id, name: c.name };
        content.push({ type: 'tool_use', id, name: c.name, input: c.input });
      }
      yield { type: 'done', stopReason: calls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 100, outputTokens: 10 }, message: { role: 'assistant', content } };
    },
    async complete() {
      return 'Đang xử lý yêu cầu';
    },
    async fetchModels() {
      return [{ id: 'm', label: 'Scripted' }];
    },
    async ping() {},
  };
}

async function testEditFlow(api) {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const fileUri = vscode.Uri.joinPath(folder, 'app.ts');
  const readDisk = async () => Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');

  // Mở tệp và tạo thay đổi CHƯA LƯU: tác tử phải thấy và giữ nguyên thay đổi này.
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// ghi chú chưa lưu của người dùng\n'));
  assert.ok(doc.isDirty, 'Tệp phải đang ở trạng thái chưa lưu');

  const waitPermission = async (sidebar) => {
    let block;
    try {
      await waitFor(() => {
        const a = sidebar.snapshot().view.transcript.filter((i) => i.kind === 'assistant').at(-1);
        block = a && a.blocks.find((b) => b.type === 'tool' && b.state === 'awaiting_permission');
        return !!block;
      }, 20000, 'thẻ xin phép sửa tệp xuất hiện');
    } catch (e) {
      const snap = sidebar.snapshot();
      const dump = `running=${snap.view.running} provider=${snap.session.provider} mode=${snap.session.mode}\n${JSON.stringify(snap.view.transcript, null, 1)}`;
      if (process.env.ND_TEST_DEBUG_FILE) fs.writeFileSync(process.env.ND_TEST_DEBUG_FILE, dump);
      console.error('CHẨN ĐOÁN đã ghi ra', process.env.ND_TEST_DEBUG_FILE);
      throw e;
    }
    return block;
  };

  // ── Cho phép ──────────────────────────────────────────────────────────────
  api.providers.registry.addExtraProvider(scriptedProvider('Nguyễn Văn Ánh'), [{ id: 'm', label: 'Scripted' }]);
  await api.sidebar.startNewSession();
  await api.sidebar.setModel('scripted', 'm');
  assert.strictEqual(api.sidebar.snapshot().session.mode, 'default');
  const run1 = api.sidebar.ask('Đổi tên khách hàng trong app.ts', []);
  const block = await waitPermission(api.sidebar);
  assert.strictEqual(block.name, 'edit_file');
  await sleep(900);
  await shot('04-permission-card');
  assert.strictEqual(block.permission.kind, 'edit');
  assert.strictEqual(block.permission.diff.added, 1);
  assert.strictEqual(block.permission.diff.removed, 1);
  assert.ok(await readDisk().then((t) => !t.includes('Nguyễn Văn Ánh')), 'Chưa được duyệt thì không được ghi');
  await api.sidebar.onMessage({ type: 'permission_response', id: block.permission.id, decision: 'allow' });
  await run1;
  await waitFor(() => !api.sidebar.isRunning, 30000, 'lượt sửa tệp kết thúc');

  const afterBuffer = doc.getText();
  assert.ok(afterBuffer.includes('Nguyễn Văn Ánh'), 'Editor phải có nội dung mới');
  assert.ok(afterBuffer.includes('// ghi chú chưa lưu của người dùng'), 'Thay đổi chưa lưu của người dùng không được mất');
  assert.strictEqual(doc.isDirty, false, 'Tệp phải được lưu sau khi sửa');
  assert.strictEqual(await readDisk(), afterBuffer, 'Đĩa phải khớp với editor');
  const toolBlock = api.sidebar.snapshot().view.transcript.filter((i) => i.kind === 'assistant').at(-1).blocks.find((b) => b.type === 'tool' && b.name === 'edit_file');
  assert.strictEqual(toolBlock.state, 'done');
  assert.ok(toolBlock.diff && toolBlock.diff.added === 1);

  // ── Từ chối ───────────────────────────────────────────────────────────────
  api.providers.registry.addExtraProvider(scriptedProvider('SẼ-KHÔNG-ĐƯỢC-GHI', 'Nguyễn Văn Ánh'), [{ id: 'm', label: 'Scripted' }]);
  await api.sidebar.startNewSession();
  await api.sidebar.setModel('scripted', 'm');
  const run2 = api.sidebar.ask('Đổi lần nữa', []);
  const block2 = await waitPermission(api.sidebar);
  await api.sidebar.onMessage({ type: 'permission_response', id: block2.permission.id, decision: 'deny', feedback: 'Không, giữ nguyên.' });
  await run2;
  await waitFor(() => !api.sidebar.isRunning, 30000, 'lượt bị từ chối kết thúc');
  assert.ok(!(await readDisk()).includes('SẼ-KHÔNG-ĐƯỢC-GHI'), 'Bị từ chối thì không được ghi');
  const denied = api.sidebar.snapshot().view.transcript.filter((i) => i.kind === 'assistant').at(-1).blocks.find((b) => b.type === 'tool' && b.name === 'edit_file');
  assert.strictEqual(denied.state, 'denied');
  assert.ok(api.sidebar.snapshot().session.messages.some((m) => m.content.some((b) => b.type === 'tool_result' && /Không, giữ nguyên/.test(b.content))), 'Góp ý của người dùng phải tới model');
}


// ─────────────────────────────────────────────────────────────────────────────
// Remote (0.5.2) — chạy trong VS Code THẬT: máy chủ điều khiển từ xa nối với ChatController thật.
// ─────────────────────────────────────────────────────────────────────────────

/** Yêu cầu HTTP thô (đặt được Origin tuỳ ý). */
function remoteHttp(port, method, p, o = {}) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let json = null;
        try {
          json = t ? JSON.parse(t) : null;
        } catch {
          /* không phải JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** Mở luồng SSE của Remote, gom các khung nhận được. */
function remoteStream(port, token, origin, query = '') {
  const http = require('node:http');
  const frames = [];
  let buf = '';
  let ended = false;
  const req = http.request({ host: '127.0.0.1', port, path: `/v1/stream${query}`, headers: { host: `127.0.0.1:${port}`, origin, authorization: `Bearer ${token}` } });
  req.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(block);
        if (m) frames.push(JSON.parse(m[1]));
      }
    });
    res.on('end', () => (ended = true));
  });
  req.on('error', () => (ended = true));
  req.end();
  return { frames, close: () => req.destroy(), get ended() { return ended; } };
}

/** Provider cho kiểm thử Remote: trả lời chữ từng từ một (để có thời gian chụp snapshot giữa chừng); gặp "cần quyền" thì gọi run_command trước. */
function remoteProvider() {
  return {
    id: 'remotetest',
    label: 'RemoteTest',
    kind: 'anthropic',
    flavor: 'anthropic',
    capabilities: { reasoning: 'none', parallelTools: true, vision: false, toolArgStreaming: 'whole' },
    async *stream(req) {
      const last = req.messages[req.messages.length - 1];
      const hasToolResult = last.role === 'user' && last.content.some((b) => b.type === 'tool_result');
      await sleep(50);
      if (!hasToolResult && JSON.stringify(last.content).includes('cần quyền')) {
        const id = 'rt_tool_1';
        const input = { command: 'echo remote-test-khong-duoc-chay' };
        yield { type: 'tool_start', id, name: 'run_command' };
        yield { type: 'tool_args_delta', id, name: 'run_command', delta: JSON.stringify(input) };
        yield { type: 'tool_end', id, name: 'run_command' };
        yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 }, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'run_command', input }] } };
        return;
      }
      const words = ['Đã', 'nhận', 'từ', 'xa:', 'xin', 'chào', 'bạn,', 'đây', 'là', 'một', 'câu', 'trả', 'lời', 'đủ', 'dài', 'để', 'thử', 'luồng', 'sự', 'kiện.'];
      let text = '';
      for (const w of words) {
        await sleep(45);
        if (req.signal.aborted) throw new Error('aborted');
        text += `${w} `;
        yield { type: 'text_delta', text: `${w} ` };
      }
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 }, message: { role: 'assistant', content: [{ type: 'text', text }] } };
    },
    async complete() {
      return 'Thử Remote';
    },
    async fetchModels() {
      return [{ id: 'm', label: 'RemoteTest' }];
    },
    async ping() {},
  };
}

const assistantTexts = (items) => items.filter((i) => i.kind === 'assistant').map((a) => a.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 0.5.2 — tài khoản locaith.ai + Remote qua relay
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BACKEND = process.env.LOCAITH_TEST_SUPABASE_URL;
const WEB = process.env.LOCAITH_TEST_WEB_URL;
const TEST_USER = { id: 'user-test-1', email: 'tester@locaith.ai', name: 'Người Thử' };

async function admin(route, body) {
  const r = await fetch(`${BACKEND}/__admin/${route}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`admin ${route}: ${JSON.stringify(j)}`);
  return j;
}

/** Đóng vai trang locaith.ai: đọc URL đăng nhập extension đã mở, kiểm tham số, rồi người dùng bấm «Cho phép» → trả tham số quay về VS Code. */
async function browserApproves(api) {
  const url = api.account.lastLoginUrl;
  assert.ok(url && url.startsWith(`${WEB}/#ext-auth?`), `URL đăng nhập lạ: ${url}`);
  const q = new URLSearchParams(url.split('#ext-auth?')[1]);
  assert.strictEqual(q.get('client'), 'vscode');
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(q.get('challenge')), 'challenge PKCE phải 43 ký tự base64url');
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(q.get('state')), 'state phải 22 ký tự base64url');
  assert.strictEqual(q.get('redirect'), `${vscode.env.uriScheme}://locaithai.locaith-agent/auth`);
  assert.ok(q.get('label') && q.get('label').length <= 60, 'nhãn máy phải có và ≤ 60 ký tự');
  assert.strictEqual(q.get('m_ext'), vscode.extensions.getExtension('LocaithAI.locaith-agent').packageJSON.version);
  assert.strictEqual(q.get('m_vscode'), vscode.version);
  assert.ok(!url.includes('verifier'), 'URL không được chứa verifier');
  // VS Code mở URL bằng Uri.parse(url): chuẩn hoá của Uri không được làm hỏng tham số
  const norm = vscode.Uri.parse(url);
  assert.deepStrictEqual([...new URLSearchParams(norm.fragment.split('?')[1]).entries()], [...q.entries()], 'Uri.parse làm đổi tham số của URL đăng nhập');
  const { code } = await admin('approve', { userId: TEST_USER.id, challenge: q.get('challenge'), redirect: q.get('redirect'), label: q.get('label') });
  return { redirect: q.get('redirect'), code, state: q.get('state') };
}

/**
 * Chuyển URI quay về cho extension. Gọi thẳng URI handler đã đăng ký (cùng hàm VS Code gọi khi trình duyệt mở vscode://…).
 * Không thử đường hệ điều hành (`Code --open-url`): phiên VS Code chạy bộ kiểm thử không dùng khoá một-phiên-bản nên không nhận URI từ tiến trình khác,
 * và `vscode-insiders://` trên máy này đang trỏ tới bản VS Code Insiders thật của anh.
 */
async function deliverUri(api, uri) {
  await api.account.onUri(vscode.Uri.parse(uri));
  return 'direct';
}

async function signInFlow(api) {
  await api.account.signIn();
  assert.strictEqual(api.account.session.state.status, 'signingIn');
  const { redirect, code, state } = await browserApproves(api);
  // callback mang state SAI (trang lạ mở vscode://…) bị bỏ qua, không phá lần đăng nhập thật
  await api.account.onUri(vscode.Uri.parse(`${redirect}?code=${code}&state=${'x'.repeat(22)}`));
  assert.strictEqual(api.account.session.state.status, 'signingIn', 'callback sai state không được huỷ lần đăng nhập thật');
  const via = await deliverUri(api, `${redirect}?code=${code}&state=${state}`);
  await waitFor(() => api.account.session.state.status === 'signedIn', 20000, 'đăng nhập xong');
  return via;
}

async function testAccountGate(api) {
  const A = api.account;
  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  await admin('user', TEST_USER);

  // lệnh đã đăng ký + trạng thái ban đầu
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['locaithAgent.account.signIn', 'locaithAgent.account.signOut', 'locaithAgent.account.enterCode', 'locaithAgent.account.manage']) assert.ok(cmds.includes(c), `Thiếu lệnh ${c}`);
  assert.strictEqual(A.session.state.status, 'signedOut', 'Cài mới phải ở trạng thái chưa đăng nhập');
  assert.strictEqual(A.usable, false);
  await api.sidebar.sendInit();
  const v0 = api.sidebar.snapshot().view.account;
  assert.ok(v0 && v0.status === 'signedOut' && !v0.user, 'ViewState phải mang trạng thái tài khoản');
  await sleep(1200);
  await shot('00-account-gate');

  // CỔNG ở host: mọi đường vào đều bị từ chối khi chưa đăng nhập
  await api.sidebar.ask('Câu hỏi khi chưa đăng nhập', []);
  assert.strictEqual(api.sidebar.isRunning, false);
  assert.strictEqual(api.sidebar.snapshot().view.transcript.length, 0, 'Chưa đăng nhập mà vẫn chạy trợ lý!');
  await api.sidebar.onMessage({ type: 'send', text: 'từ webview khi chưa đăng nhập', attachments: [] });
  await api.sidebar.onMessage({ type: 'save_api_key', provider: 'openai', key: 'sk-test-khong-duoc-luu' });
  assert.strictEqual(await api.sidebar.d.secrets.has('provider.openai'), false, 'Khoá API không được lưu khi chưa đăng nhập');
  assert.strictEqual(api.sidebar.snapshot().view.transcript.length, 0);
  await assert.rejects(api.sidebar.handleRemote({ type: 'send', text: 'x', attachments: [] }), /account_required/, 'Remote phải bị chặn khi chưa đăng nhập');
  // vẫn đổi được ngôn ngữ/giao diện (để người dùng đọc được màn đăng nhập)
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'lineHeight', value: 1.7 });
  await waitFor(() => api.sidebar.snapshot().view.settings.lineHeight === 1.7, 10000, 'đổi giao diện khi chưa đăng nhập');
  await api.sidebar.onMessage({ type: 'set_ui_setting', key: 'lineHeight', value: 1.65 });
  // Remote KHÔNG chạy khi chưa đăng nhập dù đã bật trong cài đặt
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  await sleep(800);
  assert.strictEqual(A.session.state.status, 'signedOut');
  assert.strictEqual(api.remote.status().running, false, 'Remote không được chạy khi chưa đăng nhập');
  assert.strictEqual(api.remote.relayHost(), undefined, 'Relay không được chạy khi chưa đăng nhập');
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);

  // đăng nhập bằng luồng OAuth/PKCE thật
  const via = await signInFlow(api);
  assert.strictEqual(via, 'direct');
  assert.strictEqual(A.usable, true);
  await waitFor(() => api.sidebar.snapshot().view.account && api.sidebar.snapshot().view.account.status === 'signedIn', 10000, 'ViewState báo đã đăng nhập');
  const v1 = api.sidebar.snapshot().view.account;
  assert.strictEqual(v1.user.email, TEST_USER.email);
  assert.strictEqual(v1.user.name, TEST_USER.name);
  const bs = await (await fetch(`${BACKEND}/__admin/state`, { method: 'POST', body: '{}' })).json();
  assert.strictEqual(bs.devices.length, 1, 'Máy chủ phải có đúng một thiết bị đăng nhập');
  assert.ok(bs.devices[0].label.length > 0 && !bs.devices[0].revoked);
  assert.ok(bs.calls.includes('ext_auth_exchange'));
  // webview cần vài trăm ms để vẽ lại sau khi nhận trạng thái mới, và các toast "hãy đăng nhập" của ba lần bị chặn ở trên tự tắt sau 4,5 s
  // → chờ rồi mới chụp, để ảnh thể hiện đúng màn hình sau khi đăng nhập.
  await sleep(2500);
  await shot('00b-account-signed-in');
}

async function testAccountLock(api) {
  const A = api.account;
  // 1. Máy chủ thu hồi thiết bị → lần xác minh kế tiếp khoá extension lại (gate chặn mọi thứ, kể cả trợ lý)
  await admin('revoke');
  await A.session.verify(true);
  assert.strictEqual(A.session.state.status, 'expired');
  assert.strictEqual(A.session.state.reason, 'revoked');
  assert.strictEqual(A.usable, false);
  await waitFor(() => api.sidebar.snapshot().view.account.status === 'expired', 10000, 'ViewState báo hết hiệu lực');
  await api.sidebar.ask('Câu hỏi sau khi bị thu hồi', []);
  assert.strictEqual(api.sidebar.isRunning, false);
  await shot('00c-account-expired');
  // 2. Đăng nhập lại → mở khoá; token cũ vô hiệu, thiết bị mới được cấp
  await signInFlow(api);
  assert.strictEqual(A.usable, true);
  // 3. Mất mạng khi xác minh → vẫn dùng được trong thời gian ân hạn
  await admin('mode', { mode: 'down' });
  await A.session.verify(true);
  assert.strictEqual(A.usable, true, 'Mất mạng trong ân hạn vẫn phải dùng được');
  assert.strictEqual(api.sidebar.snapshot().view.account.offline, true);
  await admin('mode', {});
  await A.session.verify(true);
  assert.ok(!api.sidebar.snapshot().view.account.offline);
  // 4. Đăng xuất: khoá lại + token bị thu hồi phía máy chủ
  const token = A.token();
  await A.signOut();
  assert.strictEqual(A.session.state.status, 'signedOut');
  assert.strictEqual(A.usable, false);
  const who = await (await fetch(`${BACKEND}/rest/v1/rpc/ext_auth_whoami`, { method: 'POST', headers: { apikey: process.env.LOCAITH_TEST_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ p_token: token }) })).json();
  assert.strictEqual(who.ok, false, 'Token đã đăng xuất phải vô hiệu ở máy chủ');
  // 5. Đăng nhập lại lần cuối để các bước sau (nếu có) không bị khoá
  await signInFlow(api);
  assert.strictEqual(A.usable, true);
}

/** Remote BẬT SẴN: đăng nhập xong là máy tự nối relay (không cần chạm cài đặt nào), không mở cổng cục bộ; khung chat thấy trạng thái; công tắc bật/tắt được. */
async function testRemoteDefaultOn(api) {
  const R = api.remote;
  const sb = api.sidebar;
  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  const insp = cfg.inspect('remote.enabled');
  assert.strictEqual(insp.defaultValue, true, 'remote.enabled phải mặc định BẬT');
  assert.strictEqual(cfg.inspect('remote.local').defaultValue, false, 'remote.local phải mặc định TẮT (không mở cổng nào)');
  assert.strictEqual(insp.globalValue, undefined, 'Bộ kiểm thử không được đặt sẵn remote.enabled (phải đi bằng mặc định)');
  const view = () => sb.snapshot().view.remote;

  // D1. Chỉ đăng nhập (đã làm ở các bước trước) → relay tự lên, đường cục bộ KHÔNG mở
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 25000, 'relay tự nối khi đăng nhập xong (Remote bật sẵn)');
  assert.strictEqual(R.status().running, false, 'Đường cục bộ 127.0.0.1 không được tự mở');
  // D2. Khung chat thấy trạng thái Remote
  await waitFor(() => view() && view().relay === 'online', 10000, 'khung chat thấy Remote đã kết nối');
  assert.deepStrictEqual({ enabled: view().enabled, signedIn: view().signedIn, relay: view().relay }, { enabled: true, signedIn: true, relay: 'online' });
  assert.strictEqual(view().queue, undefined);
  // D3. Công tắc trong khung chat (= cài đặt remote.enabled): tắt → rời relay; bật → nối lại
  await sb.onMessage({ type: 'remote_set_enabled', enabled: false });
  await waitFor(() => R.relayHost() === undefined, 15000, 'tắt công tắc thì rời relay');
  await waitFor(() => view() && view().enabled === false && view().relay === 'off', 10000, 'khung chat thấy Remote đã tắt');
  assert.strictEqual(cfg.inspect('remote.enabled').globalValue, false);
  await sb.onMessage({ type: 'remote_set_enabled', enabled: true });
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 20000, 'bật công tắc thì nối lại relay');
  await waitFor(() => view() && view().enabled === true && view().relay === 'online', 10000, 'khung chat thấy Remote đã bật lại');
  // trả về mặc định (xoá giá trị người dùng) để các bước sau chạy đúng như người dùng thật
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => view() && view().enabled === true, 10000, 'trả về mặc định');
}

/** Relay quá tải: VS Code thật phải NÓI RÕ là đang xếp hàng (không để người dùng tưởng mất mạng), không gõ cửa dồn dập, và vào được ngay khi hết quá tải. */
async function testRelayQueue(api) {
  const R = api.remote;
  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  const limits = (b) => admin('realtime/limits', b);
  const state = async () => (await fetch(`${BACKEND}/__admin/state`, { method: 'POST', body: '{}' })).json();
  const queueOf = () => (R.status().relay ? R.status().relay.queue : undefined);

  // Remote đang BẬT SẴN (relay đã nối): tắt hẳn để bắt đầu từ trạng thái sạch, rồi mới bật lại khi Realtime đã quá tải
  await cfg.update('remote.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.relayHost() === undefined, 15000, 'tắt Remote trước khi mô phỏng quá tải');
  const chat = () => api.sidebar.snapshot().view.remote;

  // Q1. Realtime từ chối lượt vào kênh với lý do too_many_connections → máy vào hàng chờ, có mốc thử lại ~20 giây (xáo trộn ±20%)
  await limits({ rejectJoin: true, rejectReason: 'too_many_connections' });
  await cfg.update('remote.local', false, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  await waitFor(() => queueOf(), 20000, 'vào hàng chờ khi relay quá tải');
  const q = queueOf();
  const tQueue = Date.now();
  assert.strictEqual(q.kind, 'connections');
  assert.strictEqual(q.attempt, 1);
  assert.ok(q.retryAt > Date.now() + 10000 && q.retryAt < Date.now() + 40000, `đếm ngược phải khoảng 20 giây, nhận ${q.retryAt - Date.now()} ms`);
  assert.notStrictEqual(R.status().relay.status, 'online', 'Đang xếp hàng thì không được báo online');
  // Hàng chờ hiện NGAY TRONG khung chat (view.remote): dải đếm ngược; chuỗi lỗi thô của relay KHÔNG đi xuống giao diện
  await waitFor(() => chat() && chat().relay === 'queued' && chat().queue, 10000, 'khung chat thấy hàng chờ');
  assert.strictEqual(chat().queue.attempt, 1);
  assert.strictEqual(chat().queue.kind, 'connections');
  assert.ok(chat().queue.retryAt > Date.now() + 8000 && chat().queue.waitMs >= 16000 && chat().queue.waitMs <= 24000, 'mốc đếm ngược gửi cho khung chat');
  assert.ok(!JSON.stringify(chat()).includes('too_many_connections'), 'Chuỗi lỗi thô của relay không được đi xuống giao diện');
  // (chỉ khi chụp ảnh) dải xếp hàng trong khung chat; rồi mở khung QR đang ở trạng thái xếp hàng
  await sleep(1500);
  await shot('q1-queue-chat');
  if (process.env.ND_TEST_SHOTS) {
    void R.pair();
    await sleep(3000);
    await shot('q1-queue-qr');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
  // Q2. Trong lúc chờ KHÔNG mở thêm kết nối nào (không dội vào relay đang quá tải)
  const s0 = await state();
  await sleep(2500);
  assert.strictEqual((await state()).realtime.connections, s0.realtime.connections, 'Đang xếp hàng mà vẫn mở thêm kết nối');
  // Q3. «Thử ngay» bị từ chối khi vừa thử chưa quá 5 giây; sau đó hết quá tải + thử ngay → vào được mà không phải chờ hết 20 giây
  if (Date.now() - (q.retryAt - q.waitMs) < 4500) assert.strictEqual(R.retryQueueNow(), false, 'Vừa thử chưa quá 5 giây thì chưa được thử ngay'); // (bỏ qua khi chụp ảnh làm trễ hơn 5 giây)
  await limits({ rejectJoin: false });
  await sleep(Math.max(0, 5400 - (Date.now() - tQueue)));
  assert.strictEqual(R.retryQueueNow(), true, 'Quá 5 giây thì phải thử ngay được');
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 15000, 'vào được relay sau khi hết quá tải');
  await waitFor(() => !queueOf(), 5000, 'ra khỏi hàng chờ khi đã vào được');
  await waitFor(() => chat() && chat().relay === 'online' && !chat().queue, 10000, 'khung chat: dải xếp hàng biến mất khi đã vào được');
  // «Thử ngay» bấm từ khung chat đi qua tin remote_retry (không phải lệnh VS Code): lúc không xếp hàng thì vô hại
  await api.sidebar.onMessage({ type: 'remote_retry' });

  // Q4. Từ chối ở tầng HTTP (403 kèm thân nêu too_many_connections) qua ổ cắm `ws` thật của extension → cũng vào hàng chờ, lý do giữ mã HTTP
  await limits({ rejectUpgrade: { status: 403, body: '{"error":"too_many_connections"}' } });
  await admin('realtime/drop');
  await waitFor(() => queueOf(), 20000, 'vào hàng chờ khi bắt tay HTTP bị từ chối');
  const q4 = queueOf();
  assert.strictEqual(q4.kind, 'connections');
  assert.ok(/HTTP 403/.test(q4.reason) && /too_many_connections/.test(q4.reason), `lý do phải nêu mã HTTP và mã giới hạn: ${q4.reason}`);
  const t4 = Date.now();
  await limits({ rejectUpgrade: null });
  await sleep(Math.max(0, 5400 - (Date.now() - t4)));
  assert.strictEqual(R.retryQueueNow(), true);
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online' && !queueOf(), 15000, 'vào được relay sau khi hết từ chối ở tầng HTTP');

  // Q5. Lỗi KHÁC quá tải (vd. bị từ chối vì xác thực) KHÔNG được gọi là quá tải: không có hàng chờ
  await limits({ rejectJoin: true, rejectReason: 'unauthorized' });
  await admin('realtime/drop');
  await sleep(3500);
  assert.ok(!queueOf(), 'Lỗi xác thực không được báo là quá tải');
  await limits({ rejectJoin: false });
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 30000, 'nối lại thường sau lỗi xác thực');

  // Q6. Dọn: tắt Remote → hàng chờ biến mất ở khung chat; rồi trả về mặc định (BẬT)
  await cfg.update('remote.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.relayHost() === undefined, 15000, 'tắt Remote đóng relay');
  await waitFor(() => chat() && chat().relay === 'off' && !chat().queue, 10000, 'khung chat: không còn hàng chờ khi tắt Remote');
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.local', undefined, vscode.ConfigurationTarget.Global);
  await limits({ rejectJoin: false, rejectUpgrade: null, maxConnections: null });
}

/** Phần relay: VS Code thật + trình duyệt giả (cùng mã RelayClient của trang web) qua Realtime giả. */
async function testRelay(api) {
  const kit = require(process.env.ND_TEST_KIT);
  const sb = api.sidebar;
  const R = api.remote;
  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  const apikey = process.env.LOCAITH_TEST_ANON_KEY;
  const mkLink = (hostId) => new kit.RealtimeLink({ baseUrl: BACKEND, apikey, topic: `lcr1:${hostId}`, createSocket: (u) => new kit.WebSocket(u), backoff: () => 200 });

  // R1. Remote bật sẵn → relay lên (chỉ đường Internet), cổng 127.0.0.1 KHÔNG mở. Đặt tường minh để bước này không phụ thuộc mặc định.
  await cfg.update('remote.local', false, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 20000, 'relay vào kênh Realtime');
  assert.strictEqual(R.status().running, false, 'Tắt đường cục bộ thì không được mở cổng 127.0.0.1');
  const hostId = R.status().relay.hostId;
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(hostId));
  // R2. Máy được báo danh với tài khoản (cho tab «Máy của bạn»)
  await waitFor(async () => (await (await fetch(`${BACKEND}/__admin/state`, { method: 'POST', body: '{}' })).json()).hosts.some((h) => h.hostId === hostId), 10000, 'báo danh máy với tài khoản');

  // R2b. TIN CẬY THEO TÀI KHOẢN (0.6.5): danh bạ giữ khoá tài khoản của máy → trình duyệt đăng nhập cùng tài khoản vào thẳng, không ghép đôi, không hộp thoại «Cho phép»
  api.remoteTest.approvals.length = 0;
  api.remoteTest.opened.length = 0;
  assert.strictEqual(R.status().relay.trust, true, 'Tin cậy theo tài khoản phải BẬT SẴN');
  await waitFor(() => R.status().relay.keyed, 15000, 'danh bạ đã giữ khoá tài khoản của máy');
  const regKey = async () => ((await (await fetch(`${BACKEND}/__admin/state`, { method: 'POST', body: '{}' })).json()).hosts.find((h) => h.hostId === hostId) || {}).accountKey;
  const key1 = await regKey();
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(key1 || ''), 'Danh bạ phải giữ khoá tài khoản hợp lệ (22 ký tự base64url)');
  assert.ok(!JSON.stringify(R.status()).includes(key1) && !JSON.stringify(sb.snapshot().view).includes(key1), 'Khoá tài khoản không được lọt vào trạng thái hay khung chat');
  const accountClient = async (key) => {
    const link = mkLink(hostId);
    const frames = [];
    const rc = new kit.RelayClient({ link, dev: kit.ACCOUNT_DEV, key: kit.b64u(await kit.deriveAccountKey(kit.unb64u(key), hostId)), onStream: (m) => frames.push(m), onStatus: () => undefined, helloTimeoutMs: 4000, pingMs: 3000, watchdogMs: 20000 });
    link.start();
    rc.start();
    return { link, rc, frames, stop: () => (rc.stop(), link.stop()) };
  };
  const acc = await accountClient(key1);
  await waitFor(() => acc.rc.state === 'online', 20000, 'trình duyệt cùng tài khoản vào thẳng, không ghép đôi');
  assert.strictEqual(api.remoteTest.approvals.length, 0, 'Vào bằng tài khoản không được hiện hộp thoại «Cho phép»');
  assert.strictEqual(R.status().devices.filter((d) => d.kind === 'relay').length, 0, 'Vào bằng tài khoản không được tạo bản ghi thiết bị đã ghép');
  assert.strictEqual(acc.frames[0].type, 'snapshot');
  await assert.rejects(acc.rc.command({ type: 'save_api_key', provider: 'p', key: 'k' }), (e) => e.code === 'unknown_command', 'Phiên tài khoản bị giới hạn lệnh y như thiết bị đã ghép');
  await assert.rejects(acc.rc.command({ type: 'set_mode', mode: 'bypass' }), (e) => e.code === 'bypass_not_allowed');
  // R2c. «Đổi khoá tài khoản»: phiên cũ bị cắt ngay, danh bạ nhận khoá mới, khoá cũ vô dụng
  assert.strictEqual(await R.rotateAccountKey(), true);
  await waitFor(() => acc.rc.state === 'revoked', 15000, 'đổi khoá cắt phiên tài khoản đang mở');
  // THỨ TỰ: danh bạ có khoá mới TRƯỚC khi phiên cũ bị cắt — nếu không, trình duyệt tự chữa đọc lại khoá cũ và kẹt ở «đang nối lại» (host im lặng khi MAC sai).
  const keyAtCut = await regKey();
  assert.ok(!!keyAtCut && keyAtCut !== key1, 'Khi trình duyệt bị cắt, danh bạ phải ĐÃ giữ khoá mới');
  acc.stop();
  const stale = await accountClient(key1);
  await sleep(1500);
  assert.notStrictEqual(stale.rc.state, 'online', 'Khoá cũ không được vào sau khi đổi khoá');
  stale.stop();
  const key2 = await regKey();
  const acc2 = await accountClient(key2);
  await waitFor(() => acc2.rc.state === 'online', 20000, 'khoá mới vào được');
  // R2d. `/remote` mở thẳng trang bằng TÀI KHOẢN (liên kết chỉ mang mã máy, không mang bí mật), không tạo cửa sổ ghép đôi
  assert.strictEqual(await R.openWeb(), 'account');
  const openedAcc = api.remoteTest.opened.at(-1) || '';
  assert.ok(openedAcc.endsWith(`/#remote?h=${hostId}`), `Liên kết /remote phải là #remote?h=<mã máy>, nhận ${openedAcc}`);
  assert.ok(!openedAcc.includes(key2) && !/[?&#]k=/.test(openedAcc), 'Liên kết /remote không được mang khoá hay mã ghép đôi');
  assert.strictEqual(R.relayHost().pairingState, null, '/remote bằng tài khoản không được mở cửa sổ ghép đôi');
  // R2e. Tắt `remote.trustAccount`: phiên bị cắt, khoá bị xoá khỏi danh bạ, hello «tài khoản» bị coi như thiết bị lạ, `/remote` quay về liên kết ghép đôi
  await cfg.update('remote.trustAccount', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => acc2.rc.state === 'revoked', 15000, 'tắt tin cậy theo tài khoản cắt phiên đang mở');
  await waitFor(async () => !(await regKey()), 15000, 'danh bạ xoá khoá khi tắt tin cậy theo tài khoản');
  assert.strictEqual(R.status().relay.trust, false);
  acc2.stop();
  const off = await accountClient(key2);
  await waitFor(() => off.rc.state === 'unpaired', 15000, 'hello «tài khoản» bị từ chối khi đã tắt');
  off.stop();
  assert.strictEqual(await R.openWeb(), 'pairing');
  const openedPair = api.remoteTest.opened.at(-1) || '';
  assert.ok(/#remote\?r=[A-Za-z0-9_-]{22}&k=[A-Za-z0-9_-]{22}/.test(openedPair), 'Khi tắt tin cậy, /remote dùng liên kết ghép đôi');
  R.relayHost().cancelPairing();
  // R2f. Bật lại: khoá MỚI (khoá cũ không sống lại), danh bạ giữ khoá mới
  await cfg.update('remote.trustAccount', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.status().relay.trust && R.status().relay.keyed, 15000, 'bật lại tin cậy theo tài khoản');
  const key3 = await regKey();
  assert.ok(key3 && key3 !== key1 && key3 !== key2, 'Bật lại phải sinh khoá MỚI');
  api.remoteTest.approvals.length = 0;
  console.log('[relay] R2b–R2f: tin cậy theo tài khoản — danh bạ giữ khoá, vào không ghép đôi, đổi khoá, /remote, tắt/bật lại: ĐÚNG');

  // R3. Ghép đôi: người ngồi ở máy mở cửa sổ → trình duyệt giả ghép bằng psk → hộp thoại xác nhận hiện ĐÚNG mã SAS
  api.remoteTest.approvals.length = 0;
  const { psk } = R.relayHost().startPairing();
  const pairLink = mkLink(hostId);
  pairLink.start();
  await waitFor(() => pairLink.status === 'online', 15000, 'trình duyệt giả vào kênh');
  const p = await kit.pairWithHost({ link: pairLink, psk, label: 'Chrome · thử nghiệm', timeoutMs: 30000 });
  pairLink.stop();
  assert.strictEqual(api.remoteTest.approvals.length, 1, 'Host phải hỏi người dùng đúng một lần');
  assert.strictEqual(api.remoteTest.approvals[0].sas, p.sas, 'Mã SAS ở hộp thoại VS Code phải giống mã ở trình duyệt');
  assert.strictEqual(api.remoteTest.approvals[0].label, 'Chrome · thử nghiệm');
  assert.strictEqual(R.status().devices.filter((d) => d.kind === 'relay').length, 1);
  // psk dùng một lần: ghép lần nữa bằng cùng psk không được
  const link2 = mkLink(hostId);
  link2.start();
  await assert.rejects(kit.pairWithHost({ link: link2, psk, label: 'Kẻ khác', timeoutMs: 2500, resendMs: 500 }), (e) => e.code === 'bad_host', 'psk phải chỉ dùng được một lần');
  link2.stop();
  // Từ chối: cửa sổ mới, người dùng bấm Từ chối
  api.remoteTest.answer = false;
  const { psk: psk2 } = R.relayHost().startPairing();
  const link3 = mkLink(hostId);
  link3.start();
  await assert.rejects(kit.pairWithHost({ link: link3, psk: psk2, label: 'Bị từ chối', timeoutMs: 15000 }), (e) => e.code === 'denied');
  link3.stop();
  api.remoteTest.answer = true;
  assert.strictEqual(R.status().devices.filter((d) => d.kind === 'relay').length, 1, 'Thiết bị bị từ chối không được lưu');

  // R4. Phiên: snapshot đầu tiên từ trạng thái THẬT của trợ lý, không rò rỉ cài đặt/khoá
  const provider = remoteProvider();
  api.providers.registry.addExtraProvider(provider, [{ id: 'm', label: 'RemoteTest' }]);
  await sb.startNewSession();
  await sb.setModel('remotetest', 'm');
  await sb.onMessage({ type: 'set_mode', mode: 'default' });
  const webLink = mkLink(hostId);
  const frames = [];
  const statuses = [];
  const rc = new kit.RelayClient({ link: webLink, dev: p.dev, key: p.key, onStream: (m) => frames.push(m), onStatus: (s) => statuses.push(s), helloTimeoutMs: 4000, pingMs: 3000, watchdogMs: 20000 });
  webLink.start();
  rc.start();
  await waitFor(() => rc.state === 'online', 20000, 'phiên relay online');
  assert.strictEqual(frames[0].type, 'snapshot');
  assert.strictEqual(frames[0].state.sessionId, sb.snapshot().view.sessionId);
  assert.strictEqual(frames[0].state.model, 'm');
  const snapJson = JSON.stringify(frames[0]);
  for (const leak of ['"settings"', '"skills"', '"trash"', '"slashCommands"', 'apiKey', '"baseUrl"', '"editor"', '"account"', 'lat_']) assert.ok(!snapJson.includes(leak), `Snapshot lộ ${leak}`);

  // R5. Lệnh ngoài tập cho phép bị từ chối; bypass bị chặn
  for (const type of ['delete_session', 'save_api_key', 'open_file', 'mcp_toggle', 'slash', 'account_sign_out']) {
    await assert.rejects(rc.command({ type, id: 'x', provider: 'p', key: 'k', text: 'a' }), (e) => e.code === 'unknown_command', `${type} phải bị từ chối`);
  }
  await assert.rejects(rc.command({ type: 'set_mode', mode: 'bypass' }), (e) => e.code === 'bypass_not_allowed');
  // …và lệnh gạch chéo trong nội dung tin nhắn cũng không vòng qua được chốt đó (trước 0.6.5 `send` «/mode bypass» đi thẳng tới setMode)
  for (const text of ['/mode bypass', '/MODE   Bypass']) await assert.rejects(sb.handleRemote({ type: 'send', text }), /bypass_not_allowed/, `«${text}» phải bị chặn`);
  assert.notStrictEqual(sb.snapshot().view.mode, 'bypass', 'Chế độ quyền không được đổi sang bypass từ xa');

  // R6. Một lượt hội thoại qua relay
  await rc.command({ type: 'send', text: 'Xin chào qua relay' });
  await waitFor(() => frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'text')), 20000, 'sự kiện text đầu tiên qua relay');
  await waitFor(() => !sb.isRunning, 30000, 'trả lời xong');
  await waitFor(() => frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'run_state' && e.running === false)), 15000, 'run_state=false tới trình duyệt');
  const finalTexts = assistantTexts(sb.snapshot().view.transcript);
  assert.strictEqual(finalTexts.length, 1);
  const rebuild = (fs) => {
    let items = [];
    for (const f of fs) {
      if (f.type === 'snapshot') items = JSON.parse(JSON.stringify(f.state.transcript));
      else if (f.type === 'events') {
        for (const e of f.events) {
          if (e.t === 'assistant_start') items.push({ kind: 'assistant', id: e.id, blocks: [] });
          if (e.t === 'text') {
            const a = items.find((i) => i.kind === 'assistant' && i.id === e.id);
            if (!a) continue;
            const last = a.blocks[a.blocks.length - 1];
            if (last && last.type === 'text') last.text += e.delta;
            else a.blocks.push({ type: 'text', id: 'x', text: e.delta });
          }
        }
      }
    }
    return assistantTexts(items);
  };
  assert.deepStrictEqual(rebuild(frames).slice(-1), finalTexts, 'Trình duyệt qua relay phải dựng lại đúng câu trả lời');
  assert.ok(sb.snapshot().view.transcript.some((i) => i.kind === 'user' && i.text === 'Xin chào qua relay'), 'Tin nhắn gửi qua relay phải nằm trong transcript của VS Code');

  // R7. Duyệt quyền qua relay
  await rc.command({ type: 'send', text: 'Việc này cần quyền chạy lệnh' });
  await waitFor(() => frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'tool_permission')), 25000, 'yêu cầu quyền tới trình duyệt');
  const permEv = frames.flatMap((f) => (f.type === 'events' ? f.events : [])).find((e) => e.t === 'tool_permission');
  assert.strictEqual(permEv.request.kind, 'command');
  await rc.command({ type: 'permission_response', id: permEv.request.id, decision: 'deny', feedback: 'không' });
  await waitFor(() => frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'tool_end' && e.state === 'denied')), 25000, 'công cụ bị từ chối');
  await waitFor(() => !sb.isRunning, 30000, 'lượt quyền kết thúc');

  // R8. Dừng từ xa
  await rc.command({ type: 'send', text: 'Câu dài nữa' });
  await waitFor(() => sb.isRunning, 15000, 'bắt đầu lượt dài');
  await rc.command({ type: 'stop' });
  await waitFor(() => !sb.isRunning, 20000, 'Dừng qua relay có tác dụng');

  // R9. RELAY KHÔNG ĐỌC ĐƯỢC NỘI DUNG: tìm trên mọi tin quảng bá đã đi qua kênh Realtime
  for (const secret of ['Xin chào qua relay', 'cần quyền chạy lệnh', 'Câu dài nữa', 'remotetest', 'RemoteTest', p.key, psk, 'Đã nhận từ xa', sb.snapshot().view.sessionId]) {
    const r = await admin('wire-contains', { text: secret });
    assert.strictEqual(r.found, false, `Relay nhìn thấy bản rõ: ${secret.slice(0, 20)}`);
  }
  assert.ok((await admin('wire-contains', { text: 'x' })).count > 20, 'Phải có nhiều tin đã đi qua relay');

  // R10. Relay sập → mọi bên tự nối lại, phiên hồi phục, sự kiện sau đó vẫn tới
  const before = frames.length;
  await admin('realtime/drop');
  await waitFor(() => statuses.includes('reconnecting'), 15000, 'trình duyệt phát hiện mất kết nối');
  await waitFor(() => rc.state === 'online' && R.relayHost().status === 'online', 30000, 'phiên hồi phục sau khi relay sập');
  await rc.command({ type: 'send', text: 'Sau khi relay sập' });
  await waitFor(() => sb.snapshot().view.transcript.some((i) => i.kind === 'user' && i.text === 'Sau khi relay sập'), 20000, 'lệnh gửi sau khi hồi phục tới được VS Code');
  await waitFor(() => !sb.isRunning, 30000, 'trả lời xong sau khi hồi phục');
  await waitFor(() => frames.length > before && frames.slice(before).some((f) => f.type === 'events'), 15000, 'sự kiện sau khi hồi phục tới trình duyệt');

  // R11. Thu hồi từ VS Code → trình duyệt thấy "revoked", không nối lại được nữa
  const devId = R.status().devices.find((d) => d.kind === 'relay').id;
  assert.strictEqual(await R.server.revoke(devId), true);
  await waitFor(() => rc.state === 'revoked', 15000, 'trình duyệt nhận revoked');
  assert.strictEqual(R.status().devices.filter((d) => d.kind === 'relay').length, 0);
  const link4 = mkLink(hostId);
  const st4 = [];
  const rc4 = new kit.RelayClient({ link: link4, dev: p.dev, key: p.key, onStream: () => undefined, onStatus: (s) => st4.push(s), helloTimeoutMs: 3000 });
  link4.start();
  rc4.start();
  await waitFor(() => rc4.state === 'unpaired', 15000, 'thiết bị đã thu hồi bị từ chối bắt tay');
  rc4.stop();
  link4.stop();
  rc.stop();
  webLink.stop();

  // R12. Ghép đôi lại → đăng xuất tài khoản giữa chừng: relay đóng ngay, máy bị gỡ khỏi danh bạ; đăng nhập lại → relay mở lại
  const { psk: psk3 } = R.relayHost().startPairing();
  const link5 = mkLink(hostId);
  link5.start();
  const p2 = await kit.pairWithHost({ link: link5, psk: psk3, label: 'Thiết bị thứ hai', timeoutMs: 20000 });
  link5.stop();
  const link6 = mkLink(hostId);
  const frames6 = [];
  const rc6 = new kit.RelayClient({ link: link6, dev: p2.dev, key: p2.key, onStream: (m) => frames6.push(m), onStatus: () => undefined, helloTimeoutMs: 4000, pingMs: 3000 });
  link6.start();
  rc6.start();
  await waitFor(() => rc6.state === 'online', 20000, 'thiết bị thứ hai online');
  const keyBeforeSignOut = await regKey();
  assert.ok(!!keyBeforeSignOut, 'Trước khi đăng xuất danh bạ phải đang giữ khoá tài khoản của máy');
  await api.account.signOut();
  await waitFor(() => R.relayHost() === undefined, 15000, 'relay đóng khi đăng xuất');
  await waitFor(() => frames6.some((f) => f.type === 'bye'), 10000, 'trình duyệt nhận bye khi đăng xuất');
  assert.ok(!(await (await fetch(`${BACKEND}/__admin/state`, { method: 'POST', body: '{}' })).json()).hosts.some((h) => h.hostId === hostId), 'Máy phải bị gỡ khỏi danh bạ khi đăng xuất');
  await assert.rejects(sb.handleRemote({ type: 'stop' }), /account_required/);
  rc6.stop();
  link6.stop();
  await signInFlow(api);
  await waitFor(() => R.relayHost() && R.relayHost().status === 'online', 20000, 'relay mở lại sau khi đăng nhập lại');
  assert.strictEqual(R.status().devices.filter((d) => d.kind === 'relay').length, 1, 'Thiết bị đã ghép vẫn còn sau khi đăng nhập lại');
  await waitFor(() => R.status().relay.trust && R.status().relay.keyed, 15000, 'tin cậy theo tài khoản có lại sau khi đăng nhập lại');
  const keyAfterSignIn = await regKey();
  assert.ok(!!keyAfterSignIn && keyAfterSignIn !== keyBeforeSignOut, 'Đăng xuất là THU HỒI: đăng nhập lại phải cho khoá tài khoản MỚI (tab còn cầm khoá cũ không tự vào lại được)');

  // R13. Tắt Remote = thu hồi khoá; bật lại cho khoá MỚI. Rồi dọn.
  const keyBeforeOff = await regKey();
  await cfg.update('remote.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.relayHost() === undefined, 15000, 'tắt Remote đóng relay');
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.status().relay && R.status().relay.trust && R.status().relay.keyed, 20000, 'bật lại Remote: tin cậy theo tài khoản có lại');
  const keyAfterOn = await regKey();
  assert.ok(!!keyAfterOn && keyAfterOn !== keyBeforeOff, 'Tắt rồi bật Remote phải cho khoá tài khoản MỚI');
  await cfg.update('remote.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.relayHost() === undefined, 15000, 'tắt Remote đóng relay');
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.local', undefined, vscode.ConfigurationTarget.Global);
  await sb.startNewSession();
  await sb.showScreen('chat');
}

async function testRemote(api) {
  const sb = api.sidebar;
  const R = api.remote;
  const ORIGIN = 'http://localhost:3000';

  // 0. Mặc định KHÔNG mở cổng cục bộ (Remote bật sẵn chỉ dùng đường Internet); lệnh đã đăng ký
  assert.strictEqual(R.status().running, false, 'Đường cục bộ phải TẮT theo mặc định (không mở cổng nào)');
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['locaithAgent.remote.pair', 'locaithAgent.remote.manage']) assert.ok(cmds.includes(c), `Thiếu lệnh ${c}`);

  // 1. Bật qua cài đặt người dùng (toàn cục): máy chủ mở trên 127.0.0.1, origin của webUrl tự được phép
  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  await cfg.update('remote.webUrl', ORIGIN, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.local', true, vscode.ConfigurationTarget.Global); // đường cục bộ mặc định tắt: bật tường minh
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  await waitFor(() => R.status().running, 15000, 'Remote bật theo cài đặt');
  const port = R.status().port;
  assert.ok(port >= 47630 && port <= 47639, `Cổng Remote ngoài dải: ${port}`);

  // 2. hello + chặn Origin lạ / chưa có token
  const hello = await remoteHttp(port, 'GET', '/v1/hello', { headers: { origin: ORIGIN } });
  assert.strictEqual(hello.status, 200);
  assert.strictEqual(hello.json.app, 'locaith-agent-remote');
  assert.strictEqual(hello.json.pairing, false);
  assert.strictEqual((await remoteHttp(port, 'GET', '/v1/hello', { headers: { origin: 'https://evil.example' } })).status, 403, 'Origin lạ phải bị từ chối');
  assert.strictEqual((await remoteHttp(port, 'GET', '/v1/state', { headers: { origin: ORIGIN } })).status, 401, 'Chưa có token phải 401');

  // 3. Ghép đôi bằng mã
  const { code } = await R.server.startPairing();
  assert.strictEqual((await remoteHttp(port, 'POST', '/v1/pair', { headers: { origin: ORIGIN }, body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }) })).status, 401, 'Sai mã phải 401');
  const pr = await remoteHttp(port, 'POST', '/v1/pair', { headers: { origin: ORIGIN }, body: JSON.stringify({ code, label: 'Thiết bị thử' }) });
  assert.strictEqual(pr.status, 200, `Ghép đôi: ${JSON.stringify(pr.json)}`);
  const token = pr.json.token;
  assert.ok(/^lr_/.test(token));
  const auth = { origin: ORIGIN, authorization: `Bearer ${token}` };
  assert.strictEqual(R.status().devices.length, 1);

  // 4. Luồng sự kiện: snapshot đầu tiên không rò rỉ cài đặt/khoá/kỹ năng
  const s1 = remoteStream(port, token, ORIGIN);
  await waitFor(() => s1.frames.length >= 1, 10000, 'snapshot đầu tiên');
  assert.strictEqual(s1.frames[0].type, 'snapshot');
  assert.strictEqual(s1.frames[0].state.v, 1);
  const snapJson = JSON.stringify(s1.frames[0]);
  for (const leak of ['"settings"', '"skills"', '"trash"', '"slashCommands"', 'apiKey', '"baseUrl"', '"editor"']) assert.ok(!snapJson.includes(leak), `Snapshot lộ ${leak}`);
  assert.ok(s1.frames[0].state.providers.some((p) => p.id === 'demo'), 'Snapshot phải có danh sách model');

  // 5. Lệnh ngoài tập cho phép bị từ chối (xoá lịch sử, khoá API…)
  for (const type of ['delete_session', 'save_api_key', 'open_file', 'mcp_toggle', 'slash']) {
    const r = await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type, id: 'x', provider: 'p', key: 'k', text: 'a' }) });
    assert.strictEqual(r.status, 400, `${type} phải bị từ chối`);
  }
  assert.strictEqual((await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'set_mode', mode: 'bypass' }) })).json.error, 'bypass_not_allowed', 'Không cho tự chuyển sang bypass từ xa');

  // 6. Một lượt hội thoại gửi từ xa
  const provider = remoteProvider();
  api.providers.registry.addExtraProvider(provider, [{ id: 'm', label: 'RemoteTest' }]);
  await sb.startNewSession();
  await sb.setModel('remotetest', 'm');
  await sb.onMessage({ type: 'set_mode', mode: 'default' });
  // Máy khách biết model đã đổi qua một bản vá (patch) HOẶC một snapshot mới — snapshot mới chỉ có khi có một `init` tình cờ tới sau lúc đổi model (ví dụ làm mới danh sách model ở nền xong muộn),
  // nên chờ riêng snapshot là phụ thuộc thời gian (đã hỏng khi cổng Locaith trả lời nhanh hơn): chấp nhận cả hai.
  await waitFor(() => s1.frames.some((f) => (f.type === 'snapshot' && f.state.model === 'm') || (f.type === 'patch' && f.patch && f.patch.model === 'm')), 10000, 'máy khách thấy model đã đổi (snapshot hoặc bản vá)');
  const send1 = await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'send', text: 'Xin chào từ xa' }) });
  assert.strictEqual(send1.status, 200, `send: ${JSON.stringify(send1.json)}`);
  await waitFor(() => s1.frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'text')), 15000, 'sự kiện text đầu tiên');

  // 6b. Máy khách THỨ HAI vào giữa lúc trợ lý đang trả lời: snapshot + luồng phải khớp, không áp trùng delta
  assert.ok(sb.isRunning, 'Trợ lý phải còn đang chạy khi máy khách thứ hai vào');
  const s2 = remoteStream(port, token, ORIGIN);
  await waitFor(() => s2.frames.length >= 1, 10000, 'snapshot của máy khách thứ hai');
  assert.strictEqual(s2.frames[0].type, 'snapshot');
  await waitFor(() => !sb.isRunning, 30000, 'trả lời xong');
  await waitFor(() => s2.frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'run_state' && e.running === false)), 10000, 'máy khách thứ hai nhận run_state=false');
  const finalTexts = assistantTexts(sb.snapshot().view.transcript);
  assert.strictEqual(finalTexts.length, 1);
  const rebuild = (frames) => {
    let items = [];
    for (const f of frames) {
      if (f.type === 'snapshot') items = JSON.parse(JSON.stringify(f.state.transcript));
      else if (f.type === 'events') {
        for (const e of f.events) {
          if (e.t === 'assistant_start') items.push({ kind: 'assistant', id: e.id, blocks: [] });
          if (e.t === 'text') {
            const a = items.find((i) => i.kind === 'assistant' && i.id === e.id);
            if (!a) continue;
            const last = a.blocks[a.blocks.length - 1];
            if (last && last.type === 'text') last.text += e.delta;
            else a.blocks.push({ type: 'text', id: 'x', text: e.delta });
          }
        }
      }
    }
    return assistantTexts(items);
  };
  assert.deepStrictEqual(rebuild(s2.frames), finalTexts, 'Máy khách vào giữa chừng phải dựng lại đúng câu trả lời (không trùng/thiếu delta)');
  assert.deepStrictEqual(rebuild(s1.frames).slice(-1), finalTexts, 'Máy khách đầu cũng khớp');
  const st = await remoteHttp(port, 'GET', '/v1/state', { headers: auth });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.json.state.running, false);
  assert.ok(st.json.state.transcript.some((i) => i.kind === 'user' && i.text === 'Xin chào từ xa'), 'Tin nhắn gửi từ xa phải nằm trong transcript');
  s2.close();

  // 7. Duyệt quyền từ xa: run_command bị chặn chờ duyệt → trả lời "deny" qua Remote
  const send2 = await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'send', text: 'Việc này cần quyền chạy lệnh' }) });
  assert.strictEqual(send2.status, 200);
  await waitFor(() => s1.frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'tool_permission')), 20000, 'yêu cầu quyền tới máy khách từ xa');
  const permEv = s1.frames.flatMap((f) => (f.type === 'events' ? f.events : [])).find((e) => e.t === 'tool_permission');
  assert.strictEqual(permEv.request.kind, 'command');
  assert.ok(permEv.request.id && permEv.request.canAllowSession !== undefined);
  assert.strictEqual((await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'permission_response', id: permEv.request.id, decision: 'deny', feedback: 'không' }) })).status, 200);
  await waitFor(() => s1.frames.some((f) => f.type === 'events' && f.events.some((e) => e.t === 'tool_end' && e.state === 'denied')), 20000, 'công cụ bị từ chối');
  await waitFor(() => !sb.isRunning, 30000, 'lượt thứ hai kết thúc');

  // 8. Dừng từ xa khi đang chạy
  const send3 = await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'send', text: 'Câu dài nữa' }) });
  assert.strictEqual(send3.status, 200);
  await waitFor(() => sb.isRunning, 10000, 'bắt đầu lượt thứ ba');
  assert.strictEqual((await remoteHttp(port, 'POST', '/v1/cmd', { headers: auth, body: JSON.stringify({ type: 'stop' }) })).status, 200);
  await waitFor(() => !sb.isRunning, 15000, 'Dừng từ xa có tác dụng');

  // 9. Thu hồi: luồng đóng ngay (bye) và token hết tác dụng
  const id = R.status().devices[0].id;
  assert.strictEqual(await R.server.revoke(id), true);
  await waitFor(() => s1.ended, 10000, 'luồng bị đóng sau khi thu hồi');
  assert.strictEqual(s1.frames.at(-1).type, 'bye');
  assert.strictEqual((await remoteHttp(port, 'GET', '/v1/state', { headers: auth })).status, 401, 'Token đã thu hồi phải 401');

  // 10. Tắt bằng cài đặt: đóng cổng
  await cfg.update('remote.enabled', false, vscode.ConfigurationTarget.Global);
  await waitFor(() => !R.status().running, 15000, 'Remote tắt theo cài đặt');
  await cfg.update('remote.local', undefined, vscode.ConfigurationTarget.Global);
  await assert.rejects(remoteHttp(port, 'GET', '/v1/hello', {}), /ECONNREFUSED|ECONNRESET/, 'Cổng phải đóng');
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.webUrl', undefined, vscode.ConfigurationTarget.Global);
  await sb.startNewSession();
  await sb.showScreen('chat');
}
