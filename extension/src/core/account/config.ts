/**
 * Địa chỉ dịch vụ tài khoản locaith.ai. Khoá `anon` của Supabase là khoá CÔNG KHAI (đã nằm trong mã trang web); mọi bí mật thật
 * (mã uỷ quyền, token thiết bị) nằm trong tham số từng yêu cầu và chỉ có giá trị khi khớp với băm lưu ở máy chủ.
 * Không import `vscode`.
 */

export interface AccountConfig {
  /** Gốc Supabase (REST: `${supabaseUrl}/rest/v1/rpc/<hàm>`, Realtime: `wss://…/realtime/v1/websocket`). */
  supabaseUrl: string;
  anonKey: string;
  /** Trang locaith.ai nơi người dùng đăng nhập và bấm «Cho phép». */
  webUrl: string;
}

export const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
  supabaseUrl: 'https://rhxgyhkvtyojzbrtliqn.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeGd5aGt2dHlvanpicnRsaXFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5NTc2NzEsImV4cCI6MjA3NzUzMzY3MX0.-iCANZtQFZOk5NdE0lxyQ_RbP1U6umue6Y-jFIytEwg',
  webUrl: 'https://locaith.ai',
};

/**
 * Cấu hình hiệu lực. Chỉ khi chạy kiểm thử (ND_AGENT_TEST=1) mới cho đổi địa chỉ bằng biến môi trường — người dùng thường không có đường nào
 * trỏ extension sang một "máy chủ tài khoản" khác (nếu có thì kẻ xấu chỉ cần một biến môi trường/cài đặt để hứng token).
 */
export function resolveAccountConfig(env: Record<string, string | undefined> = process.env): AccountConfig {
  if (env.ND_AGENT_TEST !== '1') return DEFAULT_ACCOUNT_CONFIG;
  return {
    supabaseUrl: (env.LOCAITH_TEST_SUPABASE_URL ?? DEFAULT_ACCOUNT_CONFIG.supabaseUrl).replace(/\/+$/, ''),
    anonKey: env.LOCAITH_TEST_ANON_KEY ?? DEFAULT_ACCOUNT_CONFIG.anonKey,
    webUrl: (env.LOCAITH_TEST_WEB_URL ?? DEFAULT_ACCOUNT_CONFIG.webUrl).replace(/\/+$/, ''),
  };
}
