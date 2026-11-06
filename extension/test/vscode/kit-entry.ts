/**
 * Bộ công cụ cho bài kiểm thử trong VS Code thật (suite.cjs là CommonJS thuần, không import được TypeScript): `_work/run-insiders.mjs` đóng gói tệp này
 * bằng esbuild thành `_work/out/test-kit.cjs`. Cho phép bài kiểm thử đóng vai TRÌNH DUYỆT: ghép đôi và nối phiên mã hoá đầu-cuối với RelayHost thật.
 */
import WebSocket from 'ws';

export { RealtimeLink } from '../../src/core/remote/phoenix';
export { ACCOUNT_DEV, b64u, deriveAccountKey, parsePairingLink, unb64u } from '../../src/core/remote/e2e';
export { CommandError, PairError, RelayClient, pairWithHost } from '../../src/core/remote/relayClient';
export { WebSocket };
