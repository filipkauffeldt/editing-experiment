import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { clamp, smoothstep } from './common';
import { srgbDecode, srgbEncode } from '../ops';

/**
 * Defringe (`crs:Defringe*`): reduces the chroma of the purple and green fringes. Per pixel, in
 * Oklab after the colour controls. The model is RAWmakase's fit to Camera Raw 18.6 renders
 * (`Effects::defringe_color`, MIT): the Purple and Green windows are centred at Oklab hue 0.875 and
 * 0.46 (turns), each Hue slider's 0..100 spans half a turn around its centre, window edges are
 * softened over 0.025, and the share of chroma removed at full window weight is
 * `(1 - 0.45 e^(-C / 0.09)) (1 - e^(-Amount / 2.5))`. Camera Raw also reduces more next to strong
 * edges; that spatial part is not reproduced.
 */

export const DEFRINGE = {
  purpleCentre: 0.875,
  greenCentre: 0.46,
  span: 0.5,
  soften: 0.025,
  floor: 0.45,
  chromaScale: 0.09,
  amountScale: 2.5,
} as const;

export interface DefringeRange {
  /** 0..20 */
  amount: number;
  /** Window edges relative to the range's centre, in turns of hue. */
  low: number;
  high: number;
  centre: number;
}

export interface Defringe {
  purple: DefringeRange | null;
  green: DefringeRange | null;
}

const slider = (params: EditParams, name: SliderParam): number => {
  const spec = SLIDER_SPECS[name];
  const raw = params[name];
  const value = raw === undefined || !Number.isFinite(raw) ? (spec.neutral ?? 0) : raw;
  return clamp(value, spec.min, spec.max);
};

function range(amount: number, lo: number, hi: number, centre: number): DefringeRange | null {
  if (amount <= 0) return null;
  const half = DEFRINGE.span / 2;
  return {
    amount,
    low: -half + (Math.min(lo, hi) / 100) * DEFRINGE.span,
    high: -half + (Math.max(lo, hi) / 100) * DEFRINGE.span,
    centre,
  };
}

export function resolveDefringe(params: EditParams): Defringe | null {
  const purple = range(
    slider(params, 'DefringePurpleAmount'),
    slider(params, 'DefringePurpleHueLo'),
    slider(params, 'DefringePurpleHueHi'),
    DEFRINGE.purpleCentre,
  );
  const green = range(
    slider(params, 'DefringeGreenAmount'),
    slider(params, 'DefringeGreenHueLo'),
    slider(params, 'DefringeGreenHueHi'),
    DEFRINGE.greenCentre,
  );
  return purple || green ? { purple, green } : null;
}

/** Linear sRGB to Oklab (Ottosson). */
function toOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Share of a hue-window's chroma removed for this hue (turns) and chroma. */
function share(window: DefringeRange, hue: number, chroma: number): number {
  let d = hue - window.centre;
  d -= Math.round(d);
  const weight =
    smoothstep(window.low - DEFRINGE.soften, window.low + DEFRINGE.soften, d) -
    smoothstep(window.high - DEFRINGE.soften, window.high + DEFRINGE.soften, d);
  if (weight <= 0) return 0;
  return (
    weight *
    (1 - DEFRINGE.floor * Math.exp(-chroma / DEFRINGE.chromaScale)) *
    (1 - Math.exp(-window.amount / DEFRINGE.amountScale))
  );
}

/** Reduces the fringe colours of one sRGB-encoded pixel. Neutral pixels are returned untouched. */
export function applyDefringe(
  er: number,
  eg: number,
  eb: number,
  defringe: Defringe,
): [number, number, number] {
  const [L, a, b] = toOklab(
    srgbDecode(clamp(er, 0, 1)),
    srgbDecode(clamp(eg, 0, 1)),
    srgbDecode(clamp(eb, 0, 1)),
  );
  const chroma = Math.hypot(a, b);
  if (chroma < 1e-6) return [er, eg, eb];
  const hue = Math.atan2(b, a) / (2 * Math.PI) + (b < 0 ? 1 : 0);
  let kept = 1;
  if (defringe.purple) kept *= 1 - share(defringe.purple, hue, chroma);
  if (defringe.green) kept *= 1 - share(defringe.green, hue, chroma);
  if (kept >= 1) return [er, eg, eb];
  const [r, g, bl] = fromOklab(L, a * kept, b * kept);
  return [srgbEncode(Math.max(0, r)), srgbEncode(Math.max(0, g)), srgbEncode(Math.max(0, bl))];
}
