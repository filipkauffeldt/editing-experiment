import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ExifToolService } from '../src/exiftool';
import {
  orientationAfterTurns,
  readXmpOrientation,
  rotationFromOrientations,
  writeXmpOrientation,
} from '../src/orientation';
import { sidecarPathFor } from '../src/paths';
import { cleanupTempDirs, makeJpeg, makeTempDir, makeTiff, sha256File } from './helpers';

const service = new ExifToolService();
afterAll(() => service.close());
afterEach(cleanupTempDirs);

describe('orientation maths for the sidecar', () => {
  it('writes the camera orientation with the turn applied', () => {
    expect(orientationAfterTurns(1, 1)).toBe(6);
    expect(orientationAfterTurns(1, -1)).toBe(8);
    expect(orientationAfterTurns(6, 1)).toBe(3);
    expect(orientationAfterTurns(undefined, 2)).toBe(3);
  });

  it('reads the turn back relative to the camera', () => {
    expect(rotationFromOrientations(1, 6)).toBe(1);
    expect(rotationFromOrientations(6, 3)).toBe(1);
    expect(rotationFromOrientations(6, 6)).toBe(0);
    expect(rotationFromOrientations(8, 1)).toBe(1);
    expect(rotationFromOrientations(1, undefined)).toBe(0);
    // A mirror is not a turn.
    expect(rotationFromOrientations(1, 2)).toBe(0);
  });
});

describe('a raw', () => {
  it('gets tiff:Orientation in its sidecar and is never written', async () => {
    const dir = await makeTempDir();
    // A TIFF named like a raw: ExifTool can read it, and the app treats it as one.
    const raw = join(dir, 'IMG_0001.NEF');
    await makeTiff(raw);
    const before = await sha256File(raw);

    await writeXmpOrientation(raw, 6, { service });

    expect(await sha256File(raw)).toBe(before);
    const sidecar = await readFile(sidecarPathFor(raw), 'utf8');
    expect(sidecar).toMatch(/tiff:Orientation(="6"|>6<)/);
    expect(await readXmpOrientation(raw, service)).toBe(6);
  });

  it('keeps the other metadata of the sidecar and removes only the orientation', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'IMG_0002.NEF');
    await makeTiff(raw);
    await writeXmpOrientation(raw, 8, { service });
    await service.write(sidecarPathFor(raw), { 'XMP-xmp:Rating': 4 });

    await writeXmpOrientation(raw, undefined, { service });

    expect(await readXmpOrientation(raw, service)).toBeUndefined();
    const sidecar = await readFile(sidecarPathFor(raw), 'utf8');
    expect(sidecar).not.toContain('tiff:Orientation');
    expect(sidecar).toMatch(/xmp:Rating(="4"|>4<)/);
  });

  it('writes no sidecar just to remove an orientation it does not have', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'IMG_0003.NEF');
    await makeTiff(raw);
    await writeXmpOrientation(raw, undefined, { service });
    await expect(readFile(sidecarPathFor(raw))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readXmpOrientation(raw, service)).toBeUndefined();
  });
});

describe('a JPEG', () => {
  it('keeps the orientation in its embedded XMP and leaves the EXIF tag alone', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'shot.jpg');
    await makeJpeg(jpeg);
    await service.write(jpeg, { 'IFD0:Orientation#': 6 });

    // The camera wrote 6; a right turn makes it 3 (upside down).
    await writeXmpOrientation(jpeg, orientationAfterTurns(6, 1), { service });

    const tags = await service.read(jpeg);
    expect(tags['XMP-tiff:Orientation']).toBe(3);
    expect(tags['IFD0:Orientation']).toBe(6);
    expect(rotationFromOrientations(6, await readXmpOrientation(jpeg, service))).toBe(1);

    await writeXmpOrientation(jpeg, undefined, { service });
    expect((await service.read(jpeg))['XMP-tiff:Orientation']).toBeUndefined();
    expect((await service.read(jpeg))['IFD0:Orientation']).toBe(6);
  });
});
