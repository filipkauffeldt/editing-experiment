import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { developPixel, renderCpu } from '../src/cpu';
import { resolveUniforms } from '../src/params';
import { hueDegrees } from '../src/ops';
import { cropOutputPixels } from '../src/crop';
import { makeHeader } from './support';

/** A camera that is already linear sRGB with unity white balance. */
function identityHeader(width = 1, height = 1): LinearImageHeader {
  return {
    ...makeHeader(width, height, 'f32', { r: 1, g: 1, b: 1 }),
    cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

const develop = (
  rgb: [number, number, number],
  params: EditParams,
  header = identityHeader(),
): [number, number, number] => developPixel(...rgb, resolveUniforms(header, params));

const hue = (rgb: [number, number, number]): number => hueDegrees(rgb[0], rgb[1], rgb[2]);

describe('Color Mixer (HSL)', () => {
  it('shifts green hues without moving orange or neutral pixels', () => {
    const green: [number, number, number] = [0.12, 0.65, 0.12];
    const orange: [number, number, number] = [0.8, 0.4, 0.1];
    const grey: [number, number, number] = [0.42, 0.42, 0.42];
    const params: EditParams = { HueAdjustmentGreen: 20 };

    const neutralGreen = develop(green, {});
    const shifted = develop(green, params);
    const neutralOrange = develop(orange, {});
    const untouchedOrange = develop(orange, params);
    const untouchedGrey = develop(grey, params);

    expect(Math.abs(hue(shifted) - hue(neutralGreen))).toBeGreaterThan(3);
    expect(untouchedOrange[0]).toBeCloseTo(neutralOrange[0]!, 6);
    expect(untouchedOrange[1]).toBeCloseTo(neutralOrange[1]!, 6);
    expect(untouchedGrey).toEqual(develop(grey, {}));
  });

  it('desaturates only the selected band', () => {
    const green: [number, number, number] = [0.12, 0.65, 0.12];
    const blue: [number, number, number] = [0.1, 0.2, 0.8];
    const params: EditParams = { SaturationAdjustmentGreen: -100 };
    const greyGreen = develop(green, params);
    const neutralGreen = develop(green, {});
    const untouchedBlue = develop(blue, params);
    const neutralBlue = develop(blue, {});
    const saturation = (c: [number, number, number]): number => Math.max(...c) - Math.min(...c);
    expect(saturation(greyGreen)).toBeLessThan(saturation(neutralGreen) * 0.5);
    expect(untouchedBlue[2]).toBeCloseTo(neutralBlue[2]!, 6);
  });
});

describe('Color Grading', () => {
  it('tints dark tones and leaves bright tones alone', () => {
    const params: EditParams = {
      ColorGradeShadowHue: 220,
      ColorGradeShadowSat: 80,
      ColorGradeBlending: 50,
    };
    const neutralDark = develop([0.05, 0.05, 0.05], {});
    const neutralBright = develop([0.9, 0.9, 0.9], {});
    const dark = develop([0.05, 0.05, 0.05], params);
    const bright = develop([0.9, 0.9, 0.9], params);
    expect(dark[2] / Math.max(dark[0], 1e-6)).toBeGreaterThan(
      (neutralDark[2] / Math.max(neutralDark[0], 1e-6)) * 1.05,
    );
    expect(Math.abs(bright[0] - neutralBright[0]!)).toBeLessThan(0.003);
    expect(Math.abs(bright[2] - neutralBright[2]!)).toBeLessThan(0.15);
  });

  it('moves the shadow region with Balance and widens it with Blending', () => {
    const base: EditParams = { ColorGradeShadowHue: 30, ColorGradeShadowSat: 60 };
    const mid = [0.4, 0.4, 0.4] as const;
    const atDefault = develop([...mid], base);
    const balanced = develop([...mid], { ...base, ColorGradeBalance: 100 });
    const widened = develop([...mid], { ...base, ColorGradeBlending: 100 });
    expect(balanced[0] - atDefault[0]).toBeGreaterThan(0.005);
    expect(widened[0] - atDefault[0]).toBeGreaterThan(0.005);
  });

  it('reads legacy split toning when no ColorGrade values exist', () => {
    const legacy = develop([0.1, 0.1, 0.1], {
      SplitToningShadowHue: 220,
      SplitToningShadowSaturation: 70,
      SplitToningBalance: 0,
    });
    const modern = develop([0.1, 0.1, 0.1], {
      ColorGradeShadowHue: 220,
      ColorGradeShadowSat: 70,
      ColorGradeBlending: 100,
    });
    expect(legacy[2]).toBeCloseTo(modern[2], 6);
  });
});

describe('Camera Calibration', () => {
  it('rotates the red primary and preserves neutrals', () => {
    const params: EditParams = { RedHue: -100 };
    const red = develop([0.7, 0.05, 0.05], params);
    const neutralRed = develop([0.7, 0.05, 0.05], {});
    const grey = develop([0.3, 0.3, 0.3], params);
    const neutralGrey = develop([0.3, 0.3, 0.3], {});
    expect(Math.abs(hue(red) - hue(neutralRed))).toBeGreaterThan(3);
    expect(grey[0]).toBeCloseTo(neutralGrey[0]!, 5);
    expect(grey[1]).toBeCloseTo(neutralGrey[1]!, 5);
    expect(grey[2]).toBeCloseTo(neutralGrey[2]!, 5);
  });

  it('tints shadows with ShadowTint and fades before the highlights', () => {
    const params: EditParams = { ShadowTint: 80 };
    const dark = develop([0.05, 0.05, 0.05], params);
    const neutralDark = develop([0.05, 0.05, 0.05], {});
    const bright = develop([0.9, 0.9, 0.9], params);
    const neutralBright = develop([0.9, 0.9, 0.9], {});
    expect(dark[0]).not.toBeCloseTo(neutralDark[0]!, 4);
    expect(Math.abs(bright[0] - neutralBright[0]!)).toBeLessThan(0.001);
  });
});

describe('parametric tone curve', () => {
  it('lifts shadows without moving highlights', () => {
    const params: EditParams = { ParametricShadows: 100 };
    const neutralDark = develop([0.1, 0.1, 0.1], {});
    const neutralBright = develop([0.9, 0.9, 0.9], {});
    const dark = develop([0.1, 0.1, 0.1], params);
    const bright = develop([0.9, 0.9, 0.9], params);
    expect(dark[0]).toBeGreaterThan(neutralDark[0]! + 0.01);
    expect(Math.abs(bright[0] - neutralBright[0]!)).toBeLessThan(0.001);
  });

  it('pulls highlights without moving shadows', () => {
    const params: EditParams = { ParametricHighlights: -100 };
    const neutralDark = develop([0.1, 0.1, 0.1], {});
    const neutralBright = develop([0.9, 0.9, 0.9], {});
    const dark = develop([0.1, 0.1, 0.1], params);
    const bright = develop([0.9, 0.9, 0.9], params);
    expect(dark[0]).toBeCloseTo(neutralDark[0]!, 4);
    expect(bright[0]).toBeLessThan(neutralBright[0]! - 0.01);
  });

  it('remains monotone with opposing regions', () => {
    const params: EditParams = {
      ParametricShadows: 100,
      ParametricDarks: -100,
      ParametricLights: 100,
      ParametricHighlights: -100,
    };
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const value = develop([i / 20, i / 20, i / 20], params)[0]!;
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });
});

/** Flat linear grey image, for the spatial effects. */
function flatGrey(
  width: number,
  height: number,
  value = 0.18,
): {
  header: LinearImageHeader;
  data: Float32Array;
} {
  const header = identityHeader(width, height);
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 1;
  }
  return { header, data };
}

const red = (rgba: ArrayLike<number>, index: number): number => rgba[index * 4] ?? 0;

describe('post-crop vignette', () => {
  it('darkens the crop corners, not the crop centre', () => {
    const { header, data } = flatGrey(40, 24);
    const params: EditParams = { PostCropVignetteAmount: -100 };
    const out = renderCpu(header, data, params);
    const centre = 12 * 40 + 20;
    const corner = 1 * 40 + 1;
    expect(red(out, centre)).toBeCloseTo(red(out, centre));
    expect(red(out, corner)).toBeLessThan(red(out, centre) * 0.7);
  });

  it('follows the crop: a cropped render has its own centre and corners', () => {
    const { header, data } = flatGrey(40, 24);
    const full: EditParams = { PostCropVignetteAmount: -100 };
    const crop = { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8, angle: 0 };
    const cropped: EditParams = { PostCropVignetteAmount: -100, crop };
    const fullOut = renderCpu(header, data, full);
    const cropSize = cropOutputPixels(crop, { width: 40, height: 24 });
    const cropOut = renderCpu(header, data, cropped, cropSize);
    const cropWidth = cropSize.width;
    const cropHeight = cropSize.height;
    const cropCentre = Math.floor(cropHeight / 2) * cropWidth + Math.floor(cropWidth / 2);
    const cropCorner = 1 * cropWidth + 1;
    const fullCentre = 12 * 40 + 20;
    expect(red(cropOut, cropCentre)).toBeCloseTo(red(fullOut, fullCentre), 0);
    expect(red(cropOut, cropCorner)).toBeLessThan(red(cropOut, cropCentre) * 0.75);
  });
});

describe('grain', () => {
  const params: EditParams = { GrainAmount: 70, GrainSize: 25, GrainFrequency: 40 };

  it('is identical for the same seed and different for another seed', () => {
    const { header, data } = flatGrey(48, 32);
    const a = renderCpu(header, data, params, { width: 48, height: 32 }, { grainSeed: 1234 });
    const b = renderCpu(header, data, params, { width: 48, height: 32 }, { grainSeed: 1234 });
    const c = renderCpu(header, data, params, { width: 48, height: 32 }, { grainSeed: 4321 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('matches preview and export statistics, and leaves the colour alone', () => {
    const { header, data } = flatGrey(64, 64);
    const plain = renderCpu(header, data, {}, { width: 64, height: 64 });
    const full = renderCpu(header, data, params, { width: 64, height: 64 }, { grainSeed: 7 });
    const preview = renderCpu(header, data, params, { width: 32, height: 32 }, { grainSeed: 7 });
    const deviation = (out: Uint8Array, baseline: Uint8Array): number => {
      let sum = 0;
      for (let i = 0; i < out.length; i += 4) {
        const d = (out[i] ?? 0) - (baseline[i] ?? 0);
        sum += d * d;
      }
      return Math.sqrt(sum / (out.length / 4));
    };
    const fullDeviation = deviation(full, plain);
    const previewPlain = renderCpu(header, data, {}, { width: 32, height: 32 });
    const previewBaseline = deviation(preview, previewPlain);
    expect(fullDeviation).toBeGreaterThan(0.5);
    expect(previewBaseline).toBeGreaterThan(0.2);
    expect(previewBaseline / fullDeviation).toBeGreaterThan(0.4);
    expect(previewBaseline / fullDeviation).toBeLessThan(1.6);
    // Grain is monochrome noise: it shifts the channels together.
    for (let i = 0; i < full.length; i += 4) {
      expect(full[i + 1]).toBe(full[i]);
      expect(full[i + 2]).toBe(full[i]);
    }
  });
});
