import type { BuiltinLensCorrection, EditParams, LensShotInfo } from '@ee/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderCpu } from '../src/cpu';
import { createDevelopRenderer, type DevelopRenderer } from '../src/renderer';
import { makeScene, maxAbsDiff } from './support';

/**
 * GPU vs CPU parity of the lens corrections (distortion, lateral CA, vignetting gain, the manual
 * settings), through the single develop pass, the multi-pass neighbourhood pipeline, tiled
 * source textures and tiled output.
 */

const W = 120;
const H = 80;

const BUILTIN: BuiltinLensCorrection = {
  source: 'Nikon built-in',
  required: true,
  centre: { x: 0.01, y: -0.008 },
  unit: 1,
  distortion: [0.97, 0, -0.1, 0.03, 0.02],
  vignetting: [1, 0, 0.5, 0, 0, 0, 0.2],
  red: [1.004, 0.002, -0.001],
  blue: [0.997, -0.002],
};
const SHOT: LensShotInfo = {
  cameraModel: 'NIKON Z 6',
  lensModel: 'NIKKOR Z 24-70mm f/4 S',
  builtin: BUILTIN,
};

const CASES: Record<string, EditParams> = {
  'camera profile': {},
  'profile amounts 60 % / 150 %': {
    LensProfileDistortionScale: 60,
    LensProfileVignettingScale: 150,
  },
  'manual distortion +60': { LensProfileEnable: false, LensManualDistortionAmount: 60 },
  'manual distortion -40 on the profile': { LensManualDistortionAmount: -40 },
  'manual vignette': { LensProfileEnable: false, VignetteAmount: -60, VignetteMidpoint: 30 },
  'Lensfun lens': {
    LensProfileEnable: true,
    LensProfileChoice: 'lensfun:Nikon|Nikkor Z 24-70mm f/4 S|1',
  },
  'profile with a straightened crop': {
    crop: { left: 0.1, top: 0.12, right: 0.88, bottom: 0.9, angle: 3 },
  },
  'profile with clarity and sharpening': { Clarity2012: 40, Sharpness: 60, Exposure2012: 0.4 },
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

function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

const scene = makeScene(W, H, { noise: 0 });
const header = {
  ...scene.header,
  lens: { ...SHOT, focalLength: 24, focalLength35: 24, fNumber: 4 },
};

describe('lens corrections: WebGL2 vs CPU', () => {
  for (const [name, params] of Object.entries(CASES)) {
    it(`matches the CPU reference: ${name}`, () => {
      renderer = createDevelopRenderer(canvas);
      renderer.setImage(header, scene.data);
      const cropped = params.crop !== undefined;
      const size = cropped ? { width: 90, height: 60 } : { width: W, height: H };
      const gpu = renderer.renderToRGBA(params, size);
      const cpu = renderCpu(header, scene.data, params, size);
      // Bilinear weights have 8 fractional bits on the GPU.
      expect(meanAbsDiff(gpu, cpu)).toBeLessThan(0.6);
      expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(8);
    });
  }

  it('actually changes the picture', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(header, scene.data);
    const on = renderer.renderToRGBA({}, { width: W, height: H });
    const off = renderer.renderToRGBA({ LensProfileEnable: false }, { width: W, height: H });
    expect(meanAbsDiff(on, off)).toBeGreaterThan(1);
  });

  it('draws the same with a source split into several textures and output tiles', () => {
    const whole = createDevelopRenderer(canvas);
    whole.setImage(header, scene.data);
    const expected = whole.renderToRGBA({}, { width: W, height: H });
    whole.dispose();
    renderer = createDevelopRenderer(canvas, { maxTextureSize: 48, maxOutputTileSize: 37 });
    renderer.setImage(header, scene.data);
    const tiled = renderer.renderToRGBA({}, { width: W, height: H });
    expect(maxAbsDiff(tiled, expected)).toBeLessThanOrEqual(1);
  });

  it('draws the same through the neighbourhood pipeline tiles as the CPU', () => {
    renderer = createDevelopRenderer(canvas, { maxOutputTileSize: 41 });
    renderer.setImage(header, scene.data);
    const params: EditParams = { Texture: 30, Dehaze: 25 };
    const gpu = renderer.renderToRGBA(params, { width: W, height: H });
    const cpu = renderCpu(header, scene.data, params, { width: W, height: H });
    expect(meanAbsDiff(gpu, cpu)).toBeLessThan(1.2);
  });
});
