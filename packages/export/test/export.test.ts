import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPhotoId } from '@ee/contracts';
import { EmbeddedPreviewError, exportPhoto } from '../src/index';
import { addExifThumbnail } from './helpers/embedded';
import { testImage } from './helpers/images';
import { testPreset } from './helpers/presets';

const photoId = asPhotoId('photo-1');
const preset = testPreset({ quality: 88, metadata: 'all' });

describe('exportPhoto', () => {
  let dir: string;
  let exiftool: ExifTool;
  let thumbnail: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-export-'));
    exiftool = new ExifTool();
    thumbnail = (
      await import('../src/index').then(({ encodeJpeg }) =>
        encodeJpeg(testImage(32, 24), testPreset({ quality: 80, metadata: 'none' })),
      )
    ).data;
  });

  afterAll(async () => {
    await exiftool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes, metadata-tags and publishes atomically', async () => {
    const outputDir = path.join(dir, 'out');
    const calls: { jpegPath: string; sawFinal: boolean }[] = [];

    const result = await exportPhoto({
      image: testImage(200, 150),
      preset,
      outputDir,
      fileName: 'finish.jpg',
      photoId,
      hooks: {
        async writeMetadata(jpegPath, givenPhotoId) {
          expect(givenPhotoId).toBe(photoId);
          await access(jpegPath);
          const final = path.join(outputDir, 'finish.jpg');
          calls.push({
            jpegPath,
            sawFinal: await access(final).then(
              () => true,
              () => false,
            ),
          });
          await exiftool.write(jpegPath, { Artist: 'Metadata Hook', Headline: 'Finish' }, [
            '-overwrite_original',
          ]);
        },
      },
    });

    expect(result.path).toBe(path.join(outputDir, 'finish.jpg'));
    expect(result.bytes).toBe((await stat(result.path)).size);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.jpegPath).not.toBe(result.path);
    expect(calls[0]?.sawFinal).toBe(false);

    const tags = await exiftool.read(result.path);
    expect(tags.Artist).toBe('Metadata Hook');
    expect(tags.Headline).toBe('Finish');

    const remaining = await readdir(outputDir);
    expect(remaining).toEqual(['finish.jpg']);
  });

  it('skips the metadata hook when metadata is none', async () => {
    let called = false;
    const result = await exportPhoto({
      image: testImage(40, 30),
      preset: testPreset({ quality: 80, metadata: 'none' }),
      outputDir: path.join(dir, 'none'),
      fileName: 'plain.jpg',
      photoId,
      hooks: {
        async writeMetadata() {
          called = true;
        },
      },
    });
    expect(called).toBe(false);
    await expect(access(result.path)).resolves.toBeUndefined();
  });

  it('fails the export when the metadata hook adds an EXIF thumbnail', async () => {
    const outputDir = path.join(dir, 'dirty');
    const finalPath = path.join(outputDir, 'leak.jpg');

    await expect(
      exportPhoto({
        image: testImage(120, 90),
        preset,
        outputDir,
        fileName: 'leak.jpg',
        photoId,
        hooks: {
          async writeMetadata(jpegPath) {
            await addExifThumbnail(jpegPath, thumbnail);
          },
        },
      }),
    ).rejects.toBeInstanceOf(EmbeddedPreviewError);

    await expect(access(finalPath)).rejects.toThrow();
    const remaining = await readdir(outputDir);
    expect(remaining).toEqual([]);
  });

  it('rejects file names that escape the output directory', async () => {
    await expect(
      exportPhoto({
        image: testImage(10, 10),
        preset,
        outputDir: path.join(dir, 'bad'),
        fileName: '../escape.jpg',
        photoId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_file_name' });
    await expect(
      exportPhoto({
        image: testImage(10, 10),
        preset,
        outputDir: path.join(dir, 'bad'),
        fileName: 'nested/escape.jpg',
        photoId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_file_name' });
  });

  it('suffixes by default instead of replacing an existing file', async () => {
    const outputDir = path.join(dir, 'default-suffix');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    await writeFile(path.join(outputDir, 'same.jpg'), 'old');

    const result = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
    });
    expect(path.basename(result.path)).toBe('same-1.jpg');
    expect(await readFile(path.join(outputDir, 'same.jpg'), 'utf8')).toBe('old');
  });

  it('refuses to overwrite a file it did not export', async () => {
    const outputDir = path.join(dir, 'foreign-overwrite');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    const existing = path.join(outputDir, 'same.jpg');
    await writeFile(existing, 'old');

    await expect(
      exportPhoto({
        image: testImage(30, 20),
        preset,
        outputDir,
        fileName: 'same.jpg',
        photoId,
        ifExists: 'overwrite',
      }),
    ).rejects.toMatchObject({ code: 'target_exists' });
    expect(await readFile(existing, 'utf8')).toBe('old');
  });

  it('overwrites a file the app says it exported', async () => {
    const outputDir = path.join(dir, 'our-overwrite');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    const existing = path.join(outputDir, 'same.jpg');
    await writeFile(existing, 'old');

    const result = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
      ifExists: 'overwrite',
      canOverwrite: () => true,
    });
    expect(result.path).toBe(existing);
    expect(result.bytes).toBeGreaterThan(3);
  });

  it('rejects a target that a host says is protected, even before writing', async () => {
    const outputDir = path.join(dir, 'protected');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    await expect(
      exportPhoto({
        image: testImage(10, 10),
        preset,
        outputDir,
        fileName: 'original.jpg',
        photoId,
        ifExists: 'suffix',
        checkTarget: () => {
          throw new Error('protected');
        },
      }),
    ).rejects.toThrow('protected');
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('adds a suffix instead of overwriting when asked', async () => {
    const outputDir = path.join(dir, 'suffix');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    await writeFile(path.join(outputDir, 'same.jpg'), 'old');

    const result = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
      ifExists: 'suffix',
    });
    expect(path.basename(result.path)).toBe('same-1.jpg');
    expect(result.skipped).toBeUndefined();
    expect(await readFile(path.join(outputDir, 'same.jpg'), 'utf8')).toBe('old');

    const again = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
      ifExists: 'suffix',
    });
    expect(path.basename(again.path)).toBe('same-2.jpg');
  });

  it('skips and leaves the existing file untouched when asked', async () => {
    const outputDir = path.join(dir, 'skip');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    const existing = path.join(outputDir, 'same.jpg');
    await writeFile(existing, 'old');

    const result = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
      ifExists: 'skip',
    });
    expect(result).toMatchObject({ path: existing, skipped: true });
    expect(await readFile(existing, 'utf8')).toBe('old');
    expect(await readdir(outputDir)).toEqual(['same.jpg']);
  });
});
