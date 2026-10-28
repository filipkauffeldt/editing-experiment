import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync as exists } from 'node:fs';
import { asVersionId, type EditParams, type RetouchVersion } from '@ee/contracts';
import { cropFromGeometry } from '@ee/develop-gl/crop';
import { ExifToolService } from '../src/exiftool';
import { readEditParams, writeEditParams } from '../src/develop';
import { readIptc, writeIptc } from '../src/iptc';
import { readRetouchVersions, writeRetouchVersions } from '../src/retouch';
import { sidecarPathFor } from '../src/paths';
import {
  cleanupTempDirs,
  copyFixture,
  fixtureAvailable,
  makeJpeg,
  makeTempDir,
  sha256File,
} from './helpers';

const params: EditParams = {
  ProcessVersion: '11.0',
  WhiteBalance: 'Custom',
  Temperature: 5200,
  Tint: -7,
  Exposure2012: 1.25,
  Contrast2012: 10,
  Highlights2012: -20,
  Shadows2012: 15,
  Whites2012: 5,
  Blacks2012: -5,
  Vibrance: 12,
  Saturation: -8,
  ToneCurvePV2012: [
    [0, 0],
    [64, 70],
    [255, 255],
  ],
  ToneCurvePV2012Red: [
    [0, 0],
    [255, 240],
  ],
  crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.85, angle: -1.5 },
};

const retouch: RetouchVersion = {
  id: asVersionId('version-1'),
  kind: 'retouch',
  name: 'Faces',
  ops: [
    {
      type: 'mosaic',
      shapes: [{ type: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.3 }],
      blockSizeRel: 0.01,
    },
  ],
};

describe('develop and retouch XMP', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it('round-trips crs: settings, tone curves and crop in a JPEG', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writeEditParams(jpeg, params, { service });
    expect(await readEditParams(jpeg, service)).toEqual(params);

    const tags = await service.read(jpeg);
    expect(tags['XMP-crs:HasSettings']).toBe(true);
    expect(tags['XMP-crs:HasCrop']).toBe(true);
    expect(tags['XMP-crs:ToneCurvePV2012']).toEqual(['0, 0', '64, 70', '255, 255']);
  });

  it('ignores crop coordinates when crs:HasCrop is false', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await service.write(jpeg, {
      'XMP-crs:CropLeft': 0.1,
      'XMP-crs:CropTop': 0.2,
      'XMP-crs:CropRight': 0.9,
      'XMP-crs:CropBottom': 0.8,
      'XMP-crs:CropAngle': 3,
      'XMP-crs:HasCrop': false,
    });
    expect(await readEditParams(jpeg, service)).toEqual({});
  });

  it('clears crs:HasCrop when the crop is removed', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    const crop = params.crop;
    if (!crop) throw new Error('fixture crop missing');
    await writeEditParams(jpeg, { crop }, { service });
    let tags = await service.read(jpeg);
    expect(tags['XMP-crs:HasCrop']).toBe(true);

    await writeEditParams(jpeg, {}, { service });
    tags = await service.read(jpeg);
    expect(tags['XMP-crs:HasCrop']).toBeUndefined();
    expect(tags['XMP-crs:CropLeft']).toBeUndefined();
  });

  it('round-trips the oriented crop for all eight EXIF orientations', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    const oriented = { width: 4000, height: 6000 };
    const crop = cropFromGeometry(1300, 2100, 1600, 900, 7, oriented);

    for (let orientation = 1; orientation <= 8; orientation++) {
      const cropSpace = { orientation, ...oriented };
      await writeEditParams(jpeg, { crop }, { service, cropSpace });
      const written = await readEditParams(jpeg, service, cropSpace);
      expect(written.crop, `orientation ${orientation}`).toBeDefined();
      expect(written.crop?.left, `orientation ${orientation}`).toBeCloseTo(crop.left, 4);
      expect(written.crop?.top, `orientation ${orientation}`).toBeCloseTo(crop.top, 4);
      expect(written.crop?.right, `orientation ${orientation}`).toBeCloseTo(crop.right, 4);
      expect(written.crop?.bottom, `orientation ${orientation}`).toBeCloseTo(crop.bottom, 4);
      expect(written.crop?.angle, `orientation ${orientation}`).toBeCloseTo(crop.angle, 4);
    }
  });

  it('writes an orientation 6 crop in stored space (displayed top-left is stored bottom-left)', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    const oriented = { width: 4000, height: 6000 };
    const crop = { left: 0, top: 0, right: 0.25, bottom: 0.25, angle: 0 };
    const cropSpace = { orientation: 6, ...oriented };

    await writeEditParams(jpeg, { crop }, { service, cropSpace });
    const tags = await service.read(jpeg);
    expect(tags['XMP-crs:CropLeft']).toBeCloseTo(0, 5);
    expect(tags['XMP-crs:CropTop']).toBeCloseTo(0.75, 5);
    expect(tags['XMP-crs:CropRight']).toBeCloseTo(0.25, 5);
    expect(tags['XMP-crs:CropBottom']).toBeCloseTo(1, 5);
    expect(tags['XMP-crs:CropAngle']).toBeCloseTo(0, 5);

    const read = await readEditParams(jpeg, service, cropSpace);
    expect(read.crop?.left).toBeCloseTo(crop.left, 5);
    expect(read.crop?.top).toBeCloseTo(crop.top, 5);
    expect(read.crop?.right).toBeCloseTo(crop.right, 5);
    expect(read.crop?.bottom).toBeCloseTo(crop.bottom, 5);
  });

  it('negates the angle in stored space for mirrored orientation 2', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    const oriented = { width: 6000, height: 4000 };
    const crop = cropFromGeometry(3000, 2000, 2000, 1200, 7, oriented);
    const cropSpace = { orientation: 2, ...oriented };

    await writeEditParams(jpeg, { crop }, { service, cropSpace });
    const tags = await service.read(jpeg);
    expect(tags['XMP-crs:CropAngle']).toBeCloseTo(-7, 1);

    const read = await readEditParams(jpeg, service, cropSpace);
    expect(read.crop?.angle).toBeCloseTo(7, 4);
    expect(read.crop?.left).toBeCloseTo(crop.left, 4);
    expect(read.crop?.top).toBeCloseTo(crop.top, 4);
  });

  it('defaults ProcessVersion when settings are written without one', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writeEditParams(jpeg, { Exposure2012: 0.5 }, { service });
    expect(await readEditParams(jpeg, service)).toEqual({
      ProcessVersion: '11.0',
      Exposure2012: 0.5,
    });
  });

  it('clears modelled settings but leaves unrelated crs: properties', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await writeEditParams(jpeg, params, { service });

    // A property we do not model, as written by Lightroom.
    await service.write(jpeg, { 'XMP-crs:Clarity2012': 17 });

    await writeEditParams(jpeg, {}, { service });
    expect(await readEditParams(jpeg, service)).toEqual({});
    const tags = await service.read(jpeg);
    expect(tags['XMP-crs:Clarity2012']).toBe(17);
    expect(tags['XMP-crs:HasSettings']).toBeUndefined();
  });

  it('preserves crs:, ee: and IPTC through each other’s writes (JPEG)', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writeEditParams(jpeg, params, { service });
    await writeRetouchVersions(jpeg, [retouch], { service });
    await writeIptc(jpeg, { headline: 'Keep me', keywords: ['a', 'b'] }, { service });

    expect(await readEditParams(jpeg, service)).toEqual(params);
    expect(await readRetouchVersions(jpeg, service)).toEqual([retouch]);
    expect(await readIptc(jpeg, service)).toEqual({
      headline: 'Keep me',
      keywords: ['a', 'b'],
    });

    await writeEditParams(jpeg, { Exposure2012: -1 }, { service });
    expect(await readRetouchVersions(jpeg, service)).toEqual([retouch]);
    expect(await readIptc(jpeg, service)).toEqual({
      headline: 'Keep me',
      keywords: ['a', 'b'],
    });
  });

  it('removes retouch versions when the list is empty', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);

    await writeRetouchVersions(jpeg, [retouch], { service });
    expect(await readRetouchVersions(jpeg, service)).toHaveLength(1);
    await writeRetouchVersions(jpeg, [], { service });
    expect(await readRetouchVersions(jpeg, service)).toEqual([]);
  });

  it('does not create a sidecar when there is nothing to write', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'shot.NEF');
    await makeJpeg(raw);

    await writeEditParams(raw, {}, { service });
    expect(await exists(sidecarPathFor(raw))).toBe(false);
  });

  it('ignores the embedded crd: camera defaults in NEFs', async () => {
    if (!fixtureAvailable('z30_14bit.NEF')) return;
    const dir = await makeTempDir();
    const nef = await copyFixture('z30_14bit.NEF', dir);
    expect(await readEditParams(nef, service)).toEqual({});
  });

  describe.skipIf(!fixtureAvailable('z6ii_CZP_0299.NEF'))('raw sidecars', () => {
    it('writes crs: and ee: to the sidecar and never the NEF', async () => {
      const dir = await makeTempDir();
      const nef = await copyFixture('z6ii_CZP_0299.NEF', dir);
      const before = await sha256File(nef);

      await writeEditParams(nef, params, { service });
      await writeRetouchVersions(nef, [retouch], { service });
      await writeIptc(nef, { caption: 'Sidecar caption', city: 'Lund' }, { service });

      expect(await readEditParams(nef, service)).toEqual(params);
      expect(await readRetouchVersions(nef, service)).toEqual([retouch]);
      expect(await readIptc(nef, service)).toEqual({
        caption: 'Sidecar caption',
        city: 'Lund',
      });
      expect(sidecarPathFor(nef)).not.toBe(nef);
      expect(await sha256File(nef)).toBe(before);
    });
  });
});
