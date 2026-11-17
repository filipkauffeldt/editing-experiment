import {
  composeOrientation,
  normalizeOrientation,
  turnsBetweenOrientations,
} from '@ee/develop-gl/crop';
import { getExifToolService, type ExifToolService } from './exiftool';
import {
  ensureMetadataTarget,
  fileExists,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { asNumber } from './values';

/**
 * Where Lightroom and Camera Raw keep a rotation: `tiff:Orientation` in the XMP of the photo (the
 * sidecar of a raw, the embedded XMP of a JPEG). Its value is the EXIF orientation the picture has
 * once the rotation is applied to the camera's own orientation, so a raw shot upright (1) and
 * turned right is 6, and one the camera recorded as 6 and turned right again is 3.
 */
export const XMP_ORIENTATION_TAG = 'XMP-tiff:Orientation';

/** The `tiff:Orientation` in a tag map as ExifTool returned it, 1..8, or undefined when it has none. */
export function xmpOrientationFromTags(tags: Record<string, unknown>): number | undefined {
  const value = asNumber(tags[XMP_ORIENTATION_TAG]);
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 8
    ? value
    : undefined;
}

/**
 * The clockwise quarter turns (0..3) a photo was turned by: its XMP orientation against the
 * camera's own. No XMP orientation is no turn, and neither is one that only differs by a mirror.
 */
export function rotationFromOrientations(
  cameraOrientation: number | undefined,
  xmpOrientation: number | undefined,
): number {
  if (xmpOrientation === undefined) return 0;
  return turnsBetweenOrientations(normalizeOrientation(cameraOrientation), xmpOrientation) ?? 0;
}

/** The orientation to write for a camera orientation turned `turns` quarter turns clockwise. */
export function orientationAfterTurns(
  cameraOrientation: number | undefined,
  turns: number,
): number {
  return composeOrientation(normalizeOrientation(cameraOrientation), turns);
}

/** The XMP orientation of a photo: its sidecar for a raw (none when there is no sidecar), else the file. */
export async function readXmpOrientation(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<number | undefined> {
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) return undefined;
  return xmpOrientationFromTags(await service.read(target));
}

/**
 * Write the XMP orientation of a photo, or remove it with `undefined`. A raw is never written: the
 * sidecar is, and made when it is missing. Removing from a raw with no sidecar writes nothing.
 */
export async function writeXmpOrientation(
  path: string,
  orientation: number | undefined,
  options: { service?: ExifToolService } = {},
): Promise<void> {
  const service = options.service ?? getExifToolService();
  if (orientation === undefined) {
    if (isRawPath(path) && !(await fileExists(sidecarPathFor(path)))) return;
    await service.write(await ensureMetadataTarget(path), { [XMP_ORIENTATION_TAG]: null });
    return;
  }
  // The `#` asks ExifTool for the number itself, which it will not take for a print-converted tag.
  await service.write(await ensureMetadataTarget(path), {
    [`${XMP_ORIENTATION_TAG}#`]: orientation,
  });
}
