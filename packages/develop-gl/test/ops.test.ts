import { describe, expect, it } from 'vitest';
import {
  contrastCurve,
  contrastGamma,
  exposureGain,
  highlightsShadows,
  hueDegrees,
  shoulder,
  srgbDecode,
  srgbEncode,
  toneLuminance,
  vibranceSaturation,
  whitesBlacks,
  type ToneParams,
} from '../src/ops';

const NEUTRAL_TONE: ToneParams = { contrastGamma: 1, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
const MID = srgbEncode(0.18);
const grid = (n: number, max: number): number[] => Array.from({ length: n + 1 }, (_, i) => (i / n) * max);

describe('sRGB transfer', () => {
  it('encodes known values and round-trips', () => {
    expect(srgbEncode(0)).toBe(0);
    expect(srgbEncode(1)).toBeCloseTo(1, 6);
    expect(srgbEncode(0.18)).toBeCloseTo(0.4614, 3);
    for (const x of [0.001, 0.02, 0.18, 0.5, 1, 3]) expect(srgbDecode(srgbEncode(x))).toBeCloseTo(x, 6);
    expect(srgbEncode(-1)).toBe(0);
    expect(srgbDecode(-1)).toBe(0);
  });
});

describe('exposure', () => {
  it('is a gain of 2^stops', () => {
    expect(exposureGain(0)).toBe(1);
    expect(exposureGain(1)).toBe(2);
    expect(exposureGain(-2)).toBe(0.25);
  });
});

describe('contrast', () => {
  it('pins black, the mid-grey pivot and white', () => {
    for (const g of [0.66, 1, 1.5]) {
      expect(contrastCurve(0, g)).toBe(0);
      expect(contrastCurve(MID, g)).toBeCloseTo(MID, 9);
      expect(contrastCurve(1, g)).toBe(1);
    }
  });

  it('is the identity at gamma 1 and for superwhites', () => {
    for (const e of grid(20, 1)) expect(contrastCurve(e, 1)).toBeCloseTo(e, 9);
    expect(contrastCurve(1.4, 1.5)).toBe(1.4);
  });

  it('darkens below and brightens above the pivot for positive contrast, and the opposite for negative', () => {
    const g = contrastGamma(1);
    expect(g).toBeGreaterThan(1);
    expect(contrastCurve(0.25, g)).toBeLessThan(0.25);
    expect(contrastCurve(0.8, g)).toBeGreaterThan(0.8);
    const flat = contrastGamma(-1);
    expect(contrastCurve(0.25, flat)).toBeGreaterThan(0.25);
    expect(contrastCurve(0.8, flat)).toBeLessThan(0.8);
  });

  it('undoes itself with the reciprocal gamma', () => {
    const g = contrastGamma(0.7);
    for (const e of grid(30, 1)) expect(contrastCurve(contrastCurve(e, g), 1 / g)).toBeCloseTo(e, 9);
  });
});

describe('highlights / shadows', () => {
  it('leaves black at black and does nothing when neutral', () => {
    expect(highlightsShadows(0, 1, 1)).toBe(0);
    for (const y of [0.01, 0.2, 1, 3]) expect(highlightsShadows(y, 0, 0)).toBe(y);
  });

  it('recovers highlights: -100 pulls white and superwhites down by the configured stops, shadows barely move', () => {
    expect(highlightsShadows(1, -1, 0)).toBeCloseTo(Math.pow(2, -1.5), 6);
    expect(highlightsShadows(2, -1, 0)).toBeCloseTo(2 * Math.pow(2, -1.5), 6);
    expect(highlightsShadows(0.005, -1, 0)).toBeCloseTo(0.005, 6);
  });

  it('lifts shadows: +100 brightens darks, leaves bright areas alone', () => {
    expect(highlightsShadows(0.02, 0, 1)).toBeGreaterThan(0.02 * 3);
    expect(highlightsShadows(0.8, 0, 1)).toBeCloseTo(0.8, 6);
  });

  it('stays monotone at the extremes so tones never invert', () => {
    for (const [h, s] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      let last = -1;
      for (const y of grid(2000, 4)) {
        const out = highlightsShadows(y, h, s);
        expect(out).toBeGreaterThanOrEqual(last);
        last = out;
      }
    }
  });
});

describe('whites / blacks', () => {
  it('moves only its own end of the range', () => {
    expect(whitesBlacks(0.5, 0, 0)).toBe(0.5);
    expect(whitesBlacks(1, 1, 0)).toBeCloseTo(1.12, 9);
    expect(whitesBlacks(0, 1, 0)).toBe(0);
    expect(whitesBlacks(1, -1, 0)).toBeCloseTo(0.88, 9);
    expect(whitesBlacks(0, 0, 1)).toBeCloseTo(0.12, 9);
    expect(whitesBlacks(0, 0, -1)).toBeCloseTo(-0.12, 9);
    expect(whitesBlacks(1, 0, 1)).toBe(1);
  });

  it('is monotone at the extremes', () => {
    for (const [w, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      let last = -Infinity;
      for (const e of grid(500, 1)) {
        const out = whitesBlacks(e, w, b);
        expect(out).toBeGreaterThanOrEqual(last);
        last = out;
      }
    }
  });
});

describe('combined tone mapping', () => {
  it('is the identity for neutral parameters', () => {
    for (const y of [0.001, 0.05, 0.18, 0.7, 1, 2.5]) expect(toneLuminance(y, NEUTRAL_TONE)).toBeCloseTo(y, 6);
  });

  it('is monotone for every extreme slider corner', () => {
    const signs = [-1, 0, 1];
    for (const h of signs)
      for (const s of signs)
        for (const w of signs)
          for (const b of signs)
            for (const c of signs) {
              const t: ToneParams = { contrastGamma: contrastGamma(c), highlights: h, shadows: s, whites: w, blacks: b };
              let last = -Infinity;
              for (const y of grid(1500, 3)) {
                const out = toneLuminance(Math.max(y, 1e-4), t);
                expect(out, `h${h} s${s} w${w} b${b} c${c} y${y}`).toBeGreaterThanOrEqual(last - 1e-9);
                last = out;
              }
            }
  });
});

describe('highlight shoulder', () => {
  it('is the identity below the knee and 1 from the white point on', () => {
    expect(shoulder(0.5)).toBe(0.5);
    expect(shoulder(0.9)).toBe(0.9);
    expect(shoulder(2)).toBe(1);
    expect(shoulder(50)).toBe(1);
    expect(shoulder(-0.3)).toBe(0);
  });

  it('rolls values above the knee off smoothly: monotone, below 1, no hard clip at 1.0', () => {
    let last = 0;
    for (const x of grid(400, 2)) {
      const out = shoulder(x);
      expect(out).toBeGreaterThanOrEqual(last);
      expect(out).toBeLessThanOrEqual(1);
      last = out;
    }
    expect(shoulder(1)).toBeLessThan(1);
    expect(shoulder(1.2)).toBeGreaterThan(shoulder(1));
    expect(shoulder(1.8)).toBeGreaterThan(shoulder(1.2));
    // Continuous slope at the knee (no visible band edge).
    const slope = (shoulder(0.9 + 1e-6) - shoulder(0.9)) / 1e-6;
    expect(slope).toBeCloseTo(1, 3);
  });
});

describe('vibrance / saturation', () => {
  it('does nothing when neutral', () => {
    expect(vibranceSaturation(0.3, 0.5, 0.7, 0, 0)).toEqual([0.3, 0.5, 0.7]);
  });

  it('removes all colour at saturation -100', () => {
    const [r, g, b] = vibranceSaturation(0.9, 0.4, 0.1, 0, -1);
    expect(r).toBeCloseTo(g, 9);
    expect(g).toBeCloseTo(b, 9);
    expect(r).toBeCloseTo(0.2126 * 0.9 + 0.7152 * 0.4 + 0.0722 * 0.1, 9);
  });

  it('keeps greys grey and scales chroma by 1 + saturation', () => {
    expect(vibranceSaturation(0.4, 0.4, 0.4, 0.5, 0.5)).toEqual([0.4, 0.4, 0.4]);
    const [r, g, b] = vibranceSaturation(0.6, 0.5, 0.4, 0, 0.5);
    expect(r - b).toBeCloseTo(0.2 * 1.5, 9);
    expect(g).toBeGreaterThan(0.4);
  });

  const chroma = (c: readonly [number, number, number]): number => Math.max(...c) - Math.min(...c);

  it('boosts muted colours more than saturated ones', () => {
    const muted = [0.45, 0.5, 0.55] as const;
    const vivid = [0.1, 0.5, 0.9] as const;
    const mutedGain = chroma(vibranceSaturation(...muted, 1, 0)) / chroma(muted);
    const vividGain = chroma(vibranceSaturation(...vivid, 1, 0)) / chroma(vivid);
    expect(mutedGain).toBeGreaterThan(1.5);
    expect(vividGain).toBeLessThan(mutedGain);
    expect(vividGain).toBeGreaterThanOrEqual(1);
  });

  it('boosts skin hues less than other hues of the same saturation', () => {
    const skin = [0.8, 0.6, 0.5] as const; // hue ~ 20 degrees
    const sky = [0.5, 0.6, 0.8] as const; // hue ~ 220 degrees
    expect(hueDegrees(...skin)).toBeGreaterThan(15);
    expect(hueDegrees(...skin)).toBeLessThan(35);
    const skinGain = chroma(vibranceSaturation(...skin, 1, 0)) / chroma(skin);
    const skyGain = chroma(vibranceSaturation(...sky, 1, 0)) / chroma(sky);
    expect(skinGain).toBeLessThan(skyGain);
    expect(skinGain).toBeGreaterThan(1);
  });

  it('computes hue in degrees', () => {
    expect(hueDegrees(1, 0, 0)).toBe(0);
    expect(hueDegrees(0, 1, 0)).toBe(120);
    expect(hueDegrees(0, 0, 1)).toBe(240);
    expect(hueDegrees(1, 0, 0.5)).toBe(330);
    expect(hueDegrees(0.5, 0.5, 0.5)).toBe(0);
  });
});
