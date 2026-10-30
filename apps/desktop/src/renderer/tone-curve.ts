import type { EditParams, SliderParam, ToneCurvePoint } from '@ee/contracts';
import { buildParametricLut, createMonotoneSpline, sampleCurve } from '@ee/develop-gl';

/** Views of the Tone Curve panel, in Lightroom's order. */
export const CURVE_CHANNELS = ['Parametric', 'Point (RGB)', 'Red', 'Green', 'Blue'] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

export type ToneCurveParam =
  'ToneCurvePV2012' | 'ToneCurvePV2012Red' | 'ToneCurvePV2012Green' | 'ToneCurvePV2012Blue';

const CURVE_PARAMS: Readonly<Record<Exclude<CurveChannel, 'Parametric'>, ToneCurveParam>> = {
  'Point (RGB)': 'ToneCurvePV2012',
  Red: 'ToneCurvePV2012Red',
  Green: 'ToneCurvePV2012Green',
  Blue: 'ToneCurvePV2012Blue',
};

/** The `crs:` curve a point view writes to, or null for the parametric view. */
export function curveParamForChannel(channel: CurveChannel): ToneCurveParam | null {
  return channel === 'Parametric' ? null : CURVE_PARAMS[channel];
}

/** Lightroom's linear curve, which is what an absent curve means. */
export const LINEAR_CURVE: readonly ToneCurvePoint[] = [
  [0, 0],
  [255, 255],
];

export const PARAMETRIC_REGION_PARAMS = [
  'ParametricShadows',
  'ParametricDarks',
  'ParametricLights',
  'ParametricHighlights',
] as const satisfies readonly SliderParam[];

export const PARAMETRIC_SPLIT_PARAMS = [
  'ParametricShadowSplit',
  'ParametricMidtoneSplit',
  'ParametricHighlightSplit',
] as const satisfies readonly SliderParam[];

export const TONE_CURVE_PARAMS: readonly (keyof EditParams)[] = [
  ...PARAMETRIC_REGION_PARAMS,
  ...PARAMETRIC_SPLIT_PARAMS,
  'ToneCurvePV2012',
  'ToneCurvePV2012Red',
  'ToneCurvePV2012Green',
  'ToneCurvePV2012Blue',
];

export function clampCurveCoordinate(value: number): number {
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

const clamp255 = clampCurveCoordinate;

const clampParam = (value: number): number =>
  Math.min(100, Math.max(-100, Math.round(Number.isFinite(value) ? value : 0)));

/** The points to draw and edit for a channel; an absent curve is the linear one. */
export function curvePoints(
  params: EditParams,
  channel: Exclude<CurveChannel, 'Parametric'>,
): ToneCurvePoint[] {
  const stored = params[CURVE_PARAMS[channel]];
  return stored === undefined ? [...LINEAR_CURVE] : stored.map(([x, y]) => [x, y] as const);
}

/** Adds a point, keeping the array sorted by input. An existing input is moved instead. */
export function addCurvePoint(
  points: readonly ToneCurvePoint[],
  input: number,
  output: number,
): ToneCurvePoint[] {
  const x = clamp255(input);
  const y = clamp255(output);
  const next = points.map(([px, py]) => [px, py] as const);
  const existing = next.findIndex(([px]) => px === x);
  if (existing >= 0) {
    next[existing] = [x, y];
    return next;
  }
  next.push([x, y]);
  next.sort((left, right) => left[0] - right[0]);
  return next;
}

/**
 * Moves one point, clamped to the curve and between its neighbours. Points can
 * never cross, so the array stays sorted and the spline stays single-valued.
 */
export function moveCurvePoint(
  points: readonly ToneCurvePoint[],
  index: number,
  input: number,
  output: number,
): ToneCurvePoint[] {
  if (index < 0 || index >= points.length) return points.map(([x, y]) => [x, y] as const);
  const first = index === 0;
  const last = index === points.length - 1;
  const previous = first ? 0 : (points[index - 1]?.[0] ?? 0) + 1;
  const next = last ? 255 : (points[index + 1]?.[0] ?? 255) - 1;
  const x = Math.min(next, Math.max(previous, clamp255(input)));
  const y = clamp255(output);
  return points.map(([px, py], i) => (i === index ? [x, y] : [px, py])) as ToneCurvePoint[];
}

/** Endpoints shape the curve's ends; Lightroom lets them move but never deletes them. */
export function isCurveEndpoint(points: readonly ToneCurvePoint[], index: number): boolean {
  return index === 0 || index === points.length - 1;
}

/** Deletes a control point; the two endpoints are left in place. */
export function removeCurvePoint(
  points: readonly ToneCurvePoint[],
  index: number,
): ToneCurvePoint[] {
  const next = points.map(([x, y]) => [x, y] as const);
  if (index <= 0 || index >= next.length - 1) return next;
  next.splice(index, 1);
  return next;
}

/** The drawn curve at input `x`, through the engine's monotone spline. */
export function curveValueAt(points: readonly ToneCurvePoint[], input: number): number {
  return Math.min(255, Math.max(0, createMonotoneSpline(points).evaluate(input)));
}

/**
 * SVG path for a point curve. `sampleCurve` is the engine's own sampling
 * function, so the editor draws exactly what the renderer will apply.
 */
export function pointCurvePath(points: readonly ToneCurvePoint[], size = 256): string {
  const values = sampleCurve(points, size);
  return [...values]
    .map((value, index) => {
      const x = (index / (size - 1)) * 255;
      const y = 255 - value * 255;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

/** SVG path for the parametric curve, through the engine's own LUT. */
export function parametricCurvePath(params: EditParams, size = 256): string {
  const lut = buildParametricLut(params, size);
  return Array.from({ length: size }, (_, index) => {
    const x = (index / (size - 1)) * 255;
    const value = lut?.[index] ?? index / (size - 1);
    const y = 255 - Math.min(1, Math.max(0, value)) * 255;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

/** Split point positions in 0..100, in order (the engine clamps the drawn curve too). */
export function parametricSplitValues(params: EditParams): [number, number, number] {
  return [
    params.ParametricShadowSplit ?? 25,
    params.ParametricMidtoneSplit ?? 50,
    params.ParametricHighlightSplit ?? 75,
  ];
}

export const SPLIT_MIN_GAP = 2;

/** Moves one split, keeping the three in order with a small gap between them. */
export function moveParametricSplit(
  splits: readonly [number, number, number],
  index: number,
  value: number,
): [number, number, number] {
  const next: [number, number, number] = [...splits];
  const lower = index === 0 ? 0 : (next[index - 1] ?? 0) + SPLIT_MIN_GAP;
  const upper = index === 2 ? 100 : (next[index + 1] ?? 100) - SPLIT_MIN_GAP;
  next[index] = Math.min(upper, Math.max(lower, Math.round(value)));
  return next;
}

/** Which parametric region an input 0..255 falls in: 0 shadows, 1 darks, 2 lights, 3 highlights. */
export function parametricRegionAt(
  splits: readonly [number, number, number],
  x: number,
): 0 | 1 | 2 | 3 {
  const position = x / 255;
  if (position < (splits[0] ?? 25) / 100) return 0;
  if (position < (splits[1] ?? 50) / 100) return 1;
  if (position < (splits[2] ?? 75) / 100) return 2;
  return 3;
}

/** A dragged region: full graph height is 255 input units and 200 slider units. */
export function regionValueFromDrag(startValue: number, deltaY: number): number {
  return clampParam(startValue + deltaY * (200 / 255));
}

/** The parametric curve's output at `input` through the engine's LUT. */
export function parametricCurveValueAt(params: EditParams, input: number): number {
  const size = 256;
  const lut = buildParametricLut(params, size);
  if (!lut) return Math.min(255, Math.max(0, input));
  const position = Math.min(size - 1, Math.max(0, (input / 255) * (size - 1)));
  const low = Math.floor(position);
  const high = Math.min(size - 1, low + 1);
  const fraction = position - low;
  const value = (lut[low] ?? 0) * (1 - fraction) + (lut[high] ?? 0) * fraction;
  return Math.min(255, Math.max(0, value * 255));
}
