/**
 * Lightroom-style white balance scale. The track is linear in mired
 * (1e6 / Kelvin), not Kelvin, so the useful 2 000–10 000 K range gets most of
 * the width while 10 000–50 000 K is compressed at the right end.
 */
export const AS_SHOT_TEMPERATURE = 5200;
/** Lightroom's relative temperature/tint scale for files with no raw multipliers. */
export const RELATIVE_WB_MIN = -100;
export const RELATIVE_WB_MAX = 100;

const MIN_MIRED = 20; // 50 000 K
const MAX_MIRED = 500; // 2 000 K
const TRACK_STEPS = 1000;
/** One relative unit is one mired, so +100 is about as warm as Lightroom's JPEG scale. */
const TRACK_PER_RELATIVE = TRACK_STEPS / (MAX_MIRED - MIN_MIRED);

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Kelvin → slider position, 0 (2 000 K) .. 1000 (50 000 K). */
export function temperatureToTrack(kelvin: number): number {
  const mired = clamp(1_000_000 / kelvin, MIN_MIRED, MAX_MIRED);
  return Math.round(((MAX_MIRED - mired) / (MAX_MIRED - MIN_MIRED)) * TRACK_STEPS);
}

/** Slider position → Kelvin, clamped to the contract's 2 000..50 000 K. */
export function trackToTemperature(position: number): number {
  const ratio = clamp(position, 0, TRACK_STEPS) / TRACK_STEPS;
  const mired = MAX_MIRED - ratio * (MAX_MIRED - MIN_MIRED);
  return Math.round(1_000_000 / mired);
}

/** Track position used when the develop params do not set a temperature. */
export function asShotTrackPosition(): number {
  return temperatureToTrack(AS_SHOT_TEMPERATURE);
}

/** Lightroom's relative temperature (0 at as shot) to the Kelvin value the pipeline stores. */
export function relativeToTemperature(relative: number): number {
  const track =
    asShotTrackPosition() + clamp(relative, RELATIVE_WB_MIN, RELATIVE_WB_MAX) * TRACK_PER_RELATIVE;
  return trackToTemperature(track);
}

/** Kelvin back to Lightroom's relative temperature scale. */
export function temperatureToRelative(kelvin: number): number {
  const relative = (temperatureToTrack(kelvin) - asShotTrackPosition()) / TRACK_PER_RELATIVE;
  return Math.round(clamp(relative, RELATIVE_WB_MIN, RELATIVE_WB_MAX));
}
