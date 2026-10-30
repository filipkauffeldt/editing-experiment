import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { histogramOfRgba } from '../src/analysis';
import { renderCpu } from '../src/cpu';
import { createDevelopRenderer, type DevelopRenderer } from '../src/renderer';
import { makeHeader } from './support';

const W = 64;
const H = 32;

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

/** A flat f32 camera image: left third black, middle grey, right third clipped white. */
function clippingScene(): { header: ReturnType<typeof makeHeader>; data: Float32Array } {
  const header = makeHeader(W, H, 'f32', { r: 1, g: 1, b: 1 });
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const value = x < W / 3 ? 0 : x >= (W * 2) / 3 ? 4 : 0.5;
      data.set([value, value, value, 1], (y * W + x) * 4);
    }
  }
  return { header, data };
}

/** A horizontal luminance ramp, for the histogram parity test. */
function rampScene(): { header: ReturnType<typeof makeHeader>; data: Float32Array } {
  const header = makeHeader(W, H, 'f32', { r: 1, g: 1, b: 1 });
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const value = x / (W - 1);
      data.set([value, value * 0.8, value * 0.6, 1], (y * W + x) * 4);
    }
  }
  return { header, data };
}

function readCanvas(source: HTMLCanvasElement): Uint8ClampedArray {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, source.width, source.height).data;
}

const pixel = (rgba: ArrayLike<number>, x: number, y: number): number[] => {
  const index = (y * W + x) * 4;
  return [rgba[index] ?? 0, rgba[index + 1] ?? 0, rgba[index + 2] ?? 0];
};

describe('clipping overlay', () => {
  it('paints clipped highlights red and crushed shadows blue, view only', () => {
    const scene = clippingScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    renderer.render({}, { clipping: { shadows: true, highlights: true } });
    const shown = readCanvas(canvas);
    expect(pixel(shown, 2, H / 2)).toEqual([0, 64, 255]);
    expect(pixel(shown, W - 3, H / 2)).toEqual([255, 0, 0]);

    const exported = renderer.renderToRGBA({}, { width: W, height: H });
    expect(pixel(exported, 2, H / 2)).toEqual([0, 0, 0]);
    expect(pixel(exported, W - 3, H / 2)).toEqual([249, 249, 249]);
  });

  it('can show one side only, and forgets the overlay on the next view', () => {
    const scene = clippingScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    renderer.render({}, { clipping: { shadows: false, highlights: true } });
    const highlights = readCanvas(canvas);
    expect(pixel(highlights, W - 3, H / 2)).toEqual([255, 0, 0]);
    expect(pixel(highlights, 2, H / 2)).toEqual([0, 0, 0]);

    renderer.render({});
    const clean = readCanvas(canvas);
    expect(pixel(clean, W - 3, H / 2)).toEqual([249, 249, 249]);
  });
});

describe('histogram', () => {
  it('matches the CPU reference histogram of the rendered frame', () => {
    const scene = rampScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    renderer.render({});
    const gpu = renderer.readHistogram(16);
    const cpu = histogramOfRgba(
      renderCpu(scene.header, scene.data, {}, { width: W, height: H }),
      W,
      H,
      16,
    );
    const tolerance = Math.max(20, Math.round((W * H) / 100));
    for (const channel of ['red', 'green', 'blue', 'luminance'] as const) {
      expect([...gpu[channel]].reduce((a, b) => a + b, 0)).toBe(W * H);
      for (let bin = 0; bin < gpu.bins; bin++) {
        expect(Math.abs((gpu[channel][bin] ?? 0) - (cpu[channel][bin] ?? 0))).toBeLessThanOrEqual(
          tolerance,
        );
      }
    }
  });

  it('measures the lens-corrected frame, not the recorded pixels', () => {
    const scene = rampScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    renderer.render({});
    const plain = renderer.readHistogram(16);
    // The manual lens vignette is part of the lens stage, before the histogram readback.
    renderer.render({ VignetteAmount: 100 });
    const corrected = renderer.readHistogram(16);
    expect([...corrected.luminance]).not.toEqual([...plain.luminance]);
  });

  it('measures the cropped frame when a crop is committed', () => {
    const scene = clippingScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    // The right (white) third only.
    renderer.render({
      crop: { left: 2 / 3, top: 0, right: 1, bottom: 1, angle: 0 },
    });
    const histogram = renderer.readHistogram(4);
    // Every pixel is white: the top luminance bin holds the whole frame.
    expect(histogram.luminance[3]).toBe(W * H);
  });
});

describe('before/after split', () => {
  it('draws the unedited photo on the left and the current edit on the right', () => {
    const scene = rampScene();
    renderer = createDevelopRenderer(canvas);
    renderer.setImage(scene.header, scene.data);
    const before = renderer.renderToRGBA({}, { width: W, height: H });
    const after = renderer.renderToRGBA({ Exposure2012: 1 }, { width: W, height: H });

    renderer.renderSplit({ Exposure2012: 1 }, {}, 0.5);
    const shown = readCanvas(canvas);
    for (const x of [1, 10, 25]) {
      expect(pixel(shown, x, H / 2)).toEqual(pixel(before, x, H / 2));
    }
    for (const x of [40, 50, W - 2]) {
      expect(pixel(shown, x, H / 2)).toEqual(pixel(after, x, H / 2));
    }
    // The current edit is visibly brighter than the original on the right.
    expect(pixel(shown, W - 2, H / 2)[0] ?? 0).toBeGreaterThan(pixel(shown, 1, H / 2)[0] ?? 0);
  });
});
