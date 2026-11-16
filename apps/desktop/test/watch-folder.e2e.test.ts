// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IngestJobInfo, IpcResult, Photo, SourceConfig } from '@ee/contracts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, fixtureNefs, repoRoot } from './helpers/fixtures';

/**
 * A folder source that watches for new files, in the built app and real mode. The toggle is set
 * in Settings → Sources, the row shows the watch, and a restart must not resume it: nothing
 * watches outside an ingest run.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const nef = fixtureNefs()[0];
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 250 + (process.pid % 50);
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

describe.skipIf(nef === undefined || !haveDisplay)(
  'a folder that watches for new files (Electron)',
  { timeout: 90_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let userData: string;
    let sourceDir: string;

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

    const launch = async (): Promise<ElectronApplication> => {
      const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
      const launched = await electron.launch({
        executablePath: electronPath,
        args: [desktopDir],
        env: {
          ...(process.env as Record<string, string>),
          ...display.env,
          EE_MOCK: '',
          EE_USER_DATA_DIR: userData,
        },
      });
      window = await launched.firstWindow();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window
        .getByTestId('status-bar')
        .getByRole('tab', { name: 'Ingest' })
        .click({ timeout: 60_000 });
      await window.getByTestId('ingest-view').waitFor();
      return launched;
    };

    const sourceRow = () => window.getByTestId('ingest-source').filter({ hasText: 'Watch folder' });

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-watch-'));
      userData = join(root, 'userdata');
      sourceDir = join(root, 'drop');
      mkdirSync(sourceDir);
      display = await ensureDisplay();
      app = await launch();
    }, 180_000);

    afterAll(async () => {
      await app?.close().catch(() => undefined);
      display?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }, 60_000);

    it('saves Watch for new files on a folder source only', async () => {
      await window
        .getByTestId('ingest-view')
        .getByRole('button', { name: 'Folder or server' })
        .click();
      const dialog = window.getByTestId('settings-dialog');
      await dialog.waitFor();

      await dialog.getByTestId('add-source').click();
      await dialog.getByTestId('add-source-card').click();
      expect(await dialog.getByLabel('Watch for new files').count()).toBe(0);

      await dialog.getByTestId('add-source').click();
      await dialog.getByTestId('add-source-folder').click();
      await dialog.getByLabel('Name', { exact: true }).fill('Watch folder');
      await dialog.getByPlaceholder('/Volumes/CARD/DCIM').fill(sourceDir);
      const watch = dialog.getByLabel('Watch for new files');
      expect(await watch.isChecked()).toBe(false);
      await watch.check();
      await dialog.getByRole('button', { name: 'Save source' }).click();

      await expect
        .poll(async () => invoke<SourceConfig[]>('sources:list'), { timeout: 15_000 })
        .toContainEqual(
          expect.objectContaining({ kind: 'folder', watchForNewFiles: true, path: sourceDir }),
        );
      await dialog.locator('footer').getByRole('button', { name: 'Close' }).click();
    });

    it('shows the row watching and ingests a photo dropped in after the first pass', async () => {
      await window.getByTestId('ingest-destination').fill(join(root, 'ingest'));
      const row = sourceRow();
      await row.waitFor();

      await window
        .getByTestId('ingest-view')
        .getByRole('button', { name: /^Ingest/ })
        .click();
      await expect.poll(() => row.textContent(), { timeout: 30_000 }).toContain('watching');

      copyInto(nef!, join(sourceDir, 'DSC_0001.NEF'));
      copyInto(nef!, join(sourceDir, 'DSC_0002.NEF'));

      await expect
        .poll(async () => (await invoke<Photo[]>('photos:list')).length, { timeout: 60_000 })
        .toBe(2);
      await expect.poll(() => row.textContent(), { timeout: 15_000 }).toContain('watching 2/2');
      // Both were copied by this run: neither may be reported as already ingested.
      expect(await row.textContent()).not.toContain('already ingested');

      await row.getByRole('button', { name: 'Stop Watch folder' }).click();
      await expect.poll(() => row.textContent(), { timeout: 15_000 }).toContain('stopped');
      expect(await invoke<IngestJobInfo[]>('ingest:status')).toContainEqual(
        expect.objectContaining({ state: 'stopped' }),
      );
    });

    it('does not watch again after a restart, and starts nothing by itself', async () => {
      await app.close();
      app = await launch();
      await window.getByTestId('ingest-view').waitFor();
      await expect
        .poll(async () => invoke<IngestJobInfo[]>('ingest:status'), { timeout: 15_000 })
        .toEqual([]);

      copyInto(nef!, join(sourceDir, 'DSC_0003.NEF'));
      // Longer than the watcher's interval and quiet period: only a watching run would copy it.
      await window.waitForTimeout(5_000);

      expect(await invoke<Photo[]>('photos:list')).toHaveLength(2);
      // The saved option is there, but no run watches until Ingest is pressed.
      expect(await sourceRow().textContent()).toContain('watching for new files');
      expect(await sourceRow().textContent()).not.toMatch(/watching \d+\/\d+/);
      expect(await invoke<IngestJobInfo[]>('ingest:status')).toEqual([]);
    });
  },
);
