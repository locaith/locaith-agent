/**
 * (0.7.2) Artifact HTML mặc định mở bằng TRÌNH DUYỆT (bạn Huân: tab bên cạnh của VS Code khó dùng cho HTML).
 * Cài đặt `locaithAgent.artifacts.htmlOpenIn` (`browser` | `vscode`, mặc định `browser`) quyết định nơi mở khi bấm nút chính
 * của thẻ HTML và khi `artifacts.autoOpen` tự mở HTML. SVG / Markdown / bảng điều khiển giữ nguyên: xem trước trong VS Code.
 * Hàm thuần — dùng chung cho host (tự mở) và giao diện (nhãn nút).
 */
export type HtmlOpenIn = 'browser' | 'vscode';
export type AutoOpenPolicy = 'never' | 'static' | 'always' | 'browser';
export type ArtifactTarget = 'browser' | 'vscode';

export function normalizeHtmlOpenIn(v: unknown): HtmlOpenIn {
  return v === 'vscode' ? 'vscode' : 'browser';
}

/** Nút chính của thẻ mở ở đâu. Chỉ HTML theo cài đặt; mọi loại khác xem trước trong VS Code. */
export function primaryArtifactTarget(type: string, htmlOpenIn: HtmlOpenIn): ArtifactTarget {
  return type === 'html' && htmlOpenIn === 'browser' ? 'browser' : 'vscode';
}

/**
 * Artifact vừa dựng xong: tự mở không, và mở ở đâu?
 *  - `never`: không bao giờ; `browser` (kiểu cũ): mọi loại mở bằng trình duyệt;
 *  - `static`: tự mở SVG/Markdown (trong VS Code); HTML chỉ khi là nhà cung cấp demo;
 *  - `always`: tự mở mọi loại, HTML theo `htmlOpenIn`.
 * Nhà cung cấp demo luôn xem trước trong VS Code (không bật trình duyệt khi chạy thử).
 */
export function autoOpenTarget(policy: AutoOpenPolicy, type: string, htmlOpenIn: HtmlOpenIn, demo: boolean): ArtifactTarget | null {
  if (policy === 'never') return null;
  if (policy === 'browser') return 'browser';
  if (type !== 'html') return 'vscode';
  if (demo) return 'vscode';
  if (policy === 'static') return null;
  return primaryArtifactTarget(type, htmlOpenIn);
}
