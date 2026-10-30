import type { EditParams, LookProfileData, ResolvedProfile } from '@ee/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderCpu } from '../src/cpu';
import { invert, mulMat, mulMatVec } from '../src/mat3';
import { bradfordAdaptation } from '../src/profile/render';
import { createDevelopRenderer, type DevelopRenderer } from '../src/renderer';
import { identityTable, profileData, setNode } from './profile-support';
import { makeChart, maxAbsDiff, Z6_XYZ_TO_CAMERA } from './support';

/**
 * GPU vs CPU parity of the camera profile stages: matrices, two HueSatMaps blended by temperature,
 * LookTable, XMP look table and curve, the tone curve, and the base pass the neighbourhood
 * stages use. Synthetic profile (never an Adobe file); runs in headless Chromium with SwiftShader.
 */

const W = 96;
const H = 64;
const MAX_LEVELS = 3;

const D65: [number, number, number] = [0.9505, 1, 1.089];
const D50: [number, number, number] = [0.9642, 1, 0.8249];

function forwardFor(xyzToCamera: number[]): number[] {
  const white = mulMatVec(xyzToCamera, D65);
  const n: [number, number, number] = [white[0] / white[1], 1, white[2] / white[1]];
  const inverse = invert(xyzToCamera);
  const y = mulMatVec(inverse, n)[1] ?? 1;
  return mulMat(
    bradfordAdaptation(D65, D50),
    mulMat(inverse, [n[0], 0, 0, 0, 1, 0, 0, 0, n[2]]),
  ).map((v) => v / y);
}

/**
 * A table with a smooth, deterministic pattern of shifts and scales, so every axis matters. Greys
 * (the first saturation node) do not depend on hue, as in a real table: a neutral has no hue, and
 * the half-float intermediates of the neighbourhood passes must not change which way it points.
 */
function wavy(hue: number, sat: number, val: number, amount: number, srgb = false) {
  const table = identityTable(hue, sat, val, srgb);
  const data = table.data.map((_, i) => {
    const node = Math.floor(i / 3);
    const k = i % 3;
    const s = node % sat;
    const h = Math.floor(node / sat) % hue;
    const v = Math.floor(node / (sat * hue));
    const phase = Math.sin((s === 0 ? 0 : h * 1.7) + v * 0.9 + s * 0.8 + 0.3) * amount;
    return k === 0
      ? s === 0
        ? 0
        : phase * 40
      : 1 + phase * 0.35 * (k === 1 ? (s === 0 ? 0 : 1) : 0.5);
  });
  return { ...table, data };
}

const warm = Z6_XYZ_TO_CAMERA;
const cool = Z6_XYZ_TO_CAMERA.map((v, i) => (i % 3 === 0 ? v * 1.1 : v));

const camera = profileData({
  colorMatrices: [warm, cool],
  forwardMatrices: [forwardFor(warm), forwardFor(cool)],
  hueSatMaps: [wavy(12, 4, 2, 1), wavy(12, 4, 2, -0.8)],
  look: wavy(8, 3, 3, 0.6, true),
  toneCurve: [0, 0, 0.1, 0.17, 0.4, 0.62, 0.8, 0.93, 1, 1],
  baselineExposureOffset: 0.35,
});

const look: LookProfileData = {
  name: 'Test Color',
  uuid: '',
  group: 'Profiles',
  base: 'Test Standard',
  restriction: '',
  copyright: '',
  supportsAmount: true,
  table: wavy(10, 3, 2, 0.9),
  tableBounds: [0, 1.5],
  curve: [0, 0, 70 / 255, 55 / 255, 180 / 255, 200 / 255, 1, 1],
  settings: { Contrast2012: 25, Highlights2012: -30, Clarity2012: 20 },
};

const PROFILES: Record<string, ResolvedProfile> = {
  'camera profile': { camera, amount: 1 },
  'camera profile and look at 100%': { camera, look, amount: 1 },
  'look at 60%': { camera, look, amount: 0.6 },
  'look at 170%': { camera, look, amount: 1.7 },
  'colour matrix only': {
    camera: profileData({ colorMatrices: [warm, cool], hueSatMaps: [wavy(6, 3, 1, 1)] }),
    amount: 1,
  },
  'default tone curve (no ProfileToneCurve)': {
    camera: profileData({ colorMatrices: [warm], forwardMatrices: [forwardFor(warm)] }),
    amount: 1,
  },
};

const PARAMS: Record<string, EditParams> = {
  'as shot': {},
  'white balance 3300 K': { Temperature: 3300, Tint: 15 },
  'white balance 8000 K': { Temperature: 8000, Tint: -10 },
  'exposure +1, contrast +30, saturation -20': {
    Exposure2012: 1,
    Contrast2012: 30,
    Saturation: -20,
  },
  'tone curve and mixer on top': {
    ToneCurvePV2012: [
      [0, 10],
      [128, 150],
      [255, 245],
    ],
    HueAdjustmentGreen: 30,
  },
};

let canvas: HTMLCanvasElement;
let renderer: DevelopRenderer | undefined;

beforeAll(() => {
  canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
});

afterEach(() => {
  renderer?.dispose();
  renderer = undefined;
});

describe('camera profile: WebGL2 vs CPU reference', () => {
  const chart = makeChart(W, H);

  for (const [profileName, profile] of Object.entries(PROFILES)) {
    for (const [paramsName, params] of Object.entries(PARAMS)) {
      it(`${profileName}, ${paramsName}`, () => {
        renderer = createDevelopRenderer(canvas);
        renderer.setImage(chart.header, chart.data);
        renderer.setProfile(profile);
        const gpu = renderer.renderToRGBA(params, { width: W, height: H });
        const cpu = renderCpu(chart.header, chart.data, params, undefined, { profile });
        expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(MAX_LEVELS);
      });
    }
  }

  it('the neighbourhood base pass (Clarity from a look, Texture) matches the CPU', () => {
    const profile = PROFILES['camera profile and look at 100%'];
    const params: EditParams = { Texture: 40 };
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    renderer.setProfile(profile ?? null);
    const gpu = renderer.renderToRGBA(params, { width: W, height: H });
    const cpu = renderCpu(chart.header, chart.data, params, undefined, {
      profile: profile ?? null,
    });
    expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(MAX_LEVELS + 2);
  });

  it('actually changes the picture, and setProfile(null) goes back to the camera matrix', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    const plain = renderer.renderToRGBA({}, { width: W, height: H });
    renderer.setProfile(PROFILES['camera profile and look at 100%'] ?? null);
    const profiled = renderer.renderToRGBA({}, { width: W, height: H });
    renderer.setProfile(null);
    const again = renderer.renderToRGBA({}, { width: W, height: H });
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff += Math.abs((plain[i] ?? 0) - (profiled[i] ?? 0));
    expect(diff / plain.length).toBeGreaterThan(5);
    expect(maxAbsDiff(plain, again)).toBe(0);
  });

  it('looks up a hue just below 360 degrees across the wrap, as the CPU does', () => {
    // A strong shift on the first and last hue node: a render of a red-ish chart differs if the wrap is wrong.
    let table = identityTable(6, 2, 1);
    table = setNode(setNode(table, 0, 0, 1, [-50, 1, 1]), 0, 5, 1, [50, 1, 1]);
    const profile: ResolvedProfile = {
      camera: profileData({
        colorMatrices: [warm],
        forwardMatrices: [forwardFor(warm)],
        hueSatMaps: [table],
        toneCurve: [0, 0, 1, 1],
      }),
      amount: 1,
    };
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    renderer.setProfile(profile);
    const gpu = renderer.renderToRGBA({}, { width: W, height: H });
    const cpu = renderCpu(chart.header, chart.data, {}, undefined, { profile });
    expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(MAX_LEVELS);
  });
});
