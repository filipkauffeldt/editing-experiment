import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { developPixel, renderCpu, renderCpuFloat } from '../src/cpu';
import { floatToHalf, halfToFloat, quantizeToHalf, toFloat32Samples } from '../src/image';
import { resolveUniforms } from '../src/params';
import { srgbEncode } from '../src/ops';
import { makeChart, makeHeader } from './support';

/** A camera that is already linear sRGB with unity white balance, so camera RGB passes straight through. */
function identityHeader(width = 1, height = 1): LinearImageHeader {
  return {
    ...makeHeader(width, height, 'f32', { r: 1, g: 1, b: 1 }),
    cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

const pixel = (rgb: [number, number, number], params: EditParams): [number, number, number] =>
  developPixel(...rgb, resolveUniforms(identityHeader(), params));

describe('half float helpers', () => {
  it('round-trips representable values and rounds others to the nearest half', () => {
    for (const v of [0, 1, -1, 0.5, 2.5, 1024, 65504, 2 ** -14, 2 ** -24, 0.333251953125]) {
      expect(halfToFloat(floatToHalf(v))).toBe(v);
    }
    expect(halfToFloat(floatToHalf(1 / 3))).toBeCloseTo(1 / 3, 3);
    expect(halfToFloat(floatToHalf(1e6))).toBe(Infinity);
    expect(Array.from(quantizeToHalf(new Float32Array([1, 2])))).toEqual([0x3c00, 0x4000]);
  });

  it('reads f16 and f32 buffers, including unaligned views, and rejects wrong sizes', () => {
    const h16 = makeHeader(1, 1, 'f16');
    const half = new Uint16Array([floatToHalf(0.25), floatToHalf(0.5), floatToHalf(1), floatToHalf(1)]);
    expect(Array.from(toFloat32Samples(h16, half))).toEqual([0.25, 0.5, 1, 1]);
    const padded = new Uint8Array(half.byteLength + 1);
    padded.set(new Uint8Array(half.buffer), 1);
    expect(Array.from(toFloat32Samples(h16, padded.subarray(1)))).toEqual([0.25, 0.5, 1, 1]);
    const h32 = makeHeader(1, 1, 'f32');
    expect(Array.from(toFloat32Samples(h32, new Float32Array([1, 2, 3, 1]).buffer))).toEqual([1, 2, 3, 1]);
    expect(() => toFloat32Samples(h32, new Float32Array(3))).toThrow(/expected 16/);
  });
});

describe('develop pixel', () => {
  it('encodes linear mid-grey to sRGB with neutral parameters', () => {
    const [r, g, b] = pixel([0.18, 0.18, 0.18], {});
    for (const c of [r, g, b]) expect(c).toBeCloseTo(srgbEncode(0.18), 9);
  });

  it('exposure +1 doubles linear light', () => {
    const [r] = pixel([0.1, 0.1, 0.1], { Exposure2012: 1 });
    expect(r).toBeCloseTo(srgbEncode(0.2), 9);
  });

  it('rolls highlights off instead of hard clipping at 1.0', () => {
    const at = (x: number): number => pixel([x, x, x], {})[0];
    expect(at(1)).toBeLessThan(1);
    expect(at(1.5)).toBeGreaterThan(at(1));
    expect(at(1.5)).toBeLessThan(1);
    expect(at(2)).toBeCloseTo(1, 12);
    expect(at(8)).toBeCloseTo(1, 12);
    // Exposure pushing values above 1 behaves the same way.
    expect(pixel([0.5, 0.5, 0.5], { Exposure2012: 1 })[0]).toBeCloseTo(at(1), 12);
  });

  it('clamps negative camera output to black', () => {
    expect(pixel([-0.2, -0.2, -0.2], { Exposure2012: 2 })).toEqual([0, 0, 0]);
  });

  it('applies tone curves: master, then per channel', () => {
    const invert: EditParams = { ToneCurvePV2012: [[0, 255], [255, 0]] };
    const [r, g, b] = pixel([0.18, 0.18, 0.18], invert);
    expect(r).toBeCloseTo(1 - srgbEncode(0.18), 3);
    expect(g).toBeCloseTo(r, 9);
    expect(b).toBeCloseTo(r, 9);
    const [r2, g2] = pixel([0.18, 0.18, 0.18], { ToneCurvePV2012Red: [[0, 0], [255, 128]] });
    expect(r2).toBeCloseTo(srgbEncode(0.18) / 2, 2);
    expect(g2).toBeCloseTo(srgbEncode(0.18), 6); // the table is float32
  });

  it('applies saturation and vibrance in display space', () => {
    const grey = pixel([0.4, 0.2, 0.1], { Saturation: -100 });
    expect(grey[0]).toBeCloseTo(grey[1], 9);
    expect(grey[1]).toBeCloseTo(grey[2], 9);
    const base = pixel([0.4, 0.2, 0.1], {});
    const vivid = pixel([0.4, 0.2, 0.1], { Vibrance: 100 });
    expect(vivid[0] - vivid[2]).toBeGreaterThan(base[0] - base[2]);
  });

  it('clamps slider values to their ranges', () => {
    expect(pixel([0.1, 0.1, 0.1], { Exposure2012: 99 })).toEqual(pixel([0.1, 0.1, 0.1], { Exposure2012: 5 }));
    expect(pixel([0.4, 0.2, 0.1], { Saturation: -500 })).toEqual(pixel([0.4, 0.2, 0.1], { Saturation: -100 }));
  });

  it('applies white balance before the colour matrix', () => {
    const header: LinearImageHeader = { ...identityHeader(), asShotMultipliers: { r: 2, g: 1, b: 1.5 } };
    const camera: [number, number, number] = [0.1, 0.2, 0.2 / 1.5];
    const [r, g, b] = developPixel(...camera, resolveUniforms(header, {}));
    expect(r).toBeCloseTo(g, 9);
    expect(b).toBeCloseTo(g, 9);
    // Overriding the temperature changes the gains, so the neutral stops being neutral.
    const warm = developPixel(...camera, resolveUniforms(makeHeader(1, 1, 'f32'), { Temperature: 3000 }));
    expect(warm[0]).not.toBeCloseTo(warm[2], 2);
  });
});

describe('render', () => {
  it('produces 8-bit RGBA with opaque alpha and a plausible chart', () => {
    const { header, data } = makeChart(32, 16);
    const out = renderCpu(header, data, { Exposure2012: 0.3, Contrast2012: 20 });
    expect(out).toHaveLength(32 * 16 * 4);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
    // Left of the ramp is dark, right of it is bright.
    expect(out[(2 * 32 + 1) * 4]).toBeLessThan(40);
    expect(out[(2 * 32 + 30) * 4]).toBeGreaterThan(220);
  });

  it('is deterministic and leaves the input untouched', () => {
    const { header, data } = makeChart(16, 8);
    const copy = data.slice();
    const a = renderCpu(header, data, { Highlights2012: -50 });
    const b = renderCpu(header, data, { Highlights2012: -50 });
    expect(a).toEqual(b);
    expect(data).toEqual(copy);
  });

  it('resamples bilinearly to another size', () => {
    const header = identityHeader(2, 1);
    const data = new Float32Array([0, 0, 0, 1, 0.18, 0.18, 0.18, 1]);
    const out = renderCpuFloat(header, data, {}, { width: 4, height: 1 });
    expect(out[0]).toBeCloseTo(0, 9); // clamps at the edge
    expect(out[4]).toBeCloseTo(srgbEncode(0.045), 6); // a quarter of the way
    expect(out[12]).toBeCloseTo(srgbEncode(0.18), 6);
  });
});
