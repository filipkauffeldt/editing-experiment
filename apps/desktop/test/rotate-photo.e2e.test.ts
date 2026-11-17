// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { ExifToolService } from '@ee/metadata';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * Turning a photo in the built app (real mode): the shortcut and the photo menu in Develop, the
 * canvas, the film strip and the sidecar after it, and the undo that turns it back.
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
  let number = 200 + (process.pid % 50);
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number += 1;
  const child: ChildProcess = spawn(
    'Xvfb',
    [`:${number}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${number}`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { env: { DISPLAY: `:${number}` }, stop: () => void child.kill() };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

const COLOURS = {
  topLeft: [220, 30, 30],
  topRight: [30, 200, 30],
  bottomLeft: [30, 30, 220],
  bottomRight: [230, 220, 30],
} as const;
type Quarter = keyof typeof COLOURS;

/** A 120x80 picture with a different colour in each quarter. */
async function quarterJpeg(path: string): Promise<void> {
  const tile = (name: Quarter) => ({
    input: {
      create: {
        width: 60,
        height: 40,
        channels: 3 as const,
        background: { r: COLOURS[name][0], g: COLOURS[name][1], b: COLOURS[name][2] },
      },
    },
    left: name.endsWith('Left') ? 0 : 60,
    top: name.startsWith('top') ? 0 : 40,
  });
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#000' } })
    .composite((Object.keys(COLOURS) as Quarter[]).map(tile))
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toFile(path);
}

/** Which quarter each corner of a PNG screenshot shows, by nearest colour. */
async function quartersOfScreenshot(png: Buffer): Promise<Record<Quarter, Quarter>> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Quarter => {
    const i = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * 3;
    let best: Quarter = 'topLeft';
    let bestDistance = Infinity;
    for (const name of Object.keys(COLOURS) as Quarter[]) {
      const [r, g, b] = COLOURS[name];
      const distance = (data[i]! - r) ** 2 + (data[i + 1]! - g) ** 2 + (data[i + 2]! - b) ** 2;
      if (distance < bestDistance) [best, bestDistance] = [name, distance];
    }
    return best;
  };
  return {
    topLeft: at(0.2, 0.2),
    topRight: at(0.8, 0.2),
    bottomLeft: at(0.2, 0.8),
    bottomRight: at(0.8, 0.8),
  };
}

describe.skipIf(!haveDisplay)('turning a photo (real Electron app)', () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  const exiftool = new ExifToolService();

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

  const canvas = () => window.locator('[data-testid=develop-canvas]');
  const canvasWidth = async (): Promise<number> =>
    Number(await canvas().getAttribute('data-image-width'));
  const canvasShows = async (): Promise<Record<Quarter, Quarter>> =>
    quartersOfScreenshot(await canvas().screenshot());
  const thumbShape = (): Promise<string> =>
    window
      .locator('[data-testid=film-strip] [role=option] img')
      .first()
      .evaluate((image) => {
        const element = image as HTMLImageElement;
        return element.naturalWidth > element.naturalHeight ? 'landscape' : 'portrait';
      });

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-rotate-e2e-'));
    for (const name of ['card', 'ingest']) mkdirSync(join(root, name));
    await quarterJpeg(join(root, 'card', 'game_a.jpg'));

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
    await window.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

    const { ingest } = await invoke<{ ingest: IngestConfig }>('settings:get');
    const config = {
      ...ingest,
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: join(root, 'card') }],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'keep',
      renameTemplate: '{filenamebase}',
    };
    await invoke('settings:set', { ingest: config });
    await invoke('ingest:start', { config });
    await until('the photo', async () => (await invoke<Photo[]>('photos:list')).length === 1);
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    await exiftool.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('turns the open photo right and left, and undoes it, on the canvas, the film strip and the sidecar', async () => {
    await window.keyboard.press('d');
    await window.locator('[data-testid=film-strip] [role=option]').first().click();
    await until('the canvas', async () => (await canvas().getAttribute('data-ready')) === 'true');
    await until(
      'the first frame',
      async () => (await canvas().getAttribute('data-visible')) === 'true',
    );
    const landscapeWidth = await canvasWidth();
    expect(await thumbShape()).toBe('landscape');
    expect(await canvasShows()).toMatchObject({ topLeft: 'topLeft', bottomRight: 'bottomRight' });

    await window.keyboard.press('Control+ArrowRight');
    await until('the photo turned', async () => (await canvasWidth()) < landscapeWidth);
    await until(
      'the turned picture drawn',
      async () => (await canvas().getAttribute('data-visible')) === 'true',
    );
    // Turned right: the left side is the top, so the blue bottom left corner is now the top left.
    await until(
      'the canvas turned right',
      async () => (await canvasShows()).topLeft === 'bottomLeft',
    );
    expect(await canvasShows()).toEqual({
      topLeft: 'bottomLeft',
      topRight: 'topLeft',
      bottomLeft: 'bottomRight',
      bottomRight: 'topRight',
    });
    await until('a portrait thumbnail', async () => (await thumbShape()) === 'portrait');
    const [turned] = await invoke<Photo[]>('photos:list');
    expect(turned).toMatchObject({ rotation: 1, width: 80, height: 120 });
    const tags = await exiftool.read(join(root, 'ingest', 'game_a.jpg'));
    expect(tags['XMP-tiff:Orientation']).toBe(6);
    const shot = process.env.EE_SCREENSHOT_DIR;
    if (shot) await window.screenshot({ path: join(shot, 'rotate-develop-right.png') });

    await window.keyboard.press('Control+z');
    await until('the photo back', async () => (await canvasWidth()) === landscapeWidth);
    await until('a landscape thumbnail', async () => (await thumbShape()) === 'landscape');
    await until('the canvas upright', async () => (await canvasShows()).topLeft === 'topLeft');
    expect(
      (await exiftool.read(join(root, 'ingest', 'game_a.jpg')))['XMP-tiff:Orientation'],
    ).toBeUndefined();

    await window.keyboard.press('Control+ArrowLeft');
    await until('turned left', async () => (await canvasWidth()) < landscapeWidth);
    await until('the canvas turned left', async () => (await canvasShows()).topLeft === 'topRight');
    expect((await exiftool.read(join(root, 'ingest', 'game_a.jpg')))['XMP-tiff:Orientation']).toBe(
      8,
    );
  }, 120_000);

  it('turns from the photo menu', async () => {
    await window
      .locator('[data-testid=film-strip] [role=option]')
      .first()
      .click({ button: 'right' });
    await window.locator('[data-testid=photo-menu]').waitFor();
    await window.locator('[data-testid=photo-menu-rotate-right]').click();
    await until('the menu closed and the photo upright', async () => {
      const [photo] = await invoke<Photo[]>('photos:list');
      return photo !== undefined && photo.rotation === undefined && photo.width === 120;
    });
    await until('the canvas upright', async () => (await canvasShows()).topLeft === 'topLeft');
  }, 60_000);
});
