import type { CameraProfileData, ResolvedProfile } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { renderCpuFloat } from '../src/cpu';
import { invert, mulMat, mulMatVec } from '../src/mat3';
import { resolveUniforms } from '../src/params';
import {
  bradfordAdaptation,
  cameraToProPhoto,
  prepareProfile,
  PROPHOTO_TO_SRGB,
  XYZ_D50_TO_SRGB,
} from '../src/profile/render';
import { multipliersFromTemperatureTint } from '../src/wb';
import { parseLookXmp } from '../src/profile/look';
import { buildLookXmp } from './look-support';
import { identityTable, profileData, setNode } from './profile-support';
import { makeHeader, Z6_XYZ_TO_CAMERA } from './support';

const D65: [number, number, number] = [0.9505, 1, 1.089];
const D50: [number, number, number] = [0.9642, 1, 0.8249];

/** A scene at most `peak` after white balance, so the highlight shoulder stays out of the way. */
function scene(width = 24, height = 16, peak = 0.25) {
  const header = makeHeader(width, height, 'f32');
  const m = header.asShotMultipliers;
  const limit = peak / Math.max(m.r, m.g, m.b);
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const i = (y * width + x) * 4;
      // A grey ramp on the top half, saturated colours below.
      if (v < 0.4) {
        data[i] = (0.02 + 0.98 * u) * limit * (1 / m.r) * Math.min(m.r, m.g, m.b) * m.r;
        data[i + 1] = (0.02 + 0.98 * u) * limit * (1 / m.g) * Math.min(m.r, m.g, m.b) * m.g;
        data[i + 2] = (0.02 + 0.98 * u) * limit * (1 / m.b) * Math.min(m.r, m.g, m.b) * m.b;
      } else {
        // Moderately saturated colours: well inside sRGB, so no channel is clipped by the profile's gamut.
        const colour: [number, number, number] = [
          (0.1 + 0.9 * u) * (0.3 + 0.7 * v),
          (0.1 + 0.9 * (1 - u)) * (0.2 + 0.5 * v),
          0.05 + 0.4 * u * (1 - v),
        ];
        const grey = (colour[0] + colour[1] + colour[2]) / 3;
        for (let c = 0; c < 3; c++) data[i + c] = limit * (grey + 0.35 * ((colour[c] ?? 0) - grey));
      }
      data[i + 3] = 1;
    }
  }
  return { header, data };
}

/** The forward matrix a profile would carry for camera matrix `xyzToCamera` at a D65 white. */
function forwardFor(xyzToCamera: number[]): number[] {
  const white = mulMatVec(xyzToCamera, D65);
  const n: [number, number, number] = [white[0] / white[1], 1, white[2] / white[1]];
  const inverse = invert(xyzToCamera);
  const y = mulMatVec(inverse, n)[1];
  return mulMat(
    bradfordAdaptation(D65, D50),
    mulMat(inverse, [n[0], 0, 0, 0, 1, 0, 0, 0, n[2]]),
  ).map((v) => v / y);
}

function resolved(
  camera: CameraProfileData,
  extra: Partial<ResolvedProfile> = {},
): ResolvedProfile {
  return { camera, amount: 1, ...extra };
}

describe('camera profile rendering (CPU)', () => {
  it('an identity profile reproduces the render without a profile', () => {
    const { header, data } = scene();
    const m = header.asShotMultipliers;
    // The forward matrix that makes the profile chain the decoder's own matrix, as shot.
    const toSrgbD50 = mulMat(invert(XYZ_D50_TO_SRGB), header.cameraToSrgb).map(
      (v) => v * Math.min(m.r, m.g, m.b),
    );
    const camera = profileData({
      colorMatrices: [Z6_XYZ_TO_CAMERA, Z6_XYZ_TO_CAMERA],
      forwardMatrices: [toSrgbD50, toSrgbD50],
      hueSatMaps: [identityTable(6, 3, 2), identityTable(6, 3, 2)],
      look: identityTable(4, 2, 1, true),
      toneCurve: [0, 0, 1, 1],
    });
    const without = renderCpuFloat(header, data, {});
    const withProfile = renderCpuFloat(header, data, {}, header, { profile: resolved(camera) });
    let worst = 0;
    for (let i = 0; i < without.length; i++) {
      worst = Math.max(worst, Math.abs((without[i] ?? 0) - (withProfile[i] ?? 0)));
    }
    // Float maths on both sides: far below one 8-bit level.
    expect(worst).toBeLessThan(2e-4);
    // And the comparison is not vacuous: the shoulder-less default curve renders differently.
    const acr3 = renderCpuFloat(header, data, {}, header, {
      profile: resolved({ ...camera, toneCurve: undefined }),
    });
    let diff = 0;
    for (let i = 0; i < without.length; i++) diff += Math.abs((without[i] ?? 0) - (acr3[i] ?? 0));
    expect(diff / without.length).toBeGreaterThan(0.02);
  });

  it('resolves white balance through the profile: the as-shot temperature and a chosen one', () => {
    const header = makeHeader(2, 2, 'f32');
    const camera = profileData({
      colorMatrices: [Z6_XYZ_TO_CAMERA, Z6_XYZ_TO_CAMERA],
      forwardMatrices: [forwardFor(Z6_XYZ_TO_CAMERA)],
    });
    const plain = resolveUniforms(header, {});
    const profiled = resolveUniforms(header, {}, { profile: resolved(camera) });
    expect(profiled.whiteBalance.temperature).toBeCloseTo(plain.whiteBalance.temperature, 0);
    expect(profiled.whiteBalance.tint).toBeCloseTo(plain.whiteBalance.tint, 1);
    const chosen = resolveUniforms(
      header,
      { Temperature: 4000, Tint: 5 },
      { profile: resolved(camera) },
    );
    const expected = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 4000, 5);
    expect(chosen.multipliers[0]).toBeCloseTo(expected.r, 9);
    expect(chosen.multipliers[2]).toBeCloseTo(expected.b, 9);
  });

  it('interpolates the ColorMatrix by temperature to choose the multipliers', () => {
    const warm = Z6_XYZ_TO_CAMERA;
    const cool = Z6_XYZ_TO_CAMERA.map((v, i) => (i % 3 === 0 ? v * 1.2 : v));
    const camera = profileData({ colorMatrices: [warm, cool] });
    const header = makeHeader(2, 2, 'f32');
    const at = (temperature: number) =>
      resolveUniforms(header, { Temperature: temperature, Tint: 0 }, { profile: resolved(camera) });
    // At the first illuminant the warm matrix is used, at the second the cool one.
    expect(at(2856).multipliers[0]).toBeCloseTo(multipliersFromTemperatureTint(warm, 2856, 0).r, 9);
    expect(at(6504).multipliers[0]).toBeCloseTo(multipliersFromTemperatureTint(cool, 6504, 0).r, 9);
    // In between it is the matrix blended with the SDK's weight.
    const w = (1 / 4500 - 1 / 2856) / (1 / 6504 - 1 / 2856);
    const blend = warm.map((v, i) => v * (1 - w) + (cool[i] ?? 0) * w);
    expect(at(4500).multipliers[0]).toBeCloseTo(
      multipliersFromTemperatureTint(blend, 4500, 0).r,
      9,
    );
  });

  it('interpolates the forward matrix by the white balance temperature', () => {
    const first = forwardFor(Z6_XYZ_TO_CAMERA);
    const second = first.map((v) => v * 1.1);
    const camera = prepareProfile(
      resolved(
        profileData({ colorMatrices: [Z6_XYZ_TO_CAMERA], forwardMatrices: [first, second] }),
      ),
    );
    const wb = { temperature: 4500, tint: 0, multipliers: { r: 2, g: 1, b: 1.5 } };
    const { matrix, weight } = cameraToProPhoto(camera, wb);
    const w = (1 / 4500 - 1 / 2856) / (1 / 6504 - 1 / 2856);
    expect(weight).toBeCloseTo(w, 12);
    const blended = first.map((v, i) => v * (1 - w) + (second[i] ?? 0) * w);
    const expected = mulMat(invert(PROPHOTO_TO_SRGB_D50()), blended).map((v) => v / 1);
    matrix.forEach((v, i) => expect(v).toBeCloseTo(expected[i] ?? 0, 6));
  });

  it('a ColorMatrix-only profile renders the white balanced neutral as a neutral', () => {
    const header = makeHeader(4, 1, 'f32');
    const m = header.asShotMultipliers;
    const camera = profileData({
      colorMatrices: [Z6_XYZ_TO_CAMERA, Z6_XYZ_TO_CAMERA],
      toneCurve: [0, 0, 1, 1],
    });
    const data = new Float32Array(16);
    for (let x = 0; x < 4; x++) {
      const k = 0.05 + x * 0.1;
      data.set([k / m.r, k / m.g, k / m.b, 1], x * 4);
    }
    const out = renderCpuFloat(header, data, {}, header, { profile: resolved(camera) });
    for (let x = 0; x < 4; x++) {
      const [r, g, b] = [out[x * 4] ?? 0, out[x * 4 + 1] ?? 0, out[x * 4 + 2] ?? 0];
      expect(Math.abs(r - g)).toBeLessThan(2e-3);
      expect(Math.abs(b - g)).toBeLessThan(2e-3);
    }
  });

  it('applies the baseline exposure offset and the HueSatMap value scale before the tone sliders', () => {
    const { header, data } = scene(8, 8, 0.2);
    const m = header.asShotMultipliers;
    const toSrgbD50 = mulMat(invert(XYZ_D50_TO_SRGB), header.cameraToSrgb).map(
      (v) => v * Math.min(m.r, m.g, m.b),
    );
    const base = profileData({
      colorMatrices: [Z6_XYZ_TO_CAMERA],
      forwardMatrices: [toSrgbD50],
      toneCurve: [0, 0, 1, 1],
    });
    const plain = renderCpuFloat(header, data, {}, header, { profile: resolved(base) });
    const lifted = renderCpuFloat(header, data, {}, header, {
      profile: resolved({ ...base, baselineExposureOffset: 1 }),
    });
    const stop = renderCpuFloat(header, data, { Exposure2012: 1 }, header, {
      profile: resolved(base),
    });
    // One stop of baseline is one stop of exposure on linear light.
    for (let i = 0; i < plain.length; i += 4) {
      expect(lifted[i + 1] ?? 0).toBeCloseTo(stop[i + 1] ?? 0, 4);
      expect(lifted[i + 1] ?? 0).toBeGreaterThanOrEqual(plain[i + 1] ?? 0);
    }
    expect(sum(lifted)).toBeGreaterThan(sum(plain) + 1);
    // A HueSatMap that halves the value everywhere darkens the picture by (almost) a stop in linear light.
    let dim = identityTable(6, 2, 1);
    for (let h = 0; h < 6; h++)
      for (let s = 0; s < 2; s++) dim = setNode(dim, 0, h, s, [0, 1, 0.5]);
    const dimmed = renderCpuFloat(header, data, {}, header, {
      profile: resolved({ ...base, hueSatMaps: [dim] }),
    });
    for (let i = 0; i < plain.length; i += 4) {
      expect(dimmed[i + 1] ?? 0).toBeLessThanOrEqual(plain[i + 1] ?? 0);
    }
    expect(sum(dimmed)).toBeLessThan(sum(plain) - 1);
  });

  it('keeps the look amount: tables and curve scale, internal settings add to the sliders', () => {
    const { header, data } = scene(8, 8, 0.5);
    const table = setNode(
      setNode(identityTable(6, 2, 1), 0, 0, 1, [60, 1, 1]),
      0,
      1,
      1,
      [60, 1.4, 1],
    );
    const look = parseLookXmp(
      buildLookXmp({
        base: 'Test Standard',
        table,
        bounds: [0, 2],
        supportsAmount: true,
        attributes: { 'crs:Contrast2012': '30' },
      }),
    );
    const camera = profileData({
      colorMatrices: [Z6_XYZ_TO_CAMERA],
      forwardMatrices: [forwardFor(Z6_XYZ_TO_CAMERA)],
    });
    const render = (amount: number) =>
      renderCpuFloat(header, data, {}, header, { profile: resolved(camera, { look, amount }) });
    const at0 = render(0);
    const baseOnly = renderCpuFloat(header, data, {}, header, { profile: resolved(camera) });
    const at1 = render(1);
    const at2 = render(2);
    const distance = (a: Float32Array, b: Float32Array): number => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum / a.length;
    };
    // Amount 0 is the camera profile alone, 100 % moves away from it, 200 % moves further.
    expect(distance(at0, baseOnly)).toBeLessThan(1e-6);
    expect(distance(at1, baseOnly)).toBeGreaterThan(0.003);
    expect(distance(at2, baseOnly)).toBeGreaterThan(distance(at1, baseOnly));
    // A look that does not support an amount ignores it.
    const fixed = { ...look, supportsAmount: false, tableBounds: [1, 1] as [number, number] };
    expect(
      distance(
        renderCpuFloat(header, data, {}, header, {
          profile: resolved(camera, { look: fixed, amount: 0 }),
        }),
        at1,
      ),
    ).toBeLessThan(1e-6);
  });
});

const sum = (a: Float32Array): number => a.reduce((x, y) => x + y, 0);

/** ProPhoto to XYZ D50 from the two exported conversions (sRGB route), for the interpolation test. */
function PROPHOTO_TO_SRGB_D50(): number[] {
  // XYZ D50 -> ProPhoto is the inverse of this; recover it from PROPHOTO_TO_SRGB and XYZ_D50_TO_SRGB.
  return mulMat(invert(XYZ_D50_TO_SRGB), PROPHOTO_TO_SRGB as number[]);
}
