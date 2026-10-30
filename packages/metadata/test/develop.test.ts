import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync as exists } from 'node:fs';
import { asVersionId, type EditParams, type RetouchVersion } from '@ee/contracts';
import {
  cropFromGeometry,
  cropGeometry,
  largestCropForAspect,
  rotateCrop,
} from '@ee/develop-gl/crop';
import { ExifToolService } from '../src/exiftool';
import { readEditParams, readRawDefaults, writeEditParams } from '../src/develop';
import { readIptc, writeIptc } from '../src/iptc';
import { readRetouchVersions, writeRetouchVersions } from '../src/retouch';
import { sidecarPathFor } from '../src/paths';
import {
  cleanupTempDirs,
  copyFixture,
  fixtureAvailable,
  makeJpeg,
  makeTempDir,
  sampleNefPath,
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
  Texture: -20,
  Clarity2012: 35,
  Dehaze: 12,
  Sharpness: 85,
  SharpenRadius: 1.4,
  SharpenDetail: 60,
  SharpenEdgeMasking: 15,
  LuminanceSmoothing: 30,
  LuminanceNoiseReductionDetail: 45,
  LuminanceNoiseReductionContrast: 10,
  ColorNoiseReduction: 40,
  ColorNoiseReductionDetail: 55,
  ColorNoiseReductionSmoothness: 65,
  HueAdjustmentRed: -10,
  SaturationAdjustmentOrange: 14,
  LuminanceAdjustmentGreen: -20,
  HueAdjustmentBlue: 25,
  ColorGradeShadowHue: 215,
  ColorGradeShadowSat: 30,
  ColorGradeMidtoneHue: 40,
  ColorGradeMidtoneSat: 15,
  ColorGradeHighlightLum: 10,
  ColorGradeGlobalHue: 30,
  ColorGradeGlobalSat: 5,
  ColorGradeBlending: 60,
  ColorGradeBalance: -12,
  ShadowTint: 14,
  RedHue: 10,
  RedSaturation: -6,
  GreenHue: -4,
  GreenSaturation: 8,
  BlueHue: 12,
  BlueSaturation: -10,
  ParametricShadows: -18,
  ParametricDarks: 12,
  ParametricLights: 9,
  ParametricHighlights: -22,
  ParametricShadowSplit: 22,
  ParametricMidtoneSplit: 48,
  ParametricHighlightSplit: 78,
  PostCropVignetteAmount: -35,
  PostCropVignetteMidpoint: 42,
  PostCropVignetteRoundness: 25,
  PostCropVignetteFeather: 65,
  PostCropVignetteHighlights: 40,
  PostCropVignetteStyle: 'Highlight Priority',
  GrainAmount: 28,
  GrainSize: 35,
  GrainFrequency: 55,
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

  it('round-trips the tone curve points and the Color Grading wheels', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    const curveParams: EditParams = {
      ProcessVersion: '11.0',
      ToneCurvePV2012: [
        [0, 0],
        [64, 70],
        [128, 140],
        [255, 255],
      ],
      ToneCurvePV2012Red: [
        [0, 0],
        [128, 120],
        [255, 255],
      ],
      ToneCurvePV2012Green: [
        [0, 0],
        [200, 190],
        [255, 255],
      ],
      ToneCurvePV2012Blue: [
        [0, 10],
        [255, 245],
      ],
      ColorGradeShadowHue: 215,
      ColorGradeShadowSat: 30,
      ColorGradeShadowLum: -10,
      ColorGradeMidtoneHue: 40,
      ColorGradeMidtoneSat: 15,
      ColorGradeMidtoneLum: 5,
      ColorGradeHighlightHue: 45,
      ColorGradeHighlightSat: 20,
      ColorGradeHighlightLum: 10,
      ColorGradeGlobalHue: 30,
      ColorGradeGlobalSat: 5,
      ColorGradeGlobalLum: -5,
      ColorGradeBlending: 60,
      ColorGradeBalance: -12,
    };

    await writeEditParams(jpeg, curveParams, { service });
    expect(await readEditParams(jpeg, service)).toEqual(curveParams);
  });

  it('reads legacy split toning as Color Grading at Blending 100', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await service.write(jpeg, {
      'XMP-crs:SplitToningShadowHue': 210,
      'XMP-crs:SplitToningShadowSaturation': 40,
      'XMP-crs:SplitToningHighlightHue': 45,
      'XMP-crs:SplitToningHighlightSaturation': 20,
      'XMP-crs:SplitToningBalance': -30,
    });
    expect(await readEditParams(jpeg, service)).toEqual({
      ColorGradeShadowHue: 210,
      ColorGradeShadowSat: 40,
      ColorGradeHighlightHue: 45,
      ColorGradeHighlightSat: 20,
      ColorGradeBalance: -30,
      ColorGradeBlending: 100,
    });
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

  it('round-trips full-frame crops straightened to +-45 degrees, landscape and portrait', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    for (const image of [
      { width: 6000, height: 4000 },
      { width: 4000, height: 6000 },
    ]) {
      for (const angle of [-45, -44.9, 45, 44.9]) {
        const crop = rotateCrop({ left: 0, top: 0, right: 1, bottom: 1, angle: 0 }, image, angle);
        for (const orientation of [1, 6]) {
          const cropSpace = { orientation, ...image };
          await writeEditParams(jpeg, { crop }, { service, cropSpace });
          const read = (await readEditParams(jpeg, service, cropSpace)).crop;
          const label = `${image.width}x${image.height} at ${angle}, orientation ${orientation}`;
          if (!read) throw new Error(`crop lost: ${label}`);
          const before = cropGeometry(crop, image);
          const after = cropGeometry(read, image);
          expect(after.width, label).toBeCloseTo(before.width, 0);
          expect(after.height, label).toBeCloseTo(before.height, 0);
          expect(after.centerX, label).toBeCloseTo(before.centerX, 0);
          expect(after.centerY, label).toBeCloseTo(before.centerY, 0);
          expect(after.angle, label).toBeCloseTo(angle, 4);
        }
      }
    }
    // A shrunk, off-centre frame at -45 too.
    const crop = largestCropForAspect({ width: 6000, height: 4000 }, -45, 16 / 9, {
      x: 3000,
      y: 2100,
    });
    await writeEditParams(jpeg, { crop }, { service });
    expect((await readEditParams(jpeg, service)).crop?.angle).toBeCloseTo(-45, 4);
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

  it('round-trips the lens corrections through the sidecar properties', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    const lens: EditParams = {
      ProcessVersion: '11.0',
      LensProfileEnable: true,
      LensProfileName: 'Adobe (NIKKOR Z 24-70mm f/4 S)',
      LensProfileFilename: 'NIKON Z 6 (NIKKOR Z 24-70mm f4 S) - RAW.lcp',
      LensProfileDistortionScale: 80,
      LensProfileVignettingScale: 120,
      AutoLateralCA: true,
      LensManualDistortionAmount: -12,
      VignetteAmount: 30,
      VignetteMidpoint: 40,
      DefringePurpleAmount: 5,
      DefringePurpleHueLo: 20,
      DefringePurpleHueHi: 80,
      DefringeGreenAmount: 3,
      DefringeGreenHueLo: 35,
      DefringeGreenHueHi: 65,
      LensProfileChoice: 'lensfun:Nikon|Nikkor Z 24-70mm f/4 S',
    };
    await writeEditParams(jpeg, lens, { service });
    expect(await readEditParams(jpeg, service)).toEqual(lens);
    const tags = await service.read(jpeg);
    // Lightroom stores both switches as integers.
    expect(tags['XMP-crs:LensProfileEnable']).toBe(1);
    expect(tags['XMP-crs:AutoLateralCA']).toBe(1);

    await writeEditParams(
      jpeg,
      { ...lens, LensProfileEnable: false, AutoLateralCA: false },
      { service },
    );
    const off = await readEditParams(jpeg, service);
    expect(off.LensProfileEnable).toBe(false);
    expect(off.AutoLateralCA).toBe(false);
  });

  it('clears modelled settings but leaves unrelated crs: properties', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    await writeEditParams(jpeg, params, { service });

    // A property we do not model, as written by Lightroom.
    await service.write(jpeg, { 'XMP-crs:LensProfileSetup': 'Auto' });

    await writeEditParams(jpeg, {}, { service });
    expect(await readEditParams(jpeg, service)).toEqual({});
    const tags = await service.read(jpeg);
    expect(tags['XMP-crs:LensProfileSetup']).toBe('Auto');
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

describe('raw defaults (Lightroom starts a raw with sharpening and colour noise reduction)', () => {
  let service: ExifToolService;

  beforeAll(() => {
    service = new ExifToolService();
  });

  afterAll(async () => {
    await service.close();
  });

  afterEach(cleanupTempDirs);

  it('uses Lightroom’s fixed defaults for a raw without camera defaults', async () => {
    const dir = await makeTempDir();
    const raw = join(dir, 'shot.NEF');
    await makeJpeg(raw);
    expect(await readRawDefaults(raw, service)).toEqual({
      Sharpness: 40,
      SharpenRadius: 1,
      SharpenDetail: 25,
      SharpenEdgeMasking: 0,
      ColorNoiseReduction: 25,
      ColorNoiseReductionDetail: 50,
      ColorNoiseReductionSmoothness: 50,
    });
  });

  it('has no defaults for JPEG and TIFF', async () => {
    const dir = await makeTempDir();
    const jpeg = join(dir, 'photo.jpg');
    await makeJpeg(jpeg);
    expect(await readRawDefaults(jpeg, service)).toEqual({});
  });

  it('takes the camera’s own crd: defaults from a Nikon NEF over the fixed ones', async () => {
    if (!fixtureAvailable('z6ii_CZP_0299.NEF')) return;
    const dir = await makeTempDir();
    const nef = await copyFixture('z6ii_CZP_0299.NEF', dir);
    const before = await sha256File(nef);
    // The Z 6II's Vivid picture control, as embedded by the camera.
    expect(await readRawDefaults(nef, service)).toMatchObject({
      Sharpness: 136,
      SharpenRadius: 2,
      SharpenDetail: 15,
      SharpenEdgeMasking: 0,
      LuminanceSmoothing: 27,
      LuminanceNoiseReductionDetail: 75,
      ColorNoiseReduction: 10,
      ColorNoiseReductionDetail: 50,
      ColorNoiseReductionSmoothness: 50,
    });
    // Reading defaults neither writes the NEF nor creates a sidecar, and they are not edits.
    expect(await sha256File(nef)).toBe(before);
    expect(await exists(sidecarPathFor(nef))).toBe(false);
    expect(await readEditParams(nef, service)).toEqual({});
  });

  it('reads the user’s own Nikon Z 6 NEF from EE_SAMPLE_NEF_DIR without touching it', async ({
    skip,
  }) => {
    const sample = await sampleNefPath();
    if (sample === undefined) {
      skip();
      return;
    }
    const before = await sha256File(sample);
    const defaults = await readRawDefaults(sample, service);
    // Every detail setting resolves to a number in range, camera value or Lightroom's.
    for (const name of [
      'Sharpness',
      'SharpenRadius',
      'SharpenDetail',
      'ColorNoiseReduction',
    ] as const) {
      expect(typeof defaults[name]).toBe('number');
    }
    expect(await sha256File(sample)).toBe(before);
  });
});
