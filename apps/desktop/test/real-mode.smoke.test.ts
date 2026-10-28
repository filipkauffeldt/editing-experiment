// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  asSourceId,
  type IngestConfig,
  type IpcResult,
  type Photo,
} from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * Starts the built app in real (non-mock) mode against a throwaway userData
 * directory and talks to it through the same transport the renderer uses.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nef = fixtureNefs()[0];
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

/** Electron needs a display even when nothing is shown; start Xvfb on a free one if there is none. */
async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 90 + (process.pid % 100);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const child: ChildProcess = spawn(
    'Xvfb',
    [`:${number}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    {
      stdio: 'ignore',
    },
  );
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { env: { DISPLAY: `:${number}` }, stop: () => void child.kill() };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!nef || !haveDisplay)('real mode smoke test (Electron)', () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let jobsPid = 0;
  let photo: Photo;

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const result = await window.evaluate(
      ([name, params]) =>
        (
          window as unknown as {
            eeTransport: { invoke(c: string, a: unknown[]): Promise<unknown> };
          }
        ).eeTransport.invoke(name as string, params as unknown[]),
      [channel, args] as const,
    );
    const typed = result as IpcResult<T>;
    if (!typed.ok) throw new Error(`${channel}: ${typed.error.code}: ${typed.error.message}`);
    return typed.value;
  };

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-smoke-'));
    const card = join(root, 'card');
    mkdirSync(card);
    copyInto(nef!, join(card, 'DSC_0001.NEF'));

    display = await ensureDisplay();
    const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        ...display.env,
        EE_MOCK: '',
        EE_USER_DATA_DIR: join(root, 'userdata'),
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);
    // Collect pushed events so tests can look at what the renderer would have seen.
    await window.evaluate(() => {
      const w = window as unknown as {
        __events: unknown[];
        eeTransport: { subscribe(c: string, l: (p: unknown) => void): void };
      };
      w.__events = [];
      w.eeTransport.subscribe('jobs:event', (event) => w.__events.push(event));
    });

    const config: IngestConfig = {
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
      destination: { path: join(root, 'ingest') },
      renameTemplate: '{sourceName}_{seq:3}',
      codeReplacementPaths: [],
    };
    await invoke('ingest:start', { config });
    for (let i = 0; i < 300; i++) {
      const photos = await invoke<Photo[]>('photos:list');
      if (photos[0]) {
        photo = photos[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!photo) throw new Error('no photo was ingested');
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('runs the real backend with the jobs utility process alive', async () => {
    const info = await invoke<{ mock: boolean; coreVersion: string }>('system:info');
    expect(info.mock).toBe(false);
    expect(info.coreVersion).toMatch(/^\d+\.\d+/);
    const ping = await invoke<{ echo: string; jobsPid: number }>('system:ping', {
      message: 'smoke',
    });
    expect(ping.echo).toBe('smoke');
    jobsPid = ping.jobsPid;
    expect(jobsPid).not.toBe(process.pid);
    expect(alive(jobsPid)).toBe(true);
    expect(photo.fileName).toBe('card_001.NEF');
  });

  it('serves the ingested photo as JPEG over app://thumb and app://preview', async () => {
    for (const [kind, url] of [
      ['thumb', appUrl.thumb(photo.id)],
      ['preview', appUrl.preview(photo.id)],
    ] as const) {
      const result = await window.evaluate(async (target) => {
        const response = await fetch(target);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          status: response.status,
          type: response.headers.get('content-type'),
          length: bytes.length,
          magic: [...bytes.slice(0, 3)],
        };
      }, url);
      expect(result.status, kind).toBe(200);
      expect(result.type).toBe('image/jpeg');
      expect(result.magic).toEqual([0xff, 0xd8, 0xff]);
      expect(result.length).toBeGreaterThan(1000);
    }
    const missing = await window.evaluate(
      async (target) => (await fetch(target)).status,
      appUrl.thumb('nope' as never),
    );
    expect(missing).toBe(404);
  });

  it('streams the linear image with its header readable by the renderer', async () => {
    const result = await window.evaluate(
      async ([url, headerName]) => {
        const response = await fetch(url as string);
        const header = response.headers.get(headerName as string);
        const bytes = (await response.arrayBuffer()).byteLength;
        return { status: response.status, header, bytes };
      },
      [appUrl.linear(photo.id, 256), LINEAR_IMAGE_HEADER] as const,
    );
    expect(result.status).toBe(200);
    const header = JSON.parse(result.header!);
    expect(Math.max(header.width, header.height)).toBeLessThanOrEqual(256);
    expect(header.sampleType).toBe('f16');
    expect(result.bytes).toBe(header.width * header.height * 4 * 2);
  });

  it('keeps settings in the jobs process and refuses to store credentials without a keyring', async () => {
    const settings = await invoke<{ ingest: { renameTemplate: string } }>('settings:get');
    expect(settings.ingest.renameTemplate).toBeTruthy();

    const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (available) {
      const { ref } = await invoke<{ ref: string }>('credentials:set', {
        secret: { password: 'pw' },
      });
      expect(ref).toMatch(/^cred-/);
      await invoke('credentials:remove', { ref });
    } else {
      await expect(invoke('credentials:set', { secret: { password: 'pw' } })).rejects.toThrowError(
        /auth.*keyring/,
      );
      expect(existsSync(join(root, 'userdata', 'credentials.json'))).toBe(false);
    }
  });

  it('restarts the jobs process after a crash and keeps serving', async () => {
    const before = jobsPid;
    process.kill(before, 'SIGKILL');
    // A request already in flight when the process dies fails; later ones wait for the new process.
    let ping: { jobsPid: number } | undefined;
    for (let attempt = 0; attempt < 20 && !ping; attempt++) {
      ping = await invoke<{ jobsPid: number }>('system:ping', { message: 'again' }).catch(
        () => undefined,
      );
    }
    if (!ping) throw new Error('the jobs process was not restarted');
    expect(ping.jobsPid).not.toBe(before);
    expect(alive(ping.jobsPid)).toBe(true);
    jobsPid = ping.jobsPid;

    // The index lives on disk, so the photo is still there and its thumbnail still served.
    expect((await invoke<Photo[]>('photos:list')).map((p) => p.id)).toEqual([photo.id]);
    const status = await window.evaluate(
      async (url) => (await fetch(url)).status,
      appUrl.thumb(photo.id),
    );
    expect(status).toBe(200);

    const events = await window.evaluate(
      () => (window as unknown as { __events: unknown[] }).__events,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'job.error',
        scope: 'jobs',
        message: expect.stringMatching(/restarting/),
      }),
    );
  }, 30_000);

  it('closes the jobs process cleanly when the app quits', async () => {
    expect(jobsPid).toBeGreaterThan(0);
    await app.close();
    for (let i = 0; i < 50 && alive(jobsPid); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(jobsPid)).toBe(false);
    expect(existsSync(join(root, 'userdata', 'index.sqlite'))).toBe(true);
  }, 30_000);
});
