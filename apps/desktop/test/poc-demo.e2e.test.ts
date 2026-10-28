// @vitest-environment node
import {
  appUrl,
  asDestinationId,
  asSourceId,
  type AppSettings,
  type CropParams,
  type FtpDestination,
  type FtpSource,
  type IngestConfig,
  type IpcResult,
  type Photo,
  type SourceConfig,
  type UploadItem,
} from '@ee/contracts';
import { decodeJpeg } from '@ee/core';
import { cropOutputPixels } from '@ee/develop-gl';
import { assertNoEmbeddedPreviews } from '@ee/export';
import { ExifToolService, readIptc } from '@ee/metadata';
import { blockSizeForShape } from '@ee/retouch';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  copyInto,
  faceJpeg,
  fixtureNefs,
  hasFaceFixtures,
  repoRoot,
  sampleNefs,
} from './helpers/fixtures';
import { startFtpServer, type TestFtpServer } from './helpers/ftp-server';

const desktopDir = join(repoRoot, 'apps', 'desktop');
const fixturesDir = join(desktopDir, 'test', 'fixtures');
const templatePath = join(fixturesDir, 'poc-template.XMP');
const codesPath = join(fixturesDir, 'poc-codes.txt');
const presetPath = join(fixturesDir, 'poc-preset.xmp');
const nefs = fixtureNefs();
const xvfb = process.platform === 'linux' && existsSync('/usr/bin/Xvfb');
const haveDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY) ||
  xvfb;

async function ensureDisplay(): Promise<{ env: Record<string, string>; stop(): void }> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  let number = 120 + (process.pid % 80);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(nefs.length === 0 || !haveDisplay)('PoC demo (real Electron app)', () => {
  let app: ElectronApplication;
  let window: Page;
  let display: Awaited<ReturnType<typeof ensureDisplay>>;
  let root: string;
  let outRoot: string;
  let sourceServer: TestFtpServer;
  let destServer: TestFtpServer;
  let photos: Photo[] = [];
  let sourceA: SourceConfig;
  let sourceB: SourceConfig;
  let sourcePool: SourceConfig;
  let destination: FtpDestination;
  let templateFields: Record<string, unknown>;

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

  const canvasReady = async (): Promise<void> => {
    await window.waitForSelector('[data-testid="develop-canvas"][data-ready="true"]', {
      timeout: 60_000,
    });
  };

  /** Wait until every image and app:// request has finished before closing. */
  const settle = async (): Promise<void> => {
    await window.waitForFunction(() => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>('[data-testid="film-strip"] img'),
      ];
      return images.every((image) => image.complete);
    });
    await window.waitForLoadState('networkidle');
  };

  const selectPhoto = async (fileName: string): Promise<void> => {
    await window.locator(`button[title^="${fileName}"]`).click();
    await window.waitForFunction(
      (name) =>
        document.querySelector('[data-testid="photo-view"]')?.textContent?.includes(name) ?? false,
      fileName,
    );
  };

  beforeAll(async () => {
    const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

    root = mkdtempSync(join(tmpdir(), 'ee-poc-'));
    const [a, b, pool, remote, out, userData] = ['a', 'b', 'pool', 'remote', 'out', 'userdata'].map(
      (name) => join(root, name),
    );
    outRoot = out!;
    for (const dir of [a!, b!, pool!, remote!, out!, userData!])
      mkdirSync(dir, { recursive: true });

    // Two folder "cards": copies of the CC0 NEFs plus the user's own NEFs when set.
    const first = nefs[0]!;
    const second = (nefs[1] ?? nefs[0])!;
    const third = (nefs[2] ?? nefs[0])!;
    copyInto(first, join(a!, 'A1.NEF'));
    copyInto(second, join(a!, 'A2.NEF'));
    sampleNefs().forEach((nef, index) => copyInto(nef, join(a!, `A${index + 3}.NEF`)));
    const expectedA = 2 + sampleNefs().length;

    copyInto(hasFaceFixtures() ? faceJpeg : first, join(b!, 'B1.jpg'));
    copyInto(third, join(b!, 'B2.NEF'));
    const expectedB = 2;

    // One anonymous FTP "hosted server", polled in parallel with the folders.
    copyInto(first, join(remote!, 'F1.NEF'));
    copyInto(second, join(remote!, 'F2.NEF'));

    sourceServer = await startFtpServer({ root: remote!, anonymous: true });
    destServer = await startFtpServer({ root: out!, anonymous: true });

    const sourceAId = asSourceId('card-a');
    const sourceBId = asSourceId('card-b');
    const sourcePoolId = asSourceId('pool-ftp');
    const destinationId = asDestinationId('desk-ftp');
    sourceA = { id: sourceAId, kind: 'folder', name: 'cardA', path: a! };
    sourceB = { id: sourceBId, kind: 'folder', name: 'cardB', path: b! };
    sourcePool = {
      id: sourcePoolId,
      kind: 'ftp',
      name: 'pool',
      host: '127.0.0.1',
      port: sourceServer.port,
      username: '',
      remotePath: '/',
      pollIntervalMs: 250,
      deleteAfterDownload: false,
      security: 'none',
    } satisfies FtpSource;
    destination = {
      id: destinationId,
      kind: 'ftp',
      name: 'Desk (anonymous)',
      host: '127.0.0.1',
      port: destServer.port,
      username: '',
      security: 'none',
      remotePathTemplate: 'incoming/{fileName}',
    };

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
        EE_USER_DATA_DIR: userData!,
      },
    });
    window = await app.firstWindow();
    await window.waitForFunction(() => 'eeTransport' in window);

    const problems: string[] = [];
    const failures: string[] = [];
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    window.on('pageerror', (error) => problems.push(error.message));
    window.on('response', (response) => {
      const url = response.url();
      if (url.startsWith('app://') && response.status() >= 400) {
        failures.push(`${response.status()} ${url}`);
      }
    });
    window.on('requestfailed', (request) => {
      if (!request.url().startsWith('app://')) return;
      const errorText = request.failure()?.errorText ?? 'failed';
      // A photo switch aborts the previous linear fetch. That is the intended
      // navigation behaviour, not a broken image.
      if (errorText === 'net::ERR_ABORTED') return;
      failures.push(`${errorText} ${request.url()}`);
    });
    (
      window as Page & {
        __problems?: string[];
        __failures?: string[];
        __events?: unknown[];
      }
    ).__problems = problems;
    (window as Page & { __failures?: string[] }).__failures = failures;
    const captureEvents = async (): Promise<void> => {
      await window.evaluate(() => {
        const w = window as unknown as {
          __events: unknown[];
          eeTransport: { subscribe(c: string, l: (p: unknown) => void): void };
        };
        w.__events = [];
        w.eeTransport.subscribe('jobs:event', (event) => w.__events.push(event));
      });
    };
    await captureEvents();

    // Import the Lightroom preset through the real backend, then reload so the
    // renderer's store loads it with everything else.
    await invoke('develop:importPreset', { path: presetPath });
    await window.reload();
    await window.waitForFunction(() => 'eeTransport' in window);
    await window.waitForSelector('[data-store-ready="true"]');
    await captureEvents();

    for (const source of [sourceA, sourceB, sourcePool]) {
      await invoke('sources:save', { source });
    }
    await invoke('destinations:save', { destination });
    const settings: AppSettings = {
      ingest: {
        destination: { path: join(root, 'ingest') },
        renameTemplate: '{sourceName}_{seq:3}',
        metadataTemplatePath: templatePath,
        codeReplacementPaths: [codesPath],
      },
      finishAction: {
        exportPreset: { quality: 90, metadata: 'all' },
        destinations: [destination.id],
      },
    };
    await invoke('settings:set', settings);

    const config: IngestConfig = {
      ...settings.ingest,
      sources: [sourceA, sourceB, sourcePool],
    };
    await invoke('ingest:start', { config });

    const expected = expectedA + expectedB + 2;
    photos = await waitFor('all photos to be ingested', async () => {
      const list = await invoke<Photo[]>('photos:list');
      return list.length >= expected ? list : undefined;
    });

    await window.waitForSelector('[data-testid="film-strip"] img', { timeout: 60_000 });
    await waitFor('thumbnails to load', () =>
      window.evaluate(() => {
        const images = [
          ...document.querySelectorAll<HTMLImageElement>('[data-testid="film-strip"] img'),
        ];
        return (
          images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
        );
      }),
    );
  }, 240_000);

  afterAll(async () => {
    const page = window as
      | (Page & {
          __problems?: string[];
          __failures?: string[];
          __events?: { type?: string; scope?: string; message?: string }[];
        })
      | undefined;
    await settle().catch(() => undefined);
    const problems = [...(page?.__problems ?? [])];
    const failures = [...(page?.__failures ?? [])];
    const jobErrors = (page?.__events ?? []).filter((event) => event.type === 'job.error');
    await app?.close().catch(() => undefined);
    await sourceServer?.close().catch(() => undefined);
    await destServer?.close().catch(() => undefined);
    display?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    if (problems.length > 0 || failures.length > 0 || jobErrors.length > 0) {
      throw new Error(
        [
          'renderer reported errors:',
          ...problems,
          ...failures,
          ...jobErrors.map((event) => `jobs: ${event.scope}: ${event.message}`),
        ].join('\n'),
      );
    }
  }, 60_000);

  it('ingests three sources in parallel in per-source filename order', async () => {
    const names = (sourceId: string): string[] =>
      photos.filter((photo) => photo.sourceId === sourceId).map((photo) => photo.fileName);
    const aNames = names('card-a');
    expect(aNames.slice(0, 2)).toEqual(['cardA_001.NEF', 'cardA_002.NEF']);
    expect(aNames).toHaveLength(2 + sampleNefs().length);
    expect(names('card-b')).toEqual(['cardB_001.jpg', 'cardB_002.NEF']);
    expect(names('pool-ftp')).toEqual(['pool_001.NEF', 'pool_002.NEF']);
    expect(photos.map((photo) => photo.id).length).toBe(new Set(photos.map((p) => p.id)).size);
  });

  it('applies the Photo Mechanic template and writes a raw sidecar', async () => {
    const raw = photos.find((photo) => photo.fileName === 'cardA_001.NEF')!;
    templateFields = (await invoke('metadata:read', { photoId: raw.id })) as Record<
      string,
      unknown
    >;
    expect(templateFields).toMatchObject({
      headline: 'PoC cup final',
      credit: 'PoC Picture Desk',
      city: 'Wembley',
      location: 'Wembley Stadium',
      jobId: 'POC-2026-CUP',
    });
    expect(existsSync(raw.sidecarPath)).toBe(true);
    expect(raw.sidecarPath).toBe(raw.path.replace(/\.NEF$/, '.xmp'));
  });

  it('expands a code replacement and a {variable} in the caption', async () => {
    await selectPhoto('cardB_001.jpg');
    const field = window.locator('[data-caption-input]');
    await field.waitFor();
    await field.fill('=t1= lift the cup at {location}');
    await field.press('Control+Space');
    await window.waitForFunction(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-caption-input]');
      return input?.value === 'Manchester City lift the cup at Wembley Stadium';
    });
    const expanded = await field.inputValue();
    expect(expanded).toBe('Manchester City lift the cup at Wembley Stadium');
    await window.waitForFunction(
      () =>
        document
          .querySelector<HTMLTextAreaElement>('[data-caption-input]')
          ?.value.includes('Manchester City') ?? false,
    );
  });

  it('applies a Lightroom preset and a moved exposure slider to the WebGL canvas', async () => {
    await selectPhoto('cardA_001.NEF');
    await canvasReady();
    const canvas = window.locator('[data-testid="develop-canvas"]');
    const renderVersion = async (): Promise<number> =>
      Number((await canvas.getAttribute('data-render-version')) ?? 0);
    const before = await canvas.screenshot();

    const versionBeforePreset = await renderVersion();
    await window.getByRole('button', { name: /PoC Punchy/ }).click();
    await window.waitForFunction(
      ([selector, version]) =>
        Number(document.querySelector(selector)?.getAttribute('data-render-version') ?? 0) >
        Number(version),
      ['[data-testid="develop-canvas"]', versionBeforePreset] as const,
    );
    await window.waitForFunction(
      () =>
        (document.querySelector('input[aria-label="Exposure value"]') as HTMLInputElement | null)
          ?.value === '0.35',
    );
    const afterPreset = await canvas.screenshot();
    expect(Buffer.compare(before, afterPreset)).not.toBe(0);

    const exposure = window.locator('input[aria-label="Exposure value"]');
    const versionBeforeExposure = await renderVersion();
    await exposure.fill('1.2');
    await exposure.blur();
    await window.waitForFunction(
      ([selector, version]) =>
        Number(document.querySelector(selector)?.getAttribute('data-render-version') ?? 0) >
        Number(version),
      ['[data-testid="develop-canvas"]', versionBeforeExposure] as const,
    );
    const afterExposure = await canvas.screenshot();
    expect(Buffer.compare(afterPreset, afterExposure)).not.toBe(0);

    const params = await invoke<{ Exposure2012?: number }>('develop:getParams', {
      photoId: photos.find((photo) => photo.fileName === 'cardA_001.NEF')!.id,
    });
    expect(params.Exposure2012).toBeCloseTo(1.2, 2);
  });

  it('crops to 1:1 with a 3 degree straighten and uploads the crop size', async () => {
    await selectPhoto('cardA_002.NEF');
    await canvasReady();
    await window.keyboard.press('c');
    await window.locator('[data-testid="crop-toolbar"]').waitFor();
    await window.locator('[data-aspect="1:1"]').click();
    await window.locator('input[aria-label="Straighten angle"]').evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await window.locator('[data-testid="apply-crop"]').click();
    await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });

    const photo = photos.find((candidate) => candidate.fileName === 'cardA_002.NEF')!;
    const params = await waitFor('the saved crop', async () => {
      const current = await invoke<{ crop?: CropParams }>('develop:getParams', {
        photoId: photo.id,
      });
      return current.crop ? current : undefined;
    });
    expect(params.crop?.angle).toBeCloseTo(3, 1);
    const expected = cropOutputPixels(params.crop!, {
      width: photo.width ?? 0,
      height: photo.height ?? 0,
    });
    expect(expected.width).toBe(expected.height);

    await window.getByRole('button', { name: /Finish & next/ }).click();
    const upload = await waitFor('the cropped upload', async () => {
      const items = await invoke<UploadItem[]>('upload:list');
      return items.find((item) => item.photoId === photo.id && item.state === 'done');
    });
    expect(upload.photoId).toBe(photo.id);
    const uploaded = join(outRoot, 'incoming', 'cardA_002.jpg');
    await waitFor('the uploaded crop', () => existsSync(uploaded));
    const decoded = await decodeJpeg(readFileSync(uploaded));
    expect(decoded.width).toBe(expected.width);
    expect(decoded.height).toBe(expected.height);
    expect(decoded.width).toBe(decoded.height);
  }, 180_000);

  it('detects faces in a dragged region and commits the mosaic version', async () => {
    await selectPhoto('cardB_001.jpg');
    await canvasReady();
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

    const faceRects = await waitFor('detected face boxes', async () => {
      const count = await window.locator('[data-face-box]').count();
      return count > 0 ? count : undefined;
    });
    expect(faceRects).toBeGreaterThan(0);
    // The live preview has painted the padded mosaic before the boxes are real.
    await window.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="mosaic-canvas"]')
            ?.getAttribute('data-mosaic-version') ?? 0,
        ) > 0,
    );

    await window.locator('[data-testid="commit-retouch"]').click();
    await window.locator('[data-testid="retouch-toolbar"]').waitFor({ state: 'detached' });
    await window.waitForSelector('button[title^="cardB_001.jpg"] [title="Retouch version"]');
    // Outside retouch mode the committed version is still the visible image.
    await window.getByTestId('retouch-version-indicator').waitFor();
    await window.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="mosaic-canvas"]')
            ?.getAttribute('data-mosaic-version') ?? 0,
        ) > 0,
    );

    const photo = (await invoke<Photo[]>('photos:list')).find(
      (candidate) => candidate.fileName === 'cardB_001.jpg',
    )!;
    const retouch = photo.versions.filter((version) => version.kind === 'retouch');
    expect(retouch).toHaveLength(1);
    expect(retouch[0]?.ops[0]).toMatchObject({ type: 'mosaic' });
  });

  it('finishes at full resolution, applies the mosaic and uploads anonymously to FTP', async () => {
    const exportedPhoto = (await invoke<Photo[]>('photos:list')).find(
      (photo) => photo.fileName === 'cardB_001.jpg',
    )!;
    const caption = (
      await invoke<{ caption?: string }>('metadata:read', {
        photoId: exportedPhoto.id,
      })
    ).caption;
    expect(caption).toBe('Manchester City lift the cup at Wembley Stadium');

    await window.getByRole('button', { name: /Finish & next/ }).click();

    const upload = await waitFor('the anonymous FTP upload', async () => {
      const items = await invoke<UploadItem[]>('upload:list');
      return items.find((item) => item.photoId === exportedPhoto.id && item.state === 'done');
    });
    expect(upload.photoId).toBe(exportedPhoto.id);

    const uploaded = join(outRoot, 'incoming', 'cardB_001.jpg');
    await waitFor('the uploaded file on the FTP server', () => existsSync(uploaded));
    await assertNoEmbeddedPreviews(uploaded);

    const exiftool = new ExifToolService();
    try {
      const sent = await readIptc(uploaded, exiftool);
      expect(sent.caption).toBe(caption);
      expect(sent).toMatchObject({ headline: 'PoC cup final', credit: 'PoC Picture Desk' });
    } finally {
      await exiftool.close();
    }

    const decoded = await decodeJpeg(readFileSync(uploaded));
    const mosaic = exportedPhoto.versions.filter((version) => version.kind === 'retouch').at(-1)
      ?.ops[0];
    expect(mosaic && mosaic.type === 'mosaic' ? mosaic.shapes.length : 0).toBeGreaterThan(0);
    const shape = mosaic && mosaic.type === 'mosaic' ? mosaic.shapes[0] : undefined;
    if (!shape || mosaic?.type !== 'mosaic') throw new Error('no mosaic shape');
    const block = blockSizeForShape(shape, mosaic.blockSizeRel, decoded.width, decoded.height);
    const centreX = Math.floor(
      (shape.type === 'rect' ? shape.x + shape.w / 2 : 0.5) * decoded.width,
    );
    const centreY = Math.floor(
      (shape.type === 'rect' ? shape.y + shape.h / 2 : 0.5) * decoded.height,
    );
    const x0 = Math.floor(centreX / block) * block + Math.floor(block / 4);
    const y0 = Math.floor(centreY / block) * block + Math.floor(block / 4);
    const values: number[][] = [];
    for (let y = y0; y < y0 + Math.max(2, Math.floor(block / 2)); y++) {
      for (let x = x0; x < x0 + Math.max(2, Math.floor(block / 2)); x++) {
        const index = (y * decoded.width + x) * 4;
        values.push([decoded.rgba[index]!, decoded.rgba[index + 1]!, decoded.rgba[index + 2]!]);
      }
    }
    for (let channel = 0; channel < 3; channel++) {
      const channelValues = values.map((value) => value[channel]!);
      // JPEG re-encoding is lossy; a mosaicked block stays nearly constant.
      expect(Math.max(...channelValues) - Math.min(...channelValues)).toBeLessThanOrEqual(8);
    }

    await window.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="photo-view"]')
          ?.textContent?.includes('cardB_002.NEF') ?? false,
      undefined,
      { timeout: 20_000 },
    );
  }, 180_000);

  it('serves the developed JPEG as a linear image too', async () => {
    const jpeg = photos.find((photo) => photo.fileName === 'cardB_001.jpg')!;
    const result = await window.evaluate(
      async ([url, headerName]) => {
        const response = await fetch(url as string);
        const header = response.headers.get(headerName as string);
        return { status: response.status, header };
      },
      [appUrl.linear(jpeg.id, 256), 'x-ee-linear-image'] as const,
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.header!)).toMatchObject({ sampleType: 'f32' });
  });
});
