// @vitest-environment node
import { asJobId, asPhotoId, asSourceId } from '@ee/contracts';
import type { IngestedFileInfo } from '@ee/ingest';
import { ExifToolService, ensureXmpFile, readIptc, writeIptc } from '@ee/metadata';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOnFileIngested } from '../src/jobs/backend/ingest-pipeline';
import { MetadataService } from '../src/jobs/backend/metadata-service';
import { PhotoIndex } from '../src/jobs/backend/photo-index';
import { PhotoLibrary } from '../src/jobs/backend/photo-library';
import { PreviewCache } from '../src/jobs/backend/previews';
import { SettingsStore } from '../src/jobs/backend/settings-store';
import { defaultSettings } from '../src/shared/settings';
import { fixtureNefs, sampleNefs } from './helpers/fixtures';

/** What the ingest copy step leaves: the source's modified time, long before "now". */
const SHOT = new Date('2026-05-01T10:00:00Z');
/** exFAT keeps 2 s steps. */
const GRANULARITY_MS = 2000;

describe('what the ingest hook does to a copy’s modified time', () => {
  let root: string;
  let exiftool: ExifToolService;
  let library: PhotoLibrary;
  let hook: ReturnType<typeof createOnFileIngested>;
  let templatePath: string;
  let reports: string[];

  beforeAll(() => {
    exiftool = new ExifToolService();
  });
  afterAll(() => exiftool.close());

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ee-ingest-time-'));
    reports = [];
    library = new PhotoLibrary(new PhotoIndex(':memory:'), () => {});
    const settings = new SettingsStore(undefined, defaultSettings(root));
    templatePath = join(root, 'template.XMP');
    await ensureXmpFile(templatePath);
    await writeIptc(
      templatePath,
      { caption: 'Match report', credit: 'Sportfotografen', keywords: ['football'] },
      { service: exiftool },
    );
    hook = createOnFileIngested(
      {
        photos: library,
        previews: new PreviewCache(join(root, 'thumb'), join(root, 'preview')),
        metadata: new MetadataService(library, exiftool, settings),
        edits: {} as never,
        exiftool,
        report: (event) => reports.push(event.message),
      },
      { metadataTemplatePath: templatePath, metadataTemplateMode: 'replace' },
    );
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const info = (path: string, backupPath: string): IngestedFileInfo => ({
    photoId: asPhotoId('p'),
    jobId: asJobId('j'),
    sourceId: asSourceId('s'),
    sourceKind: 'folder',
    sourceName: 's',
    sourcePath: path,
    sourceFileName: path.split('/').pop()!,
    path,
    fileName: path.split('/').pop()!,
    backupPath,
    size: 1,
    mtimeMs: SHOT.getTime(),
    sha256: '',
    seq: 1,
  });
  const mtime = async (path: string): Promise<number> => (await stat(path)).mtimeMs;
  const expectShot = async (path: string): Promise<void> => {
    expect(Math.abs((await mtime(path)) - SHOT.getTime()), path).toBeLessThanOrEqual(
      GRANULARITY_MS,
    );
  };

  it('keeps the time of a JPEG that takes the template inside the file, and of its backup', async () => {
    const primary = join(root, 'primary');
    const backup = join(root, 'backup');
    await Promise.all([mkdir(primary), mkdir(backup)]);
    const path = join(primary, 'frame.jpg');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } })
      .jpeg()
      .toFile(path);
    await copyFile(path, join(backup, 'frame.jpg'));
    await utimes(path, new Date(), SHOT);
    await utimes(join(backup, 'frame.jpg'), new Date(), SHOT);

    await hook(info(path, join(backup, 'frame.jpg')));

    // The template really was written into the file (so ExifTool did rewrite it)...
    expect((await readIptc(path, exiftool)).caption).toBe('Match report');
    expect((await readIptc(join(backup, 'frame.jpg'), exiftool)).caption).toBe('Match report');
    // ...and the time is still the source's, on both copies.
    await expectShot(path);
    await expectShot(join(backup, 'frame.jpg'));
    expect(reports).toEqual([]);
  });

  it('leaves a JPEG’s time alone when nothing is written to it', async () => {
    const path = join(root, 'plain.jpg');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } })
      .jpeg()
      .toFile(path);
    await utimes(path, new Date(), SHOT);
    const noTemplate = createOnFileIngested(
      {
        photos: library,
        previews: new PreviewCache(join(root, 'thumb'), join(root, 'preview')),
        metadata: {} as never,
        edits: {} as never,
        exiftool,
        report: (event) => reports.push(event.message),
      },
      {},
    );

    await noTemplate(info(path, ''));

    await expectShot(path);
  });

  describe('a camera raw', () => {
    const nef = sampleNefs()[0] ?? fixtureNefs()[0];

    it.skipIf(nef === undefined)(
      'is never written to; the sidecar is new, and the backup sidecar mirrors it',
      async () => {
        const primary = join(root, 'primary');
        const backup = join(root, 'backup');
        await Promise.all([mkdir(primary), mkdir(backup)]);
        const path = join(primary, 'frame.NEF');
        await copyFile(nef!, path);
        await copyFile(nef!, join(backup, 'frame.NEF'));
        await utimes(path, new Date(), SHOT);
        await utimes(join(backup, 'frame.NEF'), new Date(), SHOT);
        const bytes = await readFile(path);

        await hook({ ...info(path, join(backup, 'frame.NEF')), fileName: 'frame.NEF' });

        expect((await readFile(path)).equals(bytes)).toBe(true);
        await expectShot(path);
        await expectShot(join(backup, 'frame.NEF'));
        // The sidecar did not exist on the card: it is created now, which is its time. The
        // backup's is the same file's time, not the moment of the mirror.
        const sidecar = join(primary, 'frame.xmp');
        expect(
          Math.abs((await mtime(join(backup, 'frame.xmp'))) - (await mtime(sidecar))),
        ).toBeLessThanOrEqual(GRANULARITY_MS);
        expect(await mtime(sidecar)).toBeGreaterThan(SHOT.getTime() + 24 * 3600 * 1000);
        expect(reports).toEqual([]);
      },
      60_000,
    );
  });
});
