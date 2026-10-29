import { describe, expect, it } from 'vitest';
import { sharpenRgba } from '../src/index';

function solid(width: number, height: number, value: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function edge(width: number, height: number): Uint8Array {
  const rgba = solid(width, height, 60);
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width / 2); x < width; x++) {
      const index = (y * width + x) * 4;
      rgba[index] = 210;
      rgba[index + 1] = 210;
      rgba[index + 2] = 210;
    }
  }
  return rgba;
}

describe('sharpenRgba', () => {
  it('does nothing when sharpening is off', () => {
    const rgba = edge(16, 16);
    expect(sharpenRgba(rgba, 16, 16, { target: 'none', amount: 'high' })).toBe(rgba);
  });

  it('leaves a flat image and the alpha channel alone', () => {
    const rgba = solid(12, 9, 128);
    const sharpened = sharpenRgba(rgba, 12, 9, { target: 'screen', amount: 'high' });
    expect(sharpened).toEqual(rgba);
  });

  it('adds an overshoot on both sides of an edge', () => {
    const width = 12;
    const height = 6;
    const rgba = edge(width, height);
    const sharpened = sharpenRgba(rgba, width, height, { target: 'glossy', amount: 'high' });
    const row = 3 * width;
    const darkEdge = sharpened[(row + width / 2 - 1) * 4]!;
    const brightEdge = sharpened[(row + width / 2) * 4]!;
    expect(darkEdge).toBeLessThan(60);
    expect(brightEdge).toBeGreaterThan(210);
    expect(sharpened[(row + 2) * 4 + 3]).toBe(255);
  });

  it('high sharpening changes more than low', () => {
    const width = 12;
    const height = 6;
    const rgba = edge(width, height);
    const low = sharpenRgba(rgba, width, height, { target: 'screen', amount: 'low' });
    const high = sharpenRgba(rgba, width, height, { target: 'screen', amount: 'high' });
    const row = 3 * width;
    const lowEdge = low[(row + width / 2) * 4]!;
    const highEdge = high[(row + width / 2) * 4]!;
    expect(highEdge).toBeGreaterThan(lowEdge);
  });
});
