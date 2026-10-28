import type { EditParams, VignetteStyle } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { clamp, clamp01, interpolate, smoothstep } from './common';
import { srgbDecode, srgbEncode } from '../ops';
import { COLOR_TUNING as C } from './tuning';

/**
 * Post-crop vignette and Grain, ported from RAWmakase (`develop/effects/`,
 * MIT). Both are applied after the crop map, so the vignette ellipse always
 * follows the cropped output rather than the uncropped source.
 */

const value = (params: EditParams, name: SliderParam): number => {
  const raw = params[name];
  const neutral = SLIDER_SPECS[name].neutral ?? 0;
  if (raw === undefined || !Number.isFinite(raw)) return neutral;
  return Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, raw));
};

/** The encoded-space vignette operator, with its mask shape already resolved. */
export interface Vignette {
  /** -1..1; negative darkens. */
  amount: number;
  style: VignetteStyle;
  /** 0..1 highlight protection. */
  highlights: number;
  scaleX: number;
  scaleY: number;
  power: number;
  midpoint: number;
  feather: number;
}

const styleFromParams = (params: EditParams): VignetteStyle => {
  const style = params.PostCropVignetteStyle;
  if (style === 'Paint Overlay' || style === 'Color Priority' || style === 'Highlight Priority') {
    return style;
  }
  return 'Highlight Priority';
};

/**
 * Resolves the vignette for a logical output of `size` pixels (the cropped
 * output, not the preview buffer).
 */
export function resolveVignette(
  params: EditParams,
  size: { width: number; height: number },
): Vignette | null {
  const amount = value(params, 'PostCropVignetteAmount') / 100;
  if (amount === 0) return null;
  const roundness = value(params, 'PostCropVignetteRoundness') / 100;
  const midpoint = value(params, 'PostCropVignetteMidpoint') / 100;
  const feather = value(params, 'PostCropVignetteFeather') / 100;
  const highlights = value(params, 'PostCropVignetteHighlights') / 100;

  let scaleX: number;
  let scaleY: number;
  let power: number;
  if (roundness >= 0) {
    const aspect = Math.pow(
      size.width / Math.max(1, size.height),
      C.vignette.roundnessCircle * roundness,
    );
    const x = Math.sqrt((2 * aspect * aspect) / (1 + aspect * aspect));
    scaleX = x;
    scaleY = x / aspect;
    power = 2;
  } else {
    scaleX = 1;
    scaleY = 1;
    power = 2 / (1 + C.vignette.roundnessRectangle * roundness);
  }
  const half = 0.5 * Math.exp(C.vignette.midpointScale * (midpoint - 0.5));
  return {
    amount,
    style: styleFromParams(params),
    highlights,
    scaleX,
    scaleY,
    power,
    midpoint: Math.log(half / (1 - half)),
    feather: Math.max(C.vignette.featherFloor, feather),
  };
}

/** The mask, 0 at the centre to 1 at the corners, for positions in -1..1. */
export function vignetteMask(vignette: Vignette, nx: number, ny: number): number {
  const q = clamp(
    (Math.pow(Math.abs(nx * vignette.scaleX), vignette.power) +
      Math.pow(Math.abs(ny * vignette.scaleY), vignette.power)) /
      2,
    1e-6,
    1 - 1e-6,
  );
  const z = clamp((Math.log(q / (1 - q)) - vignette.midpoint) / vignette.feather, -40, 40);
  return 1 / (1 + Math.exp(-z));
}

const darkening = (amount: number): number => 1 - srgbDecode(1 - amount);

function paintDarkenPorted(
  rgb: [number, number, number],
  amount: number,
  mask: number,
): [number, number, number] {
  const gain = 1 - darkening(amount) * (1 - srgbDecode(1 - mask));
  return [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];
}

/** Applies the vignette to one encoded sRGB pixel at normalized position -1..1. */
export function applyVignette(
  r: number,
  g: number,
  b: number,
  vignette: Vignette,
  nx: number,
  ny: number,
): [number, number, number] {
  const mask = vignetteMask(vignette, nx, ny);
  const linear: [number, number, number] = [
    srgbDecode(clamp01(r)),
    srgbDecode(clamp01(g)),
    srgbDecode(clamp01(b)),
  ];
  let out: [number, number, number];
  if (vignette.amount > 0) {
    const x = vignette.amount;
    if (vignette.style === 'Paint Overlay') {
      const opacity = srgbDecode(x) * srgbDecode(mask);
      out = linear.map((v) => v + (1 - v) * opacity) as [number, number, number];
    } else {
      const strength =
        vignette.style === 'Color Priority'
          ? C.vignette.colorPriorityLighten
          : C.vignette.highlightPriorityLighten;
      const opacity = strength * srgbDecode(x) * srgbDecode(mask);
      const white = Math.pow(2, C.vignette.sceneWhiteEv);
      out = linear.map((v) => clamp01(v + (white - v) * opacity)) as [number, number, number];
    }
  } else {
    const x = Math.abs(vignette.amount);
    const shape = 1.7625 + 0.6875 * x * x;
    const gain = 1 - C.vignette.paintDarken * darkening(x) * (1 - Math.pow(1 - mask, shape));
    if (vignette.style === 'Paint Overlay') {
      out = paintDarkenPorted(linear, x, mask);
    } else if (vignette.style === 'Color Priority') {
      const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      const protect =
        vignette.highlights > 0
          ? Math.pow(
              1 - smoothstep(C.vignette.highlightProtect.from, C.vignette.highlightProtect.to, y),
              Math.pow(vignette.highlights, C.vignette.highlightProtect.exponent),
            )
          : 1;
      const exposed: [number, number, number] = [
        linear[0] * Math.pow(gain, protect),
        linear[1] * Math.pow(gain, protect),
        linear[2] * Math.pow(gain, protect),
      ];
      const painted = paintDarkenPorted(linear, x, mask);
      const w = C.vignette.colorPriorityMix.base + C.vignette.colorPriorityMix.perAmount * x;
      out = [0, 1, 2].map((c) => Math.pow(exposed[c]!, 1 - w) * Math.pow(painted[c]!, w)) as [
        number,
        number,
        number,
      ];
    } else {
      const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      const protect =
        vignette.highlights > 0
          ? Math.pow(
              1 - smoothstep(C.vignette.highlightProtect.from, C.vignette.highlightProtect.to, y),
              Math.pow(vignette.highlights, C.vignette.highlightProtect.exponent),
            )
          : 1;
      const effective = Math.pow(gain, protect);
      out = [linear[0] * effective, linear[1] * effective, linear[2] * effective];
    }
  }
  return [srgbEncode(out[0]), srgbEncode(out[1]), srgbEncode(out[2])];
}

/* ------------------------------------------------------------------------- */
/* Grain                                                                     */
/* ------------------------------------------------------------------------- */

export interface GrainField {
  /** 0..1. */
  amount: number;
  /** Value-noise lattice spacing in full-resolution pixels. */
  cell: number;
  coarse: number;
  fine: number;
  seed: number;
}

/** 32-bit hash -> -1..1, ported from RAWmakase. */
export function grainHash(x: number, y: number, seed: number): number {
  let v = (Math.imul(x | 0, 0x9e3779b9) ^ Math.imul(y | 0, 0x85ebca6b) ^ (seed >>> 0)) >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 0x7feb352d) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  v = Math.imul(v, 0x846ca68b) >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  return (v / 0xffffffff) * 2 - 1;
}

function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const cx = x / cell;
  const cy = y / cell;
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const a = smooth(cx - ix);
  const b = smooth(cy - iy);
  const top = grainHash(ix, iy, seed) * (1 - a) + grainHash(ix + 1, iy, seed) * a;
  const bottom = grainHash(ix, iy + 1, seed) * (1 - a) + grainHash(ix + 1, iy + 1, seed) * a;
  return top * (1 - b) + bottom * b;
}

/** Resolves the grain field for a source whose full-resolution long edge is `edge`. */
export function resolveGrain(params: EditParams, edge: number, seed: number): GrainField | null {
  const amount = value(params, 'GrainAmount') / 100;
  if (amount === 0) return null;
  const size = value(params, 'GrainSize') / 100;
  // Lightroom's Frequency runs from coarse (0) to fine (100); RAWmakase's
  // roughness runs the other way.
  const roughness = 1 - value(params, 'GrainFrequency') / 100;
  const G = C.grain;
  const width =
    (((G.widthBase + G.widthPerSize * size) * edge) / G.referenceEdge) *
    interpolate(roughness, G.roughness, G.roughnessWidth);
  return {
    amount,
    cell: 2 * width,
    coarse: interpolate(roughness, G.roughness, G.roughnessCoarse),
    fine:
      G.fine * Math.exp(-width / G.fineFade) * interpolate(roughness, G.roughness, G.roughnessFine),
    seed: seed >>> 0,
  };
}

/** Grain offset at a full-resolution position, given encoded luminance `l`. */
export function grainNoise(
  grain: GrainField,
  x: number,
  y: number,
  scale: number,
  l: number,
): number {
  if (grain.amount === 0) return 0;
  const averaged = Math.min(grain.cell * scale, 1);
  const coarse = valueNoise(x, y, grain.cell, grain.seed) * averaged;
  const fine = grainHash(Math.floor(x), Math.floor(y), grain.seed ^ 0x21f09) * Math.min(1, scale);
  const strength = interpolate(l, C.grain.luminance, C.grain.luminanceGain);
  return (coarse * grain.coarse + fine * grain.fine) * grain.amount * strength;
}

/** Stable, per-photo seed. Small FNV-1a so preview and export agree. */
export function grainSeedFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
