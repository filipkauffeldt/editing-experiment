// Launches the built desktop app and saves PNGs.
// Usage: pnpm screenshot [--out <dir>]
//
// 01-07 are the mock-data UI tour (no camera, no disk). 10-14 are a real-mode
// run over the fetched CC0 NEF and face fixtures: developed raw, slider change,
// retouch face detection, mosaic preview and the upload popover after export.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOutDir(argv: string[]): string {
  const index = argv.indexOf('--out');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && !value) throw new Error('--out needs a directory');
  return resolve(value ?? join(root, 'screenshots'));
}

// Electron needs a display even when nothing is shown. On a headless Linux box,
// re-run ourselves under Xvfb instead of failing with an opaque Electron abort.
function ensureDisplay(): void {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(
      'No display found and xvfb-run is not installed.\n' +
        'Install it with: sudo apt install xvfb xauth   (or run with DISPLAY set)',
    );
    process.exit(1);
  }
  const rerun = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exit(rerun.status ?? 1);
}

const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: desktopRequire('electron') as string,
    args: [join(root, 'apps/desktop')],
    env: { ...(process.env as Record<string, string>), ...env },
  });
}

function watchErrors(window: Page): string[] {
  const problems: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  window.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

const shooter = (window: Page, outDir: string) => async (name: string, selector?: string) => {
  const path = join(outDir, name);
  if (selector) await window.locator(selector).screenshot({ path });
  else await window.screenshot({ path });
  console.log(`wrote ${path}`);
};

async function runMock(outDir: string): Promise<void> {
  const app = await launch({ EE_MOCK: '1', EE_SOFTWARE_GL: '1' });
  const shoot = shooter(await app.firstWindow(), outDir);
  try {
    const window = await app.firstWindow();
    const problems = watchErrors(window);
    await window.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('[data-testid="film-strip"] img')];
        return images.length > 0 && images.every((img) => (img as HTMLImageElement).complete);
      },
      undefined,
      { timeout: 20_000 },
    );
    await window.getByText('MOCK', { exact: true }).waitFor();
    // Let the mock ingest/upload simulation produce a little progress.
    await window.waitForTimeout(900);
    await shoot('01-main-1440.png');

    // A retouched photo shows the stacked-frame badge and an active upload.
    await window.locator('[title^="_DSC8332.NEF"]').click();
    await window.waitForTimeout(350);
    await shoot('02-film-strip-badges.png', '[data-testid="film-strip"]');

    // Photo 5 deliberately carries metadata that differs from the ingest template.
    await window.locator('[title^="_DSC8334.NEF"]').click();
    await window.locator('[data-caption-input]').waitFor();
    await window.waitForTimeout(350);
    await shoot('03-metadata-template-diff.png', '[data-testid="metadata-panel"]');

    await window.locator('[data-testid="upload-summary"]').click();
    await window.getByRole('dialog', { name: 'Upload queue' }).waitFor();
    await shoot('04-upload-popover.png');

    await window.keyboard.press('Escape');
    await window.locator('[data-testid="open-settings"]').click();
    await window.getByRole('dialog', { name: 'Settings' }).waitFor();
    await window.waitForTimeout(250);
    await shoot('05-source-settings.png');

    await window.getByRole('button', { name: 'Close', exact: true }).last().click();
    await window.waitForTimeout(150);
    await window.locator('[data-testid="photo-view"]').click({ position: { x: 10, y: 10 } });
    await window.keyboard.press('Shift+/');
    await window.getByTestId('shortcuts-overlay').waitFor();
    await shoot('06-shortcuts.png');

    await window.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1920, 1080);
    });
    await window.waitForTimeout(600);
    await shoot('07-main-1920.png');

    if (problems.length > 0) throw new Error(`renderer reported errors:\n${problems.join('\n')}`);
  } finally {
    await app.close();
  }
}

async function runReal(outDir: string): Promise<void> {
  const rawDir = join(root, 'fixtures', 'raw');
  const nefs = existsSync(rawDir)
    ? readdirSync(rawDir)
        .filter((name) => name.toLowerCase().endsWith('.nef'))
        .sort()
    : [];
  const face = join(root, 'fixtures', 'retouch', 'apollo11_crew.jpg');
  if (nefs.length === 0 || !existsSync(face)) {
    console.log('skipping real-mode screenshots: run `pnpm fetch-fixtures && pnpm fetch-retouch`');
    return;
  }

  const temp = mkdtempSync(join(tmpdir(), 'ee-shots-'));
  const source = join(temp, 'card');
  const destination = join(temp, 'out');
  const userData = join(temp, 'userdata');
  mkdirSync(source, { recursive: true });
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(rawDir, nefs[0]!), join(source, 'A1.NEF'));
  copyFileSync(face, join(source, 'B1.jpg'));
  copyFileSync(join(rawDir, nefs[1] ?? nefs[0]!), join(source, 'C1.NEF'));

  const app = await launch({ EE_MOCK: '', EE_SOFTWARE_GL: '1', EE_USER_DATA_DIR: userData });
  try {
    const window = await app.firstWindow();
    const problems = watchErrors(window);
    const shoot = shooter(window, outDir);
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForTimeout(1200);

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
      const typed = result as { ok: boolean; value?: T; error?: { message: string } };
      if (!typed.ok) throw new Error(`${channel}: ${typed.error?.message ?? 'failed'}`);
      return typed.value as T;
    };

    await invoke('develop:importPreset', {
      path: join(root, 'apps', 'desktop', 'test', 'fixtures', 'poc-preset.xmp'),
    });
    await window.reload();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForTimeout(800);

    await invoke('sources:save', {
      source: { id: 'shots-card', kind: 'folder', name: 'shots', path: source },
    });
    await invoke('destinations:save', {
      destination: {
        id: 'shots-out',
        kind: 'folder',
        name: 'Screenshot outbox',
        path: destination,
        remotePathTemplate: '{fileName}',
      },
    });
    await invoke('settings:set', {
      ingest: {
        destination: { path: join(temp, 'ingest') },
        renameTemplate: '{sourceName}_{seq:3}',
        codeReplacementPaths: [],
      },
      finishAction: {
        exportPreset: { quality: 90, metadata: 'all' },
        destinations: ['shots-out'],
      },
    });
    await invoke('ingest:start', {
      config: {
        sources: [{ id: 'shots-card', kind: 'folder', name: 'shots', path: source }],
        destination: { path: join(temp, 'ingest') },
        renameTemplate: '{sourceName}_{seq:3}',
        codeReplacementPaths: [],
      },
    });
    for (let i = 0; i < 200; i++) {
      if (((await invoke('photos:list')) as unknown[]).length >= 3) break;
      await window.waitForTimeout(150);
    }
    await window.waitForSelector('[data-testid="film-strip"] img', { timeout: 30_000 });
    await window.waitForTimeout(600);

    // Developed raw with the imported preset.
    await window.locator('button[title^="shots_001.NEF"]').click();
    await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', {
      timeout: 60_000,
    });
    const preset = window.getByRole('button', { name: /PoC Punchy/ });
    if (await preset.count()) await preset.click();
    await window.waitForTimeout(900);
    await shoot('10-real-main-developed.png');

    // A slider change on the same raw.
    const exposure = window.locator('input[aria-label="Exposure value"]');
    await exposure.fill('0.9');
    await exposure.blur();
    await window.waitForTimeout(600);
    await shoot('11-real-slider-change.png');

    // Retouch the face fixture: detect faces in a dragged region.
    await window.locator('button[title^="shots_002.jpg"]').click();
    await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', {
      timeout: 60_000,
    });
    await window.keyboard.press('r');
    await window.locator('[data-testid="retouch-toolbar"]').waitFor();
    await window.locator('[data-tool="faces"]').click();
    const overlay = window.locator('[data-testid="retouch-overlay"]');
    const box = await overlay.boundingBox();
    if (!box) throw new Error('retouch overlay has no bounds');
    await window.mouse.move(box.x + box.width * 0.04, box.y + box.height * 0.2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width * 0.96, box.y + box.height * 0.94, { steps: 12 });
    await window.mouse.up();
    for (let i = 0; i < 200; i++) {
      if ((await window.locator('[data-face-box]').count()) > 0) break;
      await window.waitForTimeout(150);
    }
    await window.waitForTimeout(900);
    await shoot('12-real-retouch-faces.png');

    // Bigger blocks show the mosaic preview clearly.
    await window.locator('input[aria-label="Mosaic block size"]').evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '0.022');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await window.waitForTimeout(900);
    await shoot('13-real-mosaic-preview.png');

    // Commit, finish and show the upload popover.
    await window.locator('[data-testid="commit-retouch"]').click();
    await window.locator('[data-testid="retouch-toolbar"]').waitFor({ state: 'detached' });
    await window.getByRole('button', { name: /Finish & next/ }).click();
    for (let i = 0; i < 400; i++) {
      const uploads = (await invoke('upload:list')) as { state: string }[];
      if (uploads.length > 0 && uploads.every((item) => item.state === 'done')) break;
      await window.waitForTimeout(300);
    }
    await window.locator('[data-testid="upload-summary"]').click();
    await window.getByRole('dialog', { name: 'Upload queue' }).waitFor();
    await window.waitForTimeout(400);
    await shoot('14-real-upload-popover.png');

    if (problems.length > 0) throw new Error(`renderer reported errors:\n${problems.join('\n')}`);
  } finally {
    await app.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  ensureDisplay();
  const outDir = parseOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  await runMock(outDir);
  await runReal(outDir);
}

await main();
