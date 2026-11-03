import type { EditParams } from '@ee/contracts';
import { resolveWhiteBalance, type ColorModel, type WhiteBalanceCamera } from '@ee/develop-gl';
import { AS_SHOT_TEMPERATURE, temperatureToRelative } from './temperature-scale';

/** What the Temperature and Tint sliders show for one photo. */
export interface WhiteBalanceDisplay {
  temperature: number;
  tint: number;
  /** Lightroom's ±100 scale, for files with no sensor white balance (JPEG/TIFF). */
  relative: boolean;
  /** The camera header has arrived, so these are the photo's real values. */
  known: boolean;
  /** Neither slider is set: the photo renders with its as-shot white balance. */
  asShot: boolean;
}

type WhiteBalanceParams = Pick<EditParams, 'WhiteBalance' | 'Temperature' | 'Tint'>;

/**
 * Headers for JPEG/TIFF serve pixels as linear sRGB with unity multipliers; raws carry the
 * camera's own as-shot gains. Unity means there is no sensor white balance to show.
 */
export function hasRawWhiteBalance(camera: WhiteBalanceCamera): boolean {
  const { r, g, b } = camera.asShotMultipliers;
  return r > 0 && g > 0 && b > 0 && (r !== 1 || g !== 1 || b !== 1);
}

/**
 * The numbers the white balance sliders draw. Raws use the same conversion as the develop
 * pipeline (`resolveWhiteBalance`), so As Shot shows exactly what the render uses. Files without
 * raw multipliers get Lightroom's relative scale, 0 at as shot.
 */
export function whiteBalanceDisplay(
  camera: WhiteBalanceCamera | undefined,
  params: WhiteBalanceParams,
  model?: ColorModel,
): WhiteBalanceDisplay {
  const asShot =
    params.Temperature === undefined &&
    params.Tint === undefined &&
    (params.WhiteBalance === undefined || params.WhiteBalance === 'As Shot');

  if (camera && hasRawWhiteBalance(camera)) {
    const resolved = resolveWhiteBalance(camera, params, model);
    return {
      temperature: Math.round(resolved.temperature),
      tint: Math.round(resolved.tint),
      relative: false,
      known: true,
      asShot,
    };
  }
  if (camera) {
    return {
      temperature: params.Temperature === undefined ? 0 : temperatureToRelative(params.Temperature),
      tint: params.Tint ?? 0,
      relative: true,
      known: true,
      asShot,
    };
  }
  // The header is still loading: show the sliders' start values rather than an empty field.
  return {
    temperature: params.Temperature ?? AS_SHOT_TEMPERATURE,
    tint: params.Tint ?? 0,
    relative: false,
    known: false,
    asShot,
  };
}
