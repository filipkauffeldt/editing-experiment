// @vitest-environment node
import {
  asSourceId,
  type IpcResult,
  type SettingsFolderInfo,
  type SourceConfig,
} from '@ee/contracts';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';
import { repoRoot } from './helpers/fixtures';

/**
 * A second computer joins the settings folder: machine.json (per this computer) points at
 * the shared folder before launch, so the app reads it at start. The synced FTP source is
 * listed and says Password needed, because its `credentialRef` has no secret here.
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
  let number = 230 + (process.pid % 50);
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

const syncedSource: SourceConfig = {
  id: asSourceId('synced-pool'),
  kind: 'ftp',
  name: 'Synced pool — FTP',
  host: 'ftp.sportfotografen.se',
  port: 21,
  username: 'photographer',
  credentialRef: 'cred-synced-pool',
  remotePath: '/incoming',
  pollIntervalMs: 5000,
  deleteAfterDownload: false,
  security: 'none',
};

describe.skipIf(!haveDisplay)('settings folder (real Electron app)', { timeout: 300_000 }, () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let settingsFolder: string;
  let userData: string;

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

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-settings-folder-e2e-'));
    userData = join(root, 'userdata-b');
    settingsFolder = join(root, 'settings');
    const userDataA = join(root, 'userdata-a');
    mkdirSync(userData, { recursive: true });
    mkdirSync(settingsFolder, { recursive: true });
    mkdirSync(userDataA, { recursive: true });

    // Computer A writes the shared settings and keeps a folder source of its own.
    const a = new SettingsStore(join(userDataA, 'settings.json'), defaultSettings(root));
    a.useFolder(settingsFolder);
    a.saveSource(syncedSource);
    a.saveSource({
      id: asSourceId('card-a'),
      kind: 'folder',
      name: 'Card A on the other computer',
      path: join(root, 'card-a'),
    });

    // Computer B joins: only its machine.json names the folder.
    const b = new SettingsStore(join(userData, 'settings.json'), defaultSettings(root));
    b.useFolder(settingsFolder);

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
        EE_USER_DATA_DIR: userData,
      },
    });
    window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 873 }).catch(() => undefined);
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-store-ready="true"]');
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('reads the shared settings at start and shows the folder in use', async () => {
    const info = await invoke<SettingsFolderInfo>('settings:folder');
    expect(info).toMatchObject({ path: settingsFolder, isDefault: false, hasSettings: true });
    expect(info.problem).toBeUndefined();

    const sources = await invoke<SourceConfig[]>('sources:list');
    expect(sources.map((source) => source.id)).toEqual(['synced-pool']);

    const machine = JSON.parse(readFileSync(join(userData, 'machine.json'), 'utf8')) as {
      settingsFolder?: string;
    };
    expect(machine.settingsFolder).toBe(settingsFolder);
    expect(existsSync(join(userData, 'settings.json'))).toBe(false);

    await window.getByTestId('open-settings').click();
    await window.getByTestId('settings-dialog').waitFor();
    await window.getByRole('tab', { name: 'Settings folder' }).click();
    await window.getByTestId('settings-folder-path').waitFor();
    await window.waitForFunction(
      (path) =>
        document.querySelector('[data-testid="settings-folder-path"]')?.textContent === path,
      settingsFolder,
    );
    expect(await window.getByTestId('settings-folder-path').textContent()).toBe(settingsFolder);
    expect(await window.getByTestId('choose-settings-folder').count()).toBe(1);
  });

  it('lists the synced source and says its password is needed here', async () => {
    await window.getByRole('tab', { name: 'Sources' }).click();
    await window.getByText('Synced pool — FTP').first().waitFor();
    await window
      .getByText(/Password needed/)
      .first()
      .waitFor();
    expect(await window.getByText(/Password needed/).count()).toBeGreaterThan(0);
    expect(await window.getByText('Card A on the other computer').count()).toBe(0);
  });
});
