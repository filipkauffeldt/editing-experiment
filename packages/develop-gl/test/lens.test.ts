import type { BuiltinLensCorrection, LensShotInfo } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { renderCpuFloat } from '../src/cpu';
import { lensCorrectedPosition } from '../src/lens/model';
import { resolveLens, describeLens, type LensImage } from '../src/lens/resolve';
import {
  LENSFUN,
  lensfunByKey,
  interpolateInFocalLength,
  interpolateVignetting,
  lensfunProfile,
  matchLensfun,
  nameScore,
} from '../src/lens/lensfun';
import { identityHeader, makeImage } from './support';

const W = 400;
const H = 300;

/** A barrel-distorting lens: the corner is recorded at 0.86 of its true radius. */
const BARREL: BuiltinLensCorrection = {
  source: 'Nikon built-in',
  required: true,
  centre: { x: 0, y: 0 },
  unit: 1,
  distortion: [1, 0, -0.14],
};

const gauss = (d: number): number => Math.exp(-(d * d) / (2 * 1.4 * 1.4));

/** Straight dark lines every 50 px on a grey field, in corrected-frame coordinates. */
function gridScene(x: number, y: number): number {
  let dark = 0;
  for (let line = 50; line < W; line += 50) dark += gauss(x - line);
  for (let line = 50; line < H; line += 50) dark += gauss(y - line);
  return 0.5 - 0.45 * Math.min(1, dark);
}

function shot(builtin: BuiltinLensCorrection): LensShotInfo {
  return { cameraModel: 'NIKON Z 6', lensModel: 'NIKKOR Z 24-70mm f/4 S', builtin };
}

/** The recorded picture of `scene`: what the lens put on the sensor for a corrected-frame scene. */
function record(
  builtin: BuiltinLensCorrection,
  scene: (x: number, y: number, channel: number) => number,
) {
  const lens = resolveLens({ width: W, height: H, lens: shot(builtin) }, {}).uniforms;
  const { header, data } = makeImage(W, H, (x, y) => {
    const p = lensCorrectedPosition(lens, x + 0.5, y + 0.5);
    return [
      scene(p.x - 0.5, p.y - 0.5, 0),
      scene(p.x - 0.5, p.y - 0.5, 1),
      scene(p.x - 0.5, p.y - 0.5, 2),
    ];
  });
  return { header: { ...header, lens: shot(builtin) }, data };
}

/** Centre of a dark line along a row (or column) near `expected`, in pixels, channel `c`. */
function lineCentre(
  rgba: Float32Array,
  at: (i: number) => number,
  expected: number,
  channel = 1,
): number {
  let weight = 0;
  let moment = 0;
  for (let i = Math.floor(expected) - 6; i <= Math.floor(expected) + 6; i++) {
    const value = rgba[at(i) * 4 + channel] ?? 0;
    const w = Math.max(0, 0.75 - value);
    weight += w;
    moment += w * (i + 0.5);
  }
  return moment / weight - 0.5;
}

describe('distortion correction', () => {
  const { header, data } = record(BARREL, (x, y) => gridScene(x, y));

  it('makes the barrel-distorted grid straight again', () => {
    const corrected = renderCpuFloat(header, data, {});
    const uncorrected = renderCpuFloat(header, data, { LensProfileEnable: false });
    // A vertical line 3 grid steps from the centre, followed from the top to the bottom.
    let worstCorrected = 0;
    let worstUncorrected = 0;
    for (const x of [100, 300]) {
      for (const y of [30, 90, 150, 210, 270]) {
        // Skip crossings with the horizontal lines.
        if (Math.abs(((y % 50) + 50) % 50) < 8) continue;
        worstCorrected = Math.max(
          worstCorrected,
          Math.abs(lineCentre(corrected, (i) => y * W + i, x) - x),
        );
        worstUncorrected = Math.max(
          worstUncorrected,
          Math.abs(lineCentre(uncorrected, (i) => y * W + i, x) - x),
        );
      }
    }
    for (const y of [100, 200]) {
      for (const x of [30, 130, 270, 370]) {
        if (Math.abs(((x % 50) + 50) % 50) < 8) continue;
        worstCorrected = Math.max(
          worstCorrected,
          Math.abs(lineCentre(corrected, (i) => i * W + x, y) - y),
        );
      }
    }
    expect(worstUncorrected).toBeGreaterThan(2);
    expect(worstCorrected).toBeLessThan(0.6);
  });

  it('leaves the picture alone when the profile switch is off', () => {
    const off = renderCpuFloat(header, data, { LensProfileEnable: false });
    const plain = renderCpuFloat({ ...header, lens: undefined }, data, {});
    expect(Array.from(off)).toEqual(Array.from(plain));
  });

  it('scales the correction with the distortion amount', () => {
    const half = resolveLens({ ...header, lens: shot(BARREL) }, { LensProfileDistortionScale: 50 });
    const full = resolveLens({ ...header, lens: shot(BARREL) }, {});
    const q = 0.8;
    const at = (c: number[]): number => c[0]! + c[2]! * q * q;
    expect(at(full.uniforms.distortion!.coefficients)).toBeCloseTo(1 - 0.14 * q * q, 6);
    expect(at(half.uniforms.distortion!.coefficients)).toBeCloseTo(1 - 0.07 * q * q, 6);
  });
});

describe('manual distortion', () => {
  it('corrects barrel distortion with positive amounts and is undone by the inverse map', () => {
    const lens = resolveLens({ width: W, height: H }, { LensManualDistortionAmount: 40 }).uniforms;
    const corner = lensCorrectedPosition(lens, 0, 0);
    // Corners stay where they are (r = 1), the middle of an edge is pulled in.
    expect(corner.x).toBeCloseTo(0, 3);
    const edge = lensCorrectedPosition(lens, 0, H / 2);
    expect(edge.x).toBeGreaterThan(0.5);
  });
});

describe('vignetting correction', () => {
  const vignetted: BuiltinLensCorrection = {
    source: 'Nikon built-in',
    required: true,
    centre: { x: 0, y: 0 },
    unit: 1,
    // Gain of 1 + 0.6 q^2: the recorded corners are a third too dark.
    vignetting: [1, 0, 0.6],
  };

  it('flattens a flat field that the lens darkened', () => {
    const lens = resolveLens({ width: W, height: H, lens: shot(vignetted) }, {}).uniforms;
    const half = Math.hypot(W, H) / 2;
    const { header, data } = makeImage(W, H, (x, y) => {
      const q = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / half;
      const gain = 1 + 0.6 * q * q;
      return [0.4 / gain, 0.4 / gain, 0.4 / gain];
    });
    expect(lens.vignette).not.toBeNull();
    const withLens = { ...header, lens: shot(vignetted) };
    const flat = renderCpuFloat(withLens, data, {});
    const raw = renderCpuFloat(withLens, data, { LensProfileEnable: false });
    const spread = (rgba: Float32Array): number => {
      let min = 1;
      let max = 0;
      for (let i = 0; i < W * H; i++) {
        min = Math.min(min, rgba[i * 4] ?? 0);
        max = Math.max(max, rgba[i * 4] ?? 0);
      }
      return max - min;
    };
    expect(spread(raw)).toBeGreaterThan(0.1);
    // Within a quarter of an 8-bit level; the field is not truly flat in the corners only by rounding.
    expect(spread(flat)).toBeLessThan(1 / 255 / 2);
  });

  it('brightens the corners with the manual vignette and darkens them when negative', () => {
    const { header, data } = makeImage(W, H, () => [0.2, 0.2, 0.2]);
    const centre = (rgba: Float32Array): number => rgba[(H / 2) * W * 4 + (W / 2) * 4] ?? 0;
    const corner = (rgba: Float32Array): number => rgba[0] ?? 0;
    const lighter = renderCpuFloat(header, data, { VignetteAmount: 50 });
    const darker = renderCpuFloat(header, data, { VignetteAmount: -50 });
    expect(corner(lighter)).toBeGreaterThan(centre(lighter) + 0.03);
    expect(corner(darker)).toBeLessThan(centre(darker) - 0.03);
    // The middle of the picture is untouched.
    const plain = renderCpuFloat(header, data, {});
    expect(centre(lighter)).toBeCloseTo(centre(plain), 3);
  });
});

describe('lateral chromatic aberration', () => {
  /** Red recorded 1% larger and blue 1% smaller than green: a clean radial fringe. */
  const fringed: BuiltinLensCorrection = {
    source: 'Nikon built-in',
    required: true,
    centre: { x: 0, y: 0 },
    unit: 1,
    red: [1.01],
    blue: [0.99],
  };

  it('brings the red and blue lines back onto the green one', () => {
    const lens = resolveLens({ width: W, height: H, lens: shot(fringed) }, {}).uniforms;
    expect(lens.ca).not.toBeNull();
    const scale = [1.01, 1, 0.99];
    const { header, data } = makeImage(W, H, (x, y) => {
      const out: [number, number, number] = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const k = scale[c]!;
        out[c] = gridScene(
          W / 2 + (x + 0.5 - W / 2) / k - 0.5,
          H / 2 + (y + 0.5 - H / 2) / k - 0.5,
        );
      }
      return out;
    });
    const withLens = { ...header, lens: shot(fringed) };
    const fixed = renderCpuFloat(withLens, data, {});
    const raw = renderCpuFloat(withLens, data, { LensProfileEnable: false });
    const x = 350;
    const y = 60;
    const offset = (rgba: Float32Array): number =>
      Math.max(
        ...[0, 2].map((c) =>
          Math.abs(
            lineCentre(rgba, (i) => y * W + i, x, c) - lineCentre(rgba, (i) => y * W + i, x, 1),
          ),
        ),
      );
    expect(offset(raw)).toBeGreaterThan(1);
    expect(offset(fixed)).toBeLessThan(0.3);
  });
});

describe('Lensfun profiles', () => {
  const z6: LensShotInfo = {
    cameraModel: 'NIKON Z 6',
    lensModel: 'NIKKOR Z 24-70mm f/4 S',
    focalLength: 24,
    focalLength35: 24,
    fNumber: 4,
  };

  it('is shipped with the Nikon Z lenses and carries its database version', () => {
    expect(LENSFUN.version).toBeGreaterThan(1.7e9);
    expect(LENSFUN.lenses.some((l) => l.model === 'Nikkor Z 24-70mm f/4 S')).toBe(true);
  });

  it('finds a lens by the key stored in LensProfileChoice', () => {
    expect(lensfunByKey('Nikon|Nikkor Z 24-70mm f/4 S|1')?.model).toBe('Nikkor Z 24-70mm f/4 S');
    expect(lensfunByKey('Nikon|No such lens|1')).toBeUndefined();
  });

  it('matches the EXIF lens name', () => {
    expect(matchLensfun(z6)?.model).toBe('Nikkor Z 24-70mm f/4 S');
    expect(matchLensfun({ ...z6, lensModel: 'NIKKOR Z 40mm f/2' })?.model).toBe(
      'Nikkor Z 40mm f/2',
    );
    expect(matchLensfun({ ...z6, lensModel: 'Some Unknown 12mm f/9' })).toBeUndefined();
    // Numbers decide: a 24-70 f/2.8 is not the f/4.
    expect(nameScore('NIKKOR Z 24-70mm f/2.8 S', 'Nikkor Z 24-70mm f/4 S')).toBe(0);
  });

  it('prefers the DX calibration for a DX body', () => {
    const z50: LensShotInfo = {
      cameraModel: 'NIKON Z 50',
      lensModel: 'NIKKOR Z DX 16-50mm f/3.5-6.3 VR',
      focalLength: 20,
      focalLength35: 30,
      fNumber: 8,
    };
    expect(matchLensfun(z50)?.crop).toBeGreaterThan(1.4);
  });

  it('evaluates ptlens so that the radius where it is normalised stays fixed', () => {
    const lens = matchLensfun(z6)!;
    const profile = lensfunProfile(lens, z6, 6048, 4032);
    const c = profile.distortion!.coefficients;
    // r_d = r_u (a r^3 + b r^2 + c r + 1 - a - b - c) is exactly 1 at r_u = 1, i.e. half the short edge.
    const at = (u: number): number => c.reduce((sum, k, i) => sum + k * u ** i, 0);
    expect(at(1)).toBeCloseTo(1, 9);
    expect(profile.distortion!.unit).toBeCloseTo(2016, 0);
    // 24 mm is a calibrated focal length: its row, a = 0.032 b = -0.114 c = 0.073.
    expect(c[3]).toBeCloseTo(0.032, 6);
    expect(c[2]).toBeCloseTo(-0.114, 6);
    expect(c[1]).toBeCloseTo(0.073, 6);
  });

  it('scales the units for a crop mode', () => {
    const lens = matchLensfun(z6)!;
    const dx = lensfunProfile(lens, { ...z6, focalLength35: 36 }, 3936, 2624);
    // 1.5 crop: the same lens covers a 1.5x smaller frame, so half the short edge is 1.5x as many calibrated units.
    const fx = lensfunProfile(lens, z6, 3936, 2624);
    expect(dx.distortion!.unit / fx.distortion!.unit).toBeCloseTo(1.5, 3);
  });

  it('interpolates between calibrated focal lengths and holds beyond them', () => {
    const rows = [
      { focal: 24, values: [0.032] },
      { focal: 28, values: [0.022] },
      { focal: 35, values: [0.019] },
      { focal: 50, values: [0.024] },
    ];
    expect(interpolateInFocalLength(rows, 28, [false])![0]).toBeCloseTo(0.022, 9);
    expect(interpolateInFocalLength(rows, 10, [false])![0]).toBe(0.032);
    expect(interpolateInFocalLength(rows, 90, [false])![0]).toBe(0.024);
    const mid = interpolateInFocalLength(rows, 31.5, [false])![0]!;
    expect(mid).toBeGreaterThan(0.017);
    expect(mid).toBeLessThan(0.023);
    // Coefficients that are scaled by focal length still hit the row exactly.
    expect(interpolateInFocalLength(rows, 35, [true])![0]).toBeCloseTo(0.019, 9);
  });

  it('weights vignetting rows by distance in focal length, aperture and focus', () => {
    const rows = [
      [24, 4, 1000, -0.44, -0.87, 0.46],
      [24, 8, 1000, -0.66, -0.12, 0.11],
    ];
    expect(interpolateVignetting(rows, 24, 4, 1000)).toEqual([-0.44, -0.87, 0.46]);
    const between = interpolateVignetting(rows, 24, 5.6, 1000)!;
    expect(between[0]).toBeGreaterThan(-0.66);
    expect(between[0]).toBeLessThan(-0.44);
    // Far from every calibration nothing is applied.
    expect(interpolateVignetting([[24, 1.2, 1000, -0.4, 0, 0]], 24, 32, 0.3)).toBeUndefined();
  });

  it('offers the matched lens first in the profile choices', () => {
    const image: LensImage = { width: 6048, height: 4032, lens: z6 };
    const state = describeLens(image, {});
    expect(state.available).toBe(true);
    expect(state.profileName).toBe('Nikkor Z 24-70mm f/4 S (Lensfun)');
    expect(state.choices[0]).toEqual({ value: '', label: 'Automatic' });
    expect(state.choices[1]?.label.startsWith('★ ')).toBe(true);
    expect(state.corrects).toEqual(['distortion', 'vignetting', 'chromatic aberration']);
    // Off by default for a lens the camera does not require.
    expect(state.enabled).toBe(false);
    expect(resolveLens(image, {}).uniforms.active).toBe(false);
    expect(resolveLens(image, { LensProfileEnable: true }).uniforms.active).toBe(true);
  });

  it('zooms in when the correction would pull in empty canvas', () => {
    // Strong pincushion correction: recorded radius above the corrected one.
    const pincushion: BuiltinLensCorrection = { ...BARREL, distortion: [1, 0, 0.2] };
    const { uniforms } = resolveLens({ width: W, height: H, lens: shot(pincushion) }, {});
    const c = uniforms.distortion!.coefficients;
    const q = Math.hypot(W / 2, H / 2) / uniforms.distortion!.unit;
    const g = c[0]! + c[2]! * q * q;
    // The corner now lands on (or inside) the picture's corner.
    expect(g * Math.hypot(W / 2, H / 2)).toBeLessThanOrEqual(Math.hypot(W / 2, H / 2) + 1);
  });
});

describe('identity', () => {
  it('does nothing for a picture without lens data', () => {
    const { header } = makeImage(8, 8, () => [0.2, 0.2, 0.2]);
    expect(resolveLens(identityHeader(8, 8), { LensProfileEnable: true }).uniforms.active).toBe(
      false,
    );
    expect(header.lens).toBeUndefined();
  });
});
