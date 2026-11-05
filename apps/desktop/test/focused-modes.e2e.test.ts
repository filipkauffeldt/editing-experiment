// @vitest-environment node
import {
  LINEAR_IMAGE_HEADER,
  asSourceId,
  type IngestConfig,
  type IpcResult,
  type Photo,
} from '@ee/contracts';
import { encodeJpeg } from '@ee/core';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * The panels, Retouch and Crop in the real app, driven with a real mouse and keyboard over a
 * generated photo: Tab hides and shows the panels, Retouch and Crop open with them hidden, Done and
 * Enter leave, Alt draws a lasso for a face search, and a drawing lands under the pointer.
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(!haveDisplay)(
  'focused Retouch and Crop (real Electron app)',
  { timeout: 240_000 },
  () => {
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

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        // pnpm is a .cmd shim on Windows, which spawn only starts through a shell.
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-focus-'));
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

    const waitForCaption = async (expected: string): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        const fields = await invoke<{ caption?: string }>('metadata:read', { photoId: photo.id });
        if (fields.caption === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`the caption was not written: ${expected}`);
    };

    const canvasBox = async (): Promise<Box> => {
      const box = await window.locator('[data-testid="photo-canvas"]').boundingBox();
      if (!box) throw new Error('no photo canvas');
      return box;
    };
    const metadataVisible = (): Promise<boolean> =>
      window.locator('[data-testid="metadata-panel"]').isVisible();
    const stripVisible = (): Promise<boolean> =>
      window.locator('[data-testid="film-strip"]').isVisible();
    const toolbar = () => window.locator('[data-testid="retouch-toolbar"]');
    const resizeWindow = async (width: number, height: number): Promise<void> => {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
        { width, height },
      );
      await window.waitForFunction((expected) => globalThis.innerWidth === expected, width);
      await settle();
    };
    /** A drag with the real mouse between two page positions; `alt` holds Alt through it. */
    const drag = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      options: { alt?: boolean; during?: () => Promise<void> } = {},
    ): Promise<void> => {
      if (options.alt) await window.keyboard.down('Alt');
      await window.mouse.move(from.x, from.y);
      await window.mouse.down();
      await window.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 + 20, { steps: 6 });
      await window.mouse.move(to.x, to.y, { steps: 6 });
      await options.during?.();
      await window.mouse.up();
      if (options.alt) await window.keyboard.up('Alt');
    };
    /** A point on the picture at Fit, as fractions of the stage. */
    const pagePoint = async (fx: number, fy: number): Promise<{ x: number; y: number }> => {
      const box = await stageBox();
      return { x: box.x + box.width * fx, y: box.y + box.height * fy };
    };
    const retouchVersions = async (): Promise<number> =>
      (await invoke<Photo>('photos:get', { photoId: photo.id })).versions.filter(
        (version) => version.kind === 'retouch',
      ).length;

    it('Tab hides and shows the panels, film strip and filter row in Develop, not in a text field', async () => {
      await window.mouse.move(2, 2);
      expect(await metadataVisible()).toBe(true);
      expect(await stripVisible()).toBe(true);
      const shown = await canvasBox();

      await window.keyboard.press('Tab');
      await window.waitForFunction(
        () =>
          document.querySelector('[data-testid="develop-view"]')?.getAttribute('data-panels') ===
          'hidden',
      );
      await settle();
      expect(await metadataVisible()).toBe(false);
      expect(await stripVisible()).toBe(false);
      expect(await window.locator('[data-testid="sliders"]').isVisible()).toBe(false);
      const hidden = await canvasBox();
      expect(hidden.width).toBeGreaterThan(shown.width + 400);
      expect(hidden.height).toBeGreaterThan(shown.height + 40);

      await window.keyboard.press('Tab');
      await settle();
      expect(await metadataVisible()).toBe(true);
      expect(await stripVisible()).toBe(true);
      expect((await canvasBox()).width).toBeCloseTo(shown.width, 0);

      // In a text field Tab moves the focus and nothing hides.
      const caption = window.locator('[data-caption-input]');
      await caption.click();
      await window.keyboard.press('Tab');
      expect(await metadataVisible()).toBe(true);
      expect(await caption.evaluate((element) => document.activeElement === element)).toBe(false);
      // Shift+Tab is not a toggle either.
      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.keyboard.press('Shift+Tab');
      expect(await metadataVisible()).toBe(true);
    });

    it('Tab hides the sidebar and the inspector in the Library', async () => {
      await window.mouse.move(2, 2);
      await window.keyboard.press('g');
      await window.locator('[data-testid="library-view"]').waitFor();
      expect(await window.locator('[data-testid="library-sidebar"]').isVisible()).toBe(true);
      await window.keyboard.press('Tab');
      await window.waitForFunction(
        () =>
          document.querySelector('[data-testid="library-view"]')?.getAttribute('data-panels') ===
          'hidden',
      );
      expect(await window.locator('[data-testid="library-sidebar"]').isVisible()).toBe(false);
      expect(await window.locator('[data-testid="library-right-panels"]').isVisible()).toBe(false);
      await window.keyboard.press('Tab');
      expect(await window.locator('[data-testid="library-sidebar"]').isVisible()).toBe(true);
      await window.keyboard.press('d');
      await settle();
    });

    it('opens Retouch with the panels hidden and the photo larger, on one toolbar row', async () => {
      await window.mouse.move(2, 2);
      const before = await stageBox();
      await window.keyboard.press('r');
      await toolbar().waitFor();
      await settle();
      expect(await metadataVisible()).toBe(false);
      expect(await stripVisible()).toBe(false);
      const after = await stageBox();
      expect(after.width * after.height).toBeGreaterThan(before.width * before.height * 1.4);

      // One row at 1440 wide, with Done at the right end and no Mosaic button.
      const bar = await toolbar().boundingBox();
      expect(bar?.height ?? 999).toBeLessThan(44);
      expect(await window.getByRole('button', { name: /^Mosaic/ }).count()).toBe(0);
      expect(await window.getByRole('button', { name: /Delete version/ }).count()).toBe(0);
      expect(await window.getByRole('button', { name: 'Detect faces' }).count()).toBe(0);
      // Rectangle and Lasso appear once.
      expect(await window.getByRole('button', { name: 'Rectangle' }).count()).toBe(1);
      expect(await window.getByRole('button', { name: 'Lasso' }).count()).toBe(1);
      const done = await window.getByTestId('done-retouch').boundingBox();
      expect(done && bar ? done.x + done.width : 0).toBeGreaterThan(
        (bar?.x ?? 0) + (bar?.width ?? 0) - 24,
      );

      // The footer has the hint, not a second way out.
      expect(await window.getByTestId('focus-hint').textContent()).toContain('Enter or Esc saves');
      expect(await window.getByTestId('toggle-retouch').count()).toBe(0);
      expect(await window.getByTestId('toggle-crop').count()).toBe(0);

      // Tab brings the panels back for this session, and takes them away again.
      await window.keyboard.press('Tab');
      await settle();
      expect(await metadataVisible()).toBe(true);
      expect(await stripVisible()).toBe(true);
      // The toolbar keeps its height when the width shrinks: it wraps, never changes with the tool.
      const narrow = await toolbar().boundingBox();
      await window.getByRole('button', { name: 'Rectangle' }).click();
      await window.getByRole('button', { name: 'Subtract' }).click();
      expect((await toolbar().boundingBox())?.height).toBeCloseTo(narrow?.height ?? 0, 0);
      await window.getByRole('button', { name: 'Add' }).click();
      await window.keyboard.press('Tab');
      await settle();
      expect(await metadataVisible()).toBe(false);

      // Esc leaves (nothing to save) and the plain Develop view is back, with its panels.
      await window.mouse.move(2, 2);
      await window.keyboard.press('Escape');
      await toolbar().waitFor({ state: 'detached' });
      await settle();
      expect(await metadataVisible()).toBe(true);
      expect(await stripVisible()).toBe(true);
    });

    it('draws under the pointer, before and after Tab refits the canvas and the mosaic', async () => {
      await window.mouse.move(2, 2);
      await window.keyboard.press('r');
      await toolbar().waitFor();
      await settle();
      await window.getByRole('button', { name: 'Rectangle' }).click();

      const checkRectangle = async (fx: [number, number], fy: [number, number]): Promise<void> => {
        const stageNow = await stageBox();
        const before = await window.locator('[data-area-kind="rect"]').count();
        await drag(await pagePoint(fx[0], fy[0]), await pagePoint(fx[1], fy[1]));
        await window.waitForFunction(
          (count) => document.querySelectorAll('[data-area-kind="rect"]').length === count + 1,
          before,
        );
        const bounds = await window
          .locator('[data-area-kind="rect"]')
          .last()
          .evaluate((element) => {
            const box = (element as unknown as SVGGeometryElement).getBBox();
            return { x: box.x, y: box.y, w: box.width, h: box.height };
          });
        expect(bounds.x).toBeCloseTo(fx[0], 1);
        expect(bounds.y).toBeCloseTo(fy[0], 1);
        expect(bounds.w).toBeCloseTo(fx[1] - fx[0], 1);
        expect(bounds.h).toBeCloseTo(fy[1] - fy[0], 1);
        expect(stageNow.width).toBeGreaterThan(100);
      };
      await checkRectangle([0.2, 0.4], [0.3, 0.6]);

      // Tab refits: the canvas and the mosaic canvas stay the same size, and drawing still lands.
      await window.keyboard.press('Tab');
      await settle();
      await window.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="develop-canvas"]');
        const mosaic = document.querySelector<HTMLCanvasElement>('[data-testid="mosaic-canvas"]');
        return (
          canvas !== null &&
          mosaic !== null &&
          canvas.width === mosaic.width &&
          canvas.height === mosaic.height
        );
      });
      const sizes = await window.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="develop-canvas"]')!;
        const mosaic = document.querySelector<HTMLCanvasElement>('[data-testid="mosaic-canvas"]')!;
        return { canvas: [canvas.width, canvas.height], mosaic: [mosaic.width, mosaic.height] };
      });
      expect(sizes.mosaic).toEqual(sizes.canvas);
      await checkRectangle([0.5, 0.7], [0.2, 0.5]);
      await window.keyboard.press('Tab');
      await settle();
      await checkRectangle([0.1, 0.25], [0.7, 0.9]);

      // Done saves and leaves.
      await window.getByTestId('done-retouch').click();
      await toolbar().waitFor({ state: 'detached' });
      await window.getByTestId('retouch-version-indicator').waitFor();
      expect(await retouchVersions()).toBe(1);
    });

    it('draws a lasso search area for Faces when Alt is held, and a rectangle otherwise', async () => {
      await window.mouse.move(2, 2);
      await window.keyboard.press('r');
      await toolbar().waitFor();
      await settle();
      await window.getByRole('button', { name: 'Faces' }).click();
      const overlay = window.locator('[data-testid="retouch-overlay"]');

      const a = await pagePoint(0.15, 0.2);
      const b = await pagePoint(0.8, 0.85);
      let polylineDuringAlt = 0;
      await drag(a, b, {
        alt: true,
        during: async () => {
          polylineDuringAlt = await overlay.locator('polyline').count();
        },
      });
      expect(polylineDuringAlt).toBe(1);

      let polylineWithout = -1;
      let rectWithout = 0;
      await drag(a, b, {
        during: async () => {
          polylineWithout = await overlay.locator('polyline').count();
          rectWithout = await overlay.locator('path[class*="shape"]').count();
        },
      });
      expect(polylineWithout).toBe(0);
      expect(rectWithout).toBe(1);
      // Nothing was added by either (the mock-free detector found no faces in the pattern).
      await window.keyboard.press('Escape');
      await toolbar().waitFor({ state: 'detached' });
    });

    it('does Done on Enter, but not while a value is being typed', async () => {
      await window.mouse.move(2, 2);
      const before = await retouchVersions();
      await window.keyboard.press('r');
      await toolbar().waitFor();
      await window.getByRole('button', { name: 'Rectangle' }).click();
      await drag(await pagePoint(0.6, 0.3), await pagePoint(0.75, 0.5));
      await window.waitForFunction(
        () => document.querySelectorAll('[data-area-kind="rect"]').length >= 2,
      );

      const field = window.getByLabel('Block size in px');
      await field.click();
      await window.keyboard.press('Control+A');
      await window.keyboard.type('64');
      await window.keyboard.press('Enter');
      // Enter committed the value; the session is still open.
      await toolbar().waitFor();
      expect(await field.inputValue()).toBe('64');

      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.keyboard.press('Enter');
      await toolbar().waitFor({ state: 'detached' });
      // Done saved it into the one retouch version.
      expect(await retouchVersions()).toBe(before);
      const saved = (await invoke<Photo>('photos:get', { photoId: photo.id })).versions.find(
        (version) => version.kind === 'retouch',
      )?.ops[0];
      expect(saved?.type === 'mosaic' ? (saved.areas ?? []).length : 0).toBeGreaterThanOrEqual(2);
    });

    it('keeps an unsaved caption edit when Retouch hides the panel', async () => {
      await window.mouse.move(2, 2);
      const caption = window.locator('[data-caption-input]');
      await caption.click();
      await window.keyboard.press('Control+A');
      await window.keyboard.type('Header at the near post');
      // Straight into Retouch with the footer button, well inside the save debounce.
      await window.getByTestId('toggle-retouch').click();
      await toolbar().waitFor();
      expect(await metadataVisible()).toBe(false);
      await window.keyboard.press('Escape');
      await toolbar().waitFor({ state: 'detached' });
      await window.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>('[data-caption-input]')?.value ===
          'Header at the near post',
      );
      await waitForCaption('Header at the near post');
    });

    it('deletes the retouch version from the footer after confirming', async () => {
      await window.mouse.move(2, 2);
      expect(await window.getByTestId('toggle-retouch').count()).toBe(1);
      const button = window.getByTestId('delete-retouch');
      expect(await button.textContent()).toContain('Delete retouch…');
      expect(await retouchVersions()).toBe(1);

      // Declining keeps it.
      window.once('dialog', (dialog) => void dialog.dismiss());
      await button.click();
      await window.waitForTimeout(300);
      expect(await retouchVersions()).toBe(1);

      window.once('dialog', (dialog) => void dialog.accept());
      await button.click();
      await window.waitForFunction(
        () => document.querySelector('[data-testid="delete-retouch"]') === null,
      );
      expect(await retouchVersions()).toBe(0);
    });

    it('opens Crop with the panels hidden, one row, Enter as Done, and a footer without Apply crop', async () => {
      await window.mouse.move(2, 2);
      await window.keyboard.press('c');
      await window.locator('[data-testid="crop-toolbar"]').waitFor();
      await settle();
      expect(await metadataVisible()).toBe(false);
      expect(await stripVisible()).toBe(false);
      const bar = await window.locator('[data-testid="crop-toolbar"]').boundingBox();
      expect(bar?.height ?? 999).toBeLessThan(44);
      expect(await window.getByTestId('toggle-crop').count()).toBe(0);
      expect(await window.getByText('Apply crop').count()).toBe(0);
      expect(await window.getByTestId('focus-hint').textContent()).toContain('Esc cancels');

      await window.keyboard.press('Tab');
      expect(await metadataVisible()).toBe(true);
      await window.keyboard.press('Tab');
      await window.getByRole('button', { name: '1:1' }).click();
      await window.mouse.move(2, 2);
      await window.keyboard.press('Enter');
      await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
      expect(await metadataVisible()).toBe(true);
      const params = await invoke<{ crop?: unknown }>('develop:getParams', { photoId: photo.id });
      expect(params.crop).toBeDefined();
    });

    it('keeps the picture size and the footer on one line at 1440 and 1024 wide', async () => {
      // `sizeRequired`: Retouch and Crop hide the panels, so the footer is wide and shows the size
      // at both widths. In Develop at 1024 the details give way last first and the size, the
      // second item, may drop out whole; it is then never half cut.
      const check = async (sizeRequired: boolean): Promise<void> => {
        const footer = window.locator('[data-testid="photo-view"] footer');
        const metrics = await footer.evaluate((element) => {
          const size = element.querySelector<HTMLElement>('span[class*="size"]');
          const top = element.getBoundingClientRect();
          const at = size?.getBoundingClientRect();
          return {
            height: top.height,
            sizeShown: at !== undefined && at.top >= top.top && at.bottom <= top.bottom + 1,
            sizeClipped: size ? size.scrollWidth > size.clientWidth : true,
            sizeText: size?.textContent ?? '',
            buttonsWrapped: [...element.querySelectorAll<HTMLElement>('button')].some(
              (button) => button.getBoundingClientRect().height > 30,
            ),
          };
        });
        expect(metrics.sizeText).toContain('3200 × 2000');
        expect(metrics.sizeClipped).toBe(false);
        if (sizeRequired) expect(metrics.sizeShown).toBe(true);
        expect(metrics.buttonsWrapped).toBe(false);
        expect(metrics.height).toBeLessThan(34);
      };
      for (const width of [1440, 1024]) {
        await resizeWindow(width, 800);
        await check(width === 1440);
        await window.keyboard.press('c');
        await window.locator('[data-testid="crop-toolbar"]').waitFor();
        await check(true);
        await window.keyboard.press('Escape');
        await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
      }
      await resizeWindow(1440, 900);
    });
  },
);
