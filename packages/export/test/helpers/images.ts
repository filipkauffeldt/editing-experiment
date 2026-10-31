import type { RenderedImage } from '@ee/contracts';

/** Deterministic RGBA test image with enough detail to exercise the encoder. */
export function testImage(width: number, height: number): RenderedImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = Math.round((x / Math.max(1, width - 1)) * 255);
      rgba[at + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      rgba[at + 2] = ((x * 7 + y * 13) % 256) | 0;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}
