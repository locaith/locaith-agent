/* TỆP SINH TỰ ĐỘNG bởi scripts/cli-gen-logo.mjs từ webview/src/brand/lo.ts — đừng sửa tay. */

/** Logo «Lo» bằng khối nửa ô (26 cột × 12 hàng). Gradient dọc #22bcec → #625aec được tô lúc vẽ. */
export const LOGO_WIDTH = 26;
export const LOGO_ROWS: readonly string[] = [
  "     ▄████▄",
  "    ███▀▀███",
  "   ███▀  ███",
  "   ███  ▄██",
  "  ███▀  ███     ▄▄██▄▄▄",
  "  ███  ███    ██████████▄",
  " ███▀  ███   ███▀     ▀██▄",
  "▄███  ███▄ ▄▄███       ███",
  "███   ██████████▄     ▄██▀",
  "███▄     ▀▀▀▀▀▀█████████▀",
  " ████▄▄▄▄▄▄▄▄▄▄▄███████▀",
  "  ▀▀███████████████▀▀"
];

/** Bản nhỏ (18 cột × 8 hàng) cho terminal hẹp/thấp. */
export const LOGO_SMALL_WIDTH = 18;
export const LOGO_SMALL_ROWS: readonly string[] = [
  "   ▄███▄",
  "  ▄█▀ ██",
  "  ██  ██",
  " ██▀ ██   ▄█████▄",
  " ██ ▄██  ██    ▀██",
  "██▀ ███████    ▄██",
  "██▄       ▀█████▀",
  " ▀████████████▀"
];

/** Bản ASCII dự phòng (terminal không UTF-8 / LOCAITH_ASCII=1). */
export const LOGO_ASCII: readonly string[] = [
  "     ######",
  "    ########",
  "   ####  ###",
  "   ###  ###",
  "  ####  ###     #######",
  "  ###  ###    ###########",
  " ####  ###   ####     ####",
  "####  #### #####       ###",
  "###   ###########     ####",
  "####     ################",
  " #######################",
  "  ###################"
];
export const LOGO_SMALL_ASCII: readonly string[] = [
  "   #####",
  "  ### ##",
  "  ##  ##",
  " ### ##   #######",
  " ## ###  ##    ###",
  "### #######    ###",
  "###       #######",
  " ##############"
];
