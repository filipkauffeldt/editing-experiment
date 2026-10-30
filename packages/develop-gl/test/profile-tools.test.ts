import type { ResolvedProfile } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { autoWhiteBalance, whiteBalanceFromPatch } from '../src/analysis';
import { resolveUniforms } from '../src/params';
import { profileColorModel } from '../src/profile/render';
import { profileData } from '../src/profile/testing';
import { makeHeader, Z6_XYZ_TO_CAMERA } from './support';

/**
 * The white balance picker and Auto solve camera gains for a neutral and turn them into a
 * temperature and tint. With a camera profile the temperature picks the profile's ColorMatrix,
 * so the answer has to come from that matrix, or the render would turn the temperature back into
 * different gains and the picked patch would not come out neutral.
 */

// A profile whose two ColorMatrices differ a lot, so the interpolation matters.
const warm = Z6_XYZ_TO_CAMERA.map((v, i) => (i % 3 === 0 ? v * 0.8 : v));
const cool = Z6_XYZ_TO_CAMERA.map((v, i) => (i % 3 === 2 ? v * 1.3 : v));
const profile: ResolvedProfile = {
  camera: profileData({ colorMatrices: [warm, cool], forwardMatrices: [] }),
  amount: 1,
};

/** A patch of camera RGB that is neutral under a tungsten-ish light, as the camera records it. */
function patch(neutral: [number, number, number]) {
  const header = makeHeader(8, 8, 'f32');
  const data = new Float32Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++)
    data.set([neutral[0] * 0.3, neutral[1] * 0.3, neutral[2] * 0.3, 1], i * 4);
  return { header, data };
}

describe('white balance tools through a camera profile', () => {
  const { header, data } = patch([0.5, 1, 0.3]);
  const model = profileColorModel(profile, header.xyzToCamera);

  it('has a colour model only for a profile with a ColorMatrix', () => {
    expect(model).toBeTypeOf('function');
    expect(profileColorModel(null, header.xyzToCamera)).toBeUndefined();
    expect(
      profileColorModel(
        { camera: profileData({ forwardMatrices: [[1, 0, 0, 0, 1, 0, 0, 0, 1]] }), amount: 1 },
        header.xyzToCamera,
      ),
    ).toBeUndefined();
  });

  it.each([
    ['the picker', () => whiteBalanceFromPatch(header, data, { x: 4, y: 4 }, 3, model)],
    ['Auto', () => autoWhiteBalance(header, data, undefined, model)],
  ])('%s: the temperature renders back to the gains it solved', (_name, solve) => {
    const result = solve();
    const rendered = resolveUniforms(
      header,
      { Temperature: Math.round(result.temperature), Tint: Math.round(result.tint) },
      { profile },
    );
    // Rounding the slider values costs a fraction of a percent, not a different matrix.
    expect(rendered.multipliers[0] / result.multipliers.r).toBeCloseTo(1, 1);
    expect(rendered.multipliers[2] / result.multipliers.b).toBeCloseTo(1, 1);
  });

  it('would be wrong with the decoder matrix: the same gains give another temperature', () => {
    const through = whiteBalanceFromPatch(header, data, { x: 4, y: 4 }, 3, model);
    const plain = whiteBalanceFromPatch(header, data, { x: 4, y: 4 }, 3);
    expect(Math.abs(through.temperature - plain.temperature)).toBeGreaterThan(100);
    // And the plain answer does not round-trip through the profile.
    const back = resolveUniforms(
      header,
      { Temperature: Math.round(plain.temperature), Tint: Math.round(plain.tint) },
      { profile },
    );
    expect(Math.abs(back.multipliers[0] / plain.multipliers.r - 1)).toBeGreaterThan(0.02);
  });
});
