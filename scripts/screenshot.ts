// Launches the built desktop app and saves PNGs.
// Usage: pnpm screenshot [--out <dir>]
//
// 01-09 are the mock-data UI tour (no camera, no disk), including crop mode
// and a cropped result; 19-22 add the Library grid with a multi-selection, the
// loupe, retouch mode and the Ingest module. 10-18 and 23 are a real-mode run over the fetched CC0 NEF and
// face fixtures: developed raw, slider change, retouch face detection, mosaic
// preview and the upload popover after export, plus (17, 18) crop mode
// mid-rotation with the fine grid and the committed crop, and (23) the Library
// over the ingested files.
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
  const app = await launch({ EE_MOCK: '1', EE_SOFTWARE_GL: '1', EE_SCREENSHOTS: '1' });
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
    await window.waitForFunction(() =>
      /ingesting [1-9]\d*\/\d+/.test(document.body.textContent ?? ''),
    );
    await shoot('01-main-1440.png');

    // Copy Settings: Lightroom-style groups, Crop off by default.
    await window.getByTestId('open-copy-settings').click();
    await window.getByTestId('copy-settings-dialog').waitFor();
    await shoot('01b-copy-settings.png');
    await window.keyboard.press('Escape');

    // A retouched photo shows the stacked-frame badge and an active upload.
    await window.locator('[title^="_DSC8332.NEF"]').click();
    await window.waitForFunction(
      () =>
        document.querySelector('button[title^="_DSC8332.NEF"]')?.getAttribute('aria-selected') ===
        'true',
    );
    await shoot('02-film-strip-badges.png', '[data-testid="film-strip"]');

    // Crop mode: full image dimmed outside a 1:1 crop with a 3 degree straighten.
    await window.locator('[data-testid="toggle-crop"]').click();
    await window.locator('[data-testid="crop-toolbar"]').waitFor();
    await window.locator('[data-aspect="1:1"]').click();
    await window.locator('input[aria-label="Straighten angle"]').evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await shoot('08-crop-mode.png');
    await window.locator('[data-testid="apply-crop"]').click();
    await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
    await shoot('09-cropped-result.png');

    // Photo 5 deliberately carries metadata that differs from the ingest template.
    await window.locator('[title^="_DSC8334.NEF"]').click();
    await window.locator('[data-caption-input]').waitFor();
    await window.waitForFunction(() =>
      document.querySelector('[data-testid="metadata-panel"]')?.textContent?.includes('Liverpool'),
    );
    await shoot('03-metadata-template-diff.png', '[data-testid="metadata-panel"]');

    await window.locator('[data-testid="upload-summary"]').click();
    await window.getByRole('dialog', { name: 'Upload queue' }).waitFor();
    await shoot('04-upload-popover.png');

    await window.keyboard.press('Escape');
    await window.locator('[data-testid="open-settings"]').click();
    await window.getByRole('dialog', { name: 'Settings' }).waitFor();
    await shoot('05-source-settings.png');
    await window.getByTestId('settings-dialog').getByRole('tab', { name: 'Ingest' }).click();
    await window.getByText('Develop preset', { exact: true }).waitFor();
    await shoot('05c-ingest-settings.png');

    await window.getByRole('button', { name: 'Close', exact: true }).last().click();
    await window.getByTestId('open-export').click();
    await window.getByTestId('export-dialog').waitFor();
    await shoot('05b-export-dialog.png');
    await window.keyboard.press('Escape');
    await window.locator('[data-testid="photo-view"]').click({ position: { x: 10, y: 10 } });
    await window.keyboard.press('F1');
    await window.getByTestId('shortcuts-overlay').waitFor();
    await shoot('06-shortcuts.png');

    await window.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1920, 1080);
    });
    await window.waitForFunction(() => document.documentElement.clientWidth >= 1900);
    await shoot('07-main-1920.png');

    // Tone curve: point mode with three points, then the red channel.
    await window.getByTestId('tone-curve').scrollIntoViewIfNeeded();
    await window.getByRole('tab', { name: 'Point (RGB)' }).click();
    const curve = await window.getByTestId('tone-curve-graph').boundingBox();
    if (curve) {
      await window.mouse.click(curve.x + curve.width * 0.5, curve.y + curve.height * 0.45);
    }
    await shoot('25-tone-curve-point.png', '[data-testid="tone-curve"]');
    await window.getByRole('tab', { name: 'Red' }).click();
    const red = await window.getByTestId('tone-curve-graph').boundingBox();
    if (red) {
      await window.mouse.click(red.x + red.width * 0.45, red.y + red.height * 0.6);
    }
    await shoot('26-tone-curve-red.png', '[data-testid="tone-curve"]');
    await window.getByTestId('color-grading').scrollIntoViewIfNeeded();
    const wheelOffsets = [
      ['shadows', 0.32, 0.3],
      ['midtones', 0.72, 0.5],
      ['highlights', 0.45, 0.72],
    ] as const;
    for (const [region, x, y] of wheelOffsets) {
      const wheel = await window.getByTestId(`grading-wheel-${region}`).boundingBox();
      if (wheel) {
        await window.mouse.click(wheel.x + wheel.width * x, wheel.y + wheel.height * y);
      }
    }
    await shoot('27-color-grading-3way.png', '[data-testid="color-grading"]');

    // Library: click, Shift-range and Ctrl-toggle build a multi-selection.
    await window.keyboard.press('g');
    await window.locator('[data-testid="library-grid"]').waitFor();
    await window.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-testid="library-cell"] img')];
      return images.length > 0 && images.every((img) => (img as HTMLImageElement).complete);
    });
    const cells = window.locator('[data-testid="library-cell"]');
    await cells.nth(0).click();
    await cells.nth(5).click({ modifiers: ['Shift'] });
    await cells.nth(9).click({ modifiers: ['ControlOrMeta'] });
    await shoot('19-library-grid-selection.png');

    await window.keyboard.press('e');
    await window.locator('[data-testid="library-loupe"] img').first().waitFor();
    await shoot('20-library-loupe.png');
    await window.keyboard.press('g');

    // Retouch module: the retouch session on the Develop layout.
    await window.keyboard.press('d');
    await window.locator('[data-testid="film-strip"]').waitFor();
    await window.keyboard.press('r');
    await window.locator('[data-testid="retouch-toolbar"]').waitFor();
    await window.waitForTimeout(800);
    await shoot('21-retouch-mode.png');
    await window.keyboard.press('Escape');
    await window.locator('[data-testid="retouch-toolbar"]').waitFor({ state: 'detached' });

    // Develop tools: histogram, clipping overlay, before/after split and the
    // white balance picker loupe.
    await window.locator('[title^="_DSC8334.NEF"]').click();
    await window.waitForSelector('[data-testid="histogram"][data-has-data="true"]');
    await window.keyboard.press('j');
    const exposure = window.locator('input[aria-label="Exposure value"]');
    await exposure.fill('2.5');
    await exposure.blur();
    const blacks = window.locator('input[aria-label="Blacks value"]');
    await blacks.fill('-100');
    await blacks.blur();
    await window.waitForTimeout(300);
    await shoot('28-clipping-overlay.png');
    await window.keyboard.press('j');

    await window.locator('[title^="_DSC8336.NEF"]').click();
    await window.waitForTimeout(200);
    const splitExposure = window.locator('input[aria-label="Exposure value"]');
    await splitExposure.fill('1');
    await splitExposure.blur();
    await window.getByTestId('split-view').click();
    await window.locator('[data-testid="split-divider"]').waitFor();
    await window.waitForTimeout(300);
    await shoot('29-before-after-split.png');
    await window.getByTestId('split-view').click();

    await window.locator('[title^="_DSC8337.NEF"]').click();
    await window.waitForTimeout(200);
    await window.getByTestId('wb-picker').click();
    const canvasBox = await window.locator('[data-testid="photo-canvas"]').boundingBox();
    if (canvasBox) {
      await window.mouse.move(
        canvasBox.x + canvasBox.width * 0.42,
        canvasBox.y + canvasBox.height * 0.46,
      );
    }
    await window.locator('[data-testid="wb-loupe"]').waitFor();
    await window.waitForTimeout(200);
    await shoot('30-wb-picker-loupe.png');

    // Camera profiles. Mock mode has no Adobe files, so the names are made up.
    await window.keyboard.press('d');
    await window.locator('[data-testid="film-strip"]').waitFor();
    const profile = window.getByRole('combobox', { name: 'Camera profile' });
    await profile.waitFor();
    await window.waitForFunction(
      () =>
        ((document.querySelector('select[aria-label="Camera profile"]') as HTMLSelectElement | null)
          ?.options.length ?? 0) > 1,
    );
    await profile.selectOption({ label: 'Adobe Color' });
    await window.waitForTimeout(600);
    await window.locator('[data-testid="camera-profile"]').scrollIntoViewIfNeeded();
    await shoot('23-camera-profile.png', '[data-testid="camera-profile"]');
    await window.getByRole('button', { name: /Browse profile folders/ }).click();
    await window.getByTestId('profiles-settings').waitFor();
    await shoot('23b-profile-folders.png');
    await window.keyboard.press('Escape');

    await window.getByRole('tab', { name: 'Ingest' }).click();
    await window.locator('[data-testid="ingest-view"]').waitFor();
    await shoot('22-ingest.png');

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

  const app = await launch({
    EE_MOCK: '',
    EE_SOFTWARE_GL: '1',
    EE_SCREENSHOTS: '1',
    EE_USER_DATA_DIR: userData,
  });
  try {
    const window = await app.firstWindow();
    const problems = watchErrors(window);
    const shoot = shooter(window, outDir);
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-store-ready="true"]');

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
      exportRoot: join(temp, 'exports'),
      exportPresets: [
        {
          id: 'shots-preset',
          name: 'Sportfotografen',
          folderTemplate: '{folder}/Export/{preset}',
          fileNameTemplate: '{filenamebase}',
          ifExists: 'suffix',
          format: 'jpeg',
          quality: 90,
          colorSpace: 'srgb',
          resize: { mode: 'none' },
          outputSharpening: { target: 'none', amount: 'standard' },
          metadata: 'all',
          stripGps: false,
          version: 'top',
          sendTo: ['shots-out'],
        },
      ],
      activePresetId: 'shots-preset',
    });
    await window.reload();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-store-ready="true"]');
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
    await window.waitForFunction(() => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>('[data-testid="film-strip"] img'),
      ];
      return (
        images.length >= 3 && images.every((image) => image.complete && image.naturalWidth > 0)
      );
    });

    // Developed raw with the imported preset.
    await window.locator('button[title^="shots_001.NEF"]').click();
    await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', {
      timeout: 60_000,
    });
    const canvas = window.locator('[data-testid="develop-canvas"]');
    const renderVersion = async (): Promise<number> =>
      Number((await canvas.getAttribute('data-render-version')) ?? 0);
    const preset = window.getByRole('button', { name: /PoC Punchy/ });
    if (await preset.count()) {
      const before = await renderVersion();
      await preset.click();
      await window.waitForFunction(
        ([selector, version]) =>
          Number(document.querySelector(selector)?.getAttribute('data-render-version') ?? 0) >
          Number(version),
        ['[data-testid="develop-canvas"]', before] as const,
      );
    }
    await shoot('10-real-main-developed.png');

    // A slider change on the same raw.
    const exposure = window.locator('input[aria-label="Exposure value"]');
    const beforeExposure = await renderVersion();
    await exposure.fill('0.9');
    await exposure.blur();
    await window.waitForFunction(
      ([selector, version]) =>
        Number(document.querySelector(selector)?.getAttribute('data-render-version') ?? 0) >
        Number(version),
      ['[data-testid="develop-canvas"]', beforeExposure] as const,
    );
    await shoot('11-real-slider-change.png');

    // Lens Corrections: the camera's own profile, read from the NEF, with Remove CA on.
    const lens = window.locator('[data-testid="lens-corrections"]');
    await lens.scrollIntoViewIfNeeded();
    await window.getByLabel('Enable profile corrections').check();
    await window.getByLabel('Remove chromatic aberration').check();
    await window.waitForTimeout(800);
    await shoot('24-real-lens-corrections.png', '[data-testid="lens-corrections"]');

    // Crop mode, Lightroom style: drag outside the frame to rotate the photo
    // under it, with the finer grid up while rotating; Enter commits.
    await window.keyboard.press('c');
    await window.locator('[data-testid="crop-toolbar"]').waitFor();
    const cropOverlay = window.locator('[data-testid="crop-overlay"]');
    const cropBox = await cropOverlay.boundingBox();
    const frame = ((await cropOverlay.getAttribute('data-frame')) ?? '').split(',').map(Number);
    if (!cropBox || frame.length !== 4) throw new Error('crop overlay has no frame');
    const [frameLeft = 0, frameTop = 0, frameWidth = 0, frameHeight = 0] = frame;
    const centreX = cropBox.x + frameLeft + frameWidth / 2;
    const centreY = cropBox.y + frameTop + frameHeight / 2;
    // Start 18 px outside the lower-right corner and sweep 6 degrees clockwise around the centre.
    const outsideX = cropBox.x + frameLeft + frameWidth + 18 - centreX;
    const outsideY = cropBox.y + frameTop + frameHeight + 18 - centreY;
    const sweep = (6 * Math.PI) / 180;
    await window.mouse.move(centreX + outsideX, centreY + outsideY);
    await window.mouse.down();
    await window.mouse.move(
      centreX + outsideX * Math.cos(sweep) - outsideY * Math.sin(sweep),
      centreY + outsideX * Math.sin(sweep) + outsideY * Math.cos(sweep),
      { steps: 10 },
    );
    await window.waitForFunction(
      () =>
        document.querySelector('[data-testid="crop-overlay"]')?.getAttribute('data-gesture') ===
        'rotate',
    );
    await window.waitForTimeout(400);
    await shoot('17-real-crop-rotating.png');
    await window.mouse.up();
    await window.keyboard.press('Enter');
    await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
    await window.waitForTimeout(500);
    await shoot('18-real-cropped.png');

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
    const toolbar = await window.locator('[data-testid="retouch-toolbar"]').boundingBox();
    // Start below the toolbar: on narrow windows it wraps over the image.
    const startY = Math.min(
      box.y + box.height * 0.9,
      Math.max(box.y + box.height * 0.2, (toolbar?.y ?? box.y) + (toolbar?.height ?? 0) + 10),
    );
    await window.mouse.move(box.x + box.width * 0.04, startY);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width * 0.96, box.y + box.height * 0.94, { steps: 12 });
    await window.mouse.up();
    await window.waitForFunction(
      () => document.querySelectorAll('[data-face-box]').length > 0,
      undefined,
      { timeout: 60_000 },
    );
    const mosaicVersion = async (): Promise<number> =>
      Number(
        (await window
          .locator('[data-testid="mosaic-canvas"]')
          .getAttribute('data-mosaic-version')) ?? 0,
      );
    await window.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="mosaic-canvas"]')
            ?.getAttribute('data-mosaic-version') ?? 0,
        ) > 0,
    );
    await shoot('12-real-retouch-faces.png');

    // Bigger blocks show the mosaic preview clearly.
    const beforeBlocks = await mosaicVersion();
    await window.locator('input[aria-label="Mosaic block size"]').evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '0.022');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await window.waitForFunction(
      ([selector, version]) =>
        Number(document.querySelector(selector)?.getAttribute('data-mosaic-version') ?? 0) >
        Number(version),
      ['[data-testid="mosaic-canvas"]', beforeBlocks] as const,
    );
    await shoot('13-real-mosaic-preview.png');

    // Committed version is the default view, with its indicator and film badge.
    await window.locator('[data-testid="commit-retouch"]').click();
    await window.locator('[data-testid="retouch-toolbar"]').waitFor({ state: 'detached' });
    await window.getByTestId('retouch-version-indicator').waitFor();
    await window.waitForSelector('button[title^="shots_002.jpg"] [title="Retouch version"]');
    await shoot('14-real-committed-retouch.png');
    await shoot('15-real-film-strip-retouch.png', '[data-testid="film-strip"]');

    // Next & send, then show the upload popover.
    await window.getByTestId('next-send').click();
    for (let i = 0; i < 400; i++) {
      const uploads = (await invoke('upload:list')) as { state: string }[];
      if (uploads.length > 0 && uploads.every((item) => item.state === 'done')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await window.locator('[data-testid="upload-summary"]').click();
    await window.getByRole('dialog', { name: 'Upload queue' }).waitFor();
    await shoot('16-real-upload-popover.png');

    // Library over the ingested files, everything selected.
    // Close the upload popover by clicking outside it.
    await window.locator('[data-testid="status-bar"]').click({ position: { x: 700, y: 10 } });
    await window.keyboard.press('g');
    await window.locator('[data-testid="library-grid"]').waitFor();
    await window.waitForFunction(() => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>('[data-testid="library-cell"] img'),
      ];
      return (
        images.length >= 3 && images.every((image) => image.complete && image.naturalWidth > 0)
      );
    });
    await window.keyboard.press('ControlOrMeta+a');
    await shoot('23-real-library-grid.png');

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
