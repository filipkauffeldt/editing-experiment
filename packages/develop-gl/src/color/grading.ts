import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { clamp, encodedLuma, hsvToRgb } from './common';
import { COLOR_TUNING as C } from './tuning';

/** One colour grading region: hue in degrees, saturation and luminance 0..1 / -1..1. */
export interface GradeRegion {
  hue: number;
  sat: number;
  lum: number;
}

export interface ColorGrading {
  shadows: GradeRegion;
  midtones: GradeRegion;
  highlights: GradeRegion;
  global: GradeRegion;
  /** 0..1, 0.5 is Lightroom's default. */
  blending: number;
  /** -1..1. */
  balance: number;
  active: boolean;
}

const value = (params: EditParams, name: SliderParam): number => {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return SLIDER_SPECS[name].neutral ?? 0;
  return Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, raw));
};

const legacyValue = (
  params: EditParams,
  name:
    | 'SplitToningShadowHue'
    | 'SplitToningShadowSaturation'
    | 'SplitToningHighlightHue'
    | 'SplitToningHighlightSaturation'
    | 'SplitToningBalance',
  min: number,
  max: number,
): number => {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.min(max, Math.max(min, raw));
};

const region = (
  params: EditParams,
  prefix: 'Shadow' | 'Midtone' | 'Highlight' | 'Global',
): GradeRegion => ({
  hue: value(params, `ColorGrade${prefix}Hue` as SliderParam),
  sat: value(params, `ColorGrade${prefix}Sat` as SliderParam) / 100,
  lum: value(params, `ColorGrade${prefix}Lum` as SliderParam) / 100,
});

/**
 * Reads Color Grading. A legacy `SplitToning*` pair is accepted as a fallback
 * when the corresponding ColorGrade region is absent, matching how Lightroom
 * renders a split-toned preset as grading at Blending 100.
 */
export function resolveColorGrading(params: EditParams): ColorGrading {
  const shadows = region(params, 'Shadow');
  const midtones = region(params, 'Midtone');
  const highlights = region(params, 'Highlight');
  const global = region(params, 'Global');

  const legacyShadowHue = legacyValue(params, 'SplitToningShadowHue', 0, 360);
  const legacyShadowSat = legacyValue(params, 'SplitToningShadowSaturation', 0, 100);
  const legacyHighlightHue = legacyValue(params, 'SplitToningHighlightHue', 0, 360);
  const legacyHighlightSat = legacyValue(params, 'SplitToningHighlightSaturation', 0, 100);
  const hasLegacy =
    legacyShadowSat !== 0 ||
    legacyHighlightSat !== 0 ||
    legacyShadowHue !== 0 ||
    legacyHighlightHue !== 0;
  const hasModern =
    shadows.sat !== 0 ||
    midtones.sat !== 0 ||
    highlights.sat !== 0 ||
    global.sat !== 0 ||
    shadows.lum !== 0 ||
    midtones.lum !== 0 ||
    highlights.lum !== 0 ||
    global.lum !== 0;

  let blending = value(params, 'ColorGradeBlending') / 100;
  let balance = value(params, 'ColorGradeBalance') / 100;
  if (hasLegacy && !hasModern) {
    if (shadows.sat === 0) {
      shadows.hue = legacyShadowHue;
      shadows.sat = legacyShadowSat / 100;
    }
    if (highlights.sat === 0) {
      highlights.hue = legacyHighlightHue;
      highlights.sat = legacyHighlightSat / 100;
    }
    blending = 1;
    balance = legacyValue(params, 'SplitToningBalance', -100, 100) / 100;
  }

  return {
    shadows,
    midtones,
    highlights,
    global,
    blending: clamp(blending, 0, 1),
    balance: clamp(balance, -1, 1),
    active:
      hasLegacy ||
      hasModern ||
      global.sat !== 0 ||
      global.lum !== 0 ||
      blending !== 0.5 ||
      balance !== 0,
  };
}

/** Gaussian tonal weight of a region at encoded luminance `e`. */
function regionWeight(
  e: number,
  center: number,
  width: number,
  balance: number,
  shadows: boolean,
): number {
  const moved = center + (shadows ? balance * C.gradeBalanceShift : -balance * C.gradeBalanceShift);
  const d = (e - moved) / width;
  return Math.exp(-0.5 * d * d);
}

/** Region tint as a luma-neutral RGB direction (unit-ish, channel differences only). */
function tintDirection(hue: number): [number, number, number] {
  const [r, g, b] = hsvToRgb(hue / 360, 1, 1);
  const y = encodedLuma(r, g, b);
  return [r - y, g - y, b - y];
}

/**
 * Applies Color Grading on sRGB-encoded RGB.
 *
 * Each region has a smooth tonal weight (Balance moves it, Blending widens it);
 * its tint adds a luma-neutral chroma shift and its Luminance slider a matching
 * brightness shift. Regions multiply, Global applies over the whole range.
 */
export function applyColorGrading(
  r: number,
  g: number,
  b: number,
  grading: ColorGrading,
): [number, number, number] {
  if (!grading.active) return [r, g, b];
  const e = encodedLuma(r, g, b);
  const width = C.gradeWidth + grading.blending * C.gradeWidthPerBlending;
  let out: [number, number, number] = [r, g, b];

  const regions: Array<[GradeRegion, number]> = [
    [grading.shadows, regionWeight(e, C.gradeCentres.shadows, width, grading.balance, true)],
    [grading.midtones, regionWeight(e, C.gradeCentres.midtones, width, grading.balance, false)],
    [grading.highlights, regionWeight(e, C.gradeCentres.highlights, width, grading.balance, false)],
    [grading.global, 1],
  ];

  for (const [region, weight] of regions) {
    if (weight === 0) continue;
    if (region.sat !== 0) {
      const tint = tintDirection(region.hue);
      const amount = weight * region.sat * C.gradeTintStrength;
      out = [
        Math.max(0, out[0] * (1 + tint[0] * amount)),
        Math.max(0, out[1] * (1 + tint[1] * amount)),
        Math.max(0, out[2] * (1 + tint[2] * amount)),
      ];
    }
    if (region.lum !== 0) {
      const shift = region.lum * weight * C.gradeLuminanceStrength;
      out = [out[0] + shift, out[1] + shift, out[2] + shift];
    }
  }
  return out;
}

/** Exposed for tests: the weight a region has at an encoded luminance. */
export function gradingWeightAt(
  grading: ColorGrading,
  e: number,
  region: 'shadows' | 'midtones' | 'highlights',
): number {
  const width = C.gradeWidth + grading.blending * C.gradeWidthPerBlending;
  return regionWeight(e, C.gradeCentres[region], width, grading.balance, region === 'shadows');
}
