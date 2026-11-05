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
const IMAGE = { width: 1800, height: 1000 };
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

describe.skipIf(!haveDisplay)(
  'resizable side panels (real Electron app)',
  { timeout: 240_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let userData: string;

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

    const launch = async (): Promise<{ app: ElectronApplication; window: Page }> => {
      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      const launched = await electron.launch({
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
      const page = await launched.firstWindow();
      await page.waitForFunction(() => 'eeTransport' in window);
      return { app: launched, window: page };
    };

    const handle = (panel: string) => window.getByTestId(`panel-resize-${panel}`);

    const widthOf = async (panel: string): Promise<number> => {
      const value = await handle(panel).getAttribute('aria-valuenow');
      if (value === null) throw new Error(`no width for ${panel}`);
      return Number(value);
    };

    const waitForWidth = async (panel: string, expected: number): Promise<void> => {
      await window.waitForFunction(
        ([testId, width]) => {
          const element = document.querySelector(`[data-testid="${testId}"]`);
          return Number(element?.getAttribute('aria-valuenow')) === width;
        },
        [`panel-resize-${panel}`, expected],
      );
    };

    const nextFrames = async (): Promise<void> => {
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
    };

    const settle = async (): Promise<void> => {
      await nextFrames();
      await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]');
    };

    const stageBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      const box = await window
        .locator('[data-testid="photo-canvas"] [data-photo-id]')
        .boundingBox();
      if (!box) throw new Error('no photo stage');
      return box;
    };

    /** The canvas fits the centre column, keeps the photo's shape and never overflows it. */
    const expectCanvasFits = async (): Promise<void> => {
      const [stage, view] = await Promise.all([
        stageBox(),
        window.getByTestId('photo-view').boundingBox(),
      ]);
      if (!view) throw new Error('no photo view');
      expect(stage.width).toBeLessThanOrEqual(view.width - 44 + 1);
      expect(stage.width / stage.height).toBeCloseTo(IMAGE.width / IMAGE.height, 1);
    };

    const dragBy = async (panel: string, delta: number): Promise<number> => {
      const box = await handle(panel).boundingBox();
      if (!box) throw new Error(`no handle for ${panel}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const before = await widthOf(panel);
      await window.mouse.move(x, y);
      await window.mouse.down();
      await window.mouse.move(x + delta, y, { steps: 8 });
      await nextFrames();
      const live = await widthOf(panel);
      await window.mouse.up();
      await waitForWidth(panel, live);
      expect(live).not.toBe(before);
      return live;
    };

    const waitForSavedWidth = async (panel: string, expected: number): Promise<void> => {
      await waitFor(`${panel} width in settings`, async () => {
        const settings = await invoke<{ panelWidths?: Record<string, number> }>('settings:get');
        return settings.panelWidths?.[panel] === expected;
      });
    };

    const openModule = async (name: 'Library' | 'Develop' | 'Ingest'): Promise<void> => {
      await window.getByRole('tab', { name }).click();
      await window.waitForSelector(
        name === 'Library'
          ? '[data-testid="library-view"]'
          : name === 'Develop'
            ? '[data-testid="develop-view"]'
            : '[data-testid="ingest-view"]',
      );
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        // pnpm is a .cmd shim on Windows, which spawn only starts through a shell.
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-panels-'));
      userData = join(root, 'userdata');
      const source = join(root, 'source');
      mkdirSync(source);
      writeFileSync(join(source, 'wide.jpg'), await makePhoto());

      display = await ensureDisplay();
      ({ app, window } = await launch());

      const config: IngestConfig = {
        sources: [{ id: asSourceId('source'), name: 'source', kind: 'folder', path: source }],
        destination: { path: join(root, 'ingest') },
        fileNaming: 'rename',
        renameTemplate: '{sourceName}_{seq:3}',
      };
      await invoke('ingest:start', { config });
      const photo = await waitFor('the ingested photo', async () => {
        const photos = await invoke<Photo[]>('photos:list');
        return photos.find((candidate) => candidate.width === IMAGE.width);
      });

      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-testid="film-strip"] button');
      await window.waitForFunction(
        (fileName) =>
          document.querySelector('[data-testid="photo-view"]')?.textContent?.includes(fileName) ??
          false,
        photo.fileName,
      );
      await settle();
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('drags the develop panel live and the canvas fits the new space', async () => {
      expect(await widthOf('develop-panel')).toBe(300);
      const stageBefore = await stageBox();
      await expectCanvasFits();

      const handleBox = await handle('develop-panel').boundingBox();
      if (!handleBox) throw new Error('no develop handle');
      const x = handleBox.x + handleBox.width / 2;
      const y = handleBox.y + handleBox.height / 2;
      await window.mouse.move(x, y);
      await window.mouse.down();
      await window.mouse.move(x - 80, y, { steps: 8 });
      await settle();

      // The width follows the pointer before the button is released.
      expect(await widthOf('develop-panel')).toBe(380);
      expect((await stageBox()).width).toBeLessThan(stageBefore.width - 60);
      await expectCanvasFits();

      await window.mouse.up();
      await waitForWidth('develop-panel', 380);
      await waitForSavedWidth('develop-panel', 380);
      await settle();
      expect((await stageBox()).width).toBeLessThan(stageBefore.width - 60);
      await expectCanvasFits();
      expect(
        await window.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });

    it('clamps at both limits and resets on a double-click', async () => {
      await dragBy('develop-panel', 500);
      expect(await widthOf('develop-panel')).toBe(260);

      // Growing left stops where the centre keeps its 320 px minimum.
      await dragBy('develop-panel', -900);
      const view = await window.getByTestId('develop-view').boundingBox();
      if (!view) throw new Error('no develop view');
      const expectedMax = Math.min(620, view.width - 320 - (await widthOf('develop-metadata')));
      expect(await widthOf('develop-panel')).toBe(expectedMax);
      await waitForSavedWidth('develop-panel', expectedMax);

      const box = await handle('develop-panel').boundingBox();
      if (!box) throw new Error('no develop handle');
      await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await waitForWidth('develop-panel', 300);
      await waitFor('the reset width in settings', async () => {
        const settings = await invoke<{ panelWidths?: Record<string, number> }>('settings:get');
        return settings.panelWidths?.['develop-panel'] === undefined;
      });
    });

    it('re-clamps when the window shrinks and keeps the preference', async () => {
      await dragBy('develop-panel', -120);
      const wide = await widthOf('develop-panel');
      expect(wide).toBe(420);
      await waitForSavedWidth('develop-panel', 420);

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(960, 700);
      });
      await window.waitForFunction(() => document.documentElement.clientWidth < 1000);
      await window.waitForFunction(
        (previous) =>
          Number(
            document
              .querySelector('[data-testid="panel-resize-develop-panel"]')
              ?.getAttribute('aria-valuenow'),
          ) < previous,
        wide,
      );
      const shrunk = await widthOf('develop-panel');
      const view = await window.getByTestId('develop-view').boundingBox();
      if (!view) throw new Error('no develop view');
      const centre = view.width - shrunk - (await widthOf('develop-metadata'));
      expect(centre).toBeGreaterThanOrEqual(319);
      expect(
        await window.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
      });
      await window.waitForFunction(() => document.documentElement.clientWidth > 1200);
      await waitForWidth('develop-panel', wide);
    });

    it('resizes the Library and Ingest panels too, and keeps a zoomed view sensible', async () => {
      await openModule('Library');
      expect(await widthOf('library-sidebar')).toBe(220);
      expect(await widthOf('library-inspector')).toBe(300);
      await dragBy('library-sidebar', 60);
      expect(await widthOf('library-sidebar')).toBe(280);
      await waitForSavedWidth('library-sidebar', 280);

      await openModule('Ingest');
      await window.getByTestId('ingest-sources').waitFor();
      await dragBy('ingest-sources', 40);
      expect(await widthOf('ingest-sources')).toBe(400);
      await waitForSavedWidth('ingest-sources', 400);

      await openModule('Develop');
      await settle();
      await window.keyboard.press('z');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom') === '100',
      );
      await dragBy('develop-metadata', 40);
      expect(await widthOf('develop-metadata')).toBe(360);
      await waitForSavedWidth('develop-metadata', 360);
      await settle();
      expect(
        await window.evaluate(() =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom'),
        ),
      ).toBe('100');
      await window.keyboard.press('z');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom') === 'fit',
      );

      // Retouch keeps the mosaic preview aligned with the stage after a resize.
      await window.keyboard.press('r');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-mode') === 'retouch',
      );
      // Retouch opens with the panels hidden; Tab shows them to resize one.
      await window.keyboard.press('Tab');
      await window.getByTestId('sliders').waitFor();
      await settle();
      const mosaicBefore = await window.getByTestId('mosaic-canvas').boundingBox();
      const stageBefore = await stageBox();
      expect(mosaicBefore?.width).toBeCloseTo(stageBefore.width, 0);
      expect(mosaicBefore?.height).toBeCloseTo(stageBefore.height, 0);

      await dragBy('develop-panel', -20);
      expect(await widthOf('develop-panel')).toBe(440);
      await settle();
      const mosaicAfter = await window.getByTestId('mosaic-canvas').boundingBox();
      const stageAfter = await stageBox();
      expect(stageAfter.width).toBeLessThan(stageBefore.width);
      expect(mosaicAfter?.width).toBeCloseTo(stageAfter.width, 0);
      expect(mosaicAfter?.height).toBeCloseTo(stageAfter.height, 0);

      await dragBy('develop-panel', 20);
      await waitForSavedWidth('develop-panel', 420);
      await window.keyboard.press('Escape');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-mode') === 'develop',
      );
    });

    it('remembers every width across a restart', async () => {
      await app.close();
      ({ app, window } = await launch());
      await settle();

      expect(await widthOf('develop-panel')).toBe(420);
      expect(await widthOf('develop-metadata')).toBe(360);
      const developPanel = await window.getByTestId('develop-panel').boundingBox();
      expect(developPanel?.width).toBe(420);

      await openModule('Library');
      expect(await widthOf('library-sidebar')).toBe(280);
      const sidebar = await window.getByTestId('library-sidebar').boundingBox();
      expect(sidebar?.width).toBe(280);

      await openModule('Ingest');
      expect(await widthOf('ingest-sources')).toBe(400);
      const sources = await window.getByTestId('ingest-sources').boundingBox();
      expect(sources?.width).toBe(400);
    });
  },
);
