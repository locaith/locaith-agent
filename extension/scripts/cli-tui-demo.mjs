// Chạy giao diện terminal với MockRuntime để xem bằng mắt (không cần lõi thật).
//   node scripts/cli-tui-demo.mjs [--lang en] [--speed 0.5] [--light|--dark] [--no-color] [--ascii] [--logged-out] [--prompt "chữ điền sẵn"]
// Trong demo, gõ thử: "xin chào" · "hãy sửa parseArgs" (xin quyền + diff) · "chạy test" · "có lỗi" · "lập kế hoạch với todo" ·
// "agent song song" · "đọc nhiều tệp" · "nén ngữ cảnh" · "/resume" · "/model" · "/help" · "!git status"
import { spawnSync } from 'node:child_process';
import { buildDemo } from './cli-lib.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('cli-tui-demo cần chạy trong một terminal tương tác (TTY).');
  process.exit(2);
}
const bundle = await buildDemo();
const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 0);
