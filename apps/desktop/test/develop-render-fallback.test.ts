// @vitest-environment node
import type { EditParams, LinearImageHeader } from '@ee/contracts';
import type { createDevelopRenderer } from '@ee/develop-gl';
import { renderCpu } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { CPU_FALLBACK_MAX_PIXELS, renderWithFallback } from '../src/renderer/develop-render';

const W = 48;
const H = 32;
const header: LinearImageHeader = {
  width: W,
  height: H,
  sourceWidth: W,
  sourceHeight: H,
  sampleType: 'f32',
  asShotMultipliers: { r: 1, g: 1, b: 1 },
  cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
const samples = new Float32Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const x = i % W;
  const v = 0.05 + (0.4 * ((x * 7) % 13)) / 13;
  samples.set([v, v * 0.9, v * 1.1, 1], i * 4);
}
const data = samples.buffer;
const size = { width: W, height: H };

type Renderer = ReturnType<typeof createDevelopRenderer>;
const gpu = (supportsNeighbourhood: boolean): Renderer & { calls: EditParams[] } => {
  const calls: EditParams[] = [];
  return {
    calls,
    supportsNeighbourhood,
    renderToRGBA: (params: EditParams) => {
      calls.push(params);
      return new Uint8Array(W * H * 4).fill(7);
    },
  } as unknown as Renderer & { calls: EditParams[] };
};

describe('rendering with the CPU reference when the GPU cannot draw the detail settings', () => {
  const detail: EditParams = {
    Exposure2012: 0.3,
    Clarity2012: 40,
    Sharpness: 50,
    LuminanceSmoothing: 30,
  };

  it('uses the GPU when it supports them, and for settings that do not need them', () => {
    const renderer = gpu(true);
    expect(renderWithFallback(renderer, header, data, detail, size)[0]).toBe(7);
    const noFloat = gpu(false);
    expect(renderWithFallback(noFloat, header, data, { Exposure2012: 1 }, size)[0]).toBe(7);
    expect(noFloat.calls).toHaveLength(1);
  });

  it('renders the settings on the CPU, identical to the reference, when it does not', () => {
    const renderer = gpu(false);
    const out = renderWithFallback(renderer, header, data, detail, size, 99);
    expect(renderer.calls).toHaveLength(0);
    expect(Array.from(out)).toEqual(
      Array.from(renderCpu(header, data, detail, size, { grainSeed: 99 })),
    );
    // And it really contains the settings: not the same as the picture without them.
    const without = renderCpu(header, data, { Exposure2012: 0.3 }, size);
    expect(Array.from(out)).not.toEqual(Array.from(without));
  });

  it('fails clearly instead of running out of memory on a huge picture', () => {
    const huge = { ...header, width: 5000, height: 4000 };
    expect(huge.width * huge.height).toBeGreaterThan(CPU_FALLBACK_MAX_PIXELS);
    expect(() => renderWithFallback(gpu(false), huge, new ArrayBuffer(0), detail, size)).toThrow(
      /need GPU float support/,
    );
    // The check does not get in the way of a GPU that can do it.
    expect(renderWithFallback(gpu(true), huge, new ArrayBuffer(0), detail, size)[0]).toBe(7);
  });
});
