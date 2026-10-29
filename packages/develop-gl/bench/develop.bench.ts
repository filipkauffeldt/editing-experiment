import type { EditParams } from '@ee/contracts';
import { it } from 'vitest';
import { createDevelopRenderer } from '../src/renderer';
import { makeScene } from '../test/support';

/**
 * Frame times of the live preview with the neighbourhood ops on. Run with
 * `pnpm --filter @ee/develop-gl bench`. In a container this is SwiftShader or
 * llvmpipe (software), so the numbers are a floor, not what a GPU does.
 */

const EDGE = Number(import.meta.env?.VITE_BENCH_EDGE ?? 2560);
const ALL: EditParams = {
  Exposure2012: 0.3,
  Contrast2012: 20,
  Shadows2012: 25,
  Vibrance: 15,
  Texture: 40,
  Clarity2012: 40,
  Dehaze: 20,
  Sharpness: 60,
  LuminanceSmoothing: 30,
  ColorNoiseReduction: 30,
};

it('preview frame times', async () => {
  const width = EDGE;
  const height = Math.round((EDGE * 2) / 3);
  const scene = makeScene(width, height, { noise: 0.03, chromaNoise: 0.03 });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = createDevelopRenderer(canvas);
  renderer.setImage(scene.header, scene.data);
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const sync = (): void => {
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
  const time = (label: string, make: (i: number) => EditParams, frames = 6): string => {
    renderer.render(make(0));
    sync();
    const start = performance.now();
    for (let i = 1; i <= frames; i++) {
      renderer.render(make(i));
      sync();
    }
    const ms = (performance.now() - start) / frames;
    return `${label.padEnd(44)} ${ms.toFixed(0).padStart(6)} ms  ${(1000 / ms).toFixed(1).padStart(6)} fps`;
  };
  const lines = [
    `${width}x${height}`,
    time('all ops, dragging Exposure', (i) => ({ ...ALL, Exposure2012: i / 20 })),
    time('all ops, dragging Clarity', (i) => ({ ...ALL, Clarity2012: 40 + i })),
    time('all ops, dragging Dehaze', (i) => ({ ...ALL, Dehaze: 20 + i })),
    time('all ops, dragging Contrast', (i) => ({ ...ALL, Contrast2012: 20 + i })),
    time('all ops, dragging Sharpening', (i) => ({ ...ALL, Sharpness: 60 + i })),
    time('all ops, dragging Luminance NR (re-runs NR + fields)', (i) => ({
      ...ALL,
      LuminanceSmoothing: 30 + i,
    })),
    time('all ops, dragging Temperature (re-runs everything)', (i) => ({
      ...ALL,
      Temperature: 5600 + i * 50,
    })),
    time('no neighbourhood ops (single develop pass)', (i) => ({
      Exposure2012: i / 20,
      Contrast2012: 20,
    })),
  ];
  renderer.dispose();
  console.log(['', ...lines].join('\n'));
});
