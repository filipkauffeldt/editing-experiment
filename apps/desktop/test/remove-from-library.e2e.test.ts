// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { asSourceId, type IngestConfig, type IpcResult, type Photo } from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * Remove from Library in the built app (real mode): the right-click menu, the confirmation, a
 * photo whose file was deleted outside the app, one whose file is still there (it must stay
 * removed after a restart), and that no file on disk is touched. `EE_TRASH_DIR` points main's
 * trash at a folder of the test; it must stay empty.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nefs = fixtureNefs().slice(0, 3);
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

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe.skipIf(nefs.length < 3 || !haveDisplay)(
  'removing photos from the Library (real Electron app)',
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    const dir = (name: string): string => join(root, name);

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

    async function launch(): Promise<void> {
      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      app = await electron.launch({
        executablePath: electronPath,
        args: [desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '',
          EE_USER_DATA_DIR: dir('userdata'),
          EE_TRASH_DIR: dir('trash'),
        },
      });
      window = await app.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    }

    const cells = () => window.locator('[data-testid=library-cell]');
    const cellFor = (fileName: string) =>
      window.locator(`[data-testid=library-cell][title^="${fileName}"]`);
    const shot = async (name: string): Promise<void> => {
      const out = process.env.EE_SCREENSHOT_DIR;
      if (out) await window.screenshot({ path: join(out, name) });
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-remove-e2e-'));
      for (const name of ['card', 'ingest', 'backup']) mkdirSync(dir(name));
      nefs.forEach((nef, index) => copyInto(nef, join(dir('card'), `game_${index + 1}.NEF`)));
      display = await ensureDisplay();
      await launch();

      const { ingest } = await invoke<{ ingest: IngestConfig }>('settings:get');
      await invoke('settings:set', {
        ingest: {
          ...ingest,
          destination: { path: dir('ingest') },
          backupDestination: { path: dir('backup') },
        },
      });
      await invoke('ingest:start', {
        config: {
          ...ingest,
          sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: dir('card') }],
          destination: { path: dir('ingest') },
          backupDestination: { path: dir('backup') },
          fileNaming: 'keep',
          renameTemplate: '{filenamebase}',
        },
      });
      await until('three photos', async () => (await invoke<Photo[]>('photos:list')).length === 3);
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    /** Name, bytes and mtime of every file in a folder: what "untouched" means. */
    const fingerprint = (folder: string): string[] =>
      list(folder).map(
        (name) =>
          `${name}:${readFileSync(join(folder, name)).length}:${statSync(join(folder, name)).mtimeMs}`,
      );

    it('removes a photo whose file is gone and one whose file is still there, touching no file, and neither comes back', async () => {
      await window.keyboard.press('g');
      await cells().first().waitFor();
      await until('three cells', async () => (await cells().count()) === 3);

      // Rating a photo writes its XMP sidecar next to the raw.
      await cellFor('game_2.NEF').click();
      await window.keyboard.press('3');
      await until('the sidecar', () => list(dir('ingest')).includes('game_2.xmp'));
      // The sidecar is created first and filled a moment later; let the app finish before the
      // fingerprint, so a later difference can only come from the removal.
      let last = '';
      await until('the sidecar to settle', async () => {
        const now = JSON.stringify(fingerprint(dir('ingest')));
        const stable = now === last;
        last = now;
        if (!stable) await sleep(700);
        return stable;
      });
      // game_1 was deleted outside the app: it still has its thumbnail and a "file not found" preview.
      rmSync(join(dir('ingest'), 'game_1.NEF'));
      const untouched = {
        ingest: fingerprint(dir('ingest')),
        backup: fingerprint(dir('backup')),
        card: fingerprint(dir('card')),
      };

      // Right-click a photo outside the selection: it is selected first, then the menu asks.
      await cellFor('game_3.NEF').click();
      await cellFor('game_1.NEF').click({ button: 'right' });
      await window.locator('[data-testid=photo-menu]').waitFor();
      expect(await cellFor('game_1.NEF').getAttribute('aria-selected')).toBe('true');
      const items = await window
        .locator('[data-testid=photo-menu] [role=menuitem]')
        .allTextContents();
      expect(items).toEqual(['Delete…', 'Remove from Library…']);
      await shot('remove-from-library-menu.png');
      await window.locator('[data-testid=photo-menu-remove-from-library]').click();
      const dialog = window.locator('[data-testid=delete-photos-dialog]');
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain('1 photo will be removed from the Library');
      await shot('remove-from-library-dialog.png');
      // Nothing happened yet. Selecting the photo whose file is gone may already have raised its
      // "file not found" toast; the removal must add none.
      expect(await cells().count()).toBe(3);
      const toastsBefore = await window.locator('[data-testid=toasts]').textContent();
      await window.keyboard.press('Enter');
      await dialog.waitFor({ state: 'detached' });
      await until('the photo to leave the grid', async () => (await cells().count()) === 2);
      expect(await window.locator('[data-testid=toasts]').textContent()).toBe(toastsBefore);

      // A photo whose file is still on disk, with its sidecar: Escape cancels, Enter removes.
      await cellFor('game_2.NEF').click({ button: 'right' });
      await window.locator('[data-testid=photo-menu-remove-from-library]').click();
      await dialog.waitFor();
      await window.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await cells().count()).toBe(2);
      await cellFor('game_2.NEF').click({ button: 'right' });
      await window.locator('[data-testid=photo-menu-remove-from-library]').click();
      await dialog.waitFor();
      await window.keyboard.press('Enter');
      await dialog.waitFor({ state: 'detached' });
      await until('the photo to leave the grid', async () => (await cells().count()) === 1);
      expect(await cellFor('game_3.NEF').getAttribute('aria-selected')).toBe('true');

      // Every file is exactly where and as it was (the one deleted outside the app stays gone).
      expect(fingerprint(dir('ingest'))).toEqual(untouched.ingest);
      expect(list(dir('ingest'))).toEqual(['game_2.NEF', 'game_2.xmp', 'game_3.NEF']);
      expect(fingerprint(dir('backup'))).toEqual(untouched.backup);
      expect(fingerprint(dir('card'))).toEqual(untouched.card);
      expect(list(dir('trash'))).toEqual([]);

      // Restart: the startup scan does not bring game_2 back as "Recovered".
      await app.close();
      await launch();
      await until('the photo list', async () => {
        const photos = await invoke<Photo[]>('photos:list');
        return photos.length > 0 && photos;
      });
      await sleep(2000);
      expect((await invoke<Photo[]>('photos:list')).map((photo) => photo.fileName)).toEqual([
        'game_3.NEF',
      ]);
      expect(fingerprint(dir('ingest'))).toEqual(untouched.ingest);
    }, 280_000);
  },
);
