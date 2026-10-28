import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ExifToolService } from '../src/exiftool';
import { readPhotoLabels, writePhotoLabels } from '../src/labels';
import { copyFixture, cleanupTempDirs, fixtureAvailable, makeJpeg, makeTempDir } from './helpers';

describe('Photo Mechanic labels', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it.skipIf(!fixtureAvailable('z30_14bit.NEF'))(
    'writes tag and colour class to a raw sidecar without touching the raw',
    async () => {
      const dir = await makeTempDir();
      const raw = await copyFixture('z30_14bit.NEF', dir);

      await writePhotoLabels(raw, { tagged: true, colorClass: 3 }, { service });
      expect(await readPhotoLabels(raw, service)).toEqual({ tagged: true, colorClass: 3 });

      const tags = await service.read(join(dir, 'z30_14bit.xmp'));
      expect(String(tags['XMP-photomech:Tagged'])).toMatch(/yes|true/i);
      expect(String(tags['XMP-photomech:ColorClass'])).toMatch(/^3\b/);
      expect(String(tags['XMP-xmp:Label'])).toBe('Yellow');

      await writePhotoLabels(raw, { tagged: false, colorClass: 0 }, { service });
      expect(await readPhotoLabels(raw, service)).toEqual({ tagged: false, colorClass: 0 });
    },
  );

  it('embeds labels in a JPEG', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writePhotoLabels(jpeg, { tagged: true, colorClass: 7 }, { service });
    expect(await readPhotoLabels(jpeg, service)).toEqual({ tagged: true, colorClass: 7 });

    const tags = await service.read(jpeg);
    expect(String(tags['XMP-photomech:ColorClass'])).toMatch(/^7\b/);
    expect(String(tags['XMP-xmp:Label'])).toBe('Pink');
  });

  it('rejects a colour class outside 0..8', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await expect(writePhotoLabels(jpeg, { colorClass: 9 }, { service })).rejects.toThrow(
      /colorClass/,
    );
  });
});
