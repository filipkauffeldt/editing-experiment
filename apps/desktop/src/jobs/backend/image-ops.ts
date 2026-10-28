/**
 * Every image operation the backend does itself (the export and retouch
 * packages do theirs) lives in this file, on top of the `@ee/core` native image
 * ops. sharp is not used: its libvips clashes with the glib Electron links on
 * Linux and crashes the process.
 */
import type { RenderedImage } from '@ee/contracts';
import { decodeJpeg, encodeJpeg, makePreviews, resizeRgba, type RgbaImage } from '@ee/core';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Longest edge of the cached preview shown in the main view. */
export const PREVIEW_MAX_EDGE = 2560;
/** Longest edge of the film strip thumbnail. */
export const THUMB_MAX_EDGE = 320;

const PREVIEW_QUALITY = 85;
const THUMB_QUALITY = 80;

/** What a preview is made from: JPEG bytes in sensor orientation, or a JPEG file with its own EXIF tag. */
export type PreviewSource = { jpeg: Buffer; orientation: number } | { file: string };

export interface PreviewJpegs {
  /** At most {@link PREVIEW_MAX_EDGE} px on the long edge, upright, no EXIF. */
  preview: Buffer;
  /** At most {@link THUMB_MAX_EDGE} px on the long edge, upright, no EXIF. */
  thumb: Buffer;
}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe']);

/** Upright preview and thumbnail JPEGs for a photo. Never upscales. */
export async function makePreviewJpegs(source: PreviewSource): Promise<PreviewJpegs> {
  if ('file' in source) {
    if (!JPEG_EXTENSIONS.has(extname(source.file).toLowerCase())) {
      throw new Error(`previews of ${extname(source.file) || 'this'} files are not supported`);
    }
    // The file's own EXIF orientation is applied by the core.
    return makePreviews(await readFile(source.file), {
      thumbEdge: THUMB_MAX_EDGE,
      previewEdge: PREVIEW_MAX_EDGE,
      quality: PREVIEW_QUALITY,
    });
  }
  // An embedded raw preview is in sensor orientation; the raw decoder says how to turn it,
  // so ignore any tag in the preview itself. Resizing first keeps the turn cheap.
  const stored = await decodeJpeg(source.jpeg, { skipOrientation: true });
  const fitted = await resizeRgba(stored.rgba, stored.width, stored.height, {
    maxEdge: PREVIEW_MAX_EDGE,
  });
  const upright = orientRgba(fitted, source.orientation);
  const small = await resizeRgba(upright.rgba, upright.width, upright.height, {
    maxEdge: THUMB_MAX_EDGE,
  });
  const [preview, thumb] = await Promise.all([
    encode(upright, PREVIEW_QUALITY),
    encode(small, THUMB_QUALITY),
  ]);
  return { preview, thumb };
}

const encode = (image: RenderedImage, quality: number): Promise<Buffer> =>
  encodeJpeg(image.rgba, image.width, image.height, { quality, chroma: '420', iccSrgb: true });

/** Preview and thumbnail JPEGs from the renderer's already upright, edited pixels. */
export async function encodeEditedJpegs(images: {
  thumb: RenderedImage;
  preview: RenderedImage;
}): Promise<PreviewJpegs> {
  const [preview, thumb] = await Promise.all([
    encode(images.preview, PREVIEW_QUALITY),
    encode(images.thumb, THUMB_QUALITY),
  ]);
  return { preview, thumb };
}

/** Upright RGBA pixels of a JPEG stored in sensor orientation. */
export async function decodeOrientedRgba(jpeg: Buffer, orientation: number): Promise<RgbaImage> {
  return orientRgba(await decodeJpeg(jpeg, { skipOrientation: true }), orientation);
}

/**
 * Turn pixels stored in sensor orientation upright for an EXIF orientation (1..8).
 * Orientations 5..8 swap width and height. The unit test checks all eight against
 * the EXIF definition.
 */
export function orientRgba(image: RgbaImage, orientation: number): RgbaImage {
  if (!(orientation >= 2 && orientation <= 8)) return image;
  const { width: w, height: h } = image;
  const swap = orientation >= 5;
  const width = swap ? h : w;
  const height = swap ? w : h;
  // Pixels move as 32-bit words; a view needs a 4-byte aligned start, which pooled buffers lack.
  const aligned =
    image.rgba.byteOffset % 4 === 0
      ? image.rgba
      : Buffer.from(
          image.rgba.buffer.slice(image.rgba.byteOffset, image.rgba.byteOffset + w * h * 4),
        );
  const source = new Uint32Array(aligned.buffer, aligned.byteOffset, w * h);
  const target = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          [sx, sy] = [w - 1 - x, y];
          break;
        case 3:
          [sx, sy] = [w - 1 - x, h - 1 - y];
          break;
        case 4:
          [sx, sy] = [x, h - 1 - y];
          break;
        case 5:
          [sx, sy] = [y, x];
          break;
        case 6:
          [sx, sy] = [y, h - 1 - x];
          break;
        case 7:
          [sx, sy] = [w - 1 - y, h - 1 - x];
          break;
        default:
          [sx, sy] = [w - 1 - y, x];
      }
      target[y * width + x] = source[sy * w + sx] as number;
    }
  }
  return { width, height, rgba: Buffer.from(target.buffer) };
}
