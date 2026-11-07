// Biến đổi lúc BUILD cho kỹ năng `artifacts` của bản trình duyệt: bản trình duyệt (Chrome Web Store) không được tải mã từ internet,
// nên dòng «Chỉ được tải script/style từ: cdn…» của bản VS Code được thay bằng lời dặn viết nội tuyến. Tệp skills/artifacts/SKILL.md (dùng chung) KHÔNG đổi.
// Làm lúc build (không phải lúc chạy) để gói trình duyệt không chứa tên miền CDN nào, kể cả trong văn bản.

const CDN_LINE = /^- Chỉ được tải script\/style từ:[^\n]*$/m;
export const BROWSER_ARTIFACT_RULE = '- KHÔNG tải script/style từ internet: mọi thư viện phải viết trực tiếp trong trang (biểu đồ bằng JS thuần hoặc SVG); tải từ ngoài sẽ bị chặn.';

/** Thay dòng quy tắc CDN; ném lỗi nếu không tìm thấy đúng một dòng (tránh im lặng để lọt lời hướng dẫn sai vào gói). */
export function artifactsSkillForBrowser(md) {
  const n = md.split('\n').filter((l) => CDN_LINE.test(l)).length;
  if (n !== 1) throw new Error(`skills/artifacts/SKILL.md: cần đúng 1 dòng «Chỉ được tải script/style từ: …», thấy ${n}. Cập nhật scripts/browser-skill-transform.mjs.`);
  return md.replace(CDN_LINE, BROWSER_ARTIFACT_RULE);
}
