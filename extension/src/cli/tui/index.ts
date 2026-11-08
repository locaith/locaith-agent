/**
 * Cổng vào của giao diện terminal Locaith CLI (lane cli-tui).
 *
 *   runTui(rt, opts)        vòng tương tác trọn vẹn → mã thoát
 *   runOnboarding(opts)     lần chạy đầu: ngôn ngữ, đăng nhập, thông báo dữ liệu, tin cậy thư mục
 *   renderWelcome(info)     khung chào (logo «Lo», tài khoản, model, thư mục, mẹo)
 *   MockRuntime             CliRuntime giả có kịch bản (phát triển + kiểm thử)
 */

import type { CliRuntime } from '../runtime/contract';
import { TuiApp, type TuiOptions } from './app';

export { TuiApp } from './app';
export type { TuiOptions } from './app';
export { MockRuntime } from './mockRuntime';
export type { MockOptions } from './mockRuntime';
export { renderWelcome } from './welcome';
export type { WelcomeInfo } from './welcome';
export { runOnboarding } from './onboarding';
export type { OnboardingOptions, OnboardingResult } from './onboarding';

export type RunTuiOptions = TuiOptions;

/**
 * Chạy giao diện tương tác. Ném lỗi rõ ràng nếu stdin/stdout không phải TTY (người gọi phải chuyển sang chế độ in một lần TRƯỚC khi gọi).
 * Không bao giờ ném lỗi khi đang chạy: mọi lỗi trong vòng sự kiện được in ra như thông báo lỗi; terminal luôn được khôi phục khi thoát.
 */
export async function runTui(rt: CliRuntime, o: RunTuiOptions): Promise<number> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('runTui cần một terminal tương tác (stdin và stdout đều phải là TTY). Không có TTY: dùng chế độ in một lần, ví dụ  locaith -p "<việc cần làm>".');
  }
  const app = new TuiApp(rt, o);
  return app.run();
}
