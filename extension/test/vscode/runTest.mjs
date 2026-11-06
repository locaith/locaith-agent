// Kiểm thử tích hợp: chạy extension trong VS Code THẬT (bản đã cài trên máy), thư mục dữ liệu riêng
// nên không đụng tới cài đặt/extension của bạn.
//   npm run build && node test/vscode/runTest.mjs
//   VSCODE_EXE=<đường dẫn Code.exe> để chỉ định bản VS Code khác.
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Chạy từ terminal bên trong VS Code thì môi trường mang theo ELECTRON_RUN_AS_NODE/VSCODE_* của bản đang mở:
// nếu giữ nguyên, Code.exe chạy như Node thường hoặc nối nhầm vào cửa sổ cũ. Gỡ hết trước khi khởi chạy.
for (const k of Object.keys(process.env)) if (/^(ELECTRON_|VSCODE_)/.test(k)) delete process.env[k];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-vscode-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Dự án thử nghiệm\n\nTiếng Việt có dấu: Nguyễn Văn Ánh.\n');
fs.writeFileSync(path.join(workspace, 'app.ts'), 'export const tên = "Đặng Thị Hồng";\n');

const candidates = [
  process.env.VSCODE_EXE,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'C:\\Program Files\\Microsoft VS Code\\Code.exe',
].filter(Boolean);
const vscodeExecutablePath = candidates.find((p) => fs.existsSync(p));
if (!vscodeExecutablePath) throw new Error('Không tìm thấy VS Code. Đặt biến VSCODE_EXE.');

// Xoá khoá API trong môi trường để chắc chắn test chạy với "chưa có khoá nào" (→ chế độ demo).
const emptyKeys = Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY'].map((k) => [k, '']));

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'vscode', 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--remote-debugging-port=9339', '--skip-release-notes', '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext')],
    extensionTestsEnv: { ...emptyKeys, ND_AGENT_TEST: '1', ND_TEST_SHOTS: process.env.ND_TEST_SHOTS ?? '', ND_TEST_DEBUG_FILE: process.env.ND_TEST_DEBUG_FILE ?? '' },
  });
  console.log('✔ Kiểm thử tích hợp VS Code thành công');
} catch (err) {
  console.error('✘ Kiểm thử tích hợp thất bại:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

