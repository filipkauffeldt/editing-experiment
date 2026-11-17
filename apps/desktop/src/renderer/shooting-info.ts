import type { Photo } from '@ee/contracts';

/** An exposure time as "1/2000s", "1/2s" or "2.0s"; nothing for a time the camera did not record. */
export function shutterLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

/**
 * The shooting information as one line: ISO, focal length, aperture and shutter, then the camera
 * body when asked for. A field the photo lacks is left out, and a photo with none of them has no
 * line at all.
 */
export function shootingInfoLine(
  photo: Photo | undefined,
  options: { cameraBody?: boolean } = {},
): string | undefined {
  const camera = photo?.camera;
  if (!camera) return undefined;
  const parts = [
    camera.iso === undefined ? undefined : `ISO ${Math.round(camera.iso)}`,
    camera.focalLength === undefined ? undefined : `${Math.round(camera.focalLength)}mm`,
    camera.aperture === undefined ? undefined : `f/${camera.aperture.toFixed(1)}`,
    shutterLabel(camera.shutter),
    options.cameraBody && camera.model ? camera.model : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
