import type { FaceDetection, Rect } from '@ee/contracts';
import sharp from 'sharp';
import { detectFaces, type DetectFacesOptions } from './detect';

export interface DecodedImage {
  /** RGBA, 4 bytes per pixel, EXIF orientation applied. */
  rgba: Uint8Array;
  width: number;
  height: number;
}

/** Decode a JPEG/TIFF/PNG into upright RGBA using sharp. */
export async function decodeImageFile(path: string): Promise<DecodedImage> {
  const { data, info } = await sharp(path, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`decodeImageFile: expected 4 channels, got ${info.channels}`);
  }
  return {
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Convenience wrapper for files; raw decoding is the caller's job. */
export async function detectFacesInFile(
  path: string,
  region?: Rect,
  options: DetectFacesOptions = {},
): Promise<FaceDetection[]> {
  const image = await decodeImageFile(path);
  return detectFaces(image.rgba, image.width, image.height, region, options);
}
