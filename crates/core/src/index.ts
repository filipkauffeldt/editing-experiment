import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { LinearImageHeader } from '@ee/contracts';
import type * as Native from '../index.cjs';

/** Shape of the compiled addon, taken from the napi-generated declarations (`index.d.cts`). */
export type NativeBinding = typeof Native;

export type { RawInfo, RawPreview } from '../index.cjs';

let cached: NativeBinding | undefined;

/**
 * Load the compiled addon (once).
 *
 * The addon path is derived from this package's location via module resolution
 * rather than from `import.meta.url`, so it keeps working when this file is
 * bundled into another output directory (electron-vite bundles it into the
 * utility process bundle).
 *
 * @throws if the addon has not been built for this platform (`pnpm build:native`).
 */
export function loadCore(): NativeBinding {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve('@ee/core/package.json'));
  try {
    cached = require(join(packageDir, 'index.cjs')) as NativeBinding;
  } catch (cause) {
    throw new Error(
      'Failed to load the native core addon. Build it with `pnpm build:native` (needs Rust).',
      { cause },
    );
  }
  return cached;
}

/** Version of the native core, so callers can tell which binary was loaded. */
export function coreVersion(): string {
  return loadCore().coreVersion();
}

/**
 * Camera, exposure and geometry metadata. `captureTime` is the camera's local
 * wall-clock time (`YYYY-MM-DDTHH:MM:SS`, no zone: EXIF has none).
 *
 * The work runs on the libuv threadpool; the promise rejects with a descriptive
 * `Error` if the file is missing, unreadable or not a supported raw.
 */
export function readRawInfo(path: string): Promise<Native.RawInfo> {
  return loadCore().readRawInfo(path);
}

/**
 * The largest embedded preview as a complete JPEG (bitmap previews are encoded
 * to JPEG). Embedded previews are stored in sensor orientation: apply `orientation`
 * (EXIF 1..8) for display.
 */
export function extractPreview(path: string): Promise<Native.RawPreview> {
  return loadCore().extractPreview(path);
}

export interface DecodeLinearOptions {
  /** Longest edge of the result in pixels. Never upscales. Default: full size. */
  maxEdge?: number;
  /** Default `'f16'`. */
  sampleType?: 'f16' | 'f32';
}

/** A decoded image: `data` is `width * height * 4` RGBA samples as described by `header`. */
export interface LinearImage {
  header: LinearImageHeader;
  data: Buffer;
}

/**
 * Decodes a raw to demosaiced linear camera RGB (unity white balance, black
 * level subtracted, white level = 1.0), rotated to display orientation. See
 * {@link LinearImageHeader} for the exact format.
 */
export async function decodeLinear(
  path: string,
  options: DecodeLinearOptions = {},
): Promise<LinearImage> {
  const { header, data } = await loadCore().decodeLinear(path, options);
  const { sampleType } = header;
  if (sampleType !== 'f16' && sampleType !== 'f32') {
    throw new Error(`native core returned unknown sample type '${sampleType}'`);
  }
  return { header: { ...header, sampleType }, data };
}

/** 8-bit RGBA pixels, row-major, straight alpha: `rgba` is `width * height * 4` bytes. */
export type RgbaImage = Native.NativeRgbaImage;

export interface DecodeJpegOptions {
  /** Return the pixels as stored instead of applying the EXIF orientation. Default false. */
  skipOrientation?: boolean;
}

/**
 * Decodes a JPEG to RGBA. The EXIF orientation is applied, so the result is
 * upright (width and height swap for orientations 5..8) unless `skipOrientation`
 * is set. Grayscale and YCbCr JPEGs are supported, CMYK is not.
 */
export function decodeJpeg(jpeg: Uint8Array, options: DecodeJpegOptions = {}): Promise<RgbaImage> {
  return loadCore().decodeJpeg(jpeg, options);
}

export interface ResizeRgbaOptions {
  /** Longest edge of the result in pixels. Never upscales. */
  maxEdge: number;
}

/**
 * Downscales RGBA pixels with Lanczos3 so the longest edge is at most `maxEdge`,
 * keeping the aspect ratio (the shorter edge is rounded, minimum 1). An image
 * that already fits is returned unchanged.
 *
 * Resampling works on the sRGB-encoded values directly, not in linear light:
 * that is what browsers and most photo tools do for previews and exports, and
 * it is about twice as fast.
 */
export function resizeRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: ResizeRgbaOptions,
): Promise<RgbaImage> {
  return loadCore().resizeRgba(rgba, width, height, options);
}
