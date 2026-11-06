'use strict';
// Kiểm thử THỦ CÔNG đầu-cuối cho Remote: chạy extension THẬT trong VS Code Insiders thật, bật Remote, tạo mã ghép đôi rồi GIỮ cửa sổ mở để một trình duyệt
// (Playwright → trang locaith.ai) ghép đôi và điều khiển nó. Điều phối bằng tệp trong thư mục ND_REMOTE_E2E_DIR:
//   pairing.json  ← suite ghi mã + cổng      repair ← (trình duyệt tạo) xin mã mới      revoke ← thu hồi mọi thiết bị      done ← kết thúc
// Chạy bằng _work/run-insiders-remote.mjs (không nằm trong `npm test`).
const assert = require('node:assert');
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const dir = process.env.ND_REMOTE_E2E_DIR;
  assert.ok(dir, 'Thiếu ND_REMOTE_E2E_DIR');
  const f = (n) => path.join(dir, n);
  const ext = vscode.extensions.getExtension('LocaithAI.locaith-agent');
  const api = await ext.activate();
  assert.ok(api && api.remote, 'Thiếu TestApi.remote (cần ND_AGENT_TEST=1)');

  const cfg = vscode.workspace.getConfiguration('locaithAgent');
  await cfg.update('remote.webUrl', process.env.ND_REMOTE_WEB || 'http://localhost:3000', vscode.ConfigurationTarget.Global);
  await cfg.update('remote.enabled', true, vscode.ConfigurationTarget.Global);
  const t0 = Date.now();
  while (!api.remote.status().running) {
    assert.ok(Date.now() - t0 < 20000, 'Remote không bật');
    await sleep(100);
  }
  const writePairing = async () => {
    const { code, port } = await api.remote.server.startPairing();
    fs.writeFileSync(f('pairing.json'), JSON.stringify({ code, port, url: `http://127.0.0.1:${port}` }));
  };
  await writePairing();
  console.log('[remote-e2e] sẵn sàng, đang chờ trình duyệt…');

  const limit = Number(process.env.ND_REMOTE_E2E_MS || 300000);
  const start = Date.now();
  while (!fs.existsSync(f('done')) && Date.now() - start < limit) {
    if (fs.existsSync(f('repair'))) {
      fs.unlinkSync(f('repair'));
      await writePairing();
    }
    if (fs.existsSync(f('revoke'))) {
      fs.unlinkSync(f('revoke'));
      await api.remote.server.revokeAll();
      fs.writeFileSync(f('revoked.ok'), '1');
    }
    await sleep(250);
  }
  const view = api.sidebar.snapshot().view;
  fs.writeFileSync(
    f('host-final.json'),
    JSON.stringify({
      sessionId: view.sessionId,
      transcriptKinds: view.transcript.map((i) => i.kind),
      assistantBlocks: view.transcript.filter((i) => i.kind === 'assistant').flatMap((a) => a.blocks.map((b) => b.type)),
      userTexts: view.transcript.filter((i) => i.kind === 'user').map((u) => u.text),
      running: view.running,
      devices: api.remote.status().devices.length,
    }),
  );
  await cfg.update('remote.enabled', undefined, vscode.ConfigurationTarget.Global);
  await cfg.update('remote.webUrl', undefined, vscode.ConfigurationTarget.Global);
};
