// @vitest-environment node
// TEMPORARY: finds out which setting makes sharp crash inside Electron's utility process on CI.
import { _electron as electron } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

const desktopDir = join(repoRoot, 'apps', 'desktop');
const nef = fixtureNefs()[0];

const diag = (...parts: unknown[]): void => void process.stderr.write(parts.join(' ') + '\n');

const VARIANTS: Record<string, Record<string, string>> = {
  default: {},
  novector: { VIPS_NOVECTOR: '1' },
  nosimd: { EE_SHARP_SIMD: '0' },
  concurrency1: { EE_SHARP_CONCURRENCY: '1' },
  nocache: { EE_SHARP_CACHE: '0' },
  deepbind: { EE_SHARP_DEEPBIND: '1' },
  nosandbox: { ELECTRON_DISABLE_SANDBOX: '1' },
  logging: { ELECTRON_ENABLE_LOGGING: '1' },
};

describe.skipIf(!nef || process.platform !== 'linux')('sharp inside Electron (diagnostic)', () => {
  it('reports which variants survive an ingest', async () => {
    const flags = readFileSync('/proc/cpuinfo', 'utf8').match(/^flags.*$/m)?.[0] ?? '';
    diag(
      'DIAG cpu:',
      cpus()[0]?.model,
      'cores',
      cpus().length,
      'avx2',
      /\bavx2\b/.test(flags),
      'avx512f',
      /\bavx512f\b/.test(flags),
      'glibc',
      spawnSync('ldd', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0],
    );
    let xvfb: ChildProcess | undefined;
    const env: Record<string, string> = {};
    if (!process.env.DISPLAY) {
      let n = 200 + (process.pid % 50);
      while (existsSync(`/tmp/.X11-unix/X${n}`)) n += 1;
      xvfb = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
        stdio: 'ignore',
      });
      for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${n}`); i++)
        await new Promise((r) => setTimeout(r, 50));
      env.DISPLAY = `:${n}`;
    }
    const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
    for (const [name, extra] of Object.entries(VARIANTS)) {
      const root = mkdtempSync(join(tmpdir(), 'ee-diag-'));
      const card = join(root, 'card');
      mkdirSync(card);
      copyInto(nef!, join(card, 'DSC_0001.NEF'));
      const trace = join(root, 'trace.log');
      let result: string;
      let stderr = '';
      try {
        const app = await electron.launch({
          executablePath: electronPath,
          args: [desktopDir],
          env: {
            ...(process.env as Record<string, string>),
            ...env,
            ...extra,
            EE_MOCK: '',
            EE_USER_DATA_DIR: join(root, 'ud'),
            EE_JOBS_TRACE: trace,
          },
        });
        app.process().stderr?.on('data', (d) => (stderr += String(d)));
        const window = await app.firstWindow();
        await window.waitForFunction(() => 'eeTransport' in window);
        const call = (channel: string, args: unknown[]) =>
          window.evaluate(
            ([c, a]) =>
              (
                window as never as {
                  eeTransport: {
                    invoke(
                      c: string,
                      a: unknown[],
                    ): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
                  };
                }
              ).eeTransport.invoke(c as string, a as unknown[]),
            [channel, args] as const,
          );
        await call('ingest:start', [
          {
            config: {
              sources: [{ id: 'card', name: 'card', kind: 'folder', path: card }],
              destination: { path: join(root, 'ingest') },
              renameTemplate: '{seq:3}',
              codeReplacementPaths: [],
            },
          },
        ]);
        result = 'timeout';
        for (let i = 0; i < 100; i++) {
          const r = await call('photos:list', []);
          if (!r.ok) {
            result = `crashed: ${r.error?.message}`;
            break;
          }
          if ((r.value as unknown[]).length > 0) {
            result = 'ok';
            break;
          }
          await new Promise((res) => setTimeout(res, 200));
        }
        await app.close().catch(() => undefined);
      } catch (error) {
        result = `error: ${(error as Error).message.slice(0, 200)}`;
      }
      const lines = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [];
      diag(`DIAG ${name}: ${result}; last trace: ${lines.slice(-2).join(' | ')}`);
      if (name === 'logging' && stderr) diag(`DIAG stderr tail:\n${stderr.slice(-1500)}`);
      rmSync(root, { recursive: true, force: true });
    }
    xvfb?.kill();
  }, 300_000);
});
