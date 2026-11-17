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

/**
 * The Library compare view in the real app, over five generated photos: a 2-up and a 2 x 2 grid,
 * one zoom and pan for every pane, labels and Delete on the active pane only, and Esc back to the
 * grid with the selection kept.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

const IMAGE = { width: 1600, height: 1000 };
const BLUES = [60, 120, 180, 90, 150];

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 290 + (process.pid % 50);
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
  return encodeJpeg(rgba, IMAGE.width, IMAGE.height, { quality: 90, chroma: '444', iccSrgb: true });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(!haveDisplay)('the Library compare view (real Electron app)', () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let photos: Photo[];
  const problems: string[] = [];
  const responses: string[] = [];

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

  const panes = () => window.locator('[data-testid="compare-pane"]');
  const boxes = async (): Promise<Box[]> => {
    const all = await panes().all();
    return Promise.all(all.map(async (pane) => (await pane.boundingBox())!));
  };
  const attributes = (name: string): Promise<string[]> =>
    window
      .locator('[data-testid="compare-stage"]')
      .evaluateAll(
        (stages, attribute) => stages.map((stage) => stage.getAttribute(attribute) ?? ''),
        name,
      );
  const activePhoto = (): Promise<string | null> =>
    window
      .locator('[data-testid="compare-pane"][data-active="true"]')
      .getAttribute('data-photo-id');
  const settle = async (): Promise<void> => {
    await window.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
  };
  const waitForResponse = async (fragment: string): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (responses.some((url) => url.includes(fragment))) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no response for ${fragment}; got ${responses.join(', ')}`);
  };
  /** Back in the grid with the first `count` photos selected. */
  const selectInGrid = async (count: number): Promise<void> => {
    await window.keyboard.press('g');
    await window.waitForSelector('[data-testid="library-grid"]');
    const cells = window.locator('[data-testid="library-cell"]');
    await cells.nth(0).click();
    if (count > 1) await cells.nth(count - 1).click({ modifiers: ['Shift'] });
    await expect
      .poll(() => window.locator('[data-testid="library-cell"][aria-selected="true"]').count())
      .toBe(count);
  };
  const waitForPanes = async (count: number): Promise<void> => {
    await window.waitForSelector(`[data-testid="compare-view"][data-count="${count}"]`);
    await expect.poll(() => panes().count()).toBe(count);
  };

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-compare-'));
    const card = join(root, 'card');
    mkdirSync(card);
    for (const [index, blue] of BLUES.entries()) {
      writeFileSync(join(card, `burst_00${index + 1}.jpg`), await makePhoto(blue));
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
        EE_TRASH_DIR: join(root, 'trash'),
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
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('is disabled for one photo and for five', async () => {
    const button = window.getByTestId('compare-button');
    await selectInGrid(1);
    await expect(button.isDisabled()).resolves.toBe(true);
    expect(await button.getAttribute('title')).toBe('Select 2 to 4 photos to compare');
    await selectInGrid(5);
    await expect(button.isDisabled()).resolves.toBe(true);
    await window.keyboard.press('v');
    await expect(window.getByTestId('compare-view').count()).resolves.toBe(0);
  });

  it('shows two photos side by side', async () => {
    await selectInGrid(2);
    await expect(window.getByTestId('compare-button').isDisabled()).resolves.toBe(false);
    await window.keyboard.press('v');
    await waitForPanes(2);
    const [left, right] = await boxes();
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(1);
    expect(Math.abs(left!.width - right!.width)).toBeLessThan(1.5);
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1);
    for (const photo of photos.slice(0, 2)) await waitForResponse(`app://preview/${photo.id}`);
  });

  it('shows four photos in a 2 x 2 grid and fetches their full-size images ahead', async () => {
    await window.keyboard.press('Escape');
    await selectInGrid(4);
    await window.keyboard.press('v');
    await waitForPanes(4);
    const [a, b, c, d] = await boxes();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(1);
    expect(Math.abs(c!.y - d!.y)).toBeLessThan(1);
    expect(Math.abs(a!.x - c!.x)).toBeLessThan(1);
    expect(c!.y).toBeGreaterThan(a!.y + a!.height - 1);
    expect(await attributes('data-photo-id')).toEqual(photos.slice(0, 4).map((photo) => photo.id));
    expect(await attributes('data-zoom')).toEqual(['fit', 'fit', 'fit', 'fit']);
    for (const photo of photos.slice(0, 4)) await waitForResponse(`app://full/${photo.id}`);
  });

  it('zooms and pans every pane together', async () => {
    await window.getByTestId('compare-view').hover();
    await window.keyboard.press('z');
    await window.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="compare-stage"]')].every(
        (stage) => stage.getAttribute('data-zoom') === '100',
      ),
    );
    await settle();
    const zoomed = await attributes('data-view');
    expect(new Set(zoomed).size).toBe(1);

    // A plain wheel over the third pane pans all four.
    const [, , third] = await boxes();
    await window.mouse.move(third!.x + third!.width / 2, third!.y + third!.height / 2);
    await window.mouse.wheel(0, 120);
    await expect
      .poll(async () => (await attributes('data-view')).every((view) => view !== zoomed[0]))
      .toBe(true);
    await settle();
    expect(new Set(await attributes('data-view')).size).toBe(1);
    expect(new Set(await attributes('data-zoom')).size).toBe(1);

    await window.keyboard.press('z');
    await window.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="compare-stage"]')].every(
        (stage) => stage.getAttribute('data-zoom') === 'fit',
      ),
    );
  });

  it('puts the tag and the rating on the active pane only', async () => {
    const first = photos[0]!.id;
    expect(await activePhoto()).toBe(photos[3]!.id);
    await window.keyboard.press('ArrowLeft');
    await window.keyboard.press('ArrowLeft');
    expect(await activePhoto()).toBe(photos[1]!.id);
    await window.keyboard.press('t');
    await window.keyboard.press('3');
    await expect
      .poll(async () =>
        (await invoke<Photo[]>('photos:list'))
          .filter((photo) => photo.tagged || photo.rating === 3)
          .map((photo) => photo.id),
      )
      .toEqual([photos[1]!.id]);
    const flags = window
      .locator(`[data-testid="compare-pane"][data-photo-id="${photos[1]!.id}"]`)
      .locator('[data-testid="compare-flags"]');
    await expect(flags.getByTestId('rating-stars').getAttribute('aria-label')).resolves.toBe(
      'Rating 3 of 5',
    );
    expect(
      await window.locator(`[data-photo-id="${first}"] [data-testid="rating-stars"]`).count(),
    ).toBe(0);
    // A click on a pane makes it active.
    await panes().nth(3).click();
    expect(await activePhoto()).toBe(photos[3]!.id);
  });

  it('deletes only the photo of the active pane and keeps comparing the others', async () => {
    expect(await activePhoto()).toBe(photos[3]!.id);
    await window.keyboard.press('Delete');
    const dialog = window.getByTestId('delete-photos-dialog');
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(photos[3]!.fileName);
    await window.getByTestId('delete-photos-confirm').click();
    await waitForPanes(3);
    expect(await attributes('data-photo-id')).toEqual(photos.slice(0, 3).map((photo) => photo.id));
    await expect
      .poll(async () => (await invoke<Photo[]>('photos:list')).map((photo) => photo.id).sort())
      .toEqual([...photos.slice(0, 3), photos[4]!].map((photo) => photo.id).sort());
  });

  it('goes back to the grid on Esc and keeps the selection', async () => {
    await window.keyboard.press('Escape');
    await window.waitForSelector('[data-testid="library-grid"]');
    await expect(window.getByTestId('compare-view').count()).resolves.toBe(0);
    await expect(
      window.locator('[data-testid="library-cell"][aria-selected="true"]').count(),
    ).resolves.toBe(3);
    expect(problems).toEqual([]);
  });
});
