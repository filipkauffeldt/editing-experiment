/**
 * Every image operation the backend does itself (as opposed to the export and
 * retouch packages) lives in this file, and it is the only place that imports
 * sharp. sharp's libvips clashes with the glib that Electron links on Linux
 * (see the PR notes), so the plan is to replace this file's internals with the
 * `@ee/core` image ops; callers only see the functions below.
 */
import sharp, { type Sharp } from 'sharp';

/** Longest edge of the cached preview shown in the main view. */
export const PREVIEW_MAX_EDGE = 2560;
/** Longest edge of the film strip thumbnail. */
export const THUMB_MAX_EDGE = 320;

const PREVIEW_QUALITY = 85;
const THUMB_QUALITY = 80;

/** What a preview is made from: JPEG bytes in sensor orientation, or an image file with its own EXIF tag. */
export type PreviewSource = { jpeg: Buffer; orientation: number } | { file: string };

export interface PreviewJpegs {
  /** At most {@link PREVIEW_MAX_EDGE} px on the long edge, upright, no metadata. */
  preview: Buffer;
  /** At most {@link THUMB_MAX_EDGE} px on the long edge, upright, no metadata. */
  thumb: Buffer;
}

/** Upright preview and thumbnail JPEGs for a photo. Never upscales. */
export async function makePreviewJpegs(source: PreviewSource): Promise<PreviewJpegs> {
  const input =
    'file' in source
      ? sharp(source.file, { failOn: 'none' }).rotate()
      : applyOrientation(sharp(source.jpeg, { failOn: 'none' }), source.orientation);
  // sharp drops metadata unless asked to keep it, so the results carry none.
  const preview = await input
    .resize({
      width: PREVIEW_MAX_EDGE,
      height: PREVIEW_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: PREVIEW_QUALITY })
    .toBuffer();
  const thumb = await sharp(preview)
    .resize({
      width: THUMB_MAX_EDGE,
      height: THUMB_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();
  return { preview, thumb };
}

/** Upright 8-bit sRGB RGBA pixels of a JPEG stored in sensor orientation. */
export async function decodeOrientedRgba(
  jpeg: Buffer,
  orientation: number,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const { data, info } = await applyOrientation(sharp(jpeg, { failOn: 'none' }), orientation)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Pixel size of an image file as displayed (EXIF orientation applied). */
export async function readImageSize(path: string): Promise<{ width?: number; height?: number }> {
  const meta = await sharp(path, { failOn: 'none' }).metadata();
  const swap = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  const [width, height] = swap ? [meta.height, meta.width] : [meta.width, meta.height];
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/**
 * Apply an EXIF orientation (1..8) to a sharp pipeline. Embedded raw previews
 * are stored in sensor orientation and carry no tag we can rely on, so the
 * orientation reported by the raw decoder is applied explicitly.
 *
 * The transposed cases (5, 7) are a rotation plus a mirror; sharp always rotates
 * before it mirrors, hence "rotate, then flop". The unit test checks all eight
 * against sharp's own EXIF auto-orient.
 */
export function applyOrientation(image: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return image.flop();
    case 3:
      return image.rotate(180);
    case 4:
      return image.flip();
    case 5:
      return image.rotate(270).flop();
    case 6:
      return image.rotate(90);
    case 7:
      return image.rotate(90).flop();
    case 8:
      return image.rotate(270);
    default:
      return image;
  }
}
