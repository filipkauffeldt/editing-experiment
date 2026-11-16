// Fills a throwaway userData folder with a realistic large Library and measures the built app.
// Usage: pnpm tsx scripts/measure-library-scale.ts [--photos 60000] [--folders 100] [--keep]
//
// Nothing here is shipped. The index rows look like ingest's, the search text is already read,
// and a handful of generated JPEGs are reused for every cached thumbnail and preview (no
// binaries are stored in the repository). Run `pnpm build` first; the app is launched with
// EE_USER_DATA_DIR pointing at the generated folder.
import { _electron as electron } from '@playwright/test';
import { encodeJpeg } from '../crates/core/src/index.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PhotoIndex } from '../apps/desktop/src/jobs/backend/photo-index.ts';
import type { LibraryOverview, Photo } from '../packages/contracts/src/photo.ts';
import type { PhotoId } from '../packages/contracts/src/ids.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));

interface Options {
  photos: number;
  folders: number;
  keep: boolean;
}

function options(argv: string[]): Options {
  const value = (name: string, fallback: number): number => {
    const at = argv.indexOf(name);
    if (at < 0) return fallback;
    const parsed = Number(argv[at + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`${name} needs a positive number`);
    return parsed;
  };
  return {
    photos: value('--photos', 60_000),
    folders: value('--folders', 100),
    keep: argv.includes('--keep'),
  };
}

function launchEnvironment(
  userData: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    EE_USER_DATA_DIR: userData,
    EE_SOFTWARE_GL: '1',
    ...extra,
  };
}

function ensureDisplay(): void {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return;
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error('No display found and xvfb-run is not installed.');
    process.exit(1);
  }
  const rerun = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exit(rerun.status ?? 1);
}

function frame(width: number, height: number, tint: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (40 + tint * 11) % 255;
    rgba[i * 4 + 1] = (70 + (((i / width) | 0) % 140)) % 255;
    rgba[i * 4 + 2] = (90 + (((i % width) | 0) % 120)) % 255;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

async function jpeg(width: number, height: number, tint: number): Promise<Buffer> {
  return encodeJpeg(frame(width, height, tint), width, height, {
    quality: 70,
    chroma: '420',
    iccSrgb: true,
  });
}

/** One small preview and thumbnail, reused for every photo. */
async function sampleJpegs(): Promise<{ preview: Buffer; thumb: Buffer }> {
  return {
    preview: await jpeg(640, 427, 1),
    thumb: await jpeg(320, 213, 2),
  };
}

function folderNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, '0');
    const month = String(1 + (index % 12)).padStart(2, '0');
    return `${month}-${day} match-${String(index + 1).padStart(3, '0')}`;
  });
}

/** Which folder each photo goes to: two 3,000 frame matches, the rest spread over the others. */
function distribution(total: number, folders: number): number[] {
  if (folders < 2) return [total];
  const big = Math.min(3000, Math.floor(total / 4));
  const rest = total - big * 2;
  const small = Math.floor(rest / (folders - 2));
  const counts = [big, big, ...Array.from({ length: folders - 2 }, () => small)];
  const last = counts.length - 1;
  counts[last] = (counts[last] ?? 0) + total - counts.reduce((sum, value) => sum + value, 0);
  return counts;
}

async function generate(options: Options): Promise<{ userData: string; destination: string }> {
  const base = mkdtempSync(join(tmpdir(), 'ee-scale-'));
  const userData = join(base, 'userData');
  const destination = join(base, 'Photos');
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(userData, 'cache', 'thumb'), { recursive: true });
  mkdirSync(join(userData, 'cache', 'preview'), { recursive: true });
  mkdirSync(destination, { recursive: true });

  writeFileSync(
    join(userData, 'machine.json'),
    JSON.stringify({
      version: 1,
      format: 'ee-machine',
      ingest: { destinationPath: destination },
      exportRoot: join(base, 'exports'),
      paths: {},
      sources: [],
      destinations: [],
    }),
  );

  const { preview, thumb } = await sampleJpegs();
  const index = new PhotoIndex(join(userData, 'index.sqlite'));
  const names = folderNames(options.folders);
  const counts = distribution(options.photos, options.folders);
  const started = Date.now();
  let made = 0;
  for (let folder = 0; folder < counts.length; folder += 1) {
    const count = counts[folder]!;
    const folderPath = join(destination, '2026', names[folder]!);
    mkdirSync(folderPath, { recursive: true });
    for (let n = 0; n < count; n += 1) {
      made += 1;
      const id = `00000000-0000-4000-8000-${String(made).padStart(12, '0')}` as PhotoId;
      const fileName = `_DSC${String(1000 + n).padStart(4, '0')}.NEF`;
      const path = join(folderPath, fileName);
      const photo: Photo = {
        id,
        path,
        sidecarPath: `${path}.xmp`,
        fileName,
        captureTime: `2026-${String(1 + (folder % 12)).padStart(2, '0')}-${String(1 + (folder % 28)).padStart(2, '0')}T${String(10 + (n % 8)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:07`,
        camera: {
          make: 'NIKON CORPORATION',
          model: n % 2 === 0 ? 'NIKON Z 9' : 'NIKON Z 8',
          lens: 'NIKKOR Z 70-200mm f/2.8 VR S',
          serialNumber: n % 2 === 0 ? '3001234' : '6005678',
          iso: 3200,
          focalLength: 135,
          aperture: 2.8,
          shutter: 1 / 1000,
        },
        width: 8256,
        height: 5504,
        sourceId: 'in-place' as Photo['sourceId'],
        tagged: n % 3 === 0,
        rating: n % 6 === 0 ? 5 : n % 5 === 0 ? 3 : 0,
        colorClass: n % 40 === 0 ? 2 : 0,
        status: {
          ingest: 'done',
          edited: n % 11 === 0,
          metadataDiffersFromTemplate: false,
          export: n % 7 === 0 ? 'done' : 'none',
          upload: n % 7 === 0 ? 'done' : 'none',
        },
        versions: [
          { id: `${id}-develop` as Photo['versions'][number]['id'], kind: 'develop', ops: {} },
        ],
      };
      index.save(photo);
      writeFileSync(join(userData, 'cache', 'thumb', `${id}.jpg`), thumb);
      writeFileSync(join(userData, 'cache', 'preview', `${id}.jpg`), preview);
    }
  }
  index.close();
  // The search index reads captions in the background when a row has none. Fill them in one
  // transaction, as a finished background pass would have.
  const db = new DatabaseSync(join(userData, 'index.sqlite'));
  db.exec(`UPDATE photos SET search_text = 'match report ' || file_name || ' sportfotografen.se'`);
  db.close();
  console.log(`generated ${made} photos in ${counts.length} folders in ${Date.now() - started} ms`);
  return { userData, destination };
}

interface Sample {
  ms: number;
  detail?: string;
}

async function run(options: Options, userData: string): Promise<void> {
  const launchedAt = Date.now();
  const app = await electron.launch({
    executablePath: desktopRequire('electron') as string,
    args: [join(root, 'apps/desktop')],
    env: launchEnvironment(userData),
  });
  const page = await app.firstWindow();
  const windowShown = Date.now();
  page.setDefaultTimeout(60_000);
  try {
    const samples: Record<string, Sample> = {};
    samples['window shown'] = { ms: windowShown - launchedAt };
    await page.waitForFunction(
      () => document.querySelector('[data-store-ready="true"]') !== null,
      undefined,
      {
        timeout: 120_000,
      },
    );
    samples['launch to ready'] = { ms: Date.now() - launchedAt };
    samples['window to ready'] = { ms: Date.now() - windowShown };

    const firstThumbnails = async (): Promise<void> => {
      await page.waitForFunction(
        () => {
          const cells = [...document.querySelectorAll('[data-testid="library-cell"] img')];
          return (
            cells.length > 0 &&
            cells.slice(0, 12).every((img) => (img as HTMLImageElement).complete)
          );
        },
        undefined,
        { timeout: 60_000 },
      );
    };

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    });
    samples['Library'] = { ms: Date.now() - launchedAt };
    await page.waitForSelector('[data-testid="library-grid"]');
    const firstThumbs = Date.now();
    await page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('[data-testid="library-cell"] img')];
        return (
          images.length > 0 &&
          images.slice(0, 12).every((img) => (img as HTMLImageElement).complete)
        );
      },
      undefined,
      { timeout: 60_000 },
    );
    samples['first thumbnails'] = { ms: Date.now() - firstThumbs };
    // Let the background scans (presets, profiles, old edited previews) get out of the way;
    // the folder numbers are for a Library that is loaded, not still starting up.
    await page.waitForTimeout(1_500);

    const folderRows = page.locator('[data-testid="library-folders"] li button');
    const rowCount = await folderRows.count();
    const firstFolderText = (await folderRows.nth(1).locator('span').last().textContent()) ?? '';
    const bigCount = Number(firstFolderText.trim() || options.photos);
    const switchStart = Date.now();
    await folderRows.nth(Math.min(3, rowCount - 1)).click();
    await firstThumbnails();
    samples['folder switch'] = { ms: Date.now() - switchStart };

    // The generator makes two large folders first.
    await folderRows.nth(1).click();
    const bigStart = Date.now();
    await page.waitForFunction(
      (expected) =>
        (document.querySelector('[data-testid="filter-count"]')?.textContent ?? '').trim() ===
        String(expected),
      bigCount,
      { timeout: 60_000 },
    );
    samples['open large folder'] = { ms: Date.now() - bigStart };
    const thumbStart = Date.now();
    await page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('[data-testid="library-cell"] img')];
        return (
          images.length > 0 &&
          images.slice(0, 24).every((img) => (img as HTMLImageElement).complete)
        );
      },
      undefined,
      { timeout: 60_000 },
    );
    samples['large folder first thumbnails'] = { ms: Date.now() - thumbStart };

    const search = page.getByTestId('filter-search');
    const searchStart = Date.now();
    await search.fill('match-001');
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="filter-count"]')?.textContent ?? '').includes(
          ' of ',
        ),
      undefined,
      { timeout: 30_000 },
    );
    samples['search'] = { ms: Date.now() - searchStart };
    await search.fill('');
    await page.waitForTimeout(300);

    const tagButtons = page.locator(
      '[data-testid="filter-bar"] [role="group"][aria-label="Tag"] button',
    );
    const filterStart = Date.now();
    await tagButtons.nth(1).click();
    await page.waitForTimeout(50);
    samples['filter change'] = { ms: Date.now() - filterStart };
    await tagButtons.first().click();
    await page.waitForTimeout(200);

    await page.locator('[data-testid="library-cell"]').first().click();
    const selectStart = Date.now();
    await page.keyboard.press('Control+a');
    await page.waitForFunction(
      (expected) =>
        (document.querySelector('[data-testid="library-selection-count"]')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim() === `${expected} selected`,
      bigCount,
      { timeout: 30_000 },
    );
    samples['select all in the folder'] = { ms: Date.now() - selectStart };

    // Baseline: an idle page's frames in the same headless window.
    const baseline = await page.evaluate(async () => {
      const times: number[] = [];
      let last = performance.now();
      for (let step = 0; step < 120; step += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      return {
        frames: times.length,
        over50: times.filter((time) => time > 50).length,
        worst: Math.round(Math.max(...times)),
      };
    });
    samples['idle frame time'] = {
      ms: baseline.worst,
      detail: `${baseline.over50} of ${baseline.frames} frames over 50 ms`,
    };

    // Scroll through the folder and count long frames.
    const frames = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="library-grid"]');
      if (!viewport) return { frames: 0, over50: 0, worst: 0 };
      const times: number[] = [];
      let last = performance.now();
      for (let step = 0; step < 120; step += 1) {
        viewport.scrollTop += 280;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      return {
        frames: times.length,
        over50: times.filter((time) => time > 50).length,
        worst: Math.round(Math.max(...times)),
      };
    });
    samples['grid scroll (fast flick)'] = {
      ms: frames.worst,
      detail: `${frames.over50} of ${frames.frames} frames over 50 ms`,
    };

    // A steady wheel scroll: one row every other frame, the way a long folder is read.
    const steady = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="library-grid"]');
      if (!viewport) return { frames: 0, over50: 0, worst: 0 };
      viewport.scrollTop = 0;
      const times: number[] = [];
      let last = performance.now();
      for (let step = 0; step < 120; step += 1) {
        if (step % 2 === 0) viewport.scrollTop += 160;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      return {
        frames: times.length,
        over50: times.filter((time) => time > 50).length,
        worst: Math.round(Math.max(...times)),
      };
    });
    samples['grid scroll (steady)'] = {
      ms: steady.worst,
      detail: `${steady.over50} of ${steady.frames} frames over 50 ms`,
    };

    const folderIpc = await page.evaluate(async () => {
      const transport = (
        window as unknown as {
          eeTransport: {
            invoke(channel: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).eeTransport;
      const folders = (await transport.invoke('photos:folders', [])).value as {
        folders: { path: string }[];
      };
      const started = performance.now();
      const result = await transport.invoke('photos:list', [{ folder: folders.folders[0]?.path }]);
      const elapsed = performance.now() - started;
      return {
        ms: Math.round(elapsed),
        bytes: new Blob([JSON.stringify(result.value)]).size,
      };
    });
    samples['IPC photos:list call'] = {
      ms: folderIpc.ms,
      detail: `${Math.round(folderIpc.bytes / 1024)} kB`,
    };

    const sizes = await page.evaluate(async () => {
      const transport = (
        window as unknown as {
          eeTransport: {
            invoke(channel: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).eeTransport;
      const call = async <T>(channel: string, args: unknown[] = []): Promise<T> => {
        const result = await transport.invoke(channel, args);
        if (!result.ok) throw new Error(`IPC ${channel} failed`);
        return result.value as T;
      };
      const bytes = (value: unknown): number => new Blob([JSON.stringify(value)]).size;
      const folders = await call<LibraryOverview>('photos:folders');
      const photos = await call<Photo[]>('photos:list', [{ folder: folders.folders[0]?.path }]);
      const page = await call<{ photos: Photo[] }>('photos:query', [
        { folder: folders.folders[0]?.path, limit: 3000 },
      ]);
      return {
        folders: { rows: folders.folders.length, bytes: bytes(folders) },
        folderPhotos: { rows: photos.length, bytes: bytes(photos) },
        queryPage: { rows: page.photos.length, bytes: bytes(page) },
      };
    });

    const memory = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((metric) => ({
        type: metric.type,
        pid: metric.pid,
        workingSetKb: metric.memory.workingSetSize,
      })),
    );
    const ping = await page.evaluate(async () => {
      const transport = (
        window as unknown as {
          eeTransport: {
            invoke(channel: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown }>;
          };
        }
      ).eeTransport;
      const result = await transport.invoke('system:ping', [{ message: 'memory' }]);
      return result.value as { jobsPid: number };
    });
    const jobsRss = Number(
      spawnSync('ps', ['-o', 'rss=', '-p', String(ping.jobsPid)], {
        encoding: 'utf8',
      }).stdout.trim(),
    );

    console.log('\nLibrary scale report');
    console.log(`photos: ${options.photos}, folders: ${options.folders}`);
    for (const [name, sample] of Object.entries(samples)) {
      console.log(
        `  ${name.padEnd(30)} ${String(sample.ms).padStart(7)} ms${sample.detail ? ` (${sample.detail})` : ''}`,
      );
    }
    const renderer = memory.find((metric) => metric.type === 'Tab');
    console.log(
      `  renderer working set            ${String(Math.round((renderer?.workingSetKb ?? 0) / 1024)).padStart(7)} MB`,
    );
    console.log(
      `  jobs RSS                        ${String(Math.round(jobsRss / 1024)).padStart(7)} MB`,
    );
    console.log(
      `  IPC photos:folders              ${String(sizes.folders.rows).padStart(7)} rows, ${Math.round(sizes.folders.bytes / 1024)} kB`,
    );
    console.log(
      `  IPC folder photos:list          ${String(sizes.folderPhotos.rows).padStart(7)} rows, ${Math.round(sizes.folderPhotos.bytes / 1024)} kB`,
    );
    console.log(
      `  IPC photos:query page           ${String(sizes.queryPage.rows).padStart(7)} rows, ${Math.round(sizes.queryPage.bytes / 1024)} kB`,
    );
  } finally {
    await app.close();
  }
}

ensureDisplay();
const parsed = options(process.argv.slice(2));
const built = existsSync(join(root, 'apps/desktop/out/main/index.js'));
if (!built) {
  console.error('The app is not built. Run `pnpm build` first.');
  process.exit(1);
}
const generated = await generate(parsed);
try {
  await run(parsed, generated.userData);
} finally {
  if (!parsed.keep) rmSync(dirname(generated.userData), { recursive: true, force: true });
  else console.log(`kept ${generated.userData}`);
}
