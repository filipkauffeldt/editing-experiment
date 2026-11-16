// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { ExifToolService, toIsoDate } from '@ee/metadata';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * The capture time dialog in the built app (real mode): the right-click action, the preview,
 * Enter to apply, and the film strip reordering itself by the new time.
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
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe.skipIf(!haveDisplay)('shifting the capture time (real Electron app)', () => {
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

  const frames = () =>
    window
      .locator('[data-testid=film-strip] [role=option]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('title') ?? ''));

  async function makeJpeg(name: string, clock: string): Promise<string> {
    const path = join(root, 'card', name);
    const [date, time] = clock.split(' ');
    const iso = `${date!.replaceAll(':', '-')}T${time!}`;
    await sharp({ create: { width: 48, height: 32, channels: 3, background: '#284' } })
      .jpeg()
      .toFile(path);
    await exiftool.write(path, {
      'EXIF:DateTimeOriginal': clock,
      'EXIF:CreateDate': clock,
      'EXIF:SubSecTimeOriginal': '31',
      'EXIF:OffsetTimeOriginal': '+02:00',
      'XMP-exif:DateTimeOriginal': `${iso}.310+02:00`,
      'XMP-xmp:CreateDate': `${iso}.310+02:00`,
      'XMP-photoshop:DateCreated': `${iso}.310+02:00`,
      'IPTC:DateCreated': iso.slice(0, 10).replaceAll('-', ''),
      'IPTC:TimeCreated': `${iso.slice(11)}+02:00`,
    });
    return path;
  }

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-shift-e2e-'));
    for (const name of ['card', 'ingest']) mkdirSync(join(root, name));
    await makeJpeg('game_a.jpg', '2026:10:03 18:10:00');
    await makeJpeg('game_b.jpg', '2026:10:03 18:11:00');
    await makeJpeg('game_c.jpg', '2026:10:03 18:12:00');

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
    await window.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

    const { ingest } = await invoke<{ ingest: IngestConfig }>('settings:get');
    await invoke('settings:set', {
      ingest: {
        ...ingest,
        destination: { path: join(root, 'ingest') },
        fileNaming: 'keep',
        renameTemplate: '{filenamebase}',
      },
    });
    await invoke('ingest:start', {
      config: {
        ...ingest,
        sources: [
          {
            id: asSourceId('card'),
            name: 'card',
            kind: 'folder',
            path: join(root, 'card'),
          },
        ],
        destination: { path: join(root, 'ingest') },
        fileNaming: 'keep',
        renameTemplate: '{filenamebase}',
      },
    });
    await until('three photos', async () => (await invoke<Photo[]>('photos:list')).length === 3);
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    await exiftool.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('opens from the photo menu, previews the offset and reorders the film strip', async () => {
    await window.keyboard.press('d');
    await window.locator('[data-testid=film-strip]').waitFor();
    await until('the film strip in capture time order', async () => (await frames()).length === 3);
    expect((await frames()).map((title) => title.split(' — ')[0])).toEqual([
      'game_a.jpg',
      'game_b.jpg',
      'game_c.jpg',
    ]);

    await window
      .locator('[data-testid=film-strip] [role=option]')
      .first()
      .click({ button: 'right' });
    await window.locator('[data-testid=photo-menu]').waitFor();
    await window.locator('[data-testid=photo-menu-shift-capture-time]').click();

    const dialog = window.locator('[data-testid=shift-capture-time-dialog]');
    await dialog.waitFor();
    await window.locator('[data-testid=shift-capture-time-minutes]').fill('5');
    const preview = await window.locator('[data-testid=shift-capture-time-preview]').textContent();
    expect(preview).toContain('2026-10-03 18:10:00');
    expect(preview).toContain('2026-10-03 18:15:00');
    expect(await dialog.textContent()).toContain('1 photo will change');
    const shot = process.env.EE_SCREENSHOT_DIR;
    if (shot) await window.screenshot({ path: join(shot, 'shift-capture-time-dialog.png') });

    await window.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await until(
      'the shifted photo to sort last',
      async () =>
        (await frames()).map((title) => title.split(' — ')[0]).join(',') ===
        'game_b.jpg,game_c.jpg,game_a.jpg',
    );
    if (shot) await window.screenshot({ path: join(shot, 'shift-capture-time-film-strip.png') });

    const tags = await exiftool.read(join(root, 'ingest', 'game_a.jpg'));
    expect(toIsoDate(tags['ExifIFD:DateTimeOriginal'])).toBe('2026-10-03T18:15:00');
    expect(toIsoDate(tags['XMP-exif:DateTimeOriginal'])).toBe('2026-10-03T18:15:00.310+02:00');
    expect(String(tags['ExifIFD:OffsetTimeOriginal'])).toBe('+02:00');
  }, 60_000);
});
