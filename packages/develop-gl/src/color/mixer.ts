import type { EditParams } from '@ee/contracts';
import { SLIDER_SPECS, type SliderParam } from '@ee/contracts';
import { bandWeight, clamp01, hsvToRgb, rgbToHsv, smoothstep } from './common';
import { COLOR_TUNING as C } from './tuning';

/** One resolved Color Mixer band: hue, saturation and luminance shifts, -1..1. */
export interface MixerBand {
  hue: number;
  sat: number;
  lum: number;
}

export interface ColorMixer {
  bands: MixerBand[];
  active: boolean;
}

const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

const value = (params: EditParams, name: SliderParam): number => {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.min(SLIDER_SPECS[name].max, Math.max(SLIDER_SPECS[name].min, raw)) / 100;
};

/** Reads the 24 mixer sliders. */
export function resolveColorMixer(params: EditParams): ColorMixer {
  const bands = BANDS.map((band) => ({
    hue: value(params, `HueAdjustment${band}` as SliderParam),
    sat: value(params, `SaturationAdjustment${band}` as SliderParam),
    lum: value(params, `LuminanceAdjustment${band}` as SliderParam),
  }));
  return {
    bands,
    active: bands.some((band) => band.hue !== 0 || band.sat !== 0 || band.lum !== 0),
  };
}

/**
 * Applies the Color Mixer on sRGB-encoded RGB.
 *
 * Lightroom's bands overlap: each slider's influence falls off smoothly from its
 * band centre and several bands can touch the same colour. Neutrals are never
 * touched, because the band weight is gated by HSV saturation.
 */
export function applyColorMixer(
  r: number,
  g: number,
  b: number,
  mixer: ColorMixer,
): [number, number, number] {
  if (!mixer.active) return [r, g, b];
  const [h, s, v] = rgbToHsv(r, g, b);
  const gate = smoothstep(C.neutralSaturation.from, C.neutralSaturation.to, s);
  if (gate === 0 || v === 0) return [r, g, b];

  let hueShift = 0;
  let satScale = 0;
  let valueScale = 0;
  for (let i = 0; i < mixer.bands.length; i++) {
    const band = mixer.bands[i]!;
    if (band.hue === 0 && band.sat === 0 && band.lum === 0) continue;
    const weight = bandWeight(h, C.bandHues[i]!) * gate;
    hueShift += band.hue * weight;
    satScale += band.sat * weight;
    valueScale += band.lum * weight;
  }

  const shiftedHue = h + (hueShift * C.hslHueDegrees) / 360;
  const saturation = clamp01(s * Math.max(0, 1 + satScale * C.hslSaturationStrength));
  const value = Math.max(0, v * Math.max(0, 1 + valueScale * C.hslLuminanceStrength));
  return hsvToRgb(shiftedHue, saturation, value);
}
