import type { CropParams, EditParams, LinearImageHeader } from '@ee/contracts';
import { cropOutputSize, croppedToSourcePixels, isUsableCrop, type Size } from './crop';
import { halfToFloat, samplesView, type LinearImageBuffer } from './image';
import { temperatureTintFromMultipliers, type Multipliers, type TemperatureTint } from './wb';

/**
 * Histogram, clipping and one-click develop analysis.
 *
 * The Auto tone prediction is ported from RAWmakase (MIT), whose Auto values are
 * linear fits to Lightroom Classic's own Auto results
 * (https://github.com/pch/rawmakase, `develop/auto.rs`). Auto white balance is
 * the same gray-world estimate with its clipping and noise-floor rejection.
 * The code is TypeScript here and works on the rendered 8-bit image, but the
 * constants and percentiles are RAWmakase's.
 */

/** Per-channel 8-bit histogram; `luminance` uses the Rec. 709 weights. */
export interface Histogram {
  bins: number;
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  luminance: Uint32Array;
}

const channelIndex = (value: number, bins: number): number =>
  Math.min(bins - 1, Math.max(0, Math.round((value / 255) * (bins - 1))));

/** Histogram of an 8-bit RGBA buffer (row 0 at the top). */
export function histogramOfRgba(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  bins = 256,
): Histogram {
  if (!Number.isInteger(bins) || bins < 2) throw new RangeError(`Invalid histogram bins ${bins}`);
  if (rgba.length < width * height * 4) {
    throw new RangeError(`RGBA buffer has ${rgba.length} values, expected ${width * height * 4}`);
  }
  const red = new Uint32Array(bins);
  const green = new Uint32Array(bins);
  const blue = new Uint32Array(bins);
  const luminance = new Uint32Array(bins);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    red[channelIndex(r, bins)]! += 1;
    green[channelIndex(g, bins)]! += 1;
    blue[channelIndex(b, bins)]! += 1;
    luminance[channelIndex(0.2126 * r + 0.7152 * g + 0.0722 * b, bins)]! += 1;
  }
  return { bins, red, green, blue, luminance };
}

/** The largest value in a histogram, for normalising its drawing (0 for an empty one). */
export function histogramPeak(histogram: Uint32Array): number {
  let peak = 0;
  for (const value of histogram) if (value > peak) peak = value;
  return peak;
}

/** Auto tone values in Lightroom's slider units (Exposure in EV, the rest -100..100). */
export interface AutoToneSettings {
  Exposure2012: number;
  Contrast2012: number;
  Highlights2012: number;
  Shadows2012: number;
  Whites2012: number;
  Blacks2012: number;
  Vibrance: number;
  Saturation: number;
}

const srgbDecode = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

const roundTo = (value: number, steps: number): number => Math.round(value * steps) / steps;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** The sorted percentiles Auto tone measures, in display-encoded sRGB. */
interface ToneMeasure {
  luma: Float32Array;
  peak: Float32Array;
  chroma: Float32Array;
}

function measureTone(rgba: ArrayLike<number>, width: number, height: number): ToneMeasure {
  const count = width * height;
  const luma = new Float32Array(count);
  const peak = new Float32Array(count);
  const chroma = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = (rgba[i * 4] ?? 0) / 255;
    const g = (rgba[i * 4 + 1] ?? 0) / 255;
    const b = (rgba[i * 4 + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    peak[i] = max;
    // Below the colour floor a pixel is mostly noise, not a saturated colour.
    chroma[i] = max > 0.02 ? (max - min) / max : 0;
  }
  luma.sort();
  peak.sort();
  chroma.sort();
  return { luma, peak, chroma };
}

const percentile = (sorted: Float32Array, q: number): number =>
  sorted[Math.round((sorted.length - 1) * clamp(q, 0, 1))] ?? 0;

/**
 * Auto tone for a rendered image, in Lightroom slider units.
 *
 * The fits are RAWmakase's (MIT), which measured Lightroom Classic's Auto on a
 * reference set; they predict the sliders rather than solve for a target, so a
 * dark photo is lifted part of the way to middle grey and highlights almost
 * always come down.
 */
export function predictAutoTone(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): AutoToneSettings {
  if (width <= 0 || height <= 0) throw new RangeError('Auto tone needs a rendered image');
  const m = measureTone(rgba, width, height);
  const luma = (q: number): number => percentile(m.luma, q);
  const peak = (q: number): number => percentile(m.peak, q);

  const exposure = 2.22 - 2.13 * luma(0.4) - 1.52 * luma(0.99);
  const highlights = -36 - 51.9 * luma(0.9) + 26.9 * peak(0.25);
  const shadows = 54.4 - 41.5 * peak(0.1);
  const whites = 67.5 - 52.2 * peak(0.998);
  const blacks = -38 - 1.86 * Math.log2(Math.max(srgbDecode(luma(0.01)), 1e-4));
  const saturation = 2.07 - 10.2 * percentile(m.chroma, 0.35);

  return {
    Exposure2012: roundTo(clamp(exposure, -5, 5), 100),
    Contrast2012: 6,
    Highlights2012: Math.round(clamp(highlights, -100, 0)),
    Shadows2012: Math.round(clamp(shadows, 0, 100)),
    Whites2012: Math.round(clamp(whites, -100, 100)),
    Blacks2012: Math.round(clamp(blacks, -100, 0)),
    Vibrance: 15,
    Saturation: Math.round(clamp(saturation, -100, 100)),
  };
}

/** Slider keys Auto tone replaces; everything else stays as it is (white balance, crop, calibration). */
const AUTO_TONE_KEYS =
  /^(Exposure2012|Contrast2012|Highlights2012|Shadows2012|Whites2012|Blacks2012|Vibrance|Saturation|ToneCurvePV2012.*|Parametric.*|PostCropVignette.*|Grain.*|Texture|Clarity2012|Dehaze|Sharpness|Sharpen.*|Luminance.*|ColorNoiseReduction.*|HueAdjustment.*|SaturationAdjustment.*|LuminanceAdjustment.*|ColorGrade.*|SplitToning.*)$/;

/**
 * The photo Auto tone measures: the current settings without the adjustments
 * Auto replaces (tone, curves, presence, mixer, grading, detail and effects).
 * As in Lightroom, Auto ignores those when measuring, so it gives the same
 * sliders whatever they are.
 */
export function autoToneBasis(params: EditParams): EditParams {
  const next: EditParams = { ...params };
  for (const name of Object.keys(next)) {
    if (AUTO_TONE_KEYS.test(name)) delete next[name as keyof EditParams];
  }
  return next;
}

/** The unedited (as-shot) parameters for the before view; the committed crop keeps both sides aligned. */
export function beforeParams(params: EditParams): EditParams {
  return params.crop !== undefined && isUsableCrop(params.crop) ? { crop: params.crop } : {};
}

/** Pixels accepted by the gray-world estimate: above the noise floor and below clipping. */
const usableSample = (r: number, g: number, b: number): boolean =>
  r > 0.002 && g > 0.002 && b > 0.002 && r < 0.9 && g < 0.9 && b < 0.9;

function sampleAt(
  header: LinearImageHeader,
  view: Uint16Array | Float32Array,
  x: number,
  y: number,
): [number, number, number] {
  const px = clamp(Math.round(x), 0, header.width - 1);
  const py = clamp(Math.round(y), 0, header.height - 1);
  const index = (py * header.width + px) * 4;
  const sample = (offset: number): number => {
    const raw = view[index + offset] ?? 0;
    return header.sampleType === 'f16' ? halfToFloat(raw) : raw;
  };
  return [sample(0), sample(1), sample(2)];
}

/** Long edge of the grid white balance is sampled on. */
const WHITE_BALANCE_EDGE = 256;

/**
 * Camera pixels inside `crop` on a grid of about {@link WHITE_BALANCE_EDGE}
 * pixels. These are unity-white-balance camera RGB, as decoded: white balance
 * must be solved before the camera matrix.
 */
export function cameraSamples(
  header: LinearImageHeader,
  data: LinearImageBuffer,
  crop?: CropParams,
): [number, number, number][] {
  const view = samplesView(header, data);
  const image: Size = { width: header.width, height: header.height };
  const output =
    crop !== undefined && isUsableCrop(crop) ? cropOutputSize(crop, image) : { ...image };
  const longEdge = Math.max(output.width, output.height);
  const scale = Math.min(1, WHITE_BALANCE_EDGE / longEdge);
  const width = Math.max(1, Math.round(output.width * scale));
  const height = Math.max(1, Math.round(output.height * scale));
  const samples: [number, number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = {
        x: ((x + 0.5) / width) * output.width,
        y: ((y + 0.5) / height) * output.height,
      };
      const source =
        crop !== undefined && isUsableCrop(crop)
          ? croppedToSourcePixels(crop, image, point)
          : point;
      samples.push(sampleAt(header, view, source.x, source.y));
    }
  }
  return samples;
}

function grayWorldMultipliers(samples: readonly [number, number, number][]): Multipliers {
  const sum = [0, 0, 0];
  let count = 0;
  for (const [r, g, b] of samples) {
    if (!usableSample(r, g, b)) continue;
    sum[0]! += r;
    sum[1]! += g;
    sum[2]! += b;
    count += 1;
  }
  if (count < 16) throw new Error('No usable pixels for automatic white balance');
  const [r, g, b] = sum as [number, number, number];
  // Gains that make the average neutral; green stays 1.
  return { r: g / r, g: 1, b: g / b };
}

/** Auto white balance: gray world over the crop, converted to Temperature/Tint like the DNG SDK. */
export function autoWhiteBalance(
  header: LinearImageHeader,
  data: LinearImageBuffer,
  crop?: CropParams,
): TemperatureTint & { multipliers: Multipliers } {
  const multipliers = grayWorldMultipliers(cameraSamples(header, data, crop));
  return {
    ...temperatureTintFromMultipliers(header.xyzToCamera, multipliers),
    multipliers,
  };
}

/** White balance picker: the neutral of a small camera-RGB patch, in Temperature/Tint and gains. */
export function whiteBalanceFromPatch(
  header: LinearImageHeader,
  data: LinearImageBuffer,
  point: { x: number; y: number },
  radius = 6,
): TemperatureTint & { multipliers: Multipliers } {
  const view = samplesView(header, data);
  const samples: [number, number, number][] = [];
  const r = Math.max(1, Math.round(radius));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      samples.push(sampleAt(header, view, point.x + dx, point.y + dy));
    }
  }
  const multipliers = grayWorldMultipliers(samples);
  return {
    ...temperatureTintFromMultipliers(header.xyzToCamera, multipliers),
    multipliers,
  };
}
