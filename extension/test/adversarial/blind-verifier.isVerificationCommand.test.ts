import { describe, expect, it } from 'vitest';
import { isVerificationCommand } from '../../src/core/engine/verifier';

/**
 * (blind-verifier · kiểm chứng đối kháng) `isVerificationCommand` phải là danh sách cho phép DƯƠNG chỉ gồm lệnh KIỂM CHỨNG
 * (test / typecheck / build / lint / git chỉ-đọc). Các lệnh dưới đây SỬA tệp, SỬA kho git, XOÁ thư mục hoặc tải/mở trình duyệt —
 * không phải kiểm chứng — nhưng mã hiện tại vẫn trả về true (đi thẳng qua lớp validate; chỉ còn thẻ xin phép của người dùng,
 * và KHÔNG hỏi nếu luồng chính đã chạy đúng lệnh đó trong lượt).
 *
 * Chạy: npx vitest run test/adversarial/blind-verifier.isVerificationCommand.test.ts
 */
describe('adversarial · isVerificationCommand phải TỪ CHỐI lệnh ghi/sửa dù khớp "động từ" kiểm chứng', () => {
  it.each([
    // npm script có tên lint:*/test:*/build:* nhưng bản chất là GHI: `lint:fix` là tên rất phổ biến, ghi đè mã nguồn.
    'npm run lint:fix',
    'pnpm run lint:fix',
    'npm run test:update',
    // git branch: chỉ dạng liệt kê mới là chỉ-đọc; --delete/--move/--set-upstream-to đổi kho.
    'git branch --delete feature-x',
    'git branch --move old new',
    'git branch --set-upstream-to=origin/main',
    'git branch --unset-upstream',
    // pytest --basetemp=DIR XOÁ thư mục đó trước khi chạy (tài liệu pytest: "this directory is removed if it exists").
    'pytest --basetemp=../../important',
    'python -m pytest --basetemp=../../important',
    // playwright install/open/codegen: tải trình duyệt hàng trăm MB / mở GUI — không phải kiểm chứng.
    'npx playwright install',
    'npx playwright open https://example.com',
    'npx playwright codegen',
  ])('%s → false', (c) => {
    expect(isVerificationCommand(c)).toBe(false);
  });
});
