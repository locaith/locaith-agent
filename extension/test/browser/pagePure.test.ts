import { describe, expect, it } from 'vitest';
import { classifySensitive, clip, collapse, fold, foldMap, formatSnapshotLine, isDegenerateTransform, isTransparentColor, keyInfo, labelsDiffer, parseKeyCombo, roleOfInput, shortUrl, squeeze } from '../../src/browser/page/pure';

describe('page/pure — văn bản tiếng Việt', () => {
  it('fold bỏ dấu và hạ chữ thường', () => {
    expect(fold('Đăng Nhập Tài Khoản')).toBe('dang nhap tai khoan');
    expect(fold('ƯỚC MƠ — Ữ Ặ Ổ Ệ Ẫ Ể')).toBe('uoc mo — u a o e a e');
    // dạng tổ hợp (NFD) và dựng sẵn (NFC) cho cùng kết quả
    expect(fold('Hà Nội'.normalize('NFD'))).toBe(fold('Hà Nội'.normalize('NFC')));
  });
  it('collapse gộp khoảng trắng, NBSP, ký tự rộng 0 và xuống dòng', () => {
    expect(collapse('  Xin chào ​\n\t bạn  ')).toBe('Xin chào bạn');
  });
  it('clip không cắt đôi cặp thay thế (emoji)', () => {
    const s = 'a😀b';
    expect(clip(s, 2)).toBe('a…'); // không để lại nửa emoji
    expect(clip('ngắn', 10)).toBe('ngắn');
    expect(clip('x'.repeat(20), 5)).toBe('xxxxx…');
  });
});

describe('page/pure — URL rút gọn', () => {
  const base = 'https://shop.example.com/a/b?x=1';
  it('cùng nguồn → đường dẫn; khác nguồn → host + đường dẫn; scheme lạ → tên scheme', () => {
    expect(shortUrl('/gio-hang?id=2', base)).toBe('/gio-hang?id=2');
    expect(shortUrl('https://shop.example.com/', base)).toBe('/');
    expect(shortUrl('https://other.vn/bai-viet', base)).toBe('other.vn/bai-viet');
    expect(shortUrl('https://other.vn/', base)).toBe('other.vn');
    expect(shortUrl('javascript:alert(1)', base)).toBe('javascript');
    expect(shortUrl('mailto:a@b.vn', base)).toBe('mailto');
    expect(shortUrl('https://other.vn/' + 'x'.repeat(200), base, 40).length).toBeLessThanOrEqual(41);
  });
});

describe('page/pure — nhận diện trường nhạy cảm', () => {
  it('theo type và autocomplete', () => {
    expect(classifySensitive({ type: 'password' })).toBe('password');
    expect(classifySensitive({ type: 'text', autocomplete: 'current-password' })).toBe('password');
    expect(classifySensitive({ type: 'text', autocomplete: 'one-time-code' })).toBe('otp');
    expect(classifySensitive({ type: 'text', autocomplete: 'cc-number' })).toBe('payment');
    expect(classifySensitive({ type: 'text', autocomplete: 'section-x shipping cc-csc' })).toBe('payment');
    expect(classifySensitive({ type: 'text', autocomplete: 'email' })).toBeNull();
  });
  it('theo nhãn/tên trường tiếng Việt và tiếng Anh', () => {
    expect(classifySensitive({ type: 'text', hints: ['Mật khẩu'] })).toBe('password');
    expect(classifySensitive({ type: 'text', hints: ['Số thẻ'] })).toBe('payment');
    expect(classifySensitive({ type: 'text', hints: ['Mã xác thực OTP'] })).toBe('otp');
    expect(classifySensitive({ type: 'text', hints: ['cardNumber'] })).toBe('payment');
    expect(classifySensitive({ type: 'text', hints: ['CVV'] })).toBe('payment');
    expect(classifySensitive({ type: 'text', hints: ['Họ và tên', 'Địa chỉ email'] })).toBeNull();
  });
  it('khớp theo TỪ: không nhầm "passenger", "passport", "bypass", "pinned"… là mật khẩu (form đặt vé máy bay/tàu)', () => {
    for (const hint of ['passenger_name', 'Passenger name', 'passengerName', 'Passport number', 'bypass', 'compass', 'pinned', 'spinner', 'swiftly', 'Tên hành khách']) {
      expect(classifySensitive({ type: 'text', hints: [hint] }), hint).toBeNull();
    }
  });
  it('vẫn bắt các dạng viết khác nhau của mật khẩu / thẻ / mã xác thực (camelCase, snake_case, kebab-case)', () => {
    for (const hint of ['password', 'user_password', 'userPassword', 'pwd', 'passwd', 'confirm-password', 'Nhập mật khẩu mới']) {
      expect(classifySensitive({ type: 'text', hints: [hint] }), hint).toBe('password');
    }
    for (const hint of ['card_number', 'cardNo', 'cc-number', 'ccNumber', 'credit card number', 'cvv2', 'Security code', 'Số thẻ tín dụng', 'IBAN']) {
      expect(classifySensitive({ type: 'text', hints: [hint] }), hint).toBe('payment');
    }
    for (const hint of ['otp', 'totp_code', 'sms code', 'verification code', 'one-time password', 'Mã xác thực', 'Mã OTP']) {
      expect(classifySensitive({ type: 'text', hints: [hint] }), hint).toBe('otp');
    }
  });
});

describe('page/pure — nội dung vô hình (chống giấu lời dụ)', () => {
  it('isTransparentColor: mọi dạng màu trong suốt trình duyệt có thể trả về', () => {
    for (const c of ['transparent', 'rgba(0, 0, 0, 0)', 'rgba(255,255,255,0)', 'rgba(10, 20, 30, 0.0)', 'rgb(0 0 0 / 0)', 'rgb(0 0 0 / 0%)', 'hsla(0, 0%, 0%, 0)', 'color(srgb 1 1 1 / 0)', 'rgba(0, 0, 0, 0.02)']) {
      expect(isTransparentColor(c), c).toBe(true);
    }
    for (const c of ['rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)', 'rgba(0, 0, 0, 0.5)', 'rgb(0 0 0 / 50%)', 'red', '#fff', '', 'color(srgb 1 1 1)']) {
      expect(isTransparentColor(c), c).toBe(false);
    }
  });
  it('isDegenerateTransform: co về 0 là ẩn; xoay/lật/phóng to thì không', () => {
    expect(isDegenerateTransform('matrix(0, 0, 0, 0, 0, 0)')).toBe(true);
    expect(isDegenerateTransform('matrix(0.001, 0, 0, 0.001, 0, 0)')).toBe(true);
    expect(isDegenerateTransform('matrix(0, 1, -1, 0, 0, 0)')).toBe(false); // xoay 90°
    expect(isDegenerateTransform('matrix(-1, 0, 0, 1, 0, 0)')).toBe(false); // lật ngang
    expect(isDegenerateTransform('matrix(1.5, 0, 0, 1.5, 10, 10)')).toBe(false);
    expect(isDegenerateTransform('none')).toBe(false);
  });
  it('labelsDiffer: nhãn trợ năng lệch hẳn chữ hiển thị mới bị cảnh báo', () => {
    expect(labelsDiffer('Chuyển tiền', 'Hủy')).toBe(true);
    expect(labelsDiffer('Đăng nhập', 'dang nhap')).toBe(false); // khác dấu/hoa thường
    expect(labelsDiffer('Thêm vào giỏ', 'Thêm vào giỏ hàng')).toBe(false); // một bên chứa bên kia
    expect(labelsDiffer('', 'Hủy')).toBe(false);
  });
});

describe('page/pure — squeeze / foldMap (page_find)', () => {
  it('squeeze gộp khoảng trắng nhưng KHÔNG cắt đầu/đuôi (ghép các mảnh chữ liền nhau)', () => {
    expect(squeeze(' a \n\t b ')).toBe(' a b ');
    expect(squeeze(`Giá:${String.fromCharCode(0xa0)}100.000${String.fromCharCode(0xa0)}đ`)).toBe('Giá: 100.000 đ');
  });
  it('foldMap trả chuỗi đã bỏ dấu kèm chỉ số về chuỗi gốc để cắt đoạn trích CÓ dấu', () => {
    const s = 'Mua Đồng hồ Thuỵ Sĩ';
    const { f, idx } = foldMap(s);
    expect(f).toBe('mua dong ho thuy si');
    const at = f.indexOf('thuy si');
    expect(s.slice(idx[at], idx[at + 6] + 1)).toBe('Thuỵ Sĩ');
    // dạng tổ hợp (NFD): dấu rời bị bỏ, vị trí vẫn đúng
    const nfd = 'Việt Nam'.normalize('NFD');
    const m = foldMap(nfd);
    expect(m.f).toBe('viet nam');
    expect(nfd.slice(m.idx[0], m.idx[m.f.length - 1] + 1).normalize('NFC')).toContain('Nam');
  });
});

describe('page/pure — dòng ảnh chụp và phím', () => {
  it('định dạng dòng ảnh chụp gọn, đủ trạng thái', () => {
    expect(formatSnapshotLine({ ref: 12, role: 'button', name: 'Đặt hàng', states: ['disabled'] })).toBe('[12] button "Đặt hàng" (disabled)');
    expect(formatSnapshotLine({ ref: 3, role: 'link', name: 'Trang chủ', href: '/', off: 'below' })).toBe('[3] link "Trang chủ" → / ↓');
    expect(formatSnapshotLine({ ref: 5, role: 'textbox', name: 'Họ tên', value: 'Nguyễn "Văn" A', note: 'type=text' })).toBe(
      `[5] textbox "Họ tên" value="Nguyễn 'Văn' A" (type=text)`,
    );
  });
  it('roleOfInput', () => {
    expect(roleOfInput('checkbox')).toBe('checkbox');
    expect(roleOfInput('SUBMIT')).toBe('button');
    expect(roleOfInput('email')).toBe('textbox');
    expect(roleOfInput('file')).toBe('file-upload');
  });
  it('keyInfo và parseKeyCombo', () => {
    expect(keyInfo('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(keyInfo('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65 });
    expect(keyInfo('5')).toEqual({ key: '5', code: 'Digit5', keyCode: 53 });
    expect(keyInfo('F5').keyCode).toBe(116);
    expect(keyInfo('Esc').key).toBe('Escape');
    expect(parseKeyCombo('Control+Shift+a')).toEqual({ key: 'a', ctrl: true, shift: true, alt: false, meta: false });
    expect(parseKeyCombo('Enter')).toEqual({ key: 'Enter', ctrl: false, shift: false, alt: false, meta: false });
  });
});
