import type { EditParams } from '@ee/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderCpu } from '../src/cpu';
import { floatToHalf } from '../src/image';
import { createDevelopRenderer, DevelopGlError, type DevelopRenderer } from '../src/renderer';
import { makeChart, makeHeader, maxAbsDiff } from './support';

/**
 * GPU vs CPU parity: the shaders and the CPU reference are two implementations
 * of the same maths, so on a synthetic chart (ramp into superwhites, hue sweep,
 * noise) they must agree to rounding. Runs in headless Chromium with SwiftShader.
 */

const W = 96;
const H = 64;
// 8-bit output: the GPU rounds in hardware and does its maths in float32, so allow a couple of levels.
const MAX_LEVELS = 2;

const CASES: Record<string, EditParams> = {
  'neutral (as shot)': {},
  'exposure +1.5': { Exposure2012: 1.5 },
  'exposure -2': { Exposure2012: -2 },
  'white balance 3200 K / +20': { Temperature: 3200, Tint: 20 },
  'white balance 2500 K (clipped highlights, strong gains)': { Temperature: 2500, Tint: -30 },
  'white balance daylight preset': { WhiteBalance: 'Daylight' },
  'contrast +100': { Contrast2012: 100 },
  'contrast -100': { Contrast2012: -100 },
  'highlights -100': { Highlights2012: -100 },
  'highlights +100': { Highlights2012: 100 },
  'shadows +100': { Shadows2012: 100 },
  'shadows -100': { Shadows2012: -100 },
  'whites +100 / blacks -100': { Whites2012: 100, Blacks2012: -100 },
  'whites -100 / blacks +100': { Whites2012: -100, Blacks2012: 100 },
  'vibrance +100': { Vibrance: 100 },
  'vibrance -60': { Vibrance: -60 },
  'saturation +60 / -100': { Saturation: 60 },
  'saturation -100': { Saturation: -100 },
  'master curve': {
    ToneCurvePV2012: [
      [0, 10],
      [64, 50],
      [128, 150],
      [192, 215],
      [255, 245],
    ],
  },
  'rgb curves': {
    ToneCurvePV2012Red: [
      [0, 0],
      [128, 150],
      [255, 255],
    ],
    ToneCurvePV2012Green: [
      [0, 20],
      [255, 235],
    ],
    ToneCurvePV2012Blue: [
      [0, 0],
      [100, 60],
      [255, 255],
    ],
  },
  'everything at once': {
    Exposure2012: 0.4,
    Temperature: 4800,
    Tint: -12,
    Contrast2012: 35,
    Highlights2012: -45,
    Shadows2012: 30,
    Whites2012: 15,
    Blacks2012: -20,
    Vibrance: 40,
    Saturation: -10,
    ToneCurvePV2012: [
      [0, 0],
      [100, 90],
      [255, 255],
    ],
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

/** Reads the canvas after a draw (the drawing buffer is cleared once the task ends). */
function readCanvas(source: HTMLCanvasElement): Uint8ClampedArray {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, source.width, source.height).data;
}

function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

describe('WebGL2 vs CPU reference', () => {
  const chart = makeChart(W, H);

  for (const [name, params] of Object.entries(CASES)) {
    it(`renderToRGBA matches the CPU: ${name}`, () => {
      renderer = createDevelopRenderer(canvas);
      renderer.setImage(chart.header, chart.data);
      const gpu = renderer.renderToRGBA(params, { width: W, height: H });
      const cpu = renderCpu(chart.header, chart.data, params);
      expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(MAX_LEVELS);
      expect(meanAbsDiff(gpu, cpu)).toBeLessThan(0.3);
    });
  }

  it('actually changes the picture (the comparison is not vacuous)', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    const neutral = renderer.renderToRGBA({}, { width: W, height: H });
    const edited = renderer.renderToRGBA(
      { Exposure2012: 1, Saturation: 50 },
      { width: W, height: H },
    );
    expect(meanAbsDiff(neutral, edited)).toBeGreaterThan(10);
  });

  it('render() to the canvas shows the same upright picture as the CPU', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    const params: EditParams = { Exposure2012: 0.5, Contrast2012: 30, Vibrance: 30 };
    renderer.render(params);
    const shown = readCanvas(canvas);
    const cpu = renderCpu(chart.header, chart.data, params);
    expect(maxAbsDiff(shown, cpu)).toBeLessThanOrEqual(MAX_LEVELS);
  });

  it('re-renders with new parameters without re-uploading', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    renderer.render({ Exposure2012: -1 });
    renderer.render({ Exposure2012: 1 });
    expect(
      maxAbsDiff(readCanvas(canvas), renderCpu(chart.header, chart.data, { Exposure2012: 1 })),
    ).toBeLessThanOrEqual(MAX_LEVELS);
  });

  it('accepts float32 samples', () => {
    const header = { ...chart.header, sampleType: 'f32' as const };
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(header, chart.samples);
    const params: EditParams = { Highlights2012: -30, Vibrance: 20 };
    const gpu = renderer.renderToRGBA(params, { width: W, height: H });
    expect(maxAbsDiff(gpu, renderCpu(header, chart.samples, params))).toBeLessThanOrEqual(
      MAX_LEVELS,
    );
  });

  it('reads f16 data from a view into a larger buffer', () => {
    const padded = new Uint8Array(chart.data.byteLength + 6);
    padded.set(new Uint8Array(chart.data.buffer, chart.data.byteOffset, chart.data.byteLength), 6);
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, padded.subarray(6));
    const gpu = renderer.renderToRGBA({}, { width: W, height: H });
    expect(maxAbsDiff(gpu, renderCpu(chart.header, chart.data, {}))).toBeLessThanOrEqual(
      MAX_LEVELS,
    );
  });

  it('resamples to other sizes like the CPU (bilinear)', () => {
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(chart.header, chart.data);
    const params: EditParams = { Contrast2012: 20 };
    for (const size of [
      { width: 48, height: 32 },
      { width: 150, height: 97 },
    ]) {
      const gpu = renderer.renderToRGBA(params, size);
      const cpu = renderCpu(chart.header, chart.data, params, size);
      // GPU bilinear weights have 8 fractional bits, hence the looser bound.
      expect(meanAbsDiff(gpu, cpu)).toBeLessThan(0.8);
      expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(10);
    }
  });
});

describe('tiling', () => {
  const chart = makeChart(W, H);
  const params: EditParams = { Exposure2012: 0.3, Contrast2012: 25, Saturation: 15 };

  it('renders an image larger than the texture limit in tiles, identical to the untiled render', () => {
    const whole = createDevelopRenderer(canvas);
    whole.setImage(chart.header, chart.data);
    const expected = whole.renderToRGBA(params, { width: W, height: H });
    whole.dispose();

    renderer = createDevelopRenderer(canvas, { maxTextureSize: 40, maxOutputTileSize: 33 });
    renderer.setImage(chart.header, chart.data);
    const tiled = renderer.renderToRGBA(params, { width: W, height: H });
    expect(maxAbsDiff(tiled, expected)).toBe(0);
    expect(maxAbsDiff(tiled, renderCpu(chart.header, chart.data, params))).toBeLessThanOrEqual(
      MAX_LEVELS,
    );
  });

  it('resamples across source tile borders without seams', () => {
    const whole = createDevelopRenderer(canvas);
    whole.setImage(chart.header, chart.data);
    const size = { width: 70, height: 45 };
    const expected = whole.renderToRGBA(params, size);
    whole.dispose();

    renderer = createDevelopRenderer(canvas, { maxTextureSize: 40, maxOutputTileSize: 32 });
    renderer.setImage(chart.header, chart.data);
    const tiled = renderer.renderToRGBA(params, size);
    expect(maxAbsDiff(tiled, expected)).toBeLessThanOrEqual(1);
  });

  it('draws a tiled source to the canvas too', () => {
    renderer = createDevelopRenderer(canvas, { maxTextureSize: 40 });
    renderer.setImage(chart.header, chart.data);
    renderer.render(params);
    expect(
      maxAbsDiff(readCanvas(canvas), renderCpu(chart.header, chart.data, params)),
    ).toBeLessThanOrEqual(MAX_LEVELS);
  });
});

describe('errors', () => {
  it('refuses to render before an image is set and after dispose', () => {
    renderer = createDevelopRenderer(canvas);
    expect(() => renderer?.render({})).toThrow(DevelopGlError);
    renderer.dispose();
    expect(() => renderer?.render({})).toThrow(/disposed/);
  });

  it('rejects a buffer whose size does not match the header', () => {
    renderer = createDevelopRenderer(canvas);
    expect(() => renderer?.setImage(makeHeader(4, 4, 'f16'), new Uint16Array(3))).toThrow(
      RangeError,
    );
  });

  it('keeps an explicit half-float extreme representable', () => {
    expect(floatToHalf(65504)).toBe(0x7bff);
  });
});
