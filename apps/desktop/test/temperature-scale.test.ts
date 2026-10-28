import { describe, expect, it } from 'vitest';
import {
  asShotTrackPosition,
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
});
