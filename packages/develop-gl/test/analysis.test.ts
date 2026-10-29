import type { LinearImageHeader } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  autoToneBasis,
  autoWhiteBalance,
  beforeParams,
  cameraSamples,
  histogramOfRgba,
  predictAutoTone,
  whiteBalanceFromPatch,
} from '../src/analysis';
import { cropFromGeometry } from '../src/crop';
import { multipliersFromTemperatureTint, temperatureTintFromMultipliers } from '../src/wb';
import { Z6_XYZ_TO_CAMERA, makeHeader } from './support';

function multiply(rgb: readonly number[], m: { r: number; g: number; b: number }): number[] {
  return [rgb[0]! * m.r, rgb[1]! * m.g, rgb[2]! * m.b];
}

/** A flat camera image of one neutral surface under an illuminant. */
function flatCamera(
  temperature: number,
  tint: number,
  level = 0.4,
  cast: [number, number, number] = [1, 1, 1],
): { header: LinearImageHeader; data: Float32Array } {
  const header = makeHeader(64, 48, 'f32');
  // The multipliers that render this illuminant neutral; the camera sees the reciprocal.
  const m = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, temperature, tint);
  const raw = [level / m.r, level, level / m.b];
  const data = new Float32Array(64 * 48 * 4);
  for (let i = 0; i < 64 * 48; i++) {
    data[i * 4] = raw[0]! * cast[0];
    data[i * 4 + 1] = raw[1]! * cast[1];
    data[i * 4 + 2] = raw[2]! * cast[2];
    data[i * 4 + 3] = 1;
  }
  return { header, data };
}

describe('histogramOfRgba', () => {
  it('counts each channel and Rec. 709 luminance into exact bins', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 255, 0, 128, 255]);
    const histogram = histogramOfRgba(rgba, 2, 1, 4);
    expect([...histogram.red]).toEqual([1, 0, 0, 1]);
    expect([...histogram.green]).toEqual([2, 0, 0, 0]);
    expect([...histogram.blue]).toEqual([1, 0, 1, 0]);
    // 18.6 and 63.4 in 0..255 become bins 0 and 1 of four.
    expect([...histogram.luminance]).toEqual([1, 1, 0, 0]);
  });

  it('rejects invalid bins and short buffers', () => {
    expect(() => histogramOfRgba(new Uint8Array(4), 1, 1, 1)).toThrow(RangeError);
    expect(() => histogramOfRgba(new Uint8Array(4), 2, 1, 4)).toThrow(RangeError);
  });
});

describe('Auto white balance', () => {
  it('recovers the temperature and tint of a neutral patch under a known illuminant', () => {
    const { header, data } = flatCamera(4000, 0);
    const wb = autoWhiteBalance(header, data);
    expect(wb.temperature).toBeCloseTo(4000, -2);
    expect(Math.abs(wb.tint)).toBeLessThan(2);
    const mean = multiply([0.4 / wb.multipliers.r, 0.4, 0.4 / wb.multipliers.b], wb.multipliers);
    // Applying the gains makes the patch neutral to within a level of 8 bits.
    expect(Math.abs(mean[0]! - mean[1]!)).toBeLessThan(0.002);
    expect(Math.abs(mean[2]! - mean[1]!)).toBeLessThan(0.002);
  });

  it('neutralises a colour cast and rejects clipped and noisy pixels', () => {
    const { header, data } = flatCamera(5200, 0, 0.4, [0.8, 1, 1.25]);
    // Blow out one quadrant: those pixels must not pull the estimate.
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 64 + x) * 4;
        data[i] = 1.2;
        data[i + 1] = 1.2;
        data[i + 2] = 1.2;
      }
    }
    const wb = autoWhiteBalance(header, data);
    // The cast is neutralised: the mean of the (uncrushed) patch is grey.
    const m = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 5200, 0);
    const raw = [(0.4 / m.r) * 0.8, 0.4, (0.4 / m.b) * 1.25];
    const neutral = multiply(raw, wb.multipliers);
    expect(Math.abs(neutral[0]! - neutral[1]!)).toBeLessThan(0.01);
    expect(Math.abs(neutral[2]! - neutral[1]!)).toBeLessThan(0.01);
  });

  it('throws when there are no usable pixels at all', () => {
    const header = makeHeader(16, 16, 'f32');
    const data = new Float32Array(16 * 16 * 4).fill(0);
    for (let i = 3; i < data.length; i += 4) data[i] = 1;
    expect(() => autoWhiteBalance(header, data)).toThrow(/No usable pixels/);
  });
});

describe('white balance picker', () => {
  it('turns a small grey patch into the expected temperature and neutral output', () => {
    const { header, data } = flatCamera(3800, 4);
    const wb = whiteBalanceFromPatch(header, data, { x: 30, y: 20 }, 5);
    expect(Math.abs(wb.temperature - 3800)).toBeLessThan(80);
    expect(Math.abs(wb.tint - 4)).toBeLessThan(2);
    const m = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 3800, 4);
    const neutral = multiply([0.4 / m.r, 0.4, 0.4 / m.b], wb.multipliers);
    expect(Math.abs(neutral[0]! - neutral[1]!)).toBeLessThan(0.001);
    expect(Math.abs(neutral[2]! - neutral[1]!)).toBeLessThan(0.001);
  });

  it('uses only the crop when one is committed', () => {
    const { header, data } = flatCamera(4300, 0);
    const crop = cropFromGeometry(32, 24, 20, 12, 0, { width: 64, height: 48 });
    const samples = cameraSamples(header, data, crop);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(([r, g, b]) => r > 0 && g > 0 && b > 0)).toBe(true);
    expect(autoWhiteBalance(header, data, crop).temperature).toBeCloseTo(4300, -2);
  });
});

describe('Auto tone', () => {
  const flat = (value: number): Uint8Array => {
    const rgba = new Uint8Array(64 * 48 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = Math.round(value * 255);
      rgba[i + 1] = Math.round(value * 255);
      rgba[i + 2] = Math.round(value * 255);
      rgba[i + 3] = 255;
    }
    return rgba;
  };

  it('raises exposure on an underexposed photo and lowers it on a bright one', () => {
    const dark = predictAutoTone(flat(0.08), 64, 48);
    const bright = predictAutoTone(flat(0.8), 64, 48);
    expect(dark.Exposure2012).toBeGreaterThan(0.8);
    expect(bright.Exposure2012).toBeLessThan(0);
    expect(dark.Blacks2012).toBeLessThanOrEqual(0);
    expect(dark.Whites2012).toBeGreaterThan(bright.Whites2012);
    expect(dark.Vibrance).toBe(15);
  });

  it('measures the photo without the sliders it is about to replace', () => {
    const basis = autoToneBasis({
      Exposure2012: 2,
      Contrast2012: 50,
      Highlights2012: -60,
      Shadows2012: 40,
      Vibrance: 25,
      Saturation: 30,
      ToneCurvePV2012: [
        [0, 20],
        [255, 255],
      ],
      Texture: 20,
      Sharpness: 40,
      Temperature: 5200,
      Tint: 8,
      crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 },
    });
    expect(basis).toMatchObject({ Temperature: 5200, Tint: 8 });
    expect(basis.crop).toBeDefined();
    for (const key of [
      'Exposure2012',
      'Contrast2012',
      'Highlights2012',
      'Shadows2012',
      'Vibrance',
      'Saturation',
      'ToneCurvePV2012',
      'Texture',
      'Sharpness',
    ]) {
      expect(basis).not.toHaveProperty(key);
    }
  });
});

describe('before/after', () => {
  it('keeps only the committed crop so both sides have the same framing', () => {
    const crop = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 2 };
    expect(beforeParams({ Exposure2012: 1, Temperature: 5000, crop })).toEqual({ crop });
    expect(beforeParams({ Exposure2012: 1 })).toEqual({});
  });
});

describe('Temperature/tint round trip', () => {
  it('matches the gains from the DNG SDK temperature code', () => {
    const m = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 4550, 12);
    const back = temperatureTintFromMultipliers(Z6_XYZ_TO_CAMERA, m);
    expect(back.temperature).toBeCloseTo(4550, -1);
    expect(back.tint).toBeCloseTo(12, 0);
  });
});
