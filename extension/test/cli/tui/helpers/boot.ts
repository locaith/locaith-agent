import * as fs from 'node:fs';
import { MockRuntime, type MockOptions } from '../../../../src/cli/tui/mockRuntime';
import { TuiApp, type TuiOptions } from '../../../../src/cli/tui/app';
import { FakeIn, VT, sleep } from './vt';

export const KEY = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  tab: '\t',
  shiftTab: '\x1b[Z',
  ctrl: (c: string): string => String.fromCharCode(c.toLowerCase().charCodeAt(0) - 96),
  paste: (s: string): string => `\x1b[200~${s}\x1b[201~`,
  altEnter: '\x1b\r',
};

export interface Booted {
  vt: VT;
  inp: FakeIn;
  rt: MockRuntime;
  app: TuiApp;
  done: Promise<number>;
  /** Gõ rồi chờ vẽ xong. */
  type(s: string, wait?: number): Promise<void>;
  /** Chờ tới khi điều kiện đúng (tối đa ms). */
  until(cond: () => boolean, ms?: number): Promise<void>;
  tick(ms?: number): Promise<void>;
  screenText(): string;
  dump(name: string): void;
}

export async function boot(o: { cols?: number; rows?: number; mock?: MockOptions; app?: Partial<TuiOptions>; env?: NodeJS.ProcessEnv } = {}): Promise<Booted> {
  const vt = new VT(o.cols ?? 80, o.rows ?? 30);
  const inp = new FakeIn();
  const rt = new MockRuntime({ speed: 0, ...o.mock });
  const app = new TuiApp(rt, {
    version: '0.4.0',
    lang: 'vi',
    stdin: inp as unknown as NodeJS.ReadStream,
    stdout: vt as unknown as NodeJS.WriteStream,
    historyFile: null,
    env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', ...o.env },
    cwd: 'C:\\Dev\\demo-app',
    ...o.app,
  });
  const done = app.run();
  const tick = async (ms = 70): Promise<void> => {
    await sleep(ms);
    await vt.settle();
  };
  await tick();
  return {
    vt,
    inp,
    rt,
    app,
    done,
    tick,
    async type(s, wait = 70) {
      inp.type(s);
      await tick(wait);
    },
    async until(cond, ms = 4000) {
      const t0 = Date.now();
      while (!cond() && Date.now() - t0 < ms) await tick(30);
      if (!cond()) throw new Error('until: hết giờ\n' + vt.all().join('\n'));
    },
    screenText: () => vt.all().join('\n'),
    dump(name: string) {
      const dir = process.env.LOCAITH_TUI_DUMP;
      if (dir) fs.writeFileSync(`${dir}/${name}.txt`, vt.all().join('\n'));
    },
  };
}
