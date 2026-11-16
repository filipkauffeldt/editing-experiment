// @vitest-environment node
import {
  asSourceId,
  type IngestConfig,
  type IpcResult,
  type MosaicOp,
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
import { STRIPES, luma, stripeProblems, type Shot } from './helpers/stripes';

/**
 * Zoom in the Library loupe, in the real app, over three generated photos that differ in colour
 * and share a stripe patch at one place. It checks what the compositor shows: that 100% is pixel
 * sharp, that the zoom carries to the next photo, that a zoom needs no raw decode, that the
 * neighbours are fetched ahead, and that a retouched photo never shows camera pixels.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

const IMAGE = { width: 3200, height: 2000 };
const RATIOS = [1, 1.25];

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 240 + (process.pid % 50);
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

/** A gradient whose blue level tells the photos apart, with the stripe patch in it. */
async function makePhoto(blue: number): Promise<Buffer> {
  const rgba = new Uint8Array(IMAGE.width * IMAGE.height * 4);
  for (let y = 0; y < IMAGE.height; y++) {
    for (let x = 0; x < IMAGE.width; x++) {
      const at = (y * IMAGE.width + x) * 4;
      rgba[at] = 50 + Math.round((x / IMAGE.width) * 90);
      rgba[at + 1] = 50 + Math.round((y / IMAGE.height) * 90);
      rgba[at + 2] = blue;
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

const BLUES = [60, 120, 180, 90, 150];

describe.skipIf(!haveDisplay).each(RATIOS)(
  'the Library loupe zooms at devicePixelRatio %s (real Electron app)',
  { timeout: 300_000 },
  (ratio) => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let photos: Photo[];
    const problems: string[] = [];
    /** Every `app://` response the window received, in order: what actually came from the backend. */
    const responses: string[] = [];
    /**
     * Every `app://linear` request the window issued, when it was issued. A request that came
     * from Develop or from its neighbour warm-up can answer long after it was made, so only the
     * requests made at a given moment say what that moment asked the backend to decode.
     */
    const linearRequests: string[] = [];
    let linearRequestsBefore = 0;

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

    const stage = () => window.locator('[data-testid="loupe-stage"]');
    const read = async (name: string): Promise<string> => (await stage().getAttribute(name)) ?? '';
    const view = async (): Promise<{ scale: number; x: number; y: number }> => {
      const [scale, x, y] = (await read('data-view')).split(',').map(Number);
      return { scale: scale!, x: x!, y: y! };
    };
    const stageBox = async () => {
      const box = await stage().boundingBox();
      if (!box) throw new Error('no stage');
      return box;
    };
    const settle = async (): Promise<void> => {
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
    };
    const waitForPhoto = async (id: string): Promise<void> => {
      await window.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="loupe-stage"]')?.getAttribute('data-photo-id') ===
          expected,
        id,
      );
    };
    const waitForZoom = async (zoom: string): Promise<void> => {
      await window.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="loupe-stage"]')?.getAttribute('data-zoom') ===
          expected,
        zoom,
      );
      await settle();
    };
    const waitForFull = async (): Promise<void> => {
      await window.waitForSelector('[data-testid="loupe-stage"][data-full-ready="true"]', {
        timeout: 60_000,
      });
      await settle();
    };
    const waitForResponse = async (fragment: string): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (responses.some((url) => url.includes(fragment))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no response for ${fragment}; got ${responses.join(', ')}`);
    };
    const shoot = async (): Promise<Shot> => {
      const jpeg = await window.screenshot({ type: 'jpeg', quality: 100, clip: await stageBox() });
      const decoded = await decodeJpeg(jpeg);
      return { width: decoded.width, height: decoded.height, rgba: decoded.rgba };
    };
    /** The blue level of the picture beside the stripe patch, which names the photo on screen. */
    const blueOf = async (): Promise<number> => {
      const shot = await shoot();
      const at = (((shot.height >> 1) + 150) * shot.width + (shot.width >> 1) - 150) * 4;
      return shot.rgba[at + 2]!;
    };
    /**
     * How many pixels of the stripe patch's own black and white are on screen. The gradient around
     * it stays between 50 and 190, so only the camera's patch (or its sharp edges) has them. The
     * patch is found from the layout, not from the pixels, so a photo that shows none reads 0.
     */
    const patchExtremes = async (): Promise<number> => {
      const [shot, v] = await Promise.all([shoot(), view()]);
      const left = Math.round((v.x + STRIPES.x * v.scale) * ratio);
      const top = Math.round((v.y + STRIPES.y * v.scale) * ratio);
      const size = Math.round(STRIPES.w * v.scale * ratio);
      let found = 0;
      for (let y = Math.max(0, top); y < Math.min(shot.height, top + size); y++) {
        for (let x = Math.max(0, left); x < Math.min(shot.width, left + size); x++) {
          const value = luma(shot, x, y);
          if (value < 20 || value > 235) found += 1;
        }
      }
      return found;
    };
    const mosaicOver = async (photo: Photo): Promise<void> => {
      const mosaic: MosaicOp = {
        type: 'mosaic',
        shapes: [
          {
            type: 'rect',
            x: (STRIPES.x - 100) / IMAGE.width,
            y: (STRIPES.y - 100) / IMAGE.height,
            w: (STRIPES.w + 200) / IMAGE.width,
            h: (STRIPES.h + 200) / IMAGE.height,
          },
        ],
        blockSizeRel: 0.05,
      };
      const version = await invoke<{ id: string }>('photos:createVersion', {
        photoId: photo.id,
        kind: 'retouch',
      });
      await invoke('retouch:set', { photoId: photo.id, versionId: version.id, ops: [mosaic] });
    };
    /** Arrow keys to a photo of the burst. */
    const goTo = async (photo: Photo): Promise<void> => {
      const target = photos.findIndex((candidate) => candidate.id === photo.id);
      for (let i = 0; i < photos.length; i++) {
        const id = await read('data-photo-id');
        const current = photos.findIndex((candidate) => candidate.id === id);
        if (current === target) return;
        const next = photos[current < target ? current + 1 : current - 1]!;
        await window.keyboard.press(current < target ? 'ArrowRight' : 'ArrowLeft');
        await waitForPhoto(next.id);
      }
    };
    const toFit = async (): Promise<void> => {
      if ((await read('data-zoom')) !== 'fit') {
        await window.keyboard.press('z');
        await waitForZoom('fit');
      }
    };
    /** Moves the pointer over the stripe patch as Fit shows it, so `Z` zooms about it. */
    const pointAtStripes = async (): Promise<void> => {
      const fit = await view();
      const box = await stageBox();
      await window.mouse.move(
        box.x + fit.x + (STRIPES.x + STRIPES.w / 2) * fit.scale,
        box.y + fit.y + (STRIPES.y + STRIPES.h / 2) * fit.scale,
      );
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-loupe-'));
      const card = join(root, 'card');
      mkdirSync(card);
      for (const [index, blue] of BLUES.entries()) {
        writeFileSync(join(card, `burst_00${index + 1}.jpg`), await makePhoto(blue));
      }

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
      window.on('response', (response) => {
        if (response.url().startsWith('app://')) responses.push(response.url());
      });
      window.on('request', (request) => {
        if (request.url().startsWith('app://linear/')) linearRequests.push(request.url());
      });

      const config: IngestConfig = {
        sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
        destination: { path: join(root, 'ingest') },
        fileNaming: 'rename',
        renameTemplate: '{sourceName}_{seq:3}',
      };
      await invoke('ingest:start', { config });
      for (let i = 0; i < 300; i++) {
        const listed = await invoke<Photo[]>('photos:list');
        if (listed.length === BLUES.length && listed.every((photo) => photo.width)) {
          photos = listed.sort((a, b) => a.fileName.localeCompare(b.fileName));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!photos) throw new Error('the photos were not ingested');

      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-testid="app-ready"], [data-store-ready="true"]');
      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.keyboard.press('g');
      await window.keyboard.press('e');
      await window.waitForSelector('[data-testid="loupe-stage"]');
      await waitForPhoto(photos[0]!.id);
      expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(ratio);
      // Whatever the app decoded before the loupe opened (the window starts in Develop) was
      // asked for before this point. Counting requests, not responses, leaves out the decode
      // that is still in flight and answers later without the loupe having asked for it.
      linearRequestsBefore = linearRequests.length;
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('shows the cached preview at Fit and asks for no full-size image yet', async () => {
      expect(await read('data-zoom')).toBe('fit');
      await expect(window.getByTestId('loupe-full').count()).resolves.toBe(0);
      await waitForResponse(`app://preview/${photos[0]!.id}`);
      expect(responses.some((url) => url.startsWith('app://full/'))).toBe(false);
      expect(Math.abs((await blueOf()) - BLUES[0]!)).toBeLessThan(12);
    });

    it('fetches the next photo ahead at Fit, before any key is pressed', async () => {
      await waitForResponse(`app://preview/${photos[1]!.id}`);
    });

    it('Z zooms to a 1:1 view of the camera JPEG without decoding the raw', async () => {
      await pointAtStripes();
      await window.keyboard.press('z');
      await waitForZoom('100');
      await waitForFull();
      expect(await read('data-frame')).toBe(`${IMAGE.width}x${IMAGE.height}`);
      expect(stripeProblems(await shoot(), 1)).toEqual([]);
      // No raw decode since the loupe opened: a decode starts only when the window asks for
      // the linear image, and nothing has since the baseline was taken.
      expect(linearRequests).toHaveLength(linearRequestsBefore);
      expect(responses.some((url) => url.startsWith(`app://full/${photos[0]!.id}`))).toBe(true);
    });

    it('keeps 1:1 through wheel pans', async () => {
      for (const [dx, dy] of [
        [0, 3],
        [5, 0],
        [-2, 0],
        [0, -7],
      ] as const) {
        await window.mouse.wheel(dx, dy);
        await settle();
        expect(stripeProblems(await shoot(), 1), `after ${dx},${dy}`).toEqual([]);
      }
    });

    it('fetches the next full-size image ahead while zoomed', async () => {
      await waitForResponse(`app://full/${photos[1]!.id}`);
    });

    it('carries the zoom and the position to the next photo with an arrow key', async () => {
      const before = await view();
      await window.keyboard.press('ArrowRight');
      await waitForPhoto(photos[1]!.id);
      await waitForFull();
      expect(await read('data-zoom')).toBe('100');
      expect(await view()).toEqual(before);
      // The same spot of the next frame: its colour, and the patch sharp in the same place.
      expect(Math.abs((await blueOf()) - BLUES[1]!)).toBeLessThan(12);
      expect(stripeProblems(await shoot(), 1)).toEqual([]);
      await window.keyboard.press('ArrowLeft');
      await waitForPhoto(photos[0]!.id);
      await waitForFull();
      expect(await view()).toEqual(before);
      expect(Math.abs((await blueOf()) - BLUES[0]!)).toBeLessThan(12);
    });

    it('Z goes back to Fit, and the next photo then starts at Fit', async () => {
      await window.keyboard.press('z');
      await waitForZoom('fit');
      await window.keyboard.press('ArrowRight');
      await waitForPhoto(photos[1]!.id);
      expect(await read('data-zoom')).toBe('fit');
      await window.keyboard.press('ArrowLeft');
      await waitForPhoto(photos[0]!.id);
    });

    it('zooms with the footer levels and Ctrl+wheel as Develop does', async () => {
      await toFit();
      await window
        .getByTestId('zoom-levels')
        .getByRole('button', { name: '200%' })
        .dispatchEvent('click');
      await waitForZoom('200');
      await window
        .getByTestId('zoom-levels')
        .getByRole('button', { name: '100%' })
        .dispatchEvent('click');
      await waitForZoom('100');
      await window
        .getByTestId('zoom-levels')
        .getByRole('button', { name: 'Fit' })
        .dispatchEvent('click');
      await waitForZoom('fit');
      const box = await stageBox();
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await window.keyboard.down('Control');
      await window.mouse.wheel(0, -100);
      await window.keyboard.up('Control');
      await window.waitForFunction(
        () =>
          document.querySelector('[data-testid="loupe-stage"]')?.getAttribute('data-zoom') !==
          'fit',
      );
      await toFit();
    });

    it('pans with Space and a drag', async () => {
      await pointAtStripes();
      await window.keyboard.press('z');
      await waitForZoom('100');
      const before = await view();
      const box = await stageBox();
      await window.keyboard.down(' ');
      await window.waitForSelector('[data-testid="loupe-pan-layer"]');
      await window.mouse.move(box.x + 300, box.y + 300);
      await window.mouse.down();
      await window.mouse.move(box.x + 340, box.y + 320, { steps: 4 });
      await window.mouse.up();
      await window.keyboard.up(' ');
      const after = await view();
      expect(after.x - before.x).toBeCloseTo(40, 0);
      expect(after.y - before.y).toBeCloseTo(20, 0);
      await toFit();
    });

    it('never shows camera pixels of a retouched photo, at Fit or zoomed', async () => {
      const retouched = photos[2]!;
      await mosaicOver(retouched);
      await goTo(retouched);
      await toFit();
      await pointAtStripes();
      await window.keyboard.press('z');
      await waitForZoom('100');
      // Whatever the stage shows (the grey placeholder until the render arrives, then the edited
      // preview) has none of the patch's pure black and white.
      for (let i = 0; i < 10; i++) {
        expect(await patchExtremes()).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // The camera's JPEG is not what is shown: the retouched photo's frame is its edited preview.
      expect(await read('data-full-ready')).toBe('false');
      await toFit();
    });

    describe('a retouch added after the camera JPEG was shown or fetched', () => {
      /** Zoomed in on the patch of a photo, which must show the camera's pixels now. */
      const zoomOn = async (photo: Photo): Promise<void> => {
        await goTo(photo);
        await toFit();
        await pointAtStripes();
        await window.keyboard.press('z');
        await waitForZoom('100');
        await waitForFull();
        // The positive control: with no retouch the patch is on screen, sharp.
        expect(await patchExtremes()).toBeGreaterThan(500);
      };
      const expectNoCameraPixels = async (what: string): Promise<void> => {
        for (let i = 0; i < 8; i++) {
          expect(await patchExtremes(), what).toBe(0);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };

      it('replaces the zoomed image of the photo on screen', async () => {
        const photo = photos[3]!;
        await zoomOn(photo);
        await mosaicOver(photo);
        await window.waitForSelector('[data-testid="loupe-stage"][data-full-ready="false"]');
        await expectNoCameraPixels('the photo on screen');
        await window.keyboard.press('z');
        await waitForZoom('fit');
      });

      it('is not shown after a retouch made while the loupe was left, then zoomed again', async () => {
        const photo = photos[4]!;
        await zoomOn(photo);
        await window.keyboard.press('d');
        await window.waitForSelector('[data-testid="develop-canvas"]');
        await mosaicOver(photo);
        await window.keyboard.press('g');
        await window.keyboard.press('e');
        await window.waitForSelector('[data-testid="loupe-stage"]');
        await waitForPhoto(photo.id);
        await pointAtStripes();
        await window.keyboard.press('z');
        await waitForZoom('100');
        await expectNoCameraPixels('after coming back to the loupe');
        await toFit();
      });
    });

    it('is not shown for a neighbour that was retouched after it had been fetched ahead', async () => {
      // photos[1] is clean. Zoomed on photos[0], its full-size JPEG is fetched ahead.
      const neighbour = photos[1]!;
      await goTo(photos[0]!);
      await toFit();
      await pointAtStripes();
      await window.keyboard.press('z');
      await waitForZoom('100');
      await waitForFull();
      await waitForResponse(`app://full/${neighbour.id}`);
      await mosaicOver(neighbour);
      // The backend's update reaches the window as an event.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await window.keyboard.press('ArrowRight');
      await waitForPhoto(neighbour.id);
      for (let i = 0; i < 8; i++) {
        expect(await patchExtremes()).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await toFit();
    });

    it('Develop decodes the neighbours ahead, so an arrow key finds them done', async () => {
      await window.keyboard.press('g');
      await window.keyboard.press('d');
      await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', {
        timeout: 60_000,
      });
      const current = (await window
        .locator('[data-testid="photo-canvas"] [data-photo-id]')
        .getAttribute('data-photo-id'))!;
      const index = photos.findIndex((photo) => photo.id === current);
      const asked = (id: string) =>
        responses.some((url) => url.startsWith(`app://linear/${id}?`) && url.includes('warm=1'));
      const requested = (id: string) =>
        linearRequests.some(
          (url) => url.startsWith(`app://linear/${id}?`) && url.includes('warm=1'),
        );
      for (const next of [photos[index + 1], photos[index - 1]]) {
        if (!next) continue;
        for (let i = 0; i < 200 && !asked(next.id); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(asked(next.id), `${next.fileName} was warmed`).toBe(true);
        // The zoom test counts requests; this proves the window's requests are seen at all.
        expect(requested(next.id), `${next.fileName} was asked for`).toBe(true);
      }
    });

    it('had no errors in the console', () => {
      expect(problems).toEqual([]);
    });
  },
);
