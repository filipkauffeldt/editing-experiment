import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPhotoId } from '@ee/contracts';
import { EmbeddedPreviewError, exportPhoto } from '../src/index';
import { addExifThumbnail } from './helpers/embedded';
import { testImage } from './helpers/images';

const photoId = asPhotoId('photo-1');
const preset = { quality: 88, metadata: 'all' as const };

describe('exportPhoto', () => {
  let dir: string;
  let exiftool: ExifTool;
  let thumbnail: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ee-export-'));
    exiftool = new ExifTool();
    thumbnail = (
      await import('../src/index').then(({ encodeJpeg }) =>
        encodeJpeg(testImage(32, 24), { quality: 80, metadata: 'none' }),
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
      preset: { quality: 80, metadata: 'none' },
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

  it('replaces an existing export', async () => {
    const outputDir = path.join(dir, 'replace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
    await writeFile(path.join(outputDir, 'same.jpg'), 'old');

    const result = await exportPhoto({
      image: testImage(30, 20),
      preset,
      outputDir,
      fileName: 'same.jpg',
      photoId,
    });
    expect(result.bytes).toBeGreaterThan(3);
  });
});
