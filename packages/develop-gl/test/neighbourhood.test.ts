import { describe, expect, it } from 'vitest';
import { renderCpuFloat } from '../src/cpu';
import { srgbDecode } from '../src/ops';
import { needsNeighbourhood, NEIGHBOURHOOD_PARAMS, withoutNeighbourhood } from '../src';
import { makeImage, rng, stats } from './support';

/**
 * CPU reference of the neighbourhood ops (Texture, Clarity, Dehaze, sharpening,
 * noise reduction) on synthetic images where the expected effect is known.
 */

/** Amplitude (log2 units, after decoding the render) of a vertical grating of `period` px along row `y`. */
function gratingAmplitude(
  render: Float32Array,
  width: number,
  y: number,
  period: number,
  x0: number,
  x1: number,
): number {
  let s = 0;
  let c = 0;
  for (let x = x0; x < x1; x++) {
    const v = Math.log2(Math.max(srgbDecode(render[(y * width + x) * 4 + 1] ?? 0), 1e-6));
    const t = (2 * Math.PI * x) / period;
    s += v * Math.sin(t);
    c += v * Math.cos(t);
  }
  return Math.hypot(s, c);
}

/** A 0.5 EV grating on a dark scene with a bright strip along the bottom (it sets Clarity's key level). */
function gratingScene(period: number) {
  const W = 384;
  const H = 128;
  const image = makeImage(W, H, (x, y) => {
    const v = y > 120 ? 4 : 0.05 * 2 ** (0.5 * Math.sin((2 * Math.PI * x) / period));
    return [v, v, v];
  });
  return { W, ...image };
}

const gaussian = (rand: () => number): number => {
  let s = 0;
  for (let i = 0; i < 6; i++) s += rand();
  return (s - 3) * 1.4;
};

describe('Texture', () => {
  it('boosts fine detail, softens it when negative, and leaves flat areas alone', () => {
    const { W, header, data } = gratingScene(16);
    const amplitude = (p: object) =>
      gratingAmplitude(renderCpuFloat(header, data, p), W, 60, 16, 96, 288);
    const base = amplitude({});
    expect(amplitude({ Texture: 100 }) / base).toBeGreaterThan(1.25);
    expect(amplitude({ Texture: -100 }) / base).toBeLessThan(0.8);
    expect(amplitude({ Texture: 0 }) / base).toBeCloseTo(1, 6);

    const flat = makeImage(64, 64, () => [0.2, 0.2, 0.2]);
    const a = renderCpuFloat(flat.header, flat.data, {});
    const b = renderCpuFloat(flat.header, flat.data, { Texture: 100 });
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i] ?? 0, 5);
  });

  it('leaves very coarse structure alone', () => {
    const { W, header, data } = gratingScene(128);
    const amplitude = (p: object) =>
      gratingAmplitude(renderCpuFloat(header, data, p), W, 60, 128, 96, 288);
    expect(amplitude({ Texture: 100 }) / amplitude({})).toBeLessThan(1.05);
  });
});

describe('Clarity', () => {
  it('raises local contrast at medium scales without shifting the mean luminance', () => {
    const { W, header, data } = gratingScene(48);
    const base = renderCpuFloat(header, data, {});
    const clear = renderCpuFloat(header, data, { Clarity2012: 100 });
    const soft = renderCpuFloat(header, data, { Clarity2012: -100 });
    const amp = (r: Float32Array) => gratingAmplitude(r, W, 60, 48, 96, 288);
    expect(amp(clear) / amp(base)).toBeGreaterThan(1.3);
    expect(amp(soft) / amp(base)).toBeLessThan(0.95);
    const rect = { x: 96, y: 0, w: 192, h: 100 };
    const mean = (r: Float32Array) => stats(r, W, rect).mean;
    expect(Math.abs(mean(clear) - mean(base)) / mean(base)).toBeLessThan(0.03);
  });

  it('does not push past the edge of a strong step (the blur is edge aware)', () => {
    const W = 256;
    const { header, data } = makeImage(W, 128, (x, y) => {
      const v = y > 120 ? 4 : x < 128 ? 0.02 : 0.5;
      return [v, v, v];
    });
    const base = renderCpuFloat(header, data, {});
    const clear = renderCpuFloat(header, data, { Clarity2012: 100 });
    // Far from the edge the levels stay put: no halo reaching 40 px away.
    for (const x of [60, 200]) {
      const i = (60 * W + x) * 4 + 1;
      expect(Math.abs((clear[i] ?? 0) - (base[i] ?? 0))).toBeLessThan(0.02);
    }
  });
});

describe('Dehaze', () => {
  /** A scene of dark and mid objects seen through uniform haze: I = J t + A (1 - t). */
  const hazy = (t: number) =>
    makeImage(160, 120, (x, y) => {
      const cell = (Math.floor(x / 16) + Math.floor(y / 16)) % 3;
      const j = [0.01, 0.08, 0.3][cell] as number;
      const v = j * t + 0.85 * (1 - t);
      return [v, v, v];
    });

  it('lifts contrast and deepens blacks of a hazy scene', () => {
    const { header, data } = hazy(0.5);
    const base = renderCpuFloat(header, data, {});
    const clear = renderCpuFloat(header, data, { Dehaze: 80 });
    const rect = { x: 0, y: 0, w: 160, h: 120 };
    const b = stats(base, 160, rect);
    const c = stats(clear, 160, rect);
    expect(c.variance).toBeGreaterThan(b.variance * 1.5);
    let minBase = 1;
    let minClear = 1;
    for (let i = 1; i < base.length; i += 4) {
      minBase = Math.min(minBase, base[i] ?? 1);
      minClear = Math.min(minClear, clear[i] ?? 1);
    }
    expect(minClear).toBeLessThan(minBase - 0.1);
  });

  it('negative Dehaze adds a veil: blacks lift and contrast falls', () => {
    const { header, data } = hazy(0.9);
    const base = renderCpuFloat(header, data, {});
    const veil = renderCpuFloat(header, data, { Dehaze: -80 });
    const rect = { x: 0, y: 0, w: 160, h: 120 };
    expect(stats(veil, 160, rect).variance).toBeLessThan(stats(base, 160, rect).variance);
    expect(stats(veil, 160, rect).mean).toBeGreaterThan(stats(base, 160, rect).mean);
  });

  it('does nothing without haze to measure at Dehaze 0', () => {
    const { header, data } = hazy(0.5);
    const a = renderCpuFloat(header, data, {});
    const b = renderCpuFloat(header, data, { Dehaze: 0 });
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe('Sharpening', () => {
  /** A soft vertical edge, 4 px wide, between 0.1 and 0.4 linear. */
  const edge = () =>
    makeImage(128, 64, (x) => {
      const v = 0.1 + 0.3 / (1 + Math.exp(-(x - 64) / 1.5));
      return [v, v, v];
    });
  /** Width in pixels of the 10%..90% rise of the encoded green channel along row 32. */
  const riseWidth = (r: Float32Array): number => {
    const row = (x: number) => r[(32 * 128 + x) * 4 + 1] ?? 0;
    const lo = row(20);
    const hi = row(108);
    const at = (f: number) => {
      const target = lo + (hi - lo) * f;
      for (let x = 21; x < 108; x++) if (row(x) >= target) return x;
      return 108;
    };
    return at(0.9) - at(0.1);
  };

  it('increases edge acutance and leaves Sharpness 0 alone', () => {
    const { header, data } = edge();
    const base = renderCpuFloat(header, data, {});
    const sharp = renderCpuFloat(header, data, { Sharpness: 100, SharpenDetail: 60 });
    expect(riseWidth(sharp)).toBeLessThan(riseWidth(base));
    expect(Array.from(renderCpuFloat(header, data, { Sharpness: 0 }))).toEqual(Array.from(base));
  });

  it('holds back halos at strong edges: overshoot stays bounded', () => {
    const { header, data } = edge();
    const base = renderCpuFloat(header, data, {});
    const sharp = renderCpuFloat(header, data, { Sharpness: 150, SharpenRadius: 1 });
    const peak = Math.max(
      ...Array.from({ length: 128 }, (_, x) => sharp[(32 * 128 + x) * 4 + 1] ?? 0),
    );
    const top = base[(32 * 128 + 120) * 4 + 1] ?? 0;
    expect(peak - top).toBeLessThan(0.1);
  });

  it('masking protects flat noisy areas but keeps edges sharpened', () => {
    const rand = rng(11);
    const W = 128;
    const { header, data } = makeImage(W, 64, (x) => {
      const noise = x < 64 ? 0.01 * gaussian(rand) : 0;
      const v = (x < 96 ? 0.15 : 0.3) * (1 + noise);
      return [v, v, v];
    });
    const rect = { x: 8, y: 8, w: 48, h: 48 };
    const base = stats(renderCpuFloat(header, data, {}), W, rect).variance;
    const open = stats(renderCpuFloat(header, data, { Sharpness: 100 }), W, rect).variance;
    const masked = stats(
      renderCpuFloat(header, data, { Sharpness: 100, SharpenEdgeMasking: 100 }),
      W,
      rect,
    ).variance;
    expect(open).toBeGreaterThan(base * 1.5);
    expect(masked).toBeLessThan(open * 0.5);
    const edgeJump = (p: object) => {
      const r = renderCpuFloat(header, data, p);
      return (r[(32 * W + 97) * 4 + 1] ?? 0) - (r[(32 * W + 94) * 4 + 1] ?? 0);
    };
    expect(edgeJump({ Sharpness: 100, SharpenEdgeMasking: 100 })).toBeGreaterThan(edgeJump({}));
  });
});

describe('Noise reduction', () => {
  const noisy = (W: number, H: number, edge = false) => {
    const rand = rng(5);
    return makeImage(W, H, (x) => {
      const level = edge && x >= W / 2 ? 0.5 : 0.18;
      const luma = 1 + 0.06 * gaussian(rand);
      const chroma = 1 + 0.04 * gaussian(rand);
      return [level * luma * chroma, level * luma, (level * luma) / chroma];
    });
  };
  const rect = { x: 40, y: 40, w: 176, h: 176 };

  it('luminance smoothing cuts the variance of a noisy flat patch', () => {
    const { header, data } = noisy(256, 256);
    const base = stats(renderCpuFloat(header, data, {}), 256, rect).variance;
    const half = stats(
      renderCpuFloat(header, data, { LuminanceSmoothing: 50 }),
      256,
      rect,
    ).variance;
    const full = stats(
      renderCpuFloat(header, data, { LuminanceSmoothing: 100 }),
      256,
      rect,
    ).variance;
    expect(half).toBeLessThan(base * 0.3);
    expect(full).toBeLessThan(half);
  });

  it('colour noise reduction cuts colour variance and keeps luminance', () => {
    const { header, data } = noisy(256, 256);
    const chromaVariance = (p: object) => {
      const r = renderCpuFloat(header, data, p);
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = (y * 256 + x) * 4;
          const d = (r[i] ?? 0) - (r[i + 2] ?? 0);
          sum += d;
          sumSq += d * d;
          n++;
        }
      }
      return sumSq / n - (sum / n) ** 2;
    };
    expect(chromaVariance({ ColorNoiseReduction: 60 })).toBeLessThan(chromaVariance({}) * 0.3);
    const lumaBase = stats(renderCpuFloat(header, data, {}), 256, rect).variance;
    const lumaColour = stats(
      renderCpuFloat(header, data, { ColorNoiseReduction: 60 }),
      256,
      rect,
    ).variance;
    expect(lumaColour).toBeGreaterThan(lumaBase * 0.7);
  });

  it('keeps a strong edge while smoothing both sides', () => {
    const { header, data } = noisy(256, 256, true);
    const jump = (p: object) => {
      const r = renderCpuFloat(header, data, p);
      return (
        stats(r, 256, { x: 140, y: 40, w: 60, h: 176 }).mean -
        stats(r, 256, { x: 56, y: 40, w: 60, h: 176 }).mean
      );
    };
    const base = jump({});
    expect(jump({ LuminanceSmoothing: 80 })).toBeGreaterThan(base * 0.9);
  });
});

describe('which settings need the neighbourhood pipeline', () => {
  it('is nothing for neutral and tone-only params, and each control on its own', () => {
    expect(needsNeighbourhood({})).toBe(false);
    expect(needsNeighbourhood({ Exposure2012: 1, Contrast2012: 20, Vibrance: 10 })).toBe(false);
    // Sharpness 0 and noise reduction at 0 are off even with their detail sliders set.
    expect(needsNeighbourhood({ Sharpness: 0, SharpenDetail: 80, LuminanceSmoothing: 0 })).toBe(
      false,
    );
    for (const params of [
      { Texture: 5 },
      { Clarity2012: -5 },
      { Dehaze: 5 },
      { Sharpness: 1 },
      { LuminanceSmoothing: 1 },
      { ColorNoiseReduction: 1 },
    ]) {
      expect(needsNeighbourhood(params)).toBe(true);
    }
  });

  it('strips exactly the neighbourhood settings and nothing else', () => {
    const params = {
      Exposure2012: 0.5,
      Vibrance: 12,
      crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 2 },
      ...Object.fromEntries(NEIGHBOURHOOD_PARAMS.map((name) => [name, 10])),
    };
    expect(withoutNeighbourhood(params)).toEqual({
      Exposure2012: 0.5,
      Vibrance: 12,
      crop: params.crop,
    });
    expect(needsNeighbourhood(withoutNeighbourhood(params))).toBe(false);
  });
});
