// @vitest-environment node
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { decodeJpeg, encodeJpeg } from '@ee/core';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * 100% and 200% sit on the device pixel grid in the real app. A 1 px black and white stripe patch
 * is zoomed to, panned and resized at window sizes that are not special (odd canvas widths,
 * heights), at device pixel ratios 1 and 1.25, and the pixels the compositor shows are read back.
 * Where the patch is on screen is found from the pixels, never from the view maths, so a picture
 * that lands half a device pixel off (every stripe a flat grey, the patch edges blended with the
 * background) fails wherever it happens to land.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

const IMAGE = { width: 3200, height: 2000 };
/** A patch of 1 px black (even x) and white (odd x) columns, in image pixels. */
const STRIPES = { x: 1000, y: 500, w: 64, h: 64 };
/** The patch's black columns run from its first column to the last even one. */
const BLACK_WIDTH = STRIPES.w - 1;

/** Content sizes of the window, in CSS pixels; none of them is a round number for the canvas. */
const SIZES = [
  { width: 1263, height: 787 },
  { width: 1237, height: 761 },
  { width: 1250, height: 781 },
  { width: 1111, height: 703 },
];
const RATIOS = [1, 1.25];

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 190 + (process.pid % 50);
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

/** A mid-tone gradient with the stripe patch in it. */
async function makePhoto(): Promise<Buffer> {
  const rgba = new Uint8Array(IMAGE.width * IMAGE.height * 4);
  for (let y = 0; y < IMAGE.height; y++) {
    for (let x = 0; x < IMAGE.width; x++) {
      const at = (y * IMAGE.width + x) * 4;
      rgba[at] = 50 + Math.round((x / IMAGE.width) * 90);
      rgba[at + 1] = 50 + Math.round((y / IMAGE.height) * 90);
      rgba[at + 2] = 80;
      rgba[at + 3] = 255;
    }
  }
  for (let y = STRIPES.y; y < STRIPES.y + STRIPES.h; y++) {
    for (let x = STRIPES.x; x < STRIPES.x + STRIPES.w; x++) {
      const at = (y * IMAGE.width + x) * 4;
      const v = x % 2 === 0 ? 0 : 255;
      rgba[at] = v;
      rgba[at + 1] = v;
      rgba[at + 2] = v;
    }
  }
  return encodeJpeg(rgba, IMAGE.width, IMAGE.height, {
    quality: 100,
    chroma: '444',
    iccSrgb: true,
  });
}

interface Shot {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const luma = (shot: Shot, x: number, y: number): number => {
  const at = (y * shot.width + x) * 4;
  return (shot.rgba[at]! + shot.rgba[at + 1]! + shot.rgba[at + 2]!) / 3;
};

/**
 * Reads the stripe patch off a screenshot: it must be exactly `ratio * 64` rows tall, every
 * column across it black or white, and its edges must not be blended with the background.
 * Returns what is wrong, or nothing.
 */
function stripeProblems(shot: Shot, ratio: number): string[] {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      if (luma(shot, x, y) >= 40) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return ['no black stripe on screen (the patch is out of view or blended to grey)'];
  const problems: string[] = [];
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width !== BLACK_WIDTH * ratio)
    problems.push(`black width ${width}, want ${BLACK_WIDTH * ratio}`);
  if (height !== STRIPES.h * ratio)
    problems.push(`black height ${height}, want ${STRIPES.h * ratio}`);
  // Every column of the patch, on a row through its middle, is black or white (flat grey is blended).
  const row = Math.round((minY + maxY) / 2);
  let grey = 0;
  for (let x = minX; x <= maxX; x++) {
    const v = luma(shot, x, row);
    if (v >= 40 && v <= 215) grey += 1;
  }
  if (grey > 0) problems.push(`${grey} columns on the middle row are neither black nor white`);
  // One device pixel outside the patch is the background, not a blend of it with a stripe.
  const background = luma(shot, Math.max(0, minX - 12), row);
  const ring = [
    luma(shot, Math.max(0, minX - 1), row),
    luma(shot, Math.min(shot.width - 1, maxX + 1), row),
    luma(shot, minX, Math.max(0, minY - 1)),
    luma(shot, minX, Math.min(shot.height - 1, maxY + 1)),
  ];
  // The patch's white edge column / row can legitimately be the neighbour of the first stripe, so
  // only the rows above and below and the column left of the first black column are compared.
  for (const at of [ring[0]!, ring[2]!, ring[3]!]) {
    if (Math.abs(at - background) > 14)
      problems.push(`edge pixel ${at.toFixed(0)} is not background ${background.toFixed(0)}`);
  }
  return problems;
}

describe.skipIf(!haveDisplay).each(RATIOS)(
  'zoom lands on the device pixel grid at devicePixelRatio %s (real Electron app)',
  { timeout: 300_000 },
  (ratio) => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let photo: Photo;
    const problems: string[] = [];

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

    const stage = () => window.locator('[data-testid="photo-canvas"] [data-photo-id]');
    const stageBox = async () => {
      const box = await stage().boundingBox();
      if (!box) throw new Error('no stage');
      return box;
    };
    const view = async (): Promise<{ scale: number; x: number; y: number; zoom: string }> => {
      const [raw, zoom] = await Promise.all([
        stage().getAttribute('data-view'),
        stage().getAttribute('data-zoom'),
      ]);
      const [scale, x, y] = (raw ?? '').split(',').map(Number);
      return { scale: scale!, x: x!, y: y!, zoom: zoom ?? '' };
    };
    const settle = async (): Promise<void> => {
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]');
    };
    const waitForZoom = async (zoom: string): Promise<void> => {
      await window.waitForFunction(
        (expected) =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom') === expected,
        zoom,
      );
      await settle();
    };
    const waitForFullResolution = async (): Promise<void> => {
      await window.waitForFunction(
        (width) =>
          Number(
            document
              .querySelector('[data-testid="develop-canvas"]')
              ?.getAttribute('data-image-width'),
          ) >= width,
        IMAGE.width,
        { timeout: 120_000 },
      );
      await settle();
    };
    /** Resizes the window's content and waits for the canvas to follow. */
    const resize = async (size: { width: number; height: number }): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, { width, height }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
      }, size);
      // A fractional device pixel ratio can leave the content a CSS pixel off the request.
      await window.waitForFunction(
        ([width, height]) =>
          Math.abs(globalThis.innerWidth - width) <= 2 &&
          Math.abs(globalThis.innerHeight - height) <= 2,
        [size.width, size.height] as const,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await settle();
    };
    const shootStage = async (): Promise<Shot> => {
      const jpeg = await window.screenshot({ type: 'jpeg', quality: 100, clip: await stageBox() });
      const decoded = await decodeJpeg(jpeg);
      return { width: decoded.width, height: decoded.height, rgba: decoded.rgba };
    };
    /** Zooms to the level the footer has selected about the stripe patch, as seen at Fit. */
    const zoomToStripes = async (expected: string): Promise<void> => {
      const fit = await view();
      const box = await stageBox();
      await window.mouse.move(
        box.x + fit.x + STRIPES.x * fit.scale + (STRIPES.w * fit.scale) / 2,
        box.y + fit.y + STRIPES.y * fit.scale + (STRIPES.h * fit.scale) / 2,
      );
      await window.keyboard.press('z');
      await waitForZoom(expected);
      await waitForFullResolution();
    };
    /** Every test starts at Fit, whatever the one before it left behind. */
    const toFit = async (): Promise<void> => {
      if ((await view()).zoom !== 'fit') {
        await window.keyboard.press('z');
        await waitForZoom('fit');
      }
    };
    const expectSharp = async (level: number, what: string): Promise<void> => {
      const found = stripeProblems(await shootStage(), level);
      expect(found, `${what} at ${level * 100}%`).toEqual([]);
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-zoom-grid-'));
      const card = join(root, 'card');
      mkdirSync(card);
      writeFileSync(join(card, 'stripes_001.jpg'), await makePhoto());

      display = await ensureDisplay();
      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      app = await electron.launch({
        executablePath: electronPath,
        args: [`--force-device-scale-factor=${ratio}`, desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '',
          EE_SOFTWARE_GL: '1',
          EE_USER_DATA_DIR: join(root, 'userdata'),
        },
      });
      window = await app.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      window.on('console', (message) => {
        if (message.type() === 'error') problems.push(message.text());
      });
      window.on('pageerror', (error) => problems.push(error.message));

      const config: IngestConfig = {
        sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
        destination: { path: join(root, 'ingest') },
        fileNaming: 'rename',
        renameTemplate: '{sourceName}_{seq:3}',
      };
      await invoke('ingest:start', { config });
      for (let i = 0; i < 300; i++) {
        const photos = await invoke<Photo[]>('photos:list');
        if (photos[0]?.width) {
          photo = photos[0];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!photo) throw new Error('no photo was ingested');

      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-testid="film-strip"] button');
      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.keyboard.press('d');
      await window
        .waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', { timeout: 60_000 })
        .catch((error: unknown) => {
          throw new Error(`no develop canvas: ${String(error)}\n${problems.join('\n')}`);
        });
      await settle();
      expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(ratio);
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('draws 1:1 pixels at 100% at any canvas size', async () => {
      await toFit();
      for (const size of SIZES) {
        await resize(size);
        await zoomToStripes('100');
        await expectSharp(1, `${size.width}x${size.height}`);
        await window.keyboard.press('z');
        await waitForZoom('fit');
      }
    });

    it('keeps 1:1 through wheel pans of odd sizes and a resize', async () => {
      await toFit();
      await resize(SIZES[0]!);
      await zoomToStripes('100');
      for (const [dx, dy] of [
        [0, 3],
        [0, -1],
        [5, 0],
        [-2, 0],
        [0, 7],
      ] as const) {
        await window.mouse.wheel(dx, dy);
        await settle();
        await expectSharp(1, `after panning by ${dx},${dy}`);
      }
      for (const size of SIZES.slice(1)) {
        await resize(size);
        await expectSharp(1, `after resizing to ${size.width}x${size.height}`);
      }
      await window.keyboard.press('z');
      await waitForZoom('fit');
    });

    it('puts the picture on whole device pixels at 200%', async () => {
      // The sampler stays linear, so 200% magnifies smoothly by design; what must hold is that
      // the picture's corner is on the device grid, so the smoothing has the same phase everywhere.
      await toFit();
      await window
        .getByTestId('zoom-levels')
        .getByRole('button', { name: '200%' })
        .dispatchEvent('click');
      await waitForZoom('200');
      await window.keyboard.press('z');
      await waitForZoom('fit');
      for (const size of SIZES) {
        await resize(size);
        await zoomToStripes('200');
        for (const delta of [0, 1, 3, 7]) {
          if (delta > 0) {
            await window.mouse.wheel(0, delta);
            await settle();
          }
          const v = await view();
          expect(v.scale * ratio).toBeCloseTo(2, 6);
          for (const offset of [v.x, v.y]) {
            const device = offset * ratio;
            expect(Math.abs(device - Math.round(device))).toBeLessThan(1e-6);
          }
        }
        await window.keyboard.press('z');
        await waitForZoom('fit');
      }
    });
  },
);
