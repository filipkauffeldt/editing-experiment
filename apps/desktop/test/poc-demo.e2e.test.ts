// @vitest-environment node
import {
  appUrl,
  asDestinationId,
  asPresetId,
  asSourceId,
  type AppSettings,
  type CropParams,
  type ExportJob,
  type ExportPreset,
  type FtpDestination,
  type FtpSource,
  type IngestConfig,
  type IpcResult,
  type MosaicOp,
  type Photo,
  type SourceConfig,
  type UploadItem,
} from '@ee/contracts';
import { decodeJpeg } from '@ee/core';
import { cropMosaicOp, cropOutputPixels } from '@ee/develop-gl';
import { assertNoEmbeddedPreviews, outputSizeForResize } from '@ee/export';
import { ExifToolService, readIptc } from '@ee/metadata';
import { blockSizeForShape, shapeBounds } from '@ee/retouch';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  timeoutMs = 240_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// Software GL and a busy machine make single steps slow; every wait below is condition based, so
// the per-test limit only has to cover the slowest step, not the typical one.
describe.skipIf(nefs.length === 0 || !haveDisplay)(
  'PoC demo (real Electron app)',
  { timeout: 300_000 },
  () => {
    let app: ElectronApplication;
    let window: Page;
    let display: Awaited<ReturnType<typeof ensureDisplay>>;
    let root: string;
    let outRoot: string;
    let exportRoot: string;
    let sourceServer: TestFtpServer;
    let destServer: TestFtpServer;
    let photos: Photo[] = [];
    let sourceA: SourceConfig;
    let sourceB: SourceConfig;
    let sourcePool: SourceConfig;
    let destination: FtpDestination;
    let mainPreset: ExportPreset;
    let batchPreset: ExportPreset;
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
          document.querySelector('[data-testid="photo-view"]')?.textContent?.includes(name) ??
          false,
        fileName,
      );
    };

    /** Natural size of a film strip thumbnail once it has loaded. */
    const stripThumbSize = (fileName: string) =>
      window
        .locator(`[data-testid="film-strip"] button[title^="${fileName}"] img`)
        .evaluate((element) => {
          const image = element as HTMLImageElement;
          return { width: image.naturalWidth, height: image.naturalHeight, src: image.src };
        });

    /** The film strip thumbnail of a photo as decoded pixels, fetched the way the <img> does. */
    const thumbPixels = async (fileName: string) => {
      const { src } = await stripThumbSize(fileName);
      const bytes = await window.evaluate(async (url) => {
        const response = await fetch(url);
        return Array.from(new Uint8Array(await response.arrayBuffer()));
      }, src);
      return decodeJpeg(Buffer.from(bytes));
    };

    const meanLuma = (image: { rgba: Uint8Array | Buffer }): number => {
      let total = 0;
      for (let i = 0; i < image.rgba.length; i += 4) total += image.rgba[i + 1]!;
      return total / (image.rgba.length / 4);
    };
    let mosaicThumbLuma = 0;

    /** Optional: where to save screenshots of the film strip (for pull requests). */
    const screenshotDir = process.env.EE_SCREENSHOT_DIR;

    const clickThumb = async (fileName: string, modifiers: ('Control' | 'Shift')[] = []) => {
      await window.locator(`button[title^="${fileName}"]`).click({ modifiers });
    };

    const waitForExportJob = async (
      photoIds: string[],
      state: 'done' | 'failed' | 'cancelled' = 'done',
    ): Promise<ExportJob> =>
      waitFor('the export job', async () => {
        const jobs = await invoke<ExportJob[]>('export:list');
        return jobs.find(
          (job) =>
            state === job.state && photoIds.every((id) => job.photoIds.includes(id as never)),
        );
      });

    const batchFile = (fileName: string): string =>
      join(root, 'batch-exports', 'Batch', fileName.replace(/\.NEF$/i, '.jpg'));

    const openExportDialog = async (): Promise<void> => {
      await window.getByTestId('open-export').click();
      await window.getByTestId('export-dialog').waitFor();
    };

    const choosePreset = async (name: string): Promise<void> => {
      await window.getByRole('option', { name: new RegExp(name) }).click();
    };

    /** Finish & next, then check the uploaded JPEG has exactly the crop's output size. */
    const finishAndCheckCropUpload = async (
      photo: Photo,
      expected: { width: number; height: number },
      uploadName: string,
    ): Promise<void> => {
      await window.getByTestId('next-send').click();
      const upload = await waitFor('the cropped upload', async () => {
        const items = await invoke<UploadItem[]>('upload:list');
        return items.find((item) => item.photoId === photo.id && item.state === 'done');
      });
      expect(upload.photoId).toBe(photo.id);
      const uploaded = join(outRoot, 'incoming', uploadName);
      await waitFor('the uploaded crop', () => existsSync(uploaded));
      const decoded = await decodeJpeg(readFileSync(uploaded));
      expect(decoded.width).toBe(expected.width);
      expect(decoded.height).toBe(expected.height);
    };

    /** The size the renderer should draw for this photo, crop and preset. */
    const exportSize = (
      source: { width: number; height: number },
      crop: CropParams | undefined,
      preset: ExportPreset,
    ): { width: number; height: number } => {
      const cropped = crop ? cropOutputPixels(crop, source) : source;
      return outputSizeForResize(cropped.width, cropped.height, preset.resize);
    };

    /** A block centre inside the exported mosaic is block-constant (JPEG tolerates some ringing). */
    const expectMosaicBlockConstant = (
      decoded: { width: number; height: number; rgba: Uint8Array | Buffer },
      crop: CropParams,
      source: { width: number; height: number },
      op: MosaicOp,
      preset: ExportPreset,
    ): void => {
      const output = exportSize(source, crop, preset);
      const mapped = cropMosaicOp(op, crop, source, output);
      const shape = mapped.shapes[0];
      if (!shape) throw new Error('no mosaic shape');
      const block = blockSizeForShape(shape, mapped.blockSizeRel, output.width, output.height);
      const bounds = shapeBounds(shape);
      const centreX = (bounds.x + bounds.w / 2) * output.width;
      const centreY = (bounds.y + bounds.h / 2) * output.height;
      const blockX = Math.floor(centreX / block) * block + block / 2;
      const blockY = Math.floor(centreY / block) * block + block / 2;
      const x0 = Math.max(0, Math.round(blockX) - 1);
      const y0 = Math.max(0, Math.round(blockY) - 1);
      const values: number[][] = [];
      for (let y = y0; y < Math.min(decoded.height, y0 + 3); y++) {
        for (let x = x0; x < Math.min(decoded.width, x0 + 3); x++) {
          const index = (y * decoded.width + x) * 4;
          values.push([decoded.rgba[index]!, decoded.rgba[index + 1]!, decoded.rgba[index + 2]!]);
        }
      }
      for (let channel = 0; channel < 3; channel++) {
        const channelValues = values.map((value) => value[channel]!);
        expect(Math.max(...channelValues) - Math.min(...channelValues)).toBeLessThanOrEqual(8);
      }
    };

    interface CropState {
      /** The frame in CSS pixels relative to the overlay. */
      frame: { left: number; top: number; width: number; height: number };
      /** The draft crop: left, top, right, bottom (normalized), angle. */
      crop: number[];
      angle: number;
      gesture: string;
      guides: number;
      tool: string;
      /** The overlay's page position, to turn frame coordinates into mouse coordinates. */
      origin: { x: number; y: number };
    }

    const cropState = async (): Promise<CropState> => {
      const overlay = window.locator('[data-testid="crop-overlay"]');
      const [left = 0, top = 0, width = 0, height = 0] = (
        (await overlay.getAttribute('data-frame')) ?? ''
      )
        .split(',')
        .map(Number);
      const box = await overlay.boundingBox();
      if (!box) throw new Error('crop overlay has no bounds');
      return {
        frame: { left, top, width, height },
        crop: ((await overlay.getAttribute('data-crop')) ?? '').split(',').map(Number),
        angle: Number(await overlay.getAttribute('data-angle')),
        gesture: (await overlay.getAttribute('data-gesture')) ?? '',
        guides: Number(await overlay.getAttribute('data-guides')),
        tool: (await overlay.getAttribute('data-tool')) ?? '',
        origin: { x: box.x, y: box.y },
      };
    };

    /** Polls the overlay until `ready` accepts its state: no fixed sleeps. */
    const settledCropState = async (
      what: string,
      ready: (state: CropState) => boolean = () => true,
    ): Promise<CropState> =>
      waitFor(what, async () => {
        const state = await cropState().catch(() => undefined);
        return state && state.frame.width > 0 && ready(state) ? state : undefined;
      });

    const openCrop = async (fileName: string): Promise<void> => {
      await selectPhoto(fileName);
      await canvasReady();
      // A press on the film strip or a field would leave focus where the shortcut is ignored.
      await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await window.keyboard.press('c');
      await window.locator('[data-testid="crop-toolbar"]').waitFor();
      await settledCropState('the crop frame', (state) => state.tool === 'crop');
      // The first frame of the rotated view has been drawn once the stage is ready.
      await window.waitForSelector('[data-testid="develop-canvas"][data-visible="true"]');
    };

    const cancelCrop = async (): Promise<void> => {
      // Escape is ignored while an input has focus (e.g. the angle slider).
      await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await window.keyboard.press('Escape');
      await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
    };

    const chooseAspect = async (
      id: string,
      ready: (state: CropState) => boolean,
    ): Promise<CropState> => {
      await window.locator(`[data-aspect="${id}"]`).click();
      return settledCropState(`the ${id} frame`, ready);
    };

    const dragTo = async (
      from: { x: number; y: number },
      steps: { x: number; y: number }[],
      keepDown = false,
    ): Promise<void> => {
      await window.mouse.move(from.x, from.y);
      await window.mouse.down();
      for (const step of steps) await window.mouse.move(step.x, step.y, { steps: 6 });
      if (!keepDown) await window.mouse.up();
    };

    const nearly = (actual: number, expected: number, tolerance = 1.5): void =>
      expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(
        tolerance,
      );

    beforeAll(async () => {
      const build = spawnSync('pnpm', ['--filter', '@ee/desktop', 'build'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

      root = mkdtempSync(join(tmpdir(), 'ee-poc-'));
      const [a, b, pool, remote, out, userData] = [
        'a',
        'b',
        'pool',
        'remote',
        'out',
        'userdata',
      ].map((name) => join(root, name));
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

      // Import the Lightroom preset and persist the sources, destinations and export
      // presets, then reload so the renderer store loads everything with the presets.
      await invoke('develop:importPreset', { path: presetPath });
      for (const source of [sourceA, sourceB, sourcePool]) {
        await invoke('sources:save', { source });
      }
      await invoke('destinations:save', { destination });
      mainPreset = {
        id: asPresetId('poc-main'),
        name: 'Sportfotografen',
        folderTemplate: '{folder}/Export/{preset}',
        fileNameTemplate: '{filenamebase}',
        ifExists: 'suffix',
        format: 'jpeg',
        quality: 90,
        colorSpace: 'srgb',
        resize: { mode: 'longEdge', pixels: 1600 },
        outputSharpening: { target: 'none', amount: 'standard' },
        metadata: 'all',
        stripGps: false,
        version: 'top',
        sendTo: [destination.id],
      };
      batchPreset = {
        ...mainPreset,
        id: asPresetId('poc-batch'),
        name: 'Batch',
        folderTemplate: join(root, 'batch-exports', '{preset}'),
        metadata: 'none',
      };
      const sourceFolderPreset: ExportPreset = {
        ...batchPreset,
        id: asPresetId('poc-source-folder'),
        name: 'Source folder',
        folderTemplate: '{folderpath}',
      };
      // The one full-resolution export in the demo: only this preset has `resize: none`.
      const fullPreset: ExportPreset = {
        ...mainPreset,
        id: asPresetId('poc-full'),
        name: 'Full resolution',
        folderTemplate: join(root, 'full-exports', '{preset}'),
        resize: { mode: 'none' },
      };
      exportRoot = join(root, 'exports');
      const settings: AppSettings = {
        ingest: {
          destination: { path: join(root, 'ingest') },
          renameTemplate: '{sourceName}_{seq:3}',
          metadataTemplatePath: templatePath,
          codeReplacementPaths: [codesPath],
        },
        exportRoot,
        exportPresets: [mainPreset, batchPreset, sourceFolderPreset, fullPreset],
        activePresetId: mainPreset.id,
      };
      await invoke('settings:set', settings);
      await window.reload();
      await window.waitForFunction(() => 'eeTransport' in window);
      await window.waitForSelector('[data-store-ready="true"]');
      await captureEvents();

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
    }, 60_000);

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
      const expected = exportSize(
        { width: photo.width ?? 0, height: photo.height ?? 0 },
        params.crop!,
        mainPreset,
      );
      expect(expected.width).toBe(expected.height);

      // The film strip shows the photo as cropped: a 1:1 crop gives a square thumbnail,
      // the camera preview it replaces is 3:2.
      const square = await waitFor('the cropped film strip thumbnail', async () => {
        const size = await stripThumbSize('cardA_002.NEF');
        return size.width > 0 && size.width === size.height ? size : undefined;
      });
      expect(square.src).toMatch(/\?v=\d+$/);

      await finishAndCheckCropUpload(photo, expected, 'cardA_002.jpg');
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

      const thumbBefore = await thumbPixels('cardB_001.jpg');
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

      // The film strip must not keep the unmosaicked face: once the edited thumbnail is
      // stored, every mosaic block inside the shape is constant, where the camera
      // preview it replaced is not.
      const retouched = await waitFor('the mosaicked thumbnail', async () => {
        const current = (await invoke<Photo[]>('photos:list')).find(
          (candidate) => candidate.fileName === 'cardB_001.jpg',
        );
        return current && current.previewStale === false && (current.previewRevision ?? 0) > 0
          ? current
          : undefined;
      });
      await waitFor('the film strip to show the new thumbnail', async () => {
        const { src } = await stripThumbSize('cardB_001.jpg');
        return src.endsWith(`?v=${retouched.previewRevision}`);
      });
      const op = retouched.versions.filter((version) => version.kind === 'retouch').at(-1)?.ops[0];
      if (op?.type !== 'mosaic') throw new Error('the retouch version has no mosaic');
      const thumbAfter = await thumbPixels('cardB_001.jpg');
      expect([thumbAfter.width, thumbAfter.height]).toEqual([
        thumbBefore.width,
        thumbBefore.height,
      ]);
      // Pixel range (green) inside every mosaic block of the shapes, with the block's size.
      const blockRanges = (image: typeof thumbAfter): { block: number; range: number }[] => {
        const ranges: { block: number; range: number }[] = [];
        for (const shape of op.shapes) {
          if (shape.type !== 'rect') continue;
          const block = blockSizeForShape(shape, op.blockSizeRel, image.width, image.height);
          const first = {
            x: Math.ceil((shape.x * image.width) / block),
            y: Math.ceil((shape.y * image.height) / block),
          };
          const last = {
            x: Math.floor(((shape.x + shape.w) * image.width) / block),
            y: Math.floor(((shape.y + shape.h) * image.height) / block),
          };
          for (let by = first.y; by < last.y; by++) {
            for (let bx = first.x; bx < last.x; bx++) {
              let lo = 255;
              let hi = 0;
              // One pixel in from the block edge: JPEG ringing spills over the borders.
              for (let y = by * block + 1; y < (by + 1) * block - 1; y++) {
                for (let x = bx * block + 1; x < (bx + 1) * block - 1; x++) {
                  const value = image.rgba[(y * image.width + x) * 4 + 1]!;
                  lo = Math.min(lo, value);
                  hi = Math.max(hi, value);
                }
              }
              ranges.push({ block, range: hi - lo });
            }
          }
        }
        return ranges;
      };
      mosaicThumbLuma = meanLuma(thumbAfter);
      expect(mosaicThumbLuma).toBeGreaterThan(20);
      const after = blockRanges(thumbAfter);
      const before = blockRanges(thumbBefore);
      expect(after.length).toBeGreaterThan(0);
      const mean = (values: number[]): number =>
        values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      // The thumbnail is a JPEG, whose 8x8 transform grid only lines up with blocks that are a
      // multiple of 8 px (the minimum). Those must be flat; a larger face gets bigger blocks
      // (9 px, say) whose edges ring through the quantiser, so for all blocks together the
      // mosaic must have removed most of the detail the camera thumbnail has.
      const aligned = after.filter(({ block }) => block % 8 === 0).map(({ range }) => range);
      expect(Math.max(0, ...aligned)).toBeLessThanOrEqual(12);
      expect(mean(before.map(({ range }) => range))).toBeGreaterThan(40);
      expect(mean(after.map(({ range }) => range))).toBeLessThan(
        0.25 * mean(before.map(({ range }) => range)),
      );

      // Add a 5 degree straighten and crop on top of the committed mosaic.
      await window.keyboard.press('c');
      await window.locator('[data-testid="crop-toolbar"]').waitFor();
      await window.locator('input[aria-label="Straighten angle"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '5');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await window.locator('[data-testid="apply-crop"]').click();
      await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });
      await waitFor('the saved crop', async () => {
        const current = await invoke<{ crop?: CropParams }>('develop:getParams', {
          photoId: photos.find((candidate) => candidate.fileName === 'cardB_001.jpg')!.id,
        });
        return current.crop ? current : undefined;
      });

      const photo = (await invoke<Photo[]>('photos:list')).find(
        (candidate) => candidate.fileName === 'cardB_001.jpg',
      )!;
      const retouch = photo.versions.filter((version) => version.kind === 'retouch');
      expect(retouch).toHaveLength(1);
      expect(retouch[0]?.ops[0]).toMatchObject({ type: 'mosaic' });
    }, 60_000);

    it('finishes at the export size, applies the mosaic and uploads anonymously to FTP', async () => {
      const exportedPhoto = (await invoke<Photo[]>('photos:list')).find(
        (photo) => photo.fileName === 'cardB_001.jpg',
      )!;
      const caption = (
        await invoke<{ caption?: string }>('metadata:read', {
          photoId: exportedPhoto.id,
        })
      ).caption;
      expect(caption).toBe('Manchester City lift the cup at Wembley Stadium');

      await window.getByTestId('next-send').click();

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
      const crop = (
        await invoke<{ crop?: CropParams }>('develop:getParams', { photoId: exportedPhoto.id })
      ).crop;
      if (!crop) throw new Error('the retouched export has no crop');
      const source = {
        width: exportedPhoto.width ?? decoded.width,
        height: exportedPhoto.height ?? decoded.height,
      };
      const mosaic = exportedPhoto.versions.filter((version) => version.kind === 'retouch').at(-1)
        ?.ops[0];
      if (!mosaic || mosaic.type !== 'mosaic' || mosaic.shapes.length === 0) {
        throw new Error('no mosaic shape');
      }
      const expected = exportSize(source, crop, mainPreset);
      expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
      expectMosaicBlockConstant(decoded, crop, source, mosaic, mainPreset);

      await window.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="photo-view"]')
            ?.textContent?.includes('cardB_002.NEF') ?? false,
        undefined,
        { timeout: 20_000 },
      );
    }, 180_000);

    it('shows the cropped, developed and mosaicked photos as edited in the film strip', async () => {
      const edited = ['cardA_001.NEF', 'cardA_002.NEF', 'cardB_001.jpg'];
      const current = await waitFor('every edited thumbnail to be drawn', async () => {
        const list = await invoke<Photo[]>('photos:list');
        const found = edited.map((name) => list.find((photo) => photo.fileName === name)!);
        return found.every((photo) => photo.previewStale === false && photo.previewRevision)
          ? found
          : undefined;
      });
      // Each <img> carries its photo's revision, so the browser cannot show an older render.
      for (const photo of current) {
        await waitFor(`the film strip image of ${photo.fileName} to refresh`, async () =>
          (await stripThumbSize(photo.fileName)).src.endsWith(`?v=${photo.previewRevision}`),
        );
      }
      await settle();
      // Cropping on top of the mosaic must not change what the thumbnail is of: a crop drawn
      // from the wrong part of the image (the dark corner) would be far darker.
      const cropped = await thumbPixels('cardB_001.jpg');
      expect(meanLuma(cropped)).toBeGreaterThan(mosaicThumbLuma * 0.7);
      expect(meanLuma(cropped)).toBeLessThan(mosaicThumbLuma * 1.3);
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await window
          .locator('[data-testid="film-strip"]')
          .screenshot({ path: join(screenshotDir, 'film-strip-edited.png') });
        await window.screenshot({ path: join(screenshotDir, 'app-edited-photos.png') });
      }
    }, 60_000);

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

    it('batch exports three selected photos to a local folder without uploading', async () => {
      const chosen = ['cardA_001.NEF', 'cardA_002.NEF', 'cardB_002.NEF'].map((name) =>
        photos.find((photo) => photo.fileName === name)!,
      );
      const before = new Set((await invoke<UploadItem[]>('upload:list')).map((item) => item.id));

      await clickThumb('cardA_001.NEF');
      await clickThumb('cardA_002.NEF', ['Control']);
      await clickThumb('cardB_002.NEF', ['Control']);
      await openExportDialog();
      expect(await window.getByTestId('export-dialog').textContent()).toContain(
        '3 photos selected',
      );
      await choosePreset('Batch');
      await window.getByTestId('export-only').click();

      const job = await waitForExportJob(chosen.map((photo) => photo.id));
      expect(job.photos.map((photo) => photo.state)).toEqual(['done', 'done', 'done']);
      for (const photo of chosen) {
        const local = batchFile(photo.fileName);
        await waitFor(`${local} to exist`, () => existsSync(local));
        await assertNoEmbeddedPreviews(local);
      }

      const uploads = await invoke<UploadItem[]>('upload:list');
      expect(uploads.filter((item) => !before.has(item.id))).toHaveLength(0);
      expect(
        uploads.filter((item) => chosen.some((photo) => photo.id === item.photoId)),
      ).toHaveLength(
        uploads.filter(
          (item) => before.has(item.id) && chosen.some((photo) => photo.id === item.photoId),
        ).length,
      );
    }, 180_000);

    it('batch exports and sends two photos to anonymous FTP, byte-identical', async () => {
      const chosen = ['cardB_002.NEF', 'pool_002.NEF'].map((name) =>
        photos.find((photo) => photo.fileName === name)!,
      );
      await clickThumb('cardB_002.NEF');
      await clickThumb('pool_002.NEF', ['Control']);
      await openExportDialog();
      await choosePreset('Batch');
      await window.getByTestId('export-send').click();

      const job = await waitForExportJob(chosen.map((photo) => photo.id));
      const done = await waitFor('both uploads to finish', async () => {
        const items = await invoke<UploadItem[]>('upload:list');
        const mine = items.filter((item) => chosen.some((photo) => photo.id === item.photoId));
        return mine.length >= 2 && mine.every((item) => item.state === 'done') ? mine : undefined;
      });
      expect(done).toHaveLength(2);

      for (const progress of job.photos) {
        const local = progress.path!;
        const remote = join(outRoot, 'incoming', basename(local));
        await waitFor(`${remote} to exist`, () => existsSync(remote));
        expect(readFileSync(remote).equals(readFileSync(local))).toBe(true);
      }
    }, 180_000);

    it('never overwrites an ingested original when exporting into its folder', async () => {
      const photo = photos.find((candidate) => candidate.fileName === 'cardB_001.jpg')!;
      const original = readFileSync(photo.path);
      await clickThumb('cardB_001.jpg');
      await openExportDialog();
      await choosePreset('Source folder');
      await window.getByTestId('export-only').click();
      await waitForExportJob([photo.id]);

      const exported = join(dirname(photo.path), 'cardB_001-1.jpg');
      await waitFor(`${exported} to exist`, () => existsSync(exported));
      expect(readFileSync(photo.path).equals(original)).toBe(true);
      expect(existsSync(exported)).toBe(true);
      await assertNoEmbeddedPreviews(exported);
    }, 180_000);

    it('batch exports a retouched photo with its mosaic applied', async () => {
      const photo = photos.find((candidate) => candidate.fileName === 'cardB_001.jpg')!;
      await clickThumb('cardB_001.jpg');
      await openExportDialog();
      await choosePreset('Batch');
      await window.getByTestId('export-only').click();
      await waitForExportJob([photo.id]);

      const local = batchFile('cardB_001.jpg');
      await waitFor(`${local} to exist`, () => existsSync(local));
      const decoded = await decodeJpeg(readFileSync(local));
      const current = await invoke<Photo>('photos:get', { photoId: photo.id });
      const crop = (await invoke<{ crop?: CropParams }>('develop:getParams', { photoId: photo.id }))
        .crop;
      if (!crop) throw new Error('the retouched export has no crop');
      const source = {
        width: current.width ?? decoded.width,
        height: current.height ?? decoded.height,
      };
      const mosaic = current.versions.filter((version) => version.kind === 'retouch').at(-1)
        ?.ops[0];
      if (!mosaic || mosaic.type !== 'mosaic') throw new Error('no mosaic shape');
      const expected = exportSize(source, crop, batchPreset);
      expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
      expectMosaicBlockConstant(decoded, crop, source, mosaic, batchPreset);
    }, 180_000);

    it('exports a full-resolution crop when the preset does not resize', async () => {
      const photo = photos.find((candidate) => candidate.fileName === 'cardB_001.jpg')!;
      await clickThumb('cardB_001.jpg');
      await openExportDialog();
      await choosePreset('Full resolution');
      await window.getByTestId('export-only').click();
      await waitForExportJob([photo.id]);

      const local = join(root, 'full-exports', 'Full resolution', 'cardB_001.jpg');
      await waitFor(`${local} to exist`, () => existsSync(local));
      const decoded = await decodeJpeg(readFileSync(local));
      const crop = (await invoke<{ crop?: CropParams }>('develop:getParams', { photoId: photo.id }))
        .crop;
      if (!crop) throw new Error('the retouched export has no crop');
      const source = {
        width: photo.width ?? decoded.width,
        height: photo.height ?? decoded.height,
      };
      const expected = cropOutputPixels(crop, source);
      expect([decoded.width, decoded.height]).toEqual([expected.width, expected.height]);
    }, 180_000);

    describe('Lightroom-style crop overlay', () => {
      it('rotates the image by dragging outside a corner while the frame stays put', async () => {
        await openCrop('pool_001.NEF');
        const before = await cropState();
        expect(before.angle).toBe(0);
        const canvas = window.locator('[data-testid="develop-canvas"]');
        const imageBefore = await canvas.screenshot();

        // 18 px outside the lower-right corner, then sweep clockwise around the frame.
        const { frame, origin } = before;
        const corner = {
          x: origin.x + frame.left + frame.width,
          y: origin.y + frame.top + frame.height,
        };
        await dragTo(
          { x: corner.x + 18, y: corner.y + 18 },
          [
            { x: corner.x - frame.width * 0.2, y: corner.y + 30 },
            { x: corner.x - frame.width * 0.45, y: corner.y + 34 },
          ],
          true,
        );
        const during = await settledCropState(
          'the rotation in progress',
          (state) =>
            state.gesture === 'rotate' && state.angle < -1 && state.frame.width < frame.width,
        );
        expect(during.gesture).toBe('rotate');
        // Clockwise sweep: the image turns clockwise, the crop angle goes negative.
        expect(during.angle).toBeLessThan(-1);
        // Rotation is about the frame centre, and the frame is a plain rectangle on screen.
        nearly(during.frame.left + during.frame.width / 2, frame.left + frame.width / 2);
        nearly(during.frame.top + during.frame.height / 2, frame.top + frame.height / 2);
        expect(await window.locator('[data-testid="crop-overlay"] polygon').count()).toBe(0);
        // A finer grid than the rule of thirds is up while rotating.
        expect(during.guides).toBeGreaterThan(4);
        // Constrained to the image: the frame shrank instead of showing empty canvas.
        expect(during.frame.width).toBeLessThan(frame.width);
        await window.mouse.up();

        const after = await settledCropState(
          'the finished rotation',
          (state) => state.gesture === '',
        );
        expect(after.angle).toBe(during.angle);
        expect(Buffer.compare(imageBefore, await canvas.screenshot())).not.toBe(0);
        await cancelCrop();
      }, 120_000);

      it('pans the image by dragging inside the frame', async () => {
        await openCrop('pool_001.NEF');
        const before = await chooseAspect(
          '1:1',
          (state) => Math.abs(state.frame.width - state.frame.height) < 0.5,
        );
        const { frame, origin } = before;
        const centre = {
          x: origin.x + frame.left + frame.width / 2,
          y: origin.y + frame.top + frame.height / 2,
        };
        await dragTo(centre, [{ x: centre.x + 70, y: centre.y }]);

        const after = await settledCropState(
          'the panned crop',
          (state) => state.gesture === '' && state.crop[0]! < before.crop[0]!,
        );
        // The frame did not move on screen; the image slid right under it, so the crop moved left.
        nearly(after.frame.left, before.frame.left, 0.01);
        nearly(after.frame.width, before.frame.width, 0.01);
        expect(after.crop[0]!).toBeLessThan(before.crop[0]!);
        expect(after.crop[2]! - after.crop[0]!).toBeCloseTo(before.crop[2]! - before.crop[0]!, 6);

        // Dragged far beyond the edge, the crop stops at the image edge.
        await dragTo(centre, [{ x: centre.x + 3000, y: centre.y }]);
        const edge = await settledCropState(
          'the crop at the image edge',
          (state) => state.gesture === '' && state.crop[0]! < 1e-6,
        );
        expect(edge.crop[0]!).toBeCloseTo(0, 6);
        await cancelCrop();
      }, 120_000);

      it('keeps a 1:1 frame square while a handle is dragged, until Shift releases the lock', async () => {
        await openCrop('pool_001.NEF');
        const before = await chooseAspect(
          '1:1',
          (state) => Math.abs(state.frame.width - state.frame.height) < 0.5,
        );
        const { origin } = before;
        const corner = (state: CropState) => ({
          x: origin.x + state.frame.left + state.frame.width,
          y: origin.y + state.frame.top + state.frame.height,
        });

        await dragTo(corner(before), [{ x: corner(before).x - 90, y: corner(before).y - 20 }]);
        const square = await settledCropState(
          'the resized square',
          (state) => state.gesture === '' && state.frame.width < before.frame.width,
        );
        nearly(square.frame.width, square.frame.height, 0.5);
        expect(square.frame.width).toBeLessThan(before.frame.width);
        // The opposite (upper-left) corner is the anchor.
        nearly(square.frame.left, before.frame.left, 0.01);
        nearly(square.frame.top, before.frame.top, 0.01);

        await window.keyboard.down('Shift');
        await dragTo(corner(square), [{ x: corner(square).x - 60, y: corner(square).y - 10 }]);
        await window.keyboard.up('Shift');
        const free = await settledCropState('the unlocked resize', (state) => state.gesture === '');
        expect(Math.abs(free.frame.width - free.frame.height)).toBeGreaterThan(20);
        await cancelCrop();
      }, 120_000);

      it('draws a new crop frame with the frame tool', async () => {
        await openCrop('pool_001.NEF');
        await window.locator('[data-aspect="free"]').click();
        await window.locator('[data-tool="draw"]').click();
        const before = await settledCropState('the draw tool', (state) => state.tool === 'draw');
        const { frame, origin } = before;
        const from = {
          x: origin.x + frame.left + frame.width * 0.25,
          y: origin.y + frame.top + frame.height * 0.2,
        };
        const to = {
          x: origin.x + frame.left + frame.width * 0.7,
          y: origin.y + frame.top + frame.height * 0.8,
        };
        await dragTo(from, [to]);

        const drawn = await settledCropState('the drawn frame', (state) => state.tool === 'crop');
        nearly(drawn.frame.left, from.x - origin.x);
        nearly(drawn.frame.top, from.y - origin.y);
        nearly(drawn.frame.width, to.x - from.x);
        nearly(drawn.frame.height, to.y - from.y);
        // One frame per activation, then back to the normal crop tool.
        expect(drawn.tool).toBe('crop');
        await cancelCrop();
      }, 120_000);

      it('commits on Enter and the export has the crop shown in the editor', async () => {
        await openCrop('pool_001.NEF');
        const first = await cropState();
        const { frame, origin } = first;
        const corner = { x: origin.x + frame.left + frame.width, y: origin.y + frame.top };
        // Rotate a little (outside the upper-right corner), then pan.
        await dragTo({ x: corner.x + 16, y: corner.y - 16 }, [
          { x: corner.x + 40, y: corner.y + 60 },
        ]);
        const rotated = await settledCropState(
          'the rotated crop',
          (state) => state.gesture === '' && Math.abs(state.angle) > 1,
        );
        const centre = {
          x: origin.x + rotated.frame.left + rotated.frame.width / 2,
          y: origin.y + rotated.frame.top + rotated.frame.height / 2,
        };
        await dragTo(centre, [{ x: centre.x - 20, y: centre.y + 10 }]);
        const draft = await settledCropState(
          'the panned draft',
          (state) => state.gesture === '' && state.crop[0] !== rotated.crop[0],
        );

        await window.keyboard.press('Enter');
        await window.locator('[data-testid="crop-toolbar"]').waitFor({ state: 'detached' });

        const photo = photos.find((candidate) => candidate.fileName === 'pool_001.NEF')!;
        const params = await waitFor('the saved crop', async () => {
          const current = await invoke<{ crop?: CropParams }>('develop:getParams', {
            photoId: photo.id,
          });
          return current.crop ? current : undefined;
        });
        const saved = params.crop!;
        [saved.left, saved.top, saved.right, saved.bottom, saved.angle].forEach((value, index) =>
          expect(value).toBeCloseTo(draft.crop[index]!, 5),
        );
        const expected = exportSize(
          { width: photo.width ?? 0, height: photo.height ?? 0 },
          saved,
          mainPreset,
        );

        // The normal view shows the committed crop at the exported aspect ratio.
        const shown = await window.locator('[data-testid="develop-canvas"]').boundingBox();
        if (!shown) throw new Error('no canvas');
        expect(shown.width / shown.height).toBeCloseTo(expected.width / expected.height, 1);

        await finishAndCheckCropUpload(photo, expected, 'pool_001.jpg');
      }, 180_000);
    });
  },
);
