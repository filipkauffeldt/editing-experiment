// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcResult, Photo } from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * "Add folder…" in the Library (real mode): the folder picker is answered by
 * `EE_PICK_FOLDER`, the photos appear where they are, the folder is in the sidebar, Rescan
 * folder picks up a file dropped in since, and Remove folder from Library drops the photos
 * while leaving every file untouched.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nefs = fixtureNefs().slice(0, 2);
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

describe.skipIf(nefs.length < 2 || !haveDisplay)(
  'opening an existing folder in the Library (real Electron app)',
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

    const cells = () => window.locator('[data-testid=library-cell]');
    const folderRow = (name: string) =>
      window.locator('[data-testid=library-folders] button').filter({ hasText: name });
    const shot = async (name: string): Promise<void> => {
      const out = process.env.EE_SCREENSHOT_DIR;
      if (out) await window.screenshot({ path: join(out, name) });
    };

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        // pnpm is a .cmd shim on Windows, which spawn only starts through a shell.
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-open-folder-e2e-'));
      mkdirSync(dir('library'));
      mkdirSync(dir('media'));
      nefs.forEach((nef, index) =>
        copyInto(nef, join(dir('library'), `existing_${index + 1}.NEF`)),
      );

      display = await ensureDisplay();
      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      app = await electron.launch({
        executablePath: electronPath,
        args: [desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '',
          EE_USER_DATA_DIR: dir('userdata'),
          // No cards on this machine's real mounts, and the picker answers with our folder.
          EE_CARD_ROOTS: dir('media'),
          EE_PICK_FOLDER: dir('library'),
        },
      });
      window = await app.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    }, 240_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('adds a folder where it is, rescans it, and removes it without touching a file', async () => {
      await window.keyboard.press('g');
      await window.getByTestId('library-view').waitFor();
      await window.getByTestId('library-add-folder').waitFor();
      const original = nefs.map((_, index) => ({
        bytes: readFileSync(join(dir('library'), `existing_${index + 1}.NEF`)).toString('base64'),
        mtimeMs: statSync(join(dir('library'), `existing_${index + 1}.NEF`)).mtimeMs,
      }));

      await window.getByTestId('library-add-folder').click();
      await until('the first photo', async () => (await cells().count()) === 1);
      expect(await folderRow('library').count()).toBe(1);

      // Rescan folder picks up a file that appeared since; nothing else changes.
      copyInto(nefs[1]!, join(dir('library'), 'existing_3.NEF'));
      await folderRow('library').click({ button: 'right' });
      const menu = window.getByTestId('folder-menu');
      await menu.waitFor();
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
        'Rescan folder',
        'Remove folder from Library…',
      ]);
      await shot('open-folder-menu.png');
      await window.getByTestId('folder-menu-rescan').click();
      await until('the third photo', async () => (await cells().count()) === 3);
      expect((await invoke<Photo[]>('photos:list')).map((photo) => photo.fileName).sort()).toEqual([
        'existing_1.NEF',
        'existing_2.NEF',
        'existing_3.NEF',
      ]);

      // Remove folder from Library: the count, the promise that no file is touched, a dialog.
      await folderRow('library').click({ button: 'right' });
      await window.getByTestId('folder-menu-remove').click();
      const dialog = window.getByTestId('folder-remove-dialog');
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain('3 photos in this folder will be removed');
      expect(await dialog.textContent()).toContain('Files on disk are not touched');
      await shot('open-folder-remove-dialog.png');
      await window.getByTestId('folder-remove-confirm').click();
      await dialog.waitFor({ state: 'detached' });
      await until('the photos to leave the grid', async () => (await cells().count()) === 0);
      expect(await folderRow('library').count()).toBe(0);
      expect(await invoke<Photo[]>('photos:list')).toEqual([]);

      for (let index = 0; index < 3; index += 1) {
        const path = join(dir('library'), `existing_${index + 1}.NEF`);
        expect(readFileSync(path).toString('base64')).toBe(
          index < 2 ? original[index]!.bytes : readFileSync(nefs[1]!).toString('base64'),
        );
        if (index < 2) expect(statSync(path).mtimeMs).toBe(original[index]!.mtimeMs);
      }
    }, 240_000);
  },
);
