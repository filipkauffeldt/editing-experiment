import type { ExportOutputSharpening, ExportSharpeningAmount } from '@ee/contracts';

const AMOUNT: Readonly<Record<ExportSharpeningAmount, number>> = {
  low: 0.25,
  standard: 0.45,
  high: 0.7,
};

/** Blur radius in pixels: the media it will be viewed on decides the halo size. */
const RADIUS: Readonly<Record<Exclude<ExportOutputSharpening['target'], 'none'>, number>> = {
  screen: 1,
  matte: 2,
  glossy: 2,
};

/** Rec.709 luma; sharpening works on luminance so colours do not fringe. */
function luma(rgba: Uint8Array, index: number): number {
  return 0.2126 * rgba[index]! + 0.7152 * rgba[index + 1]! + 0.0722 * rgba[index + 2]!;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * Box-blur the luminance channel. A box blur is enough for an output-sharpening
 * unsharp mask (the radius, not the kernel shape, sets the visible halo) and
 * keeps the jobs process free of another native dependency.
 */
function blurLuma(rgba: Uint8Array, width: number, height: number, radius: number): Float32Array {
  const pixels = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) pixels[i] = luma(rgba, i * 4);

  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= width) continue;
        sum += pixels[y * width + sx]!;
        count += 1;
      }
      horizontal[y * width + x] = sum / count;
    }
  }

  const vertical = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        sum += horizontal[sy * width + x]!;
        count += 1;
      }
      vertical[y * width + x] = sum / count;
    }
  }
  return vertical;
}

/**
 * Simple unsharp mask on the sRGB-encoded pixels after resize.
 *
 * `none` returns the input unchanged (no copy). The amount and radius are
 * deliberately small: this is output sharpening for the final medium, not
 * creative sharpening, which belongs in the develop pipeline.
 */
export function sharpenRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  sharpening: ExportOutputSharpening,
): Uint8Array {
  if (sharpening.target === 'none') return rgba;
  if (width <= 0 || height <= 0) return rgba;

  const amount = AMOUNT[sharpening.amount];
  const radius = RADIUS[sharpening.target];
  const blurred = blurLuma(rgba, width, height, radius);
  const output = new Uint8Array(rgba.length);

  for (let i = 0; i < width * height; i++) {
    const index = i * 4;
    const detail = luma(rgba, index) - blurred[i]!;
    // Below one 8-bit step the difference is noise; leaving it alone avoids
    // sharpening flat skies and out-of-focus backgrounds.
    const boost = Math.abs(detail) < 1 ? 0 : detail * amount;
    output[index] = clampByte(rgba[index]! + boost);
    output[index + 1] = clampByte(rgba[index + 1]! + boost);
    output[index + 2] = clampByte(rgba[index + 2]! + boost);
    output[index + 3] = rgba[index + 3]!;
  }
  return output;
}
