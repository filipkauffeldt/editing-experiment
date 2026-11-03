import { describe, expect, it } from 'vitest';
import {
  RELATIVE_WB_MAX,
  RELATIVE_WB_MIN,
  asShotTrackPosition,
  relativeToTemperature,
  temperatureToRelative,
  temperatureToTrack,
  trackToTemperature,
} from '../src/renderer/temperature-scale';

describe('temperature scale', () => {
  it('puts as-shot and the useful range in the middle of the track', () => {
    const asShot = asShotTrackPosition();
    expect(asShot).toBeGreaterThan(500);
    expect(asShot).toBeLessThan(750);
    expect(temperatureToTrack(10000)).toBeGreaterThan(800);
    expect(temperatureToTrack(2000)).toBe(0);
    expect(temperatureToTrack(50000)).toBe(1000);
    expect(trackToTemperature(temperatureToTrack(5200))).toBe(5200);
  });

  it('maps Lightroom’s relative scale to Kelvin, 0 at as shot', () => {
    expect(relativeToTemperature(0)).toBe(5200);
    expect(relativeToTemperature(RELATIVE_WB_MAX)).toBeGreaterThan(9000);
    expect(relativeToTemperature(RELATIVE_WB_MIN)).toBeLessThan(4000);
    expect(temperatureToRelative(5200)).toBe(0);
    expect(temperatureToRelative(relativeToTemperature(60))).toBe(60);
    expect(temperatureToRelative(relativeToTemperature(-60))).toBe(-60);
    expect(temperatureToRelative(relativeToTemperature(500))).toBe(RELATIVE_WB_MAX);
  });
});
