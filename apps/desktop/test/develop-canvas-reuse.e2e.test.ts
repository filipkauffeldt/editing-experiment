// @vitest-environment node
import {
  asSourceId,
  type EditParams,
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
 * Develop keeps one canvas and one WebGL context while the photo changes. Every photo it shows
 * must still be exactly what a fresh canvas shows for that photo: the pixels the compositor has,
 * after photos of other sizes and shapes, after edits that use the neighbourhood passes, after a
 * crop session and a zoom. And while a photo is loading the canvas shows nothing of the last one.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 290 + (process.pid % 40);
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

interface Shape {
  width: number;
  height: number;
  edits: EditParams;
}

/** Sizes of every kind (landscape, portrait, square), with plain and neighbourhood edits and a crop. */
const SHAPES: Shape[] = [
  { width: 1600, height: 1000, edits: {} },
  { width: 1000, height: 1600, edits: { Exposure2012: 0.5, Clarity2012: 40 } },
  { width: 1200, height: 1200, edits: { Texture: 50, Sharpness: 60, Vibrance: 20 } },
  {
    width: 1600,
    height: 1000,
    edits: { crop: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9, angle: 3 } },
  },
  { width: 2000, height: 1250, edits: { Contrast2012: 30, Dehaze: 25 } },
];

/** A gradient with edges in it, different for every photo. */
async function makePhoto(index: number, shape: Shape): Promise<Buffer> {
  const { width, height } = shape;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const stripe = (Math.floor(x / 40) + Math.floor(y / 40) + index) % 2 === 0 ? 20 : 0;
      rgba[at] = 40 + Math.round((x / width) * 150) + stripe;
      rgba[at + 1] = 40 + Math.round((y / height) * 150) + index * 8;
      rgba[at + 2] = 60 + ((index * 53) % 120) + stripe;
      rgba[at + 3] = 255;
    }
  }
  return encodeJpeg(rgba, width, height, { quality: 95, chroma: '444', iccSrgb: true });
}

describe.skipIf(!haveDisplay)(
  'Develop reuses one canvas (real Electron app)',
  { timeout: 300_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let photos: Photo[];
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

    /** The photo is on screen: its stage is there and the canvas has drawn its first frame. */
    const waitForFrame = async (photo: Photo): Promise<void> => {
      await window.waitForFunction(
        (id) => {
          const stage = document.querySelector('[data-testid="photo-canvas"] [data-photo-id]');
          const canvas = document.querySelector('[data-testid="develop-canvas"]');
          return (
            stage?.getAttribute('data-photo-id') === id &&
            canvas?.getAttribute('data-visible') === 'true' &&
            canvas.getAttribute('data-ready') === 'true'
          );
        },
        photo.id,
        { timeout: 60_000 },
      );
      // The edited preview that belongs to the edits may be drawn meanwhile; the canvas is not its.
      await window.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await window.mouse.move(2, 2);
    };
    /** What the compositor shows of the canvas. */
    const shoot = async (): Promise<Buffer> =>
      window.locator('[data-testid="develop-canvas"]').screenshot({ type: 'png' });
    const step = async (from: number, to: number): Promise<void> => {
      for (let at = from; at !== to;) {
        const next = at + Math.sign(to - at);
        await window.keyboard.press(next > at ? 'ArrowRight' : 'ArrowLeft');
        await waitForFrame(photos[next]!);
        at = next;
      }
    };
    const contexts = (): Promise<number> =>
      window.evaluate(() => (window as unknown as { __webglContexts: number }).__webglContexts);

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-canvas-reuse-'));
      const card = join(root, 'card');
      mkdirSync(card);
      for (const [index, shape] of SHAPES.entries()) {
        writeFileSync(join(card, `burst_00${index + 1}.jpg`), await makePhoto(index, shape));
      }

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
      // Counts the WebGL contexts the page makes on canvas elements, before any script runs.
      await window.addInitScript(() => {
        const w = window as unknown as { __webglContexts: number };
        w.__webglContexts = 0;
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          if (type === 'webgl2' || type === 'webgl') w.__webglContexts += 1;
          return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof original;
      });
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
        const listed = await invoke<Photo[]>('photos:list');
        if (listed.length === SHAPES.length && listed.every((photo) => photo.width)) {
          photos = listed.sort((a, b) => a.fileName.localeCompare(b.fileName));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!photos) throw new Error('the photos were not ingested');
      for (const [index, shape] of SHAPES.entries()) {
        if (Object.keys(shape.edits).length === 0) continue;
        await invoke('develop:setParams', { photoId: photos[index]!.id, params: shape.edits });
      }
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    /** Reloads the window, so its first photo is drawn by a context that has drawn nothing before. */
    const openFresh = async (index: number): Promise<Buffer> => {
      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-testid="film-strip"] button');
      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.locator('[data-testid="film-strip"] button').nth(index).click();
      await window.waitForSelector('[data-testid="develop-canvas"]', { timeout: 60_000 });
      await waitForFrame(photos[index]!);
      expect(await contexts()).toBe(1);
      return shoot();
    };

    it('draws every photo as a fresh canvas does, with one context all along', async () => {
      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-testid="film-strip"] button');
      await window.locator('body').click({ position: { x: 5, y: 5 } });
      await window.keyboard.press('d');
      await waitForFrame(photos[0]!);

      // The canvas must be hidden from the moment a photo changes until its own first frame, and
      // must show nothing before it has been ready: a log of what the DOM said, after every change.
      await window.evaluate(() => {
        const log: { photo: string | null; visible: string | null; ready: string | null }[] = [];
        (window as unknown as { __canvasLog: typeof log }).__canvasLog = log;
        const root = document.querySelector('[data-testid="photo-canvas"]');
        if (!root) return;
        new MutationObserver(() => {
          const canvas = document.querySelector('[data-testid="develop-canvas"]');
          log.push({
            photo:
              document
                .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
                ?.getAttribute('data-photo-id') ?? null,
            visible: canvas?.getAttribute('data-visible') ?? null,
            ready: canvas?.getAttribute('data-ready') ?? null,
          });
        }).observe(document.body, { subtree: true, attributes: true, childList: true });
      });

      const seen = new Map<number, Buffer[]>();
      const visit = async (at: number, to: number): Promise<number> => {
        await step(at, to);
        const shots = seen.get(to) ?? [];
        shots.push(await shoot());
        seen.set(to, shots);
        return to;
      };
      let at = 0;
      seen.set(0, [await shoot()]);
      for (const to of [1, 2, 3, 4, 2, 0, 4, 1]) at = await visit(at, to);

      // A crop session and a zoom on one photo, then on to the next.
      await window.keyboard.press('c');
      await window.waitForSelector('[data-testid="crop-toolbar"]');
      await window.keyboard.press('Escape');
      await window.waitForSelector('[data-testid="crop-toolbar"]', { state: 'detached' });
      await window.mouse.move(2, 2);
      await window.keyboard.press('z');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom') === '100',
      );
      await window.keyboard.press('z');
      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-canvas"] [data-photo-id]')
            ?.getAttribute('data-zoom') === 'fit',
      );
      for (const to of [2, 0]) at = await visit(at, to);

      expect(await contexts()).toBe(1);

      // Nothing of the last photo showed while the next one loaded: the first thing the DOM said
      // about a photo was that its canvas is hidden, and it is only shown once it is ready.
      const log = await window.evaluate(
        () =>
          (
            window as unknown as {
              __canvasLog: { photo: string | null; visible: string | null; ready: string | null }[];
            }
          ).__canvasLog,
      );
      let previous: string | null = photos[0]!.id;
      for (const entry of log) {
        if (entry.photo !== previous && entry.photo !== null) {
          expect(entry.visible, `canvas when ${entry.photo} appeared`).not.toBe('true');
          previous = entry.photo;
        }
        if (entry.visible === 'true') expect(entry.ready).toBe('true');
      }

      // The same photo, drawn by a canvas that has drawn nothing before.
      for (const [index, shots] of seen) {
        const fresh = await openFresh(index);
        for (const [visitNumber, shot] of shots.entries()) {
          expect(
            shot.equals(fresh),
            `photo ${index + 1}, visit ${visitNumber + 1} differs from a fresh canvas`,
          ).toBe(true);
        }
      }
    });

    it('had no errors in the console', () => {
      expect(problems).toEqual([]);
    });
  },
);
