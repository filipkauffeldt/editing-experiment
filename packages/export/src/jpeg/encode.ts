import { encodeJpeg as encodeJpegNative, resizeRgba } from '@ee/core';
import type { ExportPreset, ExportResize, RenderedImage } from '@ee/contracts';
import { ExportError } from '../errors';
import { sharpenRgba } from './sharpen';

export interface EncodedJpeg {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Longest edge to ask the native resizer for. `undefined` means "leave the
 * pixels alone". The native resizer never upscales, so a target larger than the
 * source still returns the source size.
 */
export function resizeMaxEdge(
  width: number,
  height: number,
  resize: ExportResize,
): number | undefined {
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  switch (resize.mode) {
    case 'none':
      return undefined;
    case 'longEdge':
      return resize.pixels;
    case 'shortEdge':
      return shortest <= resize.pixels
        ? undefined
        : Math.max(resize.pixels, Math.round((resize.pixels * longest) / shortest));
    case 'megapixels': {
      const target = resize.megapixels * 1_000_000;
      if (target >= width * height) return undefined;
      return Math.max(1, Math.round(longest * Math.sqrt(target / (width * height))));
    }
  }
}

/**
 * Encodes an sRGB RGBA render as a baseline JPEG (via the native core).
 *
 * - Resizes according to `preset.resize` (Lanczos, never upscales).
 * - Applies output sharpening after the resize, before encoding.
 * - Embeds an sRGB ICC profile so viewers do not guess the colour space.
 * - Uses 4:4:4 chroma at quality >= 90, 4:2:0 below that.
 * - Metadata is never carried over: the input is raw pixels and the encoder
 *   writes only JFIF and the ICC profile, so no thumbnail from the source survives.
 */
export async function encodeJpeg(image: RenderedImage, preset: ExportPreset): Promise<EncodedJpeg> {
  validateImage(image);
  validatePreset(preset);

  let { width, height } = image;
  let rgba = image.rgba;

  const maxEdge = resizeMaxEdge(width, height, preset.resize);
  if (maxEdge !== undefined && Math.max(width, height) > maxEdge) {
    const resized = await resizeRgba(rgba, width, height, { maxEdge });
    ({ width, height } = resized);
    rgba = resized.rgba;
  }

  rgba = sharpenRgba(rgba, width, height, preset.outputSharpening);

  const data = await encodeJpegNative(rgba, width, height, {
    quality: preset.quality,
    chroma: preset.quality >= 90 ? '444' : '420',
    iccSrgb: true,
  });
  return { data, width, height };
}

function validateImage(image: RenderedImage): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new ExportError('invalid_image', 'Image width and height must be integers');
  }
  if (image.width <= 0 || image.height <= 0) {
    throw new ExportError('invalid_image', 'Image width and height must be positive');
  }
  const expected = image.width * image.height * 4;
  if (image.rgba.byteLength !== expected) {
    throw new ExportError(
      'invalid_image',
      `RGBA buffer has ${image.rgba.byteLength} bytes, expected ${expected}`,
    );
  }
}

function validatePreset(preset: ExportPreset): void {
  if (!Number.isInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) {
    throw new ExportError('invalid_preset', 'JPEG quality must be an integer from 1 to 100');
  }
  const resize = preset.resize;
  if (resize === undefined) return;
  switch (resize.mode) {
    case 'none':
      return;
    case 'longEdge':
    case 'shortEdge':
      if (!Number.isInteger(resize.pixels) || resize.pixels <= 0) {
        throw new ExportError('invalid_preset', 'Resize pixels must be a positive integer');
      }
      return;
    case 'megapixels':
      if (!Number.isFinite(resize.megapixels) || resize.megapixels <= 0) {
        throw new ExportError('invalid_preset', 'Resize megapixels must be positive');
      }
      return;
    default:
      throw new ExportError(
        'invalid_preset',
        `Unknown resize mode ${(resize as { mode?: string }).mode ?? 'undefined'}`,
      );
  }
}
