// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { asSourceId, type IpcResult } from '@ee/contracts';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * What the built app does around its own life: one instance per user data folder, the window it
 * comes back with, and the log file its three processes write. Each test starts its own app against
 * a throwaway folder.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const electronPath = createRequire(join(desktopDir, 'package.json'))('electron') as string;
const haveDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);

describe.skipIf(!haveDisplay)('app lifecycle (Electron)', () => {
  const running: ElectronApplication[] = [];
  const folders: string[] = [];

  const newFolder = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'ee-lifecycle-'));
    folders.push(folder);
    return folder;
  };

  const launch = async (userData: string): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await electron.launch({
      executablePath: electronPath,
      args: [desktopDir],
      env: { ...(process.env as Record<string, string>), EE_MOCK: '', EE_USER_DATA_DIR: userData },
    });
    running.push(app);
    const page = await app.firstWindow();
    await page.waitForFunction(() => 'eeTransport' in window);
    return { app, page };
  };

  const invoke = async <T>(page: Page, channel: string, ...args: unknown[]): Promise<T> => {
    const result = (await page.evaluate(
      ([name, params]) =>
        (
          window as unknown as {
            eeTransport: { invoke(c: string, a: unknown[]): Promise<unknown> };
          }
        ).eeTransport.invoke(name as string, params as unknown[]),
      [channel, args] as const,
    )) as IpcResult<T>;
    if (!result.ok) throw new Error(`${channel}: ${result.error.code}: ${result.error.message}`);
    return result.value;
  };

  const close = async (app: ElectronApplication): Promise<void> => {
    await app.close().catch(() => undefined);
    running.splice(running.indexOf(app), 1);
  };

  beforeAll(() => {
    if (!existsSync(join(desktopDir, 'out', 'main', 'index.js'))) {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }, 120_000);

  afterEach(async () => {
    for (const app of running.splice(0)) await app.close().catch(() => undefined);
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  describe('single instance', () => {
    it('hands a second launch over to the running window and exits', async () => {
      const userData = join(newFolder(), 'userdata');
      const { app } = await launch(userData);
      await app.evaluate(({ app: electronApp }) => {
        (globalThis as { __secondLaunches?: number }).__secondLaunches = 0;
        electronApp.on('second-instance', () => {
          (globalThis as { __secondLaunches?: number }).__secondLaunches! += 1;
        });
      });

      const second = spawn(electronPath, [desktopDir, '--no-sandbox'], {
        env: { ...process.env, EE_MOCK: '', EE_USER_DATA_DIR: userData },
        stdio: 'ignore',
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          second.kill();
          reject(new Error('the second launch did not exit'));
        }, 30_000);
        second.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      expect(exitCode).toBe(0);
      await vi.waitFor(async () =>
        expect(
          await app.evaluate(() => (globalThis as { __secondLaunches?: number }).__secondLaunches),
        ).toBe(1),
      );
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
        1,
      );
    }, 90_000);

    it('does not share the lock between different user data folders', async () => {
      const [first, second] = [join(newFolder(), 'userdata'), join(newFolder(), 'userdata')];
      const a = await launch(first);
      const b = await launch(second);
      expect(
        await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      ).toBe(1);
      expect(
        await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      ).toBe(1);
    }, 90_000);
  });

  describe('window state', () => {
    const bounds = (app: ElectronApplication) =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());

    it('comes back with the size and position it was closed with, kept apart from settings', async () => {
      const userData = join(newFolder(), 'userdata');
      const first = await launch(userData);
      await first.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setBounds({ x: 130, y: 70, width: 1111, height: 777 }),
      );
      await close(first.app);

      const saved = JSON.parse(readFileSync(join(userData, 'window-state.json'), 'utf8')) as object;
      expect(saved).toMatchObject({ x: 130, y: 70, width: 1111, height: 777, maximized: false });
      const settingsFile = join(userData, 'settings.json');
      if (existsSync(settingsFile)) {
        expect(readFileSync(settingsFile, 'utf8')).not.toContain('1111');
      }

      const second = await launch(userData);
      expect(await bounds(second.app)).toEqual({ x: 130, y: 70, width: 1111, height: 777 });
    }, 120_000);

    it('opens at the default place when the saved position is on no display', async () => {
      const userData = join(newFolder(), 'userdata');
      mkdirSync(userData, { recursive: true });
      writeFileSync(
        join(userData, 'window-state.json'),
        JSON.stringify({ x: 40_000, y: 30_000, width: 1111, height: 777, maximized: false }),
      );
      const { app } = await launch(userData);
      const placed = await bounds(app);
      expect(placed.x).toBeLessThan(10_000);
      expect(placed.y).toBeLessThan(10_000);
      expect([placed.width, placed.height]).not.toEqual([1111, 777]);
    }, 90_000);

    // Maximising needs a window manager. Bare Xvfb (Linux CI) has none and ignores the request, so
    // the test is skipped there and runs on Windows and on a desktop.
    it('remembers a maximised window and restores it maximised', async (context) => {
      const userData = join(newFolder(), 'userdata');
      const isMaximized = (app: ElectronApplication): Promise<boolean> =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
      const first = await launch(userData);
      await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
      const maximized = await vi
        .waitFor(async () => expect(await isMaximized(first.app)).toBe(true), { timeout: 3_000 })
        .then(
          () => true,
          () => false,
        );
      if (!maximized) {
        await close(first.app);
        context.skip('this display has no window manager, so a window cannot be maximised');
        return;
      }
      await close(first.app);
      expect(JSON.parse(readFileSync(join(userData, 'window-state.json'), 'utf8'))).toMatchObject({
        maximized: true,
      });

      const second = await launch(userData);
      await vi.waitFor(async () => expect(await isMaximized(second.app)).toBe(true));
    }, 120_000);
  });

  describe('log file', () => {
    const readLog = (userData: string): string => {
      const file = join(userData, 'logs', 'ee.log');
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    };

    it('keeps warnings, errors and uncaught failures of the main, jobs and renderer processes', async () => {
      const userData = join(newFolder(), 'userdata');
      // A settings file the jobs process cannot read: it warns about it with console.warn.
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(userData, 'settings.json'), '{ this is not json');
      const { app, page } = await launch(userData);

      await app.evaluate(() => {
        console.warn('main warning one');
        setTimeout(() => {
          throw new Error('main uncaught two');
        }, 0);
        void Promise.reject(new Error('main rejected three'));
      });
      await page.evaluate(() => {
        console.warn('renderer warning four');
        console.error('renderer error five');
        setTimeout(() => {
          throw new Error('renderer uncaught six');
        }, 0);
        void Promise.reject(new Error('renderer rejected seven'));
        console.log('renderer plain log, not kept');
      });
      // A failed ingest is reported by the jobs process as an event.
      await invoke(page, 'ingest:start', {
        config: {
          sources: [
            {
              id: asSourceId('gone'),
              name: 'Gone',
              kind: 'folder',
              path: join(userData, 'no-such-folder'),
            },
          ],
          destination: { path: join(userData, 'ingest') },
          fileNaming: 'rename',
          renameTemplate: '{sourceName}_{seq:3}',
        },
      });

      await vi.waitFor(() => {
        const text = readLog(userData);
        for (const needle of [
          '[main] main warning one',
          'main uncaught two',
          'main rejected three',
          '[renderer] renderer warning four',
          '[renderer] renderer error five',
          'renderer uncaught six',
          'renderer rejected seven',
          '[jobs] ',
        ]) {
          expect(text).toContain(needle);
        }
      });
      const text = readLog(userData);
      expect(text).not.toContain('renderer plain log');
      expect(text).toMatch(/WARN {2}\[jobs\] .*settings/i);
      expect(text).toMatch(/ERROR \[jobs\] ingest: .*no-such-folder/);
      expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z (WARN {2}|ERROR) \[/m);
    }, 120_000);

    it('has a Help menu with Open log folder', async () => {
      const { app } = await launch(join(newFolder(), 'userdata'));
      const items = await app.evaluate(({ Menu }) => {
        const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help');
        return help?.submenu?.items.map((item) => item.label) ?? [];
      });
      expect(items).toContain('Open log folder');
    }, 90_000);
  });
});
