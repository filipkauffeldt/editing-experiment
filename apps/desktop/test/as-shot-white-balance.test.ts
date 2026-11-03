// @vitest-environment node
import { decodeLinear } from '@ee/core';
import {
  asShotTemperatureTint,
  resolveUniforms,
  resolveWhiteBalance,
  type WhiteBalanceCamera,
} from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { whiteBalanceDisplay } from '../src/renderer/white-balance-display';
import { relativeToTemperature, temperatureToRelative } from '../src/renderer/temperature-scale';
import { fixtureNefs } from './helpers/fixtures';

const nef = fixtureNefs()[0];

describe.skipIf(nef === undefined)('as-shot white balance of a real raw', () => {
  it('derives a plausible temperature and tint from the camera multipliers', async () => {
    const { header } = await decodeLinear(nef!, { maxEdge: 256, sampleType: 'f16' });
    const asShot = resolveWhiteBalance(header, {});
    expect(asShot.multipliers).toEqual(header.asShotMultipliers);
    expect(asShot.temperature).toBeGreaterThan(3500);
    expect(asShot.temperature).toBeLessThan(8000);
    expect(Math.abs(asShot.tint)).toBeLessThan(80);
  });

  it('shows exactly the numbers the develop pipeline draws with As Shot', async () => {
    const { header } = await decodeLinear(nef!, { maxEdge: 256, sampleType: 'f16' });
    const display = whiteBalanceDisplay(header, {});
    const pipeline = resolveUniforms(header, {}).whiteBalance;
    const asShot = asShotTemperatureTint(header);
    expect(display).toMatchObject({ relative: false, known: true, asShot: true });
    expect(display.temperature).toBe(Math.round(pipeline.temperature));
    expect(display.tint).toBe(Math.round(pipeline.tint));
    expect({ temperature: display.temperature, tint: display.tint }).toEqual({
      temperature: Math.round(asShot.temperature),
      tint: Math.round(asShot.tint),
    });
  });
});

describe('white balance display without raw multipliers', () => {
  const jpeg: WhiteBalanceCamera = {
    asShotMultipliers: { r: 1, g: 1, b: 1 },
    xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };

  it('uses Lightroom’s relative scale, 0 at as shot', () => {
    expect(whiteBalanceDisplay(jpeg, {})).toMatchObject({
      temperature: 0,
      tint: 0,
      relative: true,
      known: true,
      asShot: true,
    });
  });

  it('converts a stored Kelvin value back to the relative scale', () => {
    expect(whiteBalanceDisplay(jpeg, { Temperature: 6500, Tint: 12 })).toMatchObject({
      temperature: temperatureToRelative(6500),
      tint: 12,
      relative: true,
      asShot: false,
    });
    expect(relativeToTemperature(temperatureToRelative(6500))).toBeGreaterThan(6300);
    expect(relativeToTemperature(temperatureToRelative(6500))).toBeLessThan(6700);
  });
});
