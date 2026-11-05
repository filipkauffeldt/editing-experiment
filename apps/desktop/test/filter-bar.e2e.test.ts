// @vitest-environment node
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { encodeJpeg } from '@ee/core';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

const desktopDir = join(repoRoot, 'apps', 'desktop');
const IMAGE = { width: 600, height: 400 };
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 160 + (process.pid % 50);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const child: ChildProcess = spawn(
    'Xvfb',
    [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { env: { DISPLAY: `:${number}` }, stop: () => void child.kill() };
}

async function makePhoto(): Promise<Buffer> {
  const rgba = new Uint8Array(IMAGE.width * IMAGE.height * 4);
  for (let y = 0; y < IMAGE.height; y++) {
    for (let x = 0; x < IMAGE.width; x++) {
      const at = (y * IMAGE.width + x) * 4;
      rgba[at] = 40 + Math.round((x / IMAGE.width) * 160);
      rgba[at + 1] = 40 + Math.round((y / IMAGE.height) * 160);
      rgba[at + 2] = 70;
      rgba[at + 3] = 255;
    }
  }
  return encodeJpeg(rgba, IMAGE.width, IMAGE.height, {
    quality: 90,
    chroma: '444',
    iccSrgb: true,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const SHOTS = process.env.EE_FILTER_SHOTS;

describe.skipIf(!haveDisplay)('shared filter bar (real Electron app)', { timeout: 300_000 }, () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let photos: Photo[] = [];

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

  const shot = async (name: string): Promise<void> => {
    if (SHOTS) await window.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  const activeName = async (): Promise<string | null> =>
    window.locator('[data-testid="film-strip"] [aria-selected="true"] img').getAttribute('alt');

  const stripNames = async (): Promise<string[]> =>
    window
      .locator('[data-testid="film-strip"] [role="option"] img')
      .evaluateAll((images) => images.map((image) => image.getAttribute('alt') ?? ''));

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-filter-bar-'));
    const userData = join(root, 'userdata');
    const source = join(root, 'source');
    mkdirSync(source);
    const jpeg = await makePhoto();
    for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(source, `${name}.jpg`), jpeg);

    display = await ensureDisplay();
    const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        ...display.env,
        EE_MOCK: '',
        EE_SOFTWARE_GL: '1',
        EE_USER_DATA_DIR: userData,
      },
    });
    window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 873 }).catch(() => undefined);
    await window.waitForFunction(() => 'eeTransport' in window);

    const config: IngestConfig = {
      sources: [{ id: asSourceId('source'), name: 'source', kind: 'folder', path: source }],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'rename',
      renameTemplate: '{sourceName}_{seq:3}',
    };
    await invoke('ingest:start', { config });
    photos = await waitFor('five ingested photos', async () => {
      const listed = await invoke<Photo[]>('photos:list');
      return listed.length === 5 ? listed : undefined;
    });
    photos.sort((left, right) => left.fileName.localeCompare(right.fileName));

    // Stars 5, 3, 1, 4 and none; the third has a Swedish caption, the fifth a keyword.
    const ratings = [5, 3, 1, 4, 0];
    for (const [index, photo] of photos.entries()) {
      await invoke('photos:setLabels', { photoIds: [photo.id], rating: ratings[index] });
    }
    await invoke('metadata:write', {
      photoId: photos[2]?.id,
      fields: { caption: 'Målvakten Åkerlund räddar', keywords: ['allsvenskan'] },
    });
    await invoke('metadata:write', {
      photoId: photos[4]?.id,
      fields: { keywords: ['åkerlund'] },
    });

    await window.reload();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-testid="film-strip"] button');
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('filters to 3 stars with the mouse in the Library, then D and the arrow keys stay inside it', async () => {
    await window.getByRole('tab', { name: 'Library' }).click();
    await window.waitForSelector('[data-testid="library-grid"]');
    await shot('library-filter-bar');
    expect(await window.locator('[data-testid="library-cell"]').count()).toBe(5);

    await window.getByRole('button', { name: /^Status/ }).click();
    await window.waitForSelector('[role="menu"]');
    await shot('library-status-menu');
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: /^Camera/ }).click();
    await window.waitForSelector('[role="menu"]');
    await shot('library-camera-menu');
    await window.keyboard.press('Escape');

    await window.getByRole('button', { name: '3 stars and up' }).click();
    await waitFor('three photos in the grid', async () =>
      (await window.locator('[data-testid="library-cell"]').count()) === 3 ? true : undefined,
    );
    expect(await window.getByTestId('filter-count').textContent()).toBe('3 of 5');
    await shot('library-three-stars');

    await window.keyboard.press('d');
    await window.waitForSelector('[data-testid="film-strip"]');
    await waitFor('the filter still on in Develop', async () =>
      (await window.getByTestId('filter-count').textContent()) === '3 of 5' ? true : undefined,
    );
    const shown = await stripNames();
    expect(shown).toHaveLength(3);
    // 5, 3 and 4 stars in name order: photos 1, 2 and 4.
    expect(shown).toEqual([photos[0], photos[1], photos[3]].map((photo) => photo?.fileName));
    await waitFor('the first shown photo active', async () =>
      (await activeName()) === shown[0] ? true : undefined,
    );
    await shot('develop-three-stars');

    await window.keyboard.press('ArrowRight');
    await waitFor('the second', async () => ((await activeName()) === shown[1] ? true : undefined));
    await window.keyboard.press('ArrowRight');
    await waitFor('the third', async () => ((await activeName()) === shown[2] ? true : undefined));
    await window.keyboard.press('ArrowRight');
    await sleep(300);
    expect(await activeName()).toBe(shown[2]);
  });

  it('clears with the ×, then finds Swedish captions and keywords by typing', async () => {
    await window.getByTestId('filter-clear').click();
    await waitFor('all five back', async () =>
      (await stripNames()).length === 5 ? true : undefined,
    );
    expect(await window.getByTestId('filter-clear').count()).toBe(0);

    await window.keyboard.press('Control+f');
    await window.keyboard.type('ÅKERLUND');
    await waitFor('the two photos with åkerlund', async () =>
      (await stripNames()).length === 2 ? true : undefined,
    );
    expect(await stripNames()).toEqual([photos[2], photos[4]].map((photo) => photo?.fileName));
    expect(await window.getByTestId('filter-count').textContent()).toBe('2 of 5');
    await shot('develop-search');

    // Typed letters and digits did nothing else: still Develop, nothing rated.
    expect(await window.getByRole('tab', { name: 'Develop' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect((await invoke<Photo[]>('photos:list')).map((photo) => photo.rating).sort()).toEqual([
      0, 1, 3, 4, 5,
    ]);

    await window.keyboard.press('Escape');
    await waitFor('search cleared', async () =>
      (await stripNames()).length === 5 ? true : undefined,
    );
    expect(await window.getByTestId('filter-search').inputValue()).toBe('');
  });
});
