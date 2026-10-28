import { readFile } from 'node:fs/promises';
import { decodeJpeg } from '@ee/core';
import type { FaceDetection, Rect } from '@ee/contracts';
import { detectFaces, type DetectFacesOptions } from './detect';

export interface DecodedImage {
  /** RGBA, 4 bytes per pixel, EXIF orientation applied. */
  rgba: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decode a JPEG into upright RGBA with the native core.
 *
 * JPEG only: TIFF and PNG are not supported since sharp, which decoded them,
 * cannot run inside Electron. Raws go through `@ee/core` `extractPreview`.
 */
export async function decodeImageFile(path: string): Promise<DecodedImage> {
  const { rgba, width, height } = await decodeJpeg(await readFile(path));
  return { rgba, width, height };
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
