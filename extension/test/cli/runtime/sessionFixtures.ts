/** Phiên giả (định dạng CLI 0.3.x — được chuyển lên định dạng mới ở lần liệt kê đầu) để thử «mở lại phiên». */
import * as fs from 'node:fs';
import * as path from 'node:path';

const H = 3_600_000;
const D = 24 * H;

export interface FixtureSession {
  id: string;
  title: string;
  ageMs: number;
  /** Thuộc thư mục làm việc của phiên chạy thử (true) hay một thư mục khác (false). */
  here: boolean;
  q: string;
  a: string;
}

/**
 * Mới nhất trước. Hai phiên đầu CHUNG đầu mã `cli_mw7y` — giống thật: mã là `cli_<giờ><ngẫu nhiên>` nên các phiên tạo gần nhau chung 8 ký tự đầu.
 * Hai phiên có «lỗi» và hai phiên có «build» trong tiêu đề để thử tìm theo từ khoá mơ hồ.
 */
export const FIXTURE: FixtureSession[] = [
  { id: 'cli_mw7yd9w31u', title: 'Sửa lỗi đăng nhập trang quản trị', ageMs: 2 * H, here: true, q: 'Trang quản trị không đăng nhập được', a: 'Token hết hạn không được làm mới; đã vá hàm refresh.' },
  { id: 'cli_mw7yb2k4zz', title: 'Sửa lỗi build trên CI', ageMs: 5 * H, here: true, q: 'CI build đỏ', a: 'Thiếu biến môi trường NODE_ENV trong workflow.' },
  { id: 'cli_mw7xk2p8qa', title: 'Viết test cho module thanh toán', ageMs: 1 * D, here: true, q: 'Viết test cho module thanh toán', a: 'Đã thêm 12 test cho payment.ts.' },
  { id: 'cli_mw6zt4h1bc', title: 'Khảo sát vì sao build chậm', ageMs: 3 * D, here: true, q: 'Vì sao build chậm?', a: 'esbuild chạy tuần tự vì plugin đồng bộ.' },
  { id: 'cli_mw4ww1n7ee', title: 'Thiết kế logo cho Locaith', ageMs: 12 * D, here: false, q: 'Gợi ý logo', a: 'Ba hướng: chữ Lo, vòng tròn, con trỏ nhấp nháy.' },
];

/** Ghi các phiên vào `<home>/.locaith/sessions`; phiên «here» thuộc `cwd`, còn lại thuộc `other`. */
export function writeFixtureSessions(home: string, cwd: string, other: string, now = Date.now()): void {
  const dir = path.join(home, '.locaith', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of FIXTURE) {
    const legacy = {
      id: s.id,
      title: s.title,
      model: 'locaith-v5-flash',
      cwd: s.here ? cwd : other,
      updatedAt: now - s.ageMs,
      messages: [
        { role: 'user', content: [{ type: 'text', text: s.q }] },
        { role: 'assistant', content: [{ type: 'text', text: s.a }] },
      ],
    };
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(legacy));
  }
}
