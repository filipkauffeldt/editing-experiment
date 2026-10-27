import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExifToolService } from '../src/exiftool';
import { ensureXmpFile } from '../src/paths';
import { MetadataError } from '../src/errors';
import { cleanupTempDirs, makeJpeg, makeTempDir } from './helpers';

describe('ExifToolService', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService({ maxConcurrent: 2 });
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it('reads tags from a real JPEG with schema groups', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    const tags = await service.read(jpeg);
    expect(tags['File:FileType']).toBe('JPEG');
    expect(tags['File:MIMEType']).toBe('image/jpeg');
  });

  it('writes and reads back UTF-8 IIM and XMP in one file', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'utf8.jpg');
    await makeJpeg(jpeg);

    await service.write(jpeg, {
      'IPTC:CodedCharacterSet': 'UTF8',
      'IPTC:Caption-Abstract': 'Ångström åäö 😀',
      'XMP-dc:Description': 'Ångström åäö 😀',
    });

    const tags = await service.read(jpeg);
    expect(tags['IPTC:CodedCharacterSet']).toBe('UTF8');
    expect(tags['IPTC:Caption-Abstract']).toBe('Ångström åäö 😀');
    expect(tags['XMP-dc:Description']).toBe('Ångström åäö 😀');
  });

  it('serialises concurrent tasks without corrupting the process', async () => {
    const dir = await makeTempDir();
    const files = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const file = join(dir, `photo-${String(i)}.jpg`);
        await makeJpeg(file);
        return file;
      }),
    );

    const results = await Promise.all(files.map((file) => service.read(file)));
    expect(results).toHaveLength(8);
    expect(results.every((tags) => tags['File:FileType'] === 'JPEG')).toBe(true);
  });

  it('does not leave ExifTool _original backups', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await service.write(jpeg, { 'XMP-dc:Title': 'JPEG title' });
    expect(await readdir(dir)).toEqual(['photo.jpg']);

    const sidecar = join(dir, 'photo.xmp');
    await ensureXmpFile(sidecar);
    await service.write(sidecar, { 'XMP-dc:Title': 'Sidecar title' });
    expect((await readdir(dir)).sort()).toEqual(['photo.jpg', 'photo.xmp']);
  });

  it('rejects work after close and closes idempotently', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    const local = new ExifToolService();
    await local.close();
    await local.close();

    await expect(local.read(jpeg)).rejects.toBeInstanceOf(MetadataError);
    await expect(local.read(jpeg)).rejects.toMatchObject({ code: 'EXIFTOOL' });
  });
});
