/**
 * Every image operation the backend does itself (the export and retouch
 * packages do theirs) lives in this file, on top of the `@ee/core` native image
 * ops. sharp is not used: its libvips clashes with the glib Electron links on
 * Linux and crashes the process.
 */
import type { RenderedImage } from '@ee/contracts';
import { decodeJpeg, encodeJpeg, makePreviews, resizeRgba, type RgbaImage } from '@ee/core';
import { normalizeTurns } from '@ee/develop-gl/crop';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Longest edge of the cached preview shown in the main view. */
export const PREVIEW_MAX_EDGE = 2560;
/** Longest edge of the film strip thumbnail. */
export const THUMB_MAX_EDGE = 320;

const PREVIEW_QUALITY = 85;
const THUMB_QUALITY = 80;

/**
 * What a preview is made from: JPEG bytes in sensor orientation, or a JPEG file with its own EXIF
 * tag. `rotation` is the clockwise quarter turns the user added on top of that orientation.
 */
export type PreviewSource =
  { jpeg: Buffer; orientation: number; rotation?: number } | { file: string; rotation?: number };

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
    const file = await readFile(source.file);
    if (normalizeTurns(source.rotation ?? 0) === 0) {
      // The file's own EXIF orientation is applied by the core.
      return makePreviews(file, {
        thumbEdge: THUMB_MAX_EDGE,
        previewEdge: PREVIEW_MAX_EDGE,
        quality: PREVIEW_QUALITY,
      });
    }
    return previewsOf(await decodeJpeg(file), source.rotation);
  }
  // An embedded raw preview is in sensor orientation; the raw decoder says how to turn it,
  // so ignore any tag in the preview itself. Resizing first keeps the turn cheap.
  const stored = await decodeJpeg(source.jpeg, { skipOrientation: true });
  const fitted = await resizeRgba(stored.rgba, stored.width, stored.height, {
    maxEdge: PREVIEW_MAX_EDGE,
  });
  return previewsOf(orientRgba(fitted, source.orientation), source.rotation);
}

/** The preview and thumbnail JPEGs of upright pixels, turned by the user's rotation first. */
async function previewsOf(upright: RgbaImage, rotation?: number): Promise<PreviewJpegs> {
  const turned = turnRgba(upright, rotation);
  const fitted =
    Math.max(turned.width, turned.height) > PREVIEW_MAX_EDGE
      ? await resizeRgba(turned.rgba, turned.width, turned.height, { maxEdge: PREVIEW_MAX_EDGE })
      : turned;
  const small = await resizeRgba(fitted.rgba, fitted.width, fitted.height, {
    maxEdge: THUMB_MAX_EDGE,
  });
  const [preview, thumb] = await Promise.all([
    encode(fitted, PREVIEW_QUALITY),
    encode(small, THUMB_QUALITY),
  ]);
  return { preview, thumb };
}

const encode = (image: RenderedImage, quality: number): Promise<Buffer> =>
  encodeJpeg(image.rgba, image.width, image.height, { quality, chroma: '420', iccSrgb: true });

/**
 * Only the thumbnail, for regenerating one evicted cache file while the grid scrolls.
 * It never resizes to the 2560 px preview first, so scrolling an evicted folder stays cheap.
 */
export async function makeThumbnailJpeg(source: PreviewSource): Promise<Buffer> {
  if ('file' in source) {
    if (!JPEG_EXTENSIONS.has(extname(source.file).toLowerCase())) {
      throw new Error(`previews of ${extname(source.file) || 'this'} files are not supported`);
    }
    const decoded = turnRgba(await decodeJpeg(await readFile(source.file)), source.rotation);
    const small = await resizeRgba(decoded.rgba, decoded.width, decoded.height, {
      maxEdge: THUMB_MAX_EDGE,
    });
    return encode(small, THUMB_QUALITY);
  }
  const stored = await decodeJpeg(source.jpeg, { skipOrientation: true });
  const upright = turnRgba(orientRgba(stored, source.orientation), source.rotation);
  const small = await resizeRgba(upright.rgba, upright.width, upright.height, {
    maxEdge: THUMB_MAX_EDGE,
  });
  return encode(small, THUMB_QUALITY);
}

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

/**
 * Turn the displayed pixels by the user's rotation: clockwise quarter turns, 0..3 (negative and
 * larger counts wrap). Pixels move as whole `bytesPerPixel`-wide units, so 8-bit RGBA (4), half
 * float RGBA (8) and float RGBA (16) all use it. A quarter turn swaps width and height.
 */
export function turnPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  turns: number | undefined,
): { data: Buffer; width: number; height: number } {
  const quarter = normalizeTurns(turns ?? 0);
  if (quarter === 0) {
    return {
      data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      width,
      height,
    };
  }
  if (bytesPerPixel % 4 !== 0)
    throw new RangeError('pixels must be a whole number of 32-bit words');
  const words = bytesPerPixel / 4;
  const count = width * height * words;
  // A view over 32-bit words needs a 4-byte aligned start, which pooled buffers lack.
  const aligned =
    pixels.byteOffset % 4 === 0
      ? pixels
      : Uint8Array.from(pixels.subarray(0, width * height * bytesPerPixel));
  const source = new Uint32Array(aligned.buffer, aligned.byteOffset, count);
  const swap = quarter !== 2;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const target = new Uint32Array(count);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sx: number;
      let sy: number;
      // The EXIF definitions of 6 (right), 3 (upside down) and 8 (left).
      if (quarter === 1) [sx, sy] = [y, height - 1 - x];
      else if (quarter === 2) [sx, sy] = [width - 1 - x, height - 1 - y];
      else [sx, sy] = [width - 1 - y, x];
      const from = (sy * width + sx) * words;
      const to = (y * outWidth + x) * words;
      for (let k = 0; k < words; k++) target[to + k] = source[from + k] as number;
    }
  }
  return { data: Buffer.from(target.buffer), width: outWidth, height: outHeight };
}

/** 8-bit RGBA pixels turned by the user's rotation, see {@link turnPixels}. */
export function turnRgba(image: RgbaImage, turns: number | undefined): RgbaImage {
  if (normalizeTurns(turns ?? 0) === 0) return image;
  const turned = turnPixels(image.rgba, image.width, image.height, 4, turns);
  return { width: turned.width, height: turned.height, rgba: turned.data };
}

/**
 * The EXIF orientation (1..8) a JPEG carries, read from the APP1 segment at its start; `undefined`
 * when it has none. Only the segments before the image data are looked at.
 */
export function jpegExifOrientation(jpeg: Uint8Array): number | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Start of scan, end of image, or a standalone marker: no segment can follow that is EXIF.
    if (
      marker === 0xda ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd8)
    ) {
      return undefined;
    }
    const length = view.getUint16(at + 2);
    const start = at + 4;
    const isExif =
      marker === 0xe1 &&
      length >= 16 &&
      jpeg[start] === 0x45 && // E
      jpeg[start + 1] === 0x78 && // x
      jpeg[start + 2] === 0x69 && // i
      jpeg[start + 3] === 0x66 && // f
      jpeg[start + 4] === 0 &&
      jpeg[start + 5] === 0;
    if (isExif && start + length - 2 <= jpeg.length) {
      const tiff = start + 6;
      const little = jpeg[tiff] === 0x49;
      const u16 = (offset: number): number => view.getUint16(offset, little);
      const u32 = (offset: number): number => view.getUint32(offset, little);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > jpeg.length) return undefined;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > jpeg.length) return undefined;
        if (u16(entry) !== 0x0112) continue;
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : undefined;
      }
      return undefined;
    }
    at += 2 + length;
  }
  return undefined;
}
