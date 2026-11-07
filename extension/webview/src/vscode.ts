/** Cầu nối tới "host": postMessage + trạng thái giao diện lưu qua getState/setState. VS Code dùng acquireVsCodeApi; bản trình duyệt cắm cầu nối riêng. */
import type { AttachmentInfo, WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
let bridge: VsCodeApi | undefined;

/**
 * Bản trình duyệt: controller chạy cùng trang với giao diện nên cắm thẳng một cầu nối thay cho acquireVsCodeApi.
 * Phải gọi TRƯỚC khi giao diện được dựng.
 */
export function installBridge(b: VsCodeApi): void {
  bridge = b;
}

function getApi(): VsCodeApi {
  if (bridge) return bridge;
  // acquireVsCodeApi chỉ được gọi đúng một lần cho mỗi webview.
  api ??= acquireVsCodeApi();
  return api;
}

export function post(message: WebviewMessage): void {
  getApi().postMessage(message);
}

/** Trạng thái chỉ thuộc về giao diện, sống sót qua việc VS Code huỷ/tạo lại webview. */
export interface PersistedUi {
  draft?: string;
  /** Chỉ lưu tệp/vùng chọn — ảnh (base64) quá nặng để lưu. */
  attachments?: AttachmentInfo[];
}

export function loadUiState(): PersistedUi {
  try {
    const s = getApi().getState();
    return s && typeof s === 'object' ? (s as PersistedUi) : {};
  } catch {
    return {};
  }
}

export function saveUiState(patch: Partial<PersistedUi>): void {
  try {
    getApi().setState({ ...loadUiState(), ...patch });
  } catch {
    /* bỏ qua: không lưu được cũng không sao */
  }
}
