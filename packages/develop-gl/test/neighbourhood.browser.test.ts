import type { EditParams } from '@ee/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCpu } from '../src/cpu';
import { createDevelopRenderer, type DevelopRenderer } from '../src/renderer';
import { hashNoise, makeImage, makeScene, maxAbsDiff } from './support';

/**
 * The neighbourhood passes (noise reduction, Texture, Clarity, Dehaze,
 * sharpening) against their CPU reference, across resolutions and across tiles.
 * Runs in headless Chromium with SwiftShader.
 *
 * Parity tolerance: both sides run the same maths, but the GPU keeps every
 * intermediate image in half floats (10 bit mantissa) and filters with 8
 * fractional bits, so a few 8-bit levels of difference are expected (and
 * measured: 1 level at most on this scene).
 */

const MAX_LEVELS = 3;

const OPS: Record<string, EditParams> = {
  'texture +80': { Texture: 80 },
  'texture -80': { Texture: -80 },
  'clarity +70': { Clarity2012: 70 },
  'clarity -70': { Clarity2012: -70 },
  'dehaze +60': { Dehaze: 60 },
  'dehaze -50': { Dehaze: -50 },
  sharpening: { Sharpness: 100, SharpenRadius: 1.5, SharpenDetail: 60, SharpenEdgeMasking: 20 },
  'luminance noise reduction': {
    LuminanceSmoothing: 60,
    LuminanceNoiseReductionDetail: 40,
    LuminanceNoiseReductionContrast: 30,
  },
  'colour noise reduction': {
    ColorNoiseReduction: 60,
    ColorNoiseReductionDetail: 30,
    ColorNoiseReductionSmoothness: 70,
  },
};

const EVERYTHING: EditParams = {
  Exposure2012: 0.4,
  Contrast2012: 25,
  Shadows2012: 30,
  Vibrance: 20,
  Texture: 40,
  Clarity2012: 35,
  Dehaze: 25,
  Sharpness: 60,
  LuminanceSmoothing: 30,
  ColorNoiseReduction: 30,
};

let renderer: DevelopRenderer | undefined;
afterEach(() => {
  renderer?.dispose();
  renderer = undefined;
});

const canvasOf = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

/** Box-downsamples an RGBA8 render by an integer factor (alpha ignored in the comparison). */
function downscale(rgba: Uint8Array, width: number, height: number, factor: number): Uint8Array {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            sum += rgba[((y * factor + dy) * width + x * factor + dx) * 4 + c] ?? 0;
          }
        }
        out[(y * w + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return out;
}

describe('WebGL2 vs CPU reference: neighbourhood ops', () => {
  const W = 192;
  const H = 128;
  const scene = makeScene(W, H, { noise: 0.05, chromaNoise: 0.2 });

  for (const [name, params] of Object.entries({ ...OPS, 'everything at once': EVERYTHING })) {
    it(`renderToRGBA matches the CPU: ${name}`, () => {
      renderer = createDevelopRenderer(canvasOf(W, H));
      renderer.setImage(scene.header, scene.data);
      const gpu = renderer.renderToRGBA(params, { width: W, height: H });
      const cpu = renderCpu(scene.header, scene.data, params);
      expect(maxAbsDiff(gpu, cpu)).toBeLessThanOrEqual(MAX_LEVELS);
      expect(meanAbsDiff(gpu, cpu)).toBeLessThan(0.3);
      // Not vacuous: the op changes the picture well beyond the tolerance.
      const plain = renderCpu(scene.header, scene.data, {});
      expect(meanAbsDiff(cpu, plain)).toBeGreaterThan(0.5);
    });
  }

  it('matches the CPU with a crop, straighten and a different output size', () => {
    const params: EditParams = {
      ...EVERYTHING,
      crop: { left: 0.1, top: 0.15, right: 0.9, bottom: 0.85, angle: 4 },
    };
    renderer = createDevelopRenderer(canvasOf(W, H));
    renderer.setImage(scene.header, scene.data);
    for (const size of [
      { width: 160, height: 100 },
      { width: 96, height: 64 },
    ]) {
      const gpu = renderer.renderToRGBA(params, size);
      const cpu = renderCpu(scene.header, scene.data, params, size);
      expect(meanAbsDiff(gpu, cpu)).toBeLessThan(1.2);
    }
  });

  it('render() to the canvas shows the same upright picture as the CPU', () => {
    const canvas = canvasOf(W, H);
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    renderer.render(EVERYTHING);
    const copy = document.createElement('canvas');
    copy.width = W;
    copy.height = H;
    const ctx = copy.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(canvas, 0, 0);
    const shown = ctx.getImageData(0, 0, W, H).data;
    expect(maxAbsDiff(shown, renderCpu(scene.header, scene.data, EVERYTHING))).toBeLessThanOrEqual(
      MAX_LEVELS,
    );
  });

  it('reuses its cached stages without changing the result', () => {
    const size = { width: W, height: H };
    const slow: EditParams = { Texture: 40, Clarity2012: 50, Dehaze: 30, LuminanceSmoothing: 40 };
    const fresh = (params: EditParams): Uint8Array => {
      const r = createDevelopRenderer(canvasOf(W, H));
      r.setImage(scene.header, scene.data);
      const out = r.renderToRGBA(params, size);
      r.dispose();
      return out;
    };
    renderer = createDevelopRenderer(canvasOf(W, H));
    renderer.setImage(scene.header, scene.data);
    // The preview path keeps the base image, noise reduction, pyramid and fields between calls;
    // only things after them (exposure, amounts of Texture/Clarity/Dehaze, tone, sharpening) move.
    renderer.render(slow);
    for (const next of [
      { ...slow, Exposure2012: 0.8 },
      { ...slow, Clarity2012: -30, Texture: -50, Dehaze: -20, Exposure2012: -0.5 },
      { ...slow, Contrast2012: 35, Sharpness: 70, Exposure2012: 0.2 },
    ]) {
      renderer.render(next);
      const cached = renderer.renderToRGBA(next, size);
      expect(maxAbsDiff(cached, fresh(next))).toBe(0);
    }
  });
});

describe('tiles', () => {
  const W = 448;
  const H = 320;
  const scene = makeScene(W, H, { noise: 0.05, chromaNoise: 0.2 });
  const size = { width: W, height: H };

  /** Renders whole, then in tiles of `core` pixels (with `halo` around them) and with a split source. */
  function compare(params: EditParams, maxOutputTileSize: number, core: number) {
    const whole = createDevelopRenderer(canvasOf(W, H));
    whole.setImage(scene.header, scene.data);
    const expected = whole.renderToRGBA(params, size);
    whole.dispose();

    const tiled = createDevelopRenderer(canvasOf(W, H), { maxOutputTileSize });
    tiled.setImage(scene.header, scene.data);
    const actual = tiled.renderToRGBA(params, size);
    tiled.dispose();

    // A split source on top of the split output: the whole-output level 3 and the
    // measurement copy are then drawn from several source textures.
    const split = createDevelopRenderer(canvasOf(W, H), { maxOutputTileSize, maxTextureSize: 200 });
    split.setImage(scene.header, scene.data);
    const fromSplit = split.renderToRGBA(params, size);
    split.dispose();

    // Worst difference within two pixels of any tile edge, where a missing halo would show.
    let seam = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const near = x % core <= 1 || x % core >= core - 2 || y % core <= 1 || y % core >= core - 2;
        if (!near) continue;
        for (let c = 0; c < 3; c++) {
          const i = (y * W + x) * 4 + c;
          seam = Math.max(seam, Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)));
        }
      }
    }
    return { expected, actual, fromSplit, seam };
  }

  it('Texture, Clarity and Dehaze: tile seams cannot appear', () => {
    const params: EditParams = { Texture: 60, Clarity2012: 60, Dehaze: 40, Contrast2012: 20 };
    // Halo 32: a tile core of 96 pixels.
    const r = compare(params, 160, 96);
    expect(maxAbsDiff(r.actual, r.expected)).toBeLessThanOrEqual(MAX_LEVELS);
    expect(r.seam).toBeLessThanOrEqual(MAX_LEVELS);
    expect(maxAbsDiff(r.fromSplit, r.expected)).toBeLessThanOrEqual(MAX_LEVELS);
    // Not vacuous: the picture differs a lot from the unedited one.
    const plain = renderCpu(scene.header, scene.data, {});
    expect(meanAbsDiff(r.expected, plain)).toBeGreaterThan(2);
  });

  it('noise reduction and sharpening: tile seams cannot appear', () => {
    const params: EditParams = {
      LuminanceSmoothing: 50,
      ColorNoiseReduction: 50,
      Sharpness: 80,
      SharpenRadius: 2,
    };
    // Halo 192: a tile core of 96 pixels.
    const r = compare(params, 480, 96);
    expect(maxAbsDiff(r.actual, r.expected)).toBeLessThanOrEqual(MAX_LEVELS);
    expect(r.seam).toBeLessThanOrEqual(MAX_LEVELS);
    expect(maxAbsDiff(r.fromSplit, r.expected)).toBeLessThanOrEqual(MAX_LEVELS);
  });
});

describe('resolution consistency', () => {
  const FULL = { width: 1024, height: 672 };
  const PREVIEW = { width: 512, height: 336 };
  // The preview is the same photo at half size, and says so in its header.
  const full = makeScene(FULL.width, FULL.height);
  const preview = makeScene(PREVIEW.width, PREVIEW.height, {
    sourceWidth: FULL.width,
    sourceHeight: FULL.height,
  });
  const claimsFullRes = makeScene(PREVIEW.width, PREVIEW.height);

  function renderPair(params: EditParams, previewScene = preview) {
    const a = createDevelopRenderer(canvasOf(PREVIEW.width, PREVIEW.height));
    a.setImage(previewScene.header, previewScene.data);
    const shown = a.renderToRGBA(params, PREVIEW);
    const base = a.renderToRGBA({}, PREVIEW);
    a.dispose();
    const b = createDevelopRenderer(canvasOf(FULL.width, FULL.height));
    b.setImage(full.header, full.data);
    const exported = downscale(b.renderToRGBA(params, FULL), FULL.width, FULL.height, 2);
    b.dispose();
    return { shown, exported, base };
  }

  // The noise floor of the comparison itself is what two different resamplings of one render differ by.
  const floor = (): number => {
    const { shown, exported } = renderPair({});
    return meanAbsDiff(shown, exported);
  };

  const OPS_AT_SCALE: Record<string, EditParams> = {
    Texture: { Texture: 80 },
    Clarity: { Clarity2012: 80 },
    Dehaze: { Dehaze: 60 },
    Sharpening: { Sharpness: 100, SharpenRadius: 1.5 },
  };

  for (const [name, params] of Object.entries(OPS_AT_SCALE)) {
    it(`${name}: a preview at half the export size looks like the export`, () => {
      const { shown, exported, base } = renderPair(params);
      const diff = meanAbsDiff(shown, exported);
      expect(diff).toBeLessThan(floor() + 0.15);
      // Not vacuous: the op is larger than the disagreement.
      expect(meanAbsDiff(shown, base)).toBeGreaterThan(diff * 2);
    });
  }

  for (const [name, params] of Object.entries({
    Texture: OPS_AT_SCALE.Texture,
    Sharpening: OPS_AT_SCALE.Sharpening,
  }) as [string, EditParams][]) {
    it(`${name}: without the full-resolution size in the header the preview would disagree`, () => {
      const right = renderPair(params);
      const wrong = renderPair(params, claimsFullRes);
      expect(meanAbsDiff(wrong.shown, wrong.exported)).toBeGreaterThan(
        meanAbsDiff(right.shown, right.exported) * 1.8,
      );
    });
  }

  it('noise reduction removes the noise at both sizes', () => {
    const params: EditParams = { LuminanceSmoothing: 70, ColorNoiseReduction: 60 };
    for (const [w, h] of [
      [PREVIEW.width, PREVIEW.height],
      [FULL.width, FULL.height],
    ] as const) {
      // A smooth ramp, so what NR removes is noise and not detail.
      const ramp = (x: number, y: number): [number, number, number] => {
        const v = 0.05 + 0.4 * (x / w) + 0.05 * (y / h);
        return [v * 1.1, v, v * 0.9];
      };
      const clean = makeImage(w, h, ramp);
      const noisy = makeImage(w, h, (x, y) => {
        const [r, g, b] = ramp(x, y);
        const n = 1 + 0.1 * hashNoise(x, y);
        const c = 1 + 0.1 * hashNoise(x, y, 7);
        return [r * n * c, g * n, (b * n) / c];
      });
      const r = createDevelopRenderer(canvasOf(w, h));
      r.setImage(clean.header, clean.data);
      const truth = r.renderToRGBA({}, { width: w, height: h });
      r.setImage(noisy.header, noisy.data);
      const before = meanAbsDiff(r.renderToRGBA({}, { width: w, height: h }), truth);
      const after = meanAbsDiff(r.renderToRGBA(params, { width: w, height: h }), truth);
      r.dispose();
      expect(after).toBeLessThan(before * 0.6);
    }
  });
});
