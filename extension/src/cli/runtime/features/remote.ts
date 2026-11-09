/**
 * Mô-đun «Remote» — điều khiển phiên CLI này từ trang locaith.ai (điện thoại / máy khác), như extension VS Code. Lõi nằm ở `cli/remote/remote.ts` (dùng chung RelayHost,
 * RemoteServer, mã hoá đầu-cuối của extension); mô-đun này chỉ là CÁI NỐI với runtime: lệnh `/remote`, tự bật khi khởi động nếu người dùng đã bật ở thư mục này, trạng thái ở dải dưới,
 * và dọn khi thoát.
 *
 *   /remote            bật (nếu chưa) và mở trang locaith.ai — vào bằng TÀI KHOẢN, không ghép đôi
 *   /remote status     đang bật không, đường truyền, có bao nhiêu trình duyệt đang mở
 *   /remote off        tắt = THU HỒI (xoá khoá tài khoản, gỡ máy khỏi danh bạ) — gõ được ngay tại terminal
 *   /remote url        in địa chỉ để mở tay (máy không có trình duyệt, SSH)
 *   /remote pair       cửa sổ ghép đôi 5 phút cho thiết bị KHÔNG đăng nhập tài khoản này (liên kết một lần + mã xác nhận)
 *   /remote key        «Đổi khoá tài khoản»: ngắt mọi trình duyệt đang vào bằng tài khoản
 *
 * Mặc định TẮT. Bật lần đầu phải xác nhận (nói rõ rủi ro). Đã bật ở thư mục nào thì lần sau mở CLI ở thư mục đó tự bật lại (cài đặt `remote.autoStart`, mặc định BẬT khi đã từng bật;
 * `/remote off` xoá luôn ghi nhớ). Lệnh này KHÔNG có trong danh sách lệnh chạy được từ xa (xem remote/commands.ts) nên trình duyệt không tự tắt/đổi được Remote.
 */

import type { PairRequest } from '../../../core/remote/relayHost';
import { CliRemote, type CliRemoteView } from '../../remote/remote';
import { RemoteFileStore } from '../../remote/store';
import type { CliRuntime, FeatureContext, FeatureModule, RuntimeStatus, SlashRunContext } from '../contract';
import { makeTr } from './ext';

const tr = makeTr('remote', {
  desc: ['Điều khiển phiên này từ locaith.ai (điện thoại / máy khác) — /remote status|off|url|pair|key', 'Control this session from locaith.ai (phone / another computer) — /remote status|off|url|pair|key'],
  confirm: [
    'Bật điều khiển từ xa? Trình duyệt đăng nhập ĐÚNG tài khoản Locaith của bạn (và thiết bị đã ghép đôi) làm được mọi việc trợ lý làm được trên máy này (đọc/sửa tệp, chạy lệnh theo chế độ quyền đang bật). Hãy bảo vệ tài khoản bằng mật khẩu mạnh. Đường Internet được mã hoá đầu-cuối. Tắt bất cứ lúc nào bằng /remote off.',
    'Turn on remote control? A browser signed in to YOUR Locaith account (and any paired device) can do anything the assistant can do on this machine (read/edit files, run commands according to the permission mode in use). Protect the account with a strong password. The Internet path is end-to-end encrypted. Turn it off any time with /remote off.',
  ],
  yes: ['Bật Remote', 'Turn on Remote'],
  no: ['Không bật', 'Do not turn on'],
  declined: ['Chưa bật Remote.', 'Remote stays off.'],
  starting: ['Đang bật Remote…', 'Turning Remote on…'],
  opening: ['Đang mở locaith.ai…', 'Opening locaith.ai…'],
  openedAccount: [
    'Đã mở **locaith.ai** — trang tự vào máy này bằng tài khoản Locaith bạn đang đăng nhập (không cần mã/ghép đôi). Nếu trang hỏi đăng nhập, hãy dùng ĐÚNG tài khoản này.',
    'Opened **locaith.ai** — the page signs in to this machine with the Locaith account you are using (no code, no pairing). If it asks you to sign in, use THIS account.',
  ],
  openedPairing: [
    'Danh bạ locaith.ai chưa giữ khoá của máy này, nên dùng liên kết ghép đôi (dùng một lần, hết hạn sau 5 phút). Khi trình duyệt mở, đối chiếu mã xác nhận rồi bấm «Cho phép» ở đây.',
    'The locaith.ai machine list does not hold this machine’s key yet, so a pairing link is used (single use, expires in 5 minutes). When the browser opens, compare the confirmation code and click “Allow” here.',
  ],
  manual: ['Không mở được trình duyệt tự động. Mở địa chỉ này bằng tay:', 'Could not open the browser automatically. Open this address yourself:'],
  stateOn: ['Remote: **đang bật**', 'Remote: **on**'],
  stateOff: ['Remote: **tắt** — gõ `/remote` để bật.', 'Remote: **off** — type `/remote` to turn it on.'],
  linkOnline: ['đã nối locaith.ai (mã hoá đầu-cuối)', 'connected to locaith.ai (end-to-end encrypted)'],
  linkConnecting: ['đang nối locaith.ai…', 'connecting to locaith.ai…'],
  linkQueued: ['relay đang quá tải, đang xếp hàng (tự thử lại)', 'the relay is overloaded, queued (retries automatically)'],
  sessions: ['{n} trình duyệt đang mở', '{n} browser(s) open'],
  keyedYes: ['Vào bằng tài khoản: **sẵn sàng** (mở locaith.ai và chọn máy này).', 'Sign-in by account: **ready** (open locaith.ai and pick this machine).'],
  keyedNo: ['Vào bằng tài khoản: **chưa sẵn sàng** (danh bạ chưa giữ khoá) — dùng `/remote pair`.', 'Sign-in by account: **not ready** (the machine list does not hold the key yet) — use `/remote pair`.'],
  machine: ['Máy: **{name}**', 'Machine: **{name}**'],
  tips: ['Ngắt ngay: `/remote off` · ngắt mọi trình duyệt đang vào: `/remote key` · địa chỉ để mở tay: `/remote url`', 'Cut it now: `/remote off` · cut every browser that is in: `/remote key` · address to open by hand: `/remote url`'],
  off: ['Đã tắt Remote: ngắt mọi trình duyệt, gỡ máy khỏi danh bạ locaith.ai và xoá khoá tài khoản (lần bật sau dùng khoá MỚI).', 'Remote is off: every browser was cut, the machine was removed from the locaith.ai list and the account key was deleted (the next time uses a NEW key).'],
  alreadyOff: ['Remote đang tắt.', 'Remote is already off.'],
  notOn: ['Remote chưa bật — gõ `/remote` trước.', 'Remote is not on — type `/remote` first.'],
  urlAccount: ['Địa chỉ vào bằng tài khoản (không chứa bí mật):', 'Sign-in-by-account address (contains no secret):'],
  urlPairing: ['Liên kết ghép đôi — **dùng một lần, hết hạn sau 5 phút, bí mật nằm sau dấu #** (không gửi tới máy chủ web). Chỉ mở bằng thiết bị của chính bạn:', 'Pairing link — **single use, expires in 5 minutes, the secret is after the #** (never sent to the web server). Open it only on your own device:'],
  pairTitle: ['Cho phép thiết bị «{label}» điều khiển phiên CLI này?', 'Allow device “{label}” to control this CLI session?'],
  pairDetail: [
    'Mã xác nhận: {sas}\n\nMã này phải GIỐNG HỆT mã đang hiện trên trình duyệt. Chỉ cho phép nếu chính bạn vừa mở liên kết ghép đôi. Thiết bị được ghép làm được mọi việc trợ lý làm được trên máy này. Thu hồi bằng /remote off.',
    'Confirmation code: {sas}\n\nThis code must be IDENTICAL to the one in the browser. Only allow it if you just opened the pairing link yourself. A paired device can do anything the assistant can do on this machine. Revoke with /remote off.',
  ],
  pairYes: ['Cho phép', 'Allow'],
  pairNo: ['Từ chối', 'Deny'],
  pairHow: ['Đã mở cửa sổ ghép đôi 5 phút. Mở liên kết ở trên trên thiết bị cần ghép; khi nó hiện mã xác nhận, hộp «Cho phép» sẽ hiện ở đây.', 'The 5-minute pairing window is open. Open the link above on the device you want to pair; when it shows a confirmation code, an “Allow” box appears here.'],
  keyConfirm: ['Đổi khoá tài khoản? Mọi trình duyệt đang vào bằng tài khoản bị ngắt ngay; trang nào còn đăng nhập đúng tài khoản sẽ tự lấy khoá mới và vào lại. Muốn chặn hẳn thì /remote off.', 'Change the account key? Every browser that is in through the account is cut immediately; a page still signed in to the account fetches the new key and comes back. To block access completely use /remote off.'],
  keyDone: ['Đã đổi khoá tài khoản.', 'Account key changed.'],
  keyFail: ['Không đổi được khoá (không báo được danh bạ locaith.ai). Khoá cũ vẫn còn hiệu lực — thử lại khi có mạng.', 'Could not change the key (the locaith.ai machine list could not be reached). The old key still works — try again when you are online.'],
  noTty: ['Lệnh này cần giao diện tương tác (có hộp xác nhận). Mở `locaith` rồi gõ `/remote`.', 'This command needs the interactive screen (it asks for confirmation). Open `locaith` and type `/remote`.'],
  unknown: ['Không có «/remote {arg}». Dùng: /remote · status · off · url · pair · key', 'No “/remote {arg}”. Use: /remote · status · off · url · pair · key'],
  noAccount: ['Remote cần tài khoản Locaith: {why}', 'Remote needs a Locaith account: {why}'],
  failed: ['Không bật được Remote: {why}', 'Could not turn Remote on: {why}'],
  autoOn: ['Remote tự bật lại ở thư mục này (đã bật lần trước). Tắt hẳn: /remote off.', 'Remote turned itself back on in this folder (you turned it on last time). Turn it off for good: /remote off.'],
  autoFail: ['Remote đã bật ở thư mục này nhưng lần này chưa nối được: {why}', 'Remote is enabled in this folder but could not connect this time: {why}'],
});

/** Gom thông tin cho dải trạng thái (RuntimeStatus.remote) từ view của CliRemote. */
export function statusRemote(v: CliRemoteView): RuntimeStatus['remote'] | undefined {
  if (!v.on || v.link === 'off') return undefined;
  return { link: v.link, sessions: v.sessions };
}

export interface RemoteFeatureOptions {
  /** Kiểm thử: thay hộp xác nhận ghép đôi / mở trình duyệt / lõi. Ngoài kiểm thử không dùng. */
  createRemote?: (ctx: FeatureContext, rt: CliRuntime, hooks: { approve: (r: PairRequest) => Promise<boolean>; openUrl: (u: string) => Promise<boolean>; notify: (l: 'info' | 'warn', t: string) => void; onChange: () => void }) => CliRemote;
}

export function makeRemoteFeature(opts: RemoteFeatureOptions = {}): FeatureModule {
  return {
    name: 'remote',
    attach(ctx) {
      const rt = ctx.runtime?.();
      if (!rt) return; // lõi không cung cấp runtime (kiểm thử đặc biệt): không có Remote
      const store = new RemoteFileStore(ctx.home);
      let remote: CliRemote | undefined;
      let ref: { refresh(): void } | undefined;

      // Hộp xác nhận ghép đôi: CHẶN có chủ đích — đây là cổng duy nhất để một thiết bị mới có quyền điều khiển máy. Không có giao diện tương tác → luôn từ chối.
      const approve = async (r: PairRequest): Promise<boolean> => {
        if (!ctx.interactive) return false;
        const ans = await ctx.ask({
          kind: 'confirm',
          title: tr(ctx.lang, 'pairTitle', { label: r.label }),
          detail: tr(ctx.lang, 'pairDetail', { sas: r.sas }),
          yes: tr(ctx.lang, 'pairYes'),
          no: tr(ctx.lang, 'pairNo'),
          defaultYes: false,
          danger: true,
        } as never);
        return ans === true;
      };
      const openUrl = async (u: string): Promise<boolean> => {
        if (!ctx.interactive) return false;
        ctx.emit({ t: 'action', action: 'open_url', payload: u });
        return true;
      };
      const hooks = {
        approve,
        openUrl,
        notify: (level: 'info' | 'warn', text: string) => ctx.toast(level, text),
        onChange: () => ref?.refresh(),
      };
      const make = (): CliRemote =>
        opts.createRemote?.(ctx, rt, hooks) ??
        new CliRemote({
          rt,
          home: ctx.home,
          cwd: ctx.cwd,
          version: ctx.version,
          lang: () => ctx.lang,
          env: process.env,
          token: () => ctx.accountToken?.(),
          log: (l, m) => ctx.log(l, m),
          approve,
          openUrl,
          allowBypass: () => ctx.settings.get<boolean>('remote.allowBypass', false) === true,
          notify: hooks.notify,
          onChange: hooks.onChange,
        });
      const get = (): CliRemote => (remote ??= make());

      // Dải trạng thái: «● Remote · N» khi đang bật.
      ref = ctx.addStatusContributor((s) => {
        if (!remote) return;
        const r = statusRemote(remote.view());
        if (r) s.remote = r;
      });

      const intro = (c: SlashRunContext | undefined, text: string, kind: 'markdown' | 'plain' | 'error' = 'markdown'): void => (c ? c.output(text, kind) : ctx.output(text, kind));

      /** Hỏi xác nhận trước khi bật lần đầu (nói rõ rủi ro). Trả true nếu được phép bật. */
      const confirmEnable = async (c: SlashRunContext): Promise<boolean> => {
        if (store.isEnabled(ctx.cwd)) return true; // đã từng đồng ý ở thư mục này
        const ans = await c.ask({ kind: 'confirm', title: tr(c.lang, 'confirm'), yes: tr(c.lang, 'yes'), no: tr(c.lang, 'no'), defaultYes: false, danger: true } as never);
        return ans === true;
      };

      const statusText = (c: SlashRunContext): string => {
        const v = remote?.view();
        if (!v || !v.on) return tr(c.lang, 'stateOff');
        const lines = [tr(c.lang, 'stateOn'), `- ${tr(c.lang, v.link === 'online' ? 'linkOnline' : v.link === 'queued' ? 'linkQueued' : 'linkConnecting')}`, `- ${tr(c.lang, 'sessions', { n: v.sessions })}`, `- ${tr(c.lang, v.keyed ? 'keyedYes' : 'keyedNo')}`, '', tr(c.lang, 'tips')];
        return lines.join('\n');
      };

      const turnOn = async (c: SlashRunContext, openPage: boolean): Promise<void> => {
        if (!ctx.interactive) return c.output(tr(c.lang, 'noTty'), 'error');
        const r = get();
        if (!r.isOn) {
          if (!(await confirmEnable(c))) return c.output(tr(c.lang, 'declined'), 'plain');
          c.toast('info', tr(c.lang, 'starting'));
          const res = await r.start();
          if (!res.ok) {
            const why = r.view().problem ?? res.detail ?? '';
            return c.output(tr(c.lang, res.reason === 'no_account' || !!r.view().problem ? 'noAccount' : 'failed', { why }), 'error');
          }
          store.setEnabled(ctx.cwd, true); // nhớ: lần sau mở CLI ở thư mục này tự bật lại
          ref?.refresh();
        }
        if (!openPage) return c.output(statusText(c), 'markdown');
        c.toast('info', tr(c.lang, 'opening'));
        const w = await r.openWeb();
        if (!w.ok) return c.output(tr(c.lang, 'notOn'), 'error');
        const lines = [tr(c.lang, w.mode === 'account' ? 'openedAccount' : 'openedPairing')];
        if (!w.opened && w.url) lines.push('', tr(c.lang, 'manual'), '', w.url);
        lines.push('', statusText(c));
        c.output(lines.join('\n'), 'markdown');
      };

      ctx.slash({
        name: 'remote',
        description: { vi: tr('vi', 'desc'), en: tr('en', 'desc') },
        argHint: '[status|off|url|pair|key]',
        needsIdle: false,
        async run(c) {
          const arg = c.args.trim().toLowerCase();
          switch (arg) {
            case '':
            case 'on':
            case 'open':
              return turnOn(c, true);
            case 'status':
              return c.output(statusText(c), 'markdown');
            case 'off':
            case 'stop': {
              store.setEnabled(ctx.cwd, false);
              if (!remote?.isOn) return c.output(tr(c.lang, 'alreadyOff'), 'plain');
              await remote.stop();
              ref?.refresh();
              return c.output(tr(c.lang, 'off'), 'plain');
            }
            case 'url': {
              if (!remote?.isOn) return c.output(tr(c.lang, 'notOn'), 'error');
              const w = await remote.webUrl();
              if (!w) return c.output(tr(c.lang, 'notOn'), 'error');
              return c.output([tr(c.lang, w.mode === 'account' ? 'urlAccount' : 'urlPairing'), '', w.url].join('\n'), 'markdown');
            }
            case 'pair': {
              if (!remote?.isOn) return c.output(tr(c.lang, 'notOn'), 'error');
              const p = remote.startPairing();
              if (!p) return c.output(tr(c.lang, 'notOn'), 'error');
              return c.output([tr(c.lang, 'urlPairing'), '', p.url, '', tr(c.lang, 'pairHow')].join('\n'), 'markdown');
            }
            case 'key': {
              if (!remote?.isOn) return c.output(tr(c.lang, 'notOn'), 'error');
              if (!ctx.interactive) return c.output(tr(c.lang, 'noTty'), 'error');
              const ok = await c.ask({ kind: 'confirm', title: tr(c.lang, 'keyConfirm'), defaultYes: false, danger: true } as never);
              if (ok !== true) return;
              const rotated = await remote.rotateKey();
              return c.output(tr(c.lang, rotated ? 'keyDone' : 'keyFail'), rotated ? 'plain' : 'error');
            }
            default:
              return c.output(tr(c.lang, 'unknown', { arg }), 'error');
          }
        },
      });

      // Tự bật lại nếu người dùng đã bật Remote ở thư mục này lần trước (và cài đặt cho phép). Chạy NỀN: không chặn khởi động; lỗi chỉ báo một dòng.
      const auto = ctx.interactive && ctx.settings.get<boolean>('remote.autoStart', true) !== false && store.isEnabled(ctx.cwd) && !!ctx.accountToken?.();
      if (auto) {
        const t = setTimeout(() => {
          const r = get();
          void r.start().then((res) => {
            ref?.refresh();
            if (res.ok) ctx.toast('info', tr(ctx.lang, 'autoOn'));
            else ctx.toast('warn', tr(ctx.lang, 'autoFail', { why: r.view().problem ?? res.detail ?? '' }));
          });
        }, 0);
        t.unref?.();
      }

      // Thoát CLI: ngắt đường truyền, GIỮ khoá (mở lại cùng thư mục là nối tiếp).
      return async () => {
        await remote?.dispose();
      };
    },
  };
}

export const remoteFeature: FeatureModule = makeRemoteFeature();
