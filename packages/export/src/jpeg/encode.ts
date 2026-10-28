import { encodeJpeg as encodeJpegNative, resizeRgba } from '@ee/core';
import type { ExportPreset, RenderedImage } from '@ee/contracts';
import { ExportError } from '../errors';

export interface EncodedJpeg {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Encodes an sRGB RGBA render as a baseline JPEG (via the native core).
 *
 * - Downscales to `preset.maxEdge` (longest edge, never upscales) with Lanczos.
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
  if (preset.maxEdge !== undefined && Math.max(width, height) > preset.maxEdge) {
    const resized = await resizeRgba(rgba, width, height, { maxEdge: preset.maxEdge });
    ({ width, height, rgba } = resized);
  }

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
  if (preset.maxEdge !== undefined) {
    if (!Number.isInteger(preset.maxEdge) || preset.maxEdge <= 0) {
      throw new ExportError('invalid_preset', 'maxEdge must be a positive integer');
    }
  }
}
