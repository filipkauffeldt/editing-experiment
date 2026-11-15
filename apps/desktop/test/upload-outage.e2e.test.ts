// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * The upload queue of a destination that cannot be reached must read as waiting, not failed,
 * in the top bar and in the popover, and a waiting item must still be cancellable. The mock data
 * keeps one upload waiting, so the whole path runs through Electron, preload and the renderer.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const haveDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);

describe.skipIf(!haveDisplay)('upload outage in the app (Electron)', () => {
  let app: ElectronApplication;
  let window: Page;
  let userData: string;

  beforeAll(async () => {
    if (!existsSync(join(desktopDir, 'out', 'main', 'index.js'))) {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
    }
    userData = mkdtempSync(join(tmpdir(), 'ee-upload-outage-'));
    app = await electron.launch({
      executablePath: createRequire(join(desktopDir, 'package.json'))('electron') as string,
      args: [desktopDir],
      env: {
        ...(process.env as Record<string, string>),
        EE_MOCK: '1',
        EE_SOFTWARE_GL: '1',
        EE_USER_DATA_DIR: join(userData, 'userdata'),
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-store-ready="true"]');
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData) rmSync(userData, { recursive: true, force: true });
  }, 60_000);

  it('shows waiting for connection apart from failed and cancels the waiting item', async () => {
    const waiting = window.getByTestId('upload-waiting-summary');
    await waiting.waitFor({ timeout: 20_000 });
    expect((await waiting.textContent()) ?? '').toContain('Waiting for connection');
    expect(((await waiting.textContent()) ?? '').replace(/\s+/g, ' ')).toMatch(
      /Waiting for connection 1/,
    );
    // The same queue also has a real failure; it must not swallow the waiting count.
    const failed = window.getByTestId('failed-summary');
    await failed.waitFor();
    expect(((await failed.textContent()) ?? '').replace(/\s+/g, ' ')).toContain('1 failed');

    await waiting.click();
    const popover = window.getByRole('dialog', { name: 'Upload queue' });
    await popover.waitFor();
    const row = popover.getByTestId('upload-item-mock-upload-05');
    await row.waitFor();
    expect(((await row.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(
      'Waiting for connection',
    );
    expect(((await row.textContent()) ?? '').replace(/\s+/g, ' ')).toContain(
      'Cannot reach the server',
    );
    expect(await row.getByRole('button', { name: 'Retry' }).count()).toBe(0);

    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect
      .poll(async () => ((await row.textContent()) ?? '').includes('Cancelled'))
      .toBe(true);
    await expect.poll(async () => waiting.count()).toBe(0);
  }, 30_000);
});
