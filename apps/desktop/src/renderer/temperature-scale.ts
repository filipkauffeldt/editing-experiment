/**
 * Lightroom-style white balance scale. The track is linear in mired
 * (1e6 / Kelvin), not Kelvin, so the useful 2 000–10 000 K range gets most of
 * the width while 10 000–50 000 K is compressed at the right end.
 */
export const AS_SHOT_TEMPERATURE = 5200;

const MIN_MIRED = 20; // 50 000 K
const MAX_MIRED = 500; // 2 000 K
const TRACK_STEPS = 1000;

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
