// @vitest-environment node
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  asSourceId,
  type IngestConfig,
  type IpcResult,
  type Photo,
} from '@ee/contracts';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyInto, faceJpeg, fixtureNefs, hasFaceFixtures, repoRoot } from './helpers/fixtures';

/**
 * Starts the packaged app (the AppImage on Linux, the installed or unpacked app on Windows) and
 * proves what the development run cannot: that everything the app needs at run time is inside
 * the package. A raw is ingested through the Rust addon and ExifTool, previews are served, a face is
 * found with onnxruntime and the YuNet model, and a second launch hands over to the first.
 *
 * `EE_PACKAGED_APP` names the executable. On Linux it defaults to the AppImage that
 * `pnpm dist:linux` writes. Without either the file is skipped.
 */
const desktopDir = join(repoRoot, 'apps', 'desktop');
const version = (
  JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const defaultAppImage = join(
  desktopDir,
  'release',
  `editing-experiment-${version}-linux-x64.AppImage`,
);
const packaged =
  process.env.EE_PACKAGED_APP ??
  (process.platform === 'linux' && existsSync(defaultAppImage) ? defaultAppImage : undefined);
const isAppImage = packaged?.endsWith('.AppImage') === true;
const nef = fixtureNefs()[0];
const haveDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);

/**
 * The AppImage runs through its own extract-and-run mode, so no FUSE is needed. The environment
 * variable is the runtime's switch for `--appimage-extract-and-run` and keeps the argument list
 * free for the app.
 */
const appEnv = (extra: Record<string, string>): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  APPIMAGE_EXTRACT_AND_RUN: '1',
  EE_MOCK: '',
  ...extra,
});

describe.skipIf(!packaged || !nef || !haveDisplay)('packaged app', () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let userData: string;
  const photos: Record<string, Photo> = {};

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const result = (await window.evaluate(
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

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ee-packaged-'));
    userData = join(root, 'userdata');
    const card = join(root, 'card');
    mkdirSync(card);
    copyInto(nef!, join(card, 'DSC_0001.NEF'));
    if (hasFaceFixtures()) copyInto(faceJpeg, join(card, 'DSC_0002.jpg'));

    app = await electron.launch({
      executablePath: packaged!,
      // Playwright adds --no-sandbox itself unless asked not to. The AppImage decides instead.
      chromiumSandbox: true,
      env: appEnv({ EE_USER_DATA_DIR: userData }),
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);

    const config: IngestConfig = {
      sources: [{ id: asSourceId('card'), name: 'card', kind: 'folder', path: card }],
      destination: { path: join(root, 'ingest') },
      fileNaming: 'rename',
      renameTemplate: '{sourceName}_{seq:3}',
    };
    await invoke('ingest:start', { config });
    const expected = hasFaceFixtures() ? 2 : 1;
    for (let i = 0; i < 600; i++) {
      const listed = await invoke<Photo[]>('photos:list');
      if (listed.length >= expected) {
        for (const photo of listed) photos[photo.fileName.split('.').pop()!.toLowerCase()] = photo;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!photos['nef']) throw new Error('no photo was ingested by the packaged app');
  }, 240_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('opens its window with the version it was built as', async () => {
    const facts = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
      packaged: electronApp.isPackaged,
      version: electronApp.getVersion(),
      userData: electronApp.getPath('userData'),
      windows: BrowserWindow.getAllWindows().length,
    }));
    expect(facts).toEqual({ packaged: true, version, userData, windows: 1 });
    expect(await window.locator('[data-testid="status-bar"]').innerText()).toMatch(/Ingest/);
    const info = await invoke<{ appVersion: string; mock: boolean; coreVersion: string }>(
      'system:info',
    );
    expect(info.appVersion).toBe(version);
    expect(info.mock).toBe(false);
    expect(info.coreVersion).toMatch(/^\d+\.\d+/);
  });

  it('answers from the jobs process', async () => {
    const ping = await invoke<{ echo: string; jobsPid: number }>('system:ping', { message: 'pkg' });
    expect(ping.echo).toBe('pkg');
    expect(ping.jobsPid).not.toBe(process.pid);
  });

  it('ingests a raw through the Rust core and serves its previews', async () => {
    const photo = photos['nef']!;
    expect(photo.captureTime).toBeTruthy();
    for (const url of [appUrl.thumb(photo.id), appUrl.preview(photo.id)]) {
      const result = await window.evaluate(async (target) => {
        const response = await fetch(target);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, magic: [...bytes.slice(0, 3)], length: bytes.length };
      }, url);
      expect(result.status).toBe(200);
      expect(result.magic).toEqual([0xff, 0xd8, 0xff]);
      expect(result.length).toBeGreaterThan(1000);
    }
    // The full decode goes through LibRaw inside the addon.
    const linear = await window.evaluate(
      async ([url, headerName]) => {
        const response = await fetch(url as string);
        return { status: response.status, header: response.headers.get(headerName as string) };
      },
      [appUrl.linear(photo.id, 256), LINEAR_IMAGE_HEADER] as const,
    );
    expect(linear.status).toBe(200);
    expect(JSON.parse(linear.header!).sampleType).toBe('f16');
  });

  it('writes and reads metadata through the bundled ExifTool', async () => {
    const photo = photos['nef']!;
    await invoke('metadata:write', { photoId: photo.id, fields: { caption: 'Packaged smoke' } });
    expect(
      await invoke<{ caption?: string }>('metadata:read', { photoId: photo.id }),
    ).toMatchObject({ caption: 'Packaged smoke' });
    expect(existsSync(photo.sidecarPath)).toBe(true);
  });

  it.skipIf(!hasFaceFixtures())('finds faces with the bundled model and onnxruntime', async () => {
    const faces = await invoke<unknown[]>('retouch:detectFaces', { photoId: photos['jpg']!.id });
    expect(faces.length).toBeGreaterThan(0);
  });

  it('keeps its settings in the default settings folder below the user data folder', async () => {
    const folder = await invoke<{
      path: string;
      isDefault: boolean;
      problem?: string;
    }>('settings:folder');
    expect(folder.problem).toBeUndefined();
    expect(folder.isDefault).toBe(true);
    expect(folder.path.startsWith(userData)).toBe(true);
    await invoke('settings:set', { exportRoot: join(root, 'exports') });
    expect(await invoke<{ exportRoot: string }>('settings:get')).toMatchObject({
      exportRoot: join(root, 'exports'),
    });
    expect(existsSync(join(userData, 'machine.json'))).toBe(true);
  });

  it('keeps its log under the user data folder', () => {
    expect(existsSync(join(userData, 'logs'))).toBe(true);
  });

  it('hands a second launch over to the running instance and exits', async () => {
    const second = spawn(packaged!, [], {
      env: appEnv({ EE_USER_DATA_DIR: userData }),
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill();
        reject(new Error('the second launch did not exit'));
      }, 60_000);
      second.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  }, 90_000);

  // Redirected through XDG_CONFIG_HOME. Windows ignores APPDATA for this, so the test would use the
  // real profile there and meet a running app's instance lock.
  it.skipIf(process.platform !== 'linux')(
    'uses its own user data folder by default, apart from a development run',
    async () => {
      const home = join(root, 'home');
      mkdirSync(home);
      const other = await electron.launch({
        executablePath: packaged!,
        chromiumSandbox: true,
        env: appEnv({
          XDG_CONFIG_HOME: home,
          EE_USER_DATA_DIR: '',
        }),
      });
      try {
        const path = await other.evaluate(({ app: electronApp }) =>
          electronApp.getPath('userData'),
        );
        expect(path).toBe(join(home, 'Editing Experiment'));
      } finally {
        await other.close().catch(() => undefined);
      }
    },
    90_000,
  );

  it.skipIf(!isAppImage)('has no sandbox flag in the desktop entry', () => {
    const extracted = join(root, 'extracted');
    mkdirSync(extracted);
    execFileSync(packaged!, ['--appimage-extract'], { cwd: extracted });
    const desktop = readFileSync(
      join(extracted, 'squashfs-root', 'editing-experiment.desktop'),
      'utf8',
    );
    expect(desktop).not.toContain('--no-sandbox');
  });
});
