// @vitest-environment node
import {
  LINEAR_IMAGE_HEADER,
  asSourceId,
  type IngestConfig,
  type IpcResult,
  type Photo,
} from '@ee/contracts';
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
 * Zoom and pan of the main photo view in the real app, over a generated photo whose content is
 * known: a white square (the "face") at a fixed place in the image and a 1 px stripe patch.
 * Where things are is read back from pixels, not from the view maths, so a misaligned overlay or
 * a stretched canvas fails here.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

const IMAGE = { width: 3200, height: 2000 };
/** The white square, in image pixels. */
const FACE = { x: 2000, y: 700, w: 60, h: 60 };
/** A patch of 1 px black and white columns, in image pixels. */
const STRIPES = { x: 1000, y: 500, w: 64, h: 64 };

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 140 + (process.pid % 50);
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

/** Mid-tone gradient, so the white square and the stripes stand out from it. */
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
  const fill = (area: typeof FACE, value: (x: number, y: number) => number): void => {
    for (let y = area.y; y < area.y + area.h; y++) {
      for (let x = area.x; x < area.x + area.w; x++) {
        const at = (y * IMAGE.width + x) * 4;
        const v = value(x, y);
        rgba[at] = v;
        rgba[at + 1] = v;
        rgba[at + 2] = v;
      }
    }
  };
  fill(FACE, () => 255);
  fill(STRIPES, (x) => (x % 2 === 0 ? 0 : 255));
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bounding box of the pixels `test` accepts, in the shot's own pixels. */
function boundsOf(shot: Shot, test: (r: number, g: number, b: number) => boolean): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      const at = (y * shot.width + x) * 4;
      if (!test(shot.rgba[at]!, shot.rgba[at + 1]!, shot.rgba[at + 2]!)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0
    ? undefined
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const isWhite = (r: number, g: number, b: number): boolean => r > 235 && g > 235 && b > 235;

describe.skipIf(!haveDisplay)('zoom and pan (real Electron app)', { timeout: 240_000 }, () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let photo: Photo;
  const linearRequests: { url: string; width: number }[] = [];
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
  const stageBox = async (): Promise<Box> => {
    const box = await stage().boundingBox();
    if (!box) throw new Error('no stage');
    return box;
  };
  /** The picture's layout in the stage: CSS pixels per image pixel and the picture's top-left. */
  const view = async (): Promise<{ scale: number; x: number; y: number; zoom: string }> => {
    const [raw, zoom] = await Promise.all([
      stage().getAttribute('data-view'),
      stage().getAttribute('data-zoom'),
    ]);
    const [scale, x, y] = (raw ?? '').split(',').map(Number);
    return { scale: scale!, x: x!, y: y!, zoom: zoom ?? '' };
  };
  /** The picture pixel under a page position. */
  const imagePointAt = async (page: { x: number; y: number }, full = IMAGE) => {
    const [v, box] = await Promise.all([view(), stageBox()]);
    return {
      x: (page.x - box.x - v.x) / v.scale,
      y: (page.y - box.y - v.y) / v.scale,
      full,
    };
  };
  /** A key as a layout reports it (`key` is what it prints, `code` where the key sits). */
  const keyDown = async (init: { key: string; code: string; ctrlKey?: boolean }): Promise<void> => {
    await window.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ ...init, bubbles: true })}))`,
    );
  };
  const settle = async (): Promise<void> => {
    // Two animation frames: the draw runs in the frame after a state change.
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
  /** The canvas region as pixels: screenshots come from the compositor, so they show what the user sees. */
  const shoot = async (clip?: Box): Promise<{ shot: Shot; origin: Box }> => {
    const origin = clip ?? (await stageBox());
    const jpeg = await window.screenshot({ type: 'jpeg', quality: 100, clip: origin });
    const decoded = await decodeJpeg(jpeg);
    return {
      shot: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
      origin,
    };
  };
  /** Waits until the canvas has the full-resolution decode uploaded and has drawn it. */
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

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-zoom-'));
    const card = join(root, 'card');
    mkdirSync(card);
    writeFileSync(join(card, 'pattern_001.jpg'), await makePhoto());

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
        EE_USER_DATA_DIR: join(root, 'userdata'),
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    window.on('pageerror', (error) => problems.push(error.message));
    window.on('response', (response) => {
      if (!response.url().startsWith('app://linear/')) return;
      const raw = response.headers()[LINEAR_IMAGE_HEADER.toLowerCase()];
      if (raw) {
        linearRequests.push({
          url: response.url(),
          width: (JSON.parse(raw) as { width: number }).width,
        });
      }
    });

    const config: IngestConfig = {
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'rename',
      renameTemplate: '{sourceName}_{seq:3}',
    };
    await invoke('ingest:start', { config });
    for (let i = 0; i < 300; i++) {
      const photos = await invoke<Photo[]>('photos:list');
      // The index knows the size once the camera data is read.
      if (photos[0]?.width) {
        photo = photos[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!photo) throw new Error('no photo was ingested');
    expect(photo.width).toBe(IMAGE.width);

    // Reload so the renderer store starts from the indexed photo.
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
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('starts at Fit with the level selector in the footer', async () => {
    expect((await view()).zoom).toBe('fit');
    const footer = window.getByTestId('zoom-levels');
    await expect(
      footer.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed'),
    ).resolves.toBe('true');
    for (const name of ['50%', '100%', '200%']) {
      expect(await footer.getByRole('button', { name }).count()).toBe(1);
    }
    // At Fit the fitted picture (not the whole canvas) is the stage, and it is drawn from a preview.
    const widths = linearRequests.map((request) => request.width);
    expect(Math.max(...widths)).toBeLessThanOrEqual(2560);
  });

  it('Z zooms to 100% about the centre and back to Fit', async () => {
    const before = await view();
    const box = await stageBox();
    await window.mouse.move(2, 2); // not over the photo
    await window.keyboard.press('z');
    await waitForZoom('100');
    const after = await view();
    expect(after.scale).toBeCloseTo(1, 6);
    const centre = await imagePointAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(centre.x).toBeCloseTo(IMAGE.width / 2, 0);
    expect(centre.y).toBeCloseTo(IMAGE.height / 2, 0);
    expect(before.zoom).toBe('fit');
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });

  it('Z zooms about the pointer when it is over the photo', async () => {
    const box = await stageBox();
    const point = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.3 };
    await window.mouse.move(point.x, point.y);
    const under = await imagePointAt(point);
    await window.keyboard.press('z');
    await waitForZoom('100');
    const still = await imagePointAt(point);
    expect(Math.abs(still.x - under.x)).toBeLessThan(1);
    expect(Math.abs(still.y - under.y)).toBeLessThan(1);
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });

  it('uses the chosen level, and the full-resolution decode when zoomed past the preview', async () => {
    const footer = window.getByTestId('zoom-levels');
    await footer.getByRole('button', { name: '200%' }).click();
    await waitForZoom('200');
    await waitForFullResolution();
    // The full decode, not an upscaled preview.
    expect(linearRequests.some((request) => request.width === IMAGE.width)).toBe(true);
    await window.keyboard.press('z');
    await waitForZoom('fit');
    // Z now goes to 200%, the chosen level.
    await window.mouse.move(2, 2);
    await window.keyboard.press('z');
    await waitForZoom('200');
    await footer.getByRole('button', { name: '100%' }).click();
    await waitForZoom('100');
    await footer.getByRole('button', { name: 'Fit' }).click();
    await waitForZoom('fit');
  });

  it('draws 1:1 image pixels at 100%: a 1 px stripe pattern stays sharp', async () => {
    // Centre the stripes: zoom about them.
    const fit = await view();
    const box = await stageBox();
    const target = {
      x: box.x + fit.x + STRIPES.x * fit.scale + (STRIPES.w * fit.scale) / 2,
      y: box.y + fit.y + STRIPES.y * fit.scale + (STRIPES.h * fit.scale) / 2,
    };
    await window.mouse.move(target.x, target.y);
    await window.keyboard.press('z');
    await waitForZoom('100');
    await waitForFullResolution();
    const { shot, origin } = await shoot();
    const v = await view();
    // Where the patch is on screen, from the view; a row through its middle.
    const left = Math.round(v.x + STRIPES.x * v.scale);
    const row = Math.round(v.y + (STRIPES.y + STRIPES.h / 2) * v.scale);
    expect(left).toBeGreaterThan(0);
    expect(left + STRIPES.w).toBeLessThan(shot.width);
    let swing = 0;
    for (let x = left + 4; x < left + STRIPES.w - 4; x++) {
      const a = shot.rgba[(row * shot.width + x) * 4]!;
      const b = shot.rgba[(row * shot.width + x + 1) * 4]!;
      swing += Math.abs(a - b);
    }
    // Black and white columns: ~255 per step when sharp, a flat grey (~0) when resampled.
    expect(swing / (STRIPES.w - 8)).toBeGreaterThan(150);
    expect(origin.width).toBe(shot.width);
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });

  it('Ctrl+wheel zooms smoothly around the pointer', async () => {
    const box = await stageBox();
    // Level with the picture's centre: a picture that still fits the canvas on one axis stays
    // centred on it, so only the other axis follows the pointer.
    const point = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 };
    await window.mouse.move(point.x, point.y);
    const under = await imagePointAt(point);
    await window.keyboard.down('Control');
    await window.mouse.wheel(0, -100);
    await window.mouse.wheel(0, -100);
    await window.keyboard.up('Control');
    await window.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
          ?.getAttribute('data-zoom') !== 'fit',
    );
    await settle();
    const zoomed = await view();
    const fit = (await stageBox()).width;
    expect(zoomed.zoom).not.toBe('fit');
    expect(fit).toBeGreaterThan(0);
    const still = await imagePointAt(point);
    expect(Math.abs(still.x - under.x)).toBeLessThan(2);
    expect(Math.abs(still.y - under.y)).toBeLessThan(2);
    // Out again, past Fit, returns to Fit.
    await window.keyboard.down('Control');
    for (let i = 0; i < 6; i++) await window.mouse.wheel(0, 100);
    await window.keyboard.up('Control');
    await waitForZoom('fit');
  });

  it('Ctrl + and - zoom in steps on a Swedish keyboard (no Shift); Ctrl+0 is not a zoom', async () => {
    await window.mouse.move(2, 2);
    const zoomFactor = async (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
      );
    await window.keyboard.down('Control');
    // Swedish layout: + is the physical Minus key and - is the physical Slash key.
    await keyDown({ key: '+', code: 'Minus', ctrlKey: true });
    await window.keyboard.up('Control');
    await window.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
          ?.getAttribute('data-zoom') !== 'fit',
    );
    const first = (await view()).scale;
    await keyDown({ key: '+', code: 'NumpadAdd', ctrlKey: true });
    await window.waitForFunction((previous) => {
      const raw = document
        .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
        ?.getAttribute('data-view');
      return Number(raw?.split(',')[0]) > previous * 1.2;
    }, first);
    const second = (await view()).scale;
    expect(second / first).toBeCloseTo(1.25, 2);
    await keyDown({ key: '-', code: 'Slash', ctrlKey: true });
    await window.waitForFunction((previous) => {
      const raw = document
        .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
        ?.getAttribute('data-view');
      return Number(raw?.split(',')[0]) < previous * 0.9;
    }, second);
    // The page itself never zooms, and Ctrl+0 is still the colour class clear.
    expect(await zoomFactor()).toBe(1);
    await window.keyboard.press('Control+3');
    await window.keyboard.press('Control+0');
    await keyDown({ key: '0', code: 'Digit0', ctrlKey: true });
    expect(await zoomFactor()).toBe(1);
    await window.keyboard.press('z'); // zoomed, so Z goes back to Fit
    await waitForZoom('fit');
  });

  it('Space + drag pans the zoomed photo, with a grab cursor, and never types into a field', async () => {
    await window.mouse.move(2, 2);
    await window.keyboard.press('z');
    await waitForZoom('100');
    const box = await stageBox();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = await view();
    await window.mouse.move(start.x, start.y);
    await window.keyboard.down('Space');
    const layer = window.getByTestId('pan-layer');
    expect(await layer.count()).toBe(1);
    expect(await layer.evaluate((element) => getComputedStyle(element).cursor)).toBe('grab');
    await window.mouse.down();
    await window.mouse.move(start.x - 120, start.y - 60, { steps: 6 });
    expect(await layer.evaluate((element) => getComputedStyle(element).cursor)).toBe('grabbing');
    await window.mouse.up();
    await window.keyboard.up('Space');
    expect(await layer.count()).toBe(0);
    await settle();
    const after = await view();
    expect(after.x - before.x).toBeCloseTo(-120, 0);
    expect(after.y - before.y).toBeCloseTo(-60, 0);

    // The clamp: dragging a long way leaves part of the photo in view.
    await window.keyboard.down('Space');
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(start.x + 5000, start.y + 5000, { steps: 4 });
    await window.mouse.up();
    await window.keyboard.up('Space');
    await settle();
    const far = await view();
    expect(far.x).toBeLessThanOrEqual(box.width);
    expect(far.y).toBeLessThanOrEqual(box.height);
    expect(far.x).toBeGreaterThan(0);

    // Space in the caption field types a space and does not pan.
    const caption = window.locator('[data-caption-input]');
    await caption.focus();
    await caption.fill('a');
    await window.keyboard.press('Space');
    expect(await window.getByTestId('pan-layer').count()).toBe(0);
    expect(await caption.inputValue()).toBe('a ');
    await caption.fill('');
    await caption.blur();
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });

  it('scroll pans the zoomed photo, does nothing at Fit, and Ctrl+wheel still zooms', async () => {
    const box = await stageBox();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await window.mouse.move(centre.x, centre.y);
    const fit = await view();
    expect(fit.zoom).toBe('fit');
    await window.mouse.wheel(0, 120);
    await settle();
    // Fit is not a pan: the view stays where it was and the wheel is left to the page.
    expect(await view()).toEqual(fit);

    await window.keyboard.press('z');
    await waitForZoom('100');
    const zoomed = await view();
    await window.mouse.move(centre.x, centre.y);
    // Scrolling down moves the view down the photo: the picture itself moves up.
    await window.mouse.wheel(0, 120);
    await settle();
    const down = await view();
    expect(down.x).toBeCloseTo(zoomed.x, 6);
    expect(down.y).toBeCloseTo(zoomed.y - 120, 0);

    // Both axes pan.
    await window.mouse.wheel(80, 0);
    await settle();
    const sideways = await view();
    expect(sideways.x).toBeCloseTo(down.x - 80, 0);
    expect(sideways.y).toBeCloseTo(down.y, 6);

    // On Linux and Windows Chromium may send Shift+wheel as a vertical delta; it pans sideways.
    await window.keyboard.down('Shift');
    await window.mouse.wheel(0, 60);
    await window.keyboard.up('Shift');
    await settle();
    const shifted = await view();
    expect(shifted.x).toBeCloseTo(sideways.x - 60, 0);
    expect(shifted.y).toBeCloseTo(sideways.y, 6);

    // Ctrl+wheel still zooms, from Fit as well.
    await window.keyboard.press('z');
    await waitForZoom('fit');
    const beforeZoom = await view();
    await window.mouse.move(centre.x, centre.y);
    await window.keyboard.down('Control');
    await window.mouse.wheel(0, -100);
    await window.keyboard.up('Control');
    await window.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
          ?.getAttribute('data-zoom') !== 'fit',
    );
    await settle();
    const afterZoom = await view();
    expect(afterZoom.zoom).not.toBe('fit');
    expect(afterZoom.scale).toBeGreaterThan(beforeZoom.scale);
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });

  it('draws a retouch rectangle on the face while zoomed, and the stored shape is that region', async () => {
    await window.keyboard.press('r');
    await window.getByTestId('retouch-toolbar').waitFor();
    await window.locator('[data-tool="rect"]').click();
    // Zoom in on the face, which is only 20 screen pixels wide at Fit.
    const fit = await view();
    const box = await stageBox();
    await window.mouse.move(
      box.x + fit.x + (FACE.x + FACE.w / 2) * fit.scale,
      box.y + fit.y + (FACE.y + FACE.h / 2) * fit.scale,
    );
    await window.keyboard.press('z');
    await waitForZoom('100');
    await waitForFullResolution();

    // Scroll pans the zoomed view; a rectangle drawn afterwards must still land on the face.
    await window.mouse.wheel(0, 40);
    await settle();

    // Where the face really is on screen: the white square in a screenshot.
    const { shot, origin } = await shoot();
    const white = boundsOf(shot, isWhite);
    if (!white) throw new Error('the face is not in view');
    expect(white.width).toBeGreaterThan(50);
    expect(white.width).toBeLessThan(70);

    // Draw around the whole square, with a few pixels of margin.
    const margin = 6;
    const from = { x: origin.x + white.x - margin, y: origin.y + white.y - margin };
    const to = {
      x: origin.x + white.x + white.width + margin,
      y: origin.y + white.y + white.height + margin,
    };
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 8 });
    await window.mouse.up();
    await window.waitForSelector('[data-testid="retouch-overlay"] [data-area-kind="rect"]');

    const d = await window
      .locator('[data-testid="retouch-overlay"] [data-area-kind="rect"]')
      .first()
      .getAttribute('d');
    const match = /M ([\d.e-]+) ([\d.e-]+) h ([\d.e-]+) v ([\d.e-]+)/.exec(d ?? '');
    if (!match) throw new Error(`unexpected path ${d}`);
    const [x, y, w, h] = match.slice(1).map(Number) as [number, number, number, number];
    // The intended region: the face plus the margin, in the image's normalised coordinates.
    const expected = {
      x: (FACE.x - margin) / IMAGE.width,
      y: (FACE.y - margin) / IMAGE.height,
      w: (FACE.w + 2 * margin) / IMAGE.width,
      h: (FACE.h + 2 * margin) / IMAGE.height,
    };
    const onePixel = 1.5 / IMAGE.width;
    expect(Math.abs(x - expected.x)).toBeLessThan(onePixel);
    expect(Math.abs(y - expected.y)).toBeLessThan(onePixel * 1.6);
    expect(Math.abs(w - expected.w)).toBeLessThan(onePixel * 2);
    expect(Math.abs(h - expected.h)).toBeLessThan(onePixel * 3);

    // The mosaic is drawn over the same pixels: the face is no longer a clean white square.
    await window.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="mosaic-canvas"]')
            ?.getAttribute('data-mosaic-version'),
        ) > 0,
    );
    await window.mouse.move(2, 2);
    await settle();
    const mosaicked = (await shoot()).shot;
    // The toolbar over the top of the canvas changes too (the area count); only look beneath it.
    const toolbar = await window.getByTestId('retouch-toolbar').boundingBox();
    const below = Math.ceil((toolbar?.y ?? 0) + (toolbar?.height ?? 0) - origin.y) + 2;
    const stillWhite = boundsOf(mosaicked, isWhite);
    const changed = (() => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let py = Math.max(0, below); py < shot.height; py++) {
        for (let px = 0; px < shot.width; px++) {
          const at = (py * shot.width + px) * 4;
          const diff =
            Math.abs(shot.rgba[at]! - mosaicked.rgba[at]!) +
            Math.abs(shot.rgba[at + 1]! - mosaicked.rgba[at + 1]!);
          if (diff < 40) continue;
          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);
        }
      }
      return maxX < 0 ? undefined : { minX, minY, maxX, maxY };
    })();
    // The overlay shape is the one drawn; whatever the mosaic changed lies inside it (block averages
    // of the white square and its surroundings), and nothing outside it moved.
    expect(changed).toBeDefined();
    const drawn = {
      left: white.x - margin,
      top: white.y - margin,
      right: white.x + white.width + margin,
      bottom: white.y + white.height + margin,
    };
    expect(changed!.minX).toBeGreaterThanOrEqual(drawn.left - 2);
    expect(changed!.minY).toBeGreaterThanOrEqual(drawn.top - 2);
    expect(changed!.maxX).toBeLessThanOrEqual(drawn.right + 2);
    expect(changed!.maxY).toBeLessThanOrEqual(drawn.bottom + 2);
    expect(stillWhite === undefined || stillWhite.width < white.width).toBe(true);

    // Space + drag in Retouch pans and draws nothing.
    const areas = await window.locator('[data-testid="retouch-overlay"] [data-area-index]').count();
    const centre = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 };
    await window.keyboard.down('Space');
    await window.mouse.move(centre.x, centre.y);
    await window.mouse.down();
    await window.mouse.move(centre.x - 80, centre.y - 40, { steps: 5 });
    await window.mouse.up();
    await window.keyboard.up('Space');
    await settle();
    expect(await window.locator('[data-testid="retouch-overlay"] [data-area-index]').count()).toBe(
      areas,
    );

    await window.keyboard.press('Escape');
    await window.getByTestId('retouch-toolbar').waitFor({ state: 'detached' });
    // Leaving Retouch resets the zoom.
    expect((await view()).zoom).toBe('fit');
  });

  it('keeps the crop frame on the picture while zoomed, and resets zoom when the photo changes', async () => {
    await window.keyboard.press('c');
    await window.getByTestId('crop-overlay').waitFor();
    await window.mouse.move(2, 2);
    await window.getByTestId('zoom-levels').getByRole('button', { name: '50%' }).click();
    await waitForZoom('50');
    await settle();
    const v = await view();
    const frame = (await window.getByTestId('crop-overlay').getAttribute('data-frame'))!
      .split(',')
      .map(Number) as [number, number, number, number];
    // The frame is the whole image: where the overlay says it is, the image is on the canvas.
    expect(frame[0]).toBeCloseTo(v.x, 0);
    expect(frame[1]).toBeCloseTo(v.y, 0);
    expect(frame[2]).toBeCloseTo(IMAGE.width * v.scale, 0);
    const { shot } = await shoot();
    const lit = boundsOf(shot, (r, g, b) => r > 40 && g > 40 && b > 60 && Math.max(r, g, b) < 200);
    if (!lit) throw new Error('no picture in the crop view');
    // The left edge of the picture on the canvas is the frame's left edge, to a pixel or two.
    if (frame[0] > 4) expect(Math.abs(lit.x - frame[0])).toBeLessThan(3);
    await window.keyboard.press('Escape');
    await window.getByTestId('crop-overlay').waitFor({ state: 'detached' });
    expect((await view()).zoom).toBe('fit');
  });
  it('zooms a cropped photo about the pointer, and draws its crop at 100%', async () => {
    // Crop to roughly the middle: pull the left and top edges in, then apply.
    await window.keyboard.press('c');
    const overlay = window.getByTestId('crop-overlay');
    await overlay.waitFor();
    const frame = async (): Promise<Box> => {
      const [left, top, width, height] = (await overlay.getAttribute('data-frame'))!
        .split(',')
        .map(Number) as [number, number, number, number];
      const box = (await overlay.boundingBox())!;
      return { x: box.x + left, y: box.y + top, width, height };
    };
    const before = await frame();
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await window.mouse.move(from.x, from.y);
      await window.mouse.down();
      await window.mouse.move(to.x, to.y, { steps: 6 });
      await window.mouse.up();
    };
    await drag(
      { x: before.x, y: before.y + before.height / 2 },
      { x: before.x + before.width * 0.3, y: before.y + before.height / 2 },
    );
    await drag(
      { x: before.x + before.width * 0.65, y: before.y },
      { x: before.x + before.width * 0.65, y: before.y + before.height * 0.25 },
    );
    const after = await frame();
    expect(after.width).toBeLessThan(before.width * 0.8);
    await window.keyboard.press('Enter');
    await overlay.waitFor({ state: 'detached' });
    await settle();

    // Z goes to the level chosen last (50% in the crop test above); take 100% and back to Fit.
    await window.getByTestId('zoom-levels').getByRole('button', { name: '100%' }).click();
    await waitForZoom('100');
    await window.keyboard.press('z');
    await waitForZoom('fit');
    const box = await stageBox();
    const point = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.35 };
    await window.mouse.move(point.x, point.y);
    const fit = await view();
    const under = {
      x: (point.x - box.x - fit.x) / fit.scale,
      y: (point.y - box.y - fit.y) / fit.scale,
    };
    await window.keyboard.press('z');
    await waitForZoom('100');
    const zoomed = await view();
    const zoomedBox = await stageBox();
    expect(zoomed.scale).toBeCloseTo(1, 6);
    // The same cropped-picture pixel is still under the pointer.
    const still = {
      x: (point.x - zoomedBox.x - zoomed.x) / zoomed.scale,
      y: (point.y - zoomedBox.y - zoomed.y) / zoomed.scale,
    };
    expect(Math.abs(still.x - under.x)).toBeLessThan(1.5);
    expect(Math.abs(still.y - under.y)).toBeLessThan(1.5);
    // The picture is the crop: smaller than the whole image, so Fit scale is larger than for the whole.
    expect(fit.scale * IMAGE.width).toBeGreaterThan(box.width);
    await window.keyboard.press('z');
    await waitForZoom('fit');
  });
});
