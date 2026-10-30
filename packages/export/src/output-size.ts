import type { ExportResize } from '@ee/contracts';

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * The final pixel size of an export for `resize`, never upscaling. Both the
 * renderer (which renders directly at this size) and the encoder (which only
 * resizes when the render is still larger) use this, so they cannot disagree.
 */
export function outputSizeForResize(
  width: number,
  height: number,
  resize: ExportResize,
): PixelSize {
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  switch (resize.mode) {
    case 'none':
      return { width, height };
    case 'longEdge':
      return fit(width, height, resize.pixels);
    case 'shortEdge':
      if (shortest <= resize.pixels) return { width, height };
      return fit(
        width,
        height,
        Math.max(resize.pixels, Math.round((resize.pixels * longest) / shortest)),
      );
    case 'megapixels': {
      const target = resize.megapixels * 1_000_000;
      if (target >= width * height) return { width, height };
      return fit(
        width,
        height,
        Math.max(1, Math.round(longest * Math.sqrt(target / (width * height)))),
      );
    }
  }
}

/** Longest edge of `outputSizeForResize`; `undefined` means the pixels stay as they are. */
export function resizeMaxEdge(
  width: number,
  height: number,
  resize: ExportResize,
): number | undefined {
  const output = outputSizeForResize(width, height, resize);
  if (output.width === width && output.height === height) return undefined;
  return Math.max(output.width, output.height);
}

/** Fits `width` x `height` into `maxEdge` on the longest edge, like the native resizer. */
function fit(width: number, height: number, maxEdge: number): PixelSize {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  const scaled = (value: number): number => Math.max(1, Math.round(value * scale));
  return { width: scaled(width), height: scaled(height) };
}
