import { describe, expect, it } from 'vitest';
import {
  asShotTemperatureTint,
  multipliersFromTemperatureTint,
  resolveWhiteBalance,
  temperatureTintFromMultipliers,
  temperatureTintToXY,
  xyToCameraNeutral,
  xyToTemperatureTint,
  WHITE_BALANCE_PRESETS,
  type WhiteBalanceCamera,
} from '../src/wb';

/** Nikon Z 6 colour matrix (Adobe ColorMatrix2, D65), the kind of matrix LibRaw reports as `cam_xyz`. */
export const Z6_XYZ_TO_CAMERA = [0.821, -0.2534, -0.0683, -0.5355, 1.3338, 0.2212, -0.1143, 0.193, 0.6464];

const D65_XY = { x: 0.3127, y: 0.329 };
const D50_XY = { x: 0.3457, y: 0.3585 };

/** A camera whose as-shot white balance is exactly the neutral of `temperature`/`tint`. */
export function cameraShotAt(temperature: number, tint = 0, xyzToCamera = Z6_XYZ_TO_CAMERA): WhiteBalanceCamera {
  return {
    xyzToCamera,
    asShotMultipliers: multipliersFromTemperatureTint(xyzToCamera, temperature, tint),
  };
}

describe('Robertson temperature/tint <-> xy (DNG SDK port)', () => {
  it('puts D65 near 6504 K and D50 near 5000 K, both about +10 tint like Adobe reports them', () => {
    const d65 = xyToTemperatureTint(D65_XY);
    expect(d65.temperature).toBeGreaterThan(6450);
    expect(d65.temperature).toBeLessThan(6560);
    expect(d65.tint).toBeCloseTo(9.8, 0);
    const d50 = xyToTemperatureTint(D50_XY);
    expect(d50.temperature).toBeGreaterThan(4950);
    expect(d50.temperature).toBeLessThan(5060);
    expect(d50.tint).toBeCloseTo(9.6, 0);
  });

  it('round-trips temperature/tint through xy', () => {
    for (const temperature of [2200, 2850, 3800, 5000, 5500, 6500, 7500, 10000, 20000]) {
      for (const tint of [-100, -20, 0, 10, 60, 140]) {
        const back = xyToTemperatureTint(temperatureTintToXY({ temperature, tint }));
        expect(back.temperature / temperature).toBeCloseTo(1, 3);
        expect(back.tint).toBeCloseTo(tint, 1);
      }
    }
  });

  it('moves towards green for positive tint (Adobe convention)', () => {
    const neutral = temperatureTintToXY({ temperature: 5500, tint: 0 });
    const green = temperatureTintToXY({ temperature: 5500, tint: 60 });
    expect(green.y).toBeGreaterThan(neutral.y);
  });
});

describe('white balance multipliers', () => {
  it('derives plausible as-shot values for a daylight shot', () => {
    const asShot = asShotTemperatureTint(cameraShotAt(5300, 8));
    expect(asShot.temperature).toBeCloseTo(5300, -1);
    expect(asShot.tint).toBeCloseTo(8, 0);
  });

  it('maps the D65 neutral of the camera to roughly 6500 K / tint +10', () => {
    const n = xyToCameraNeutral(Z6_XYZ_TO_CAMERA, D65_XY);
    const camera: WhiteBalanceCamera = {
      xyzToCamera: Z6_XYZ_TO_CAMERA,
      asShotMultipliers: { r: 1 / n.r, g: 1, b: 1 / n.b },
    };
    const { temperature, tint } = asShotTemperatureTint(camera);
    expect(temperature).toBeGreaterThan(6400);
    expect(temperature).toBeLessThan(6600);
    expect(tint).toBeCloseTo(9.8, 0);
    // Z 6 daylight multipliers are roughly r 2, b 1.5.
    expect(camera.asShotMultipliers.r).toBeGreaterThan(1.6);
    expect(camera.asShotMultipliers.r).toBeLessThan(2.4);
    expect(camera.asShotMultipliers.b).toBeGreaterThan(1.2);
    expect(camera.asShotMultipliers.b).toBeLessThan(1.9);
  });

  it('round-trips temperature/tint -> multipliers -> temperature/tint', () => {
    for (const temperature of [2500, 3200, 4500, 5500, 6500, 8000, 12000]) {
      for (const tint of [-60, 0, 25, 90]) {
        const m = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, temperature, tint);
        const back = temperatureTintFromMultipliers(Z6_XYZ_TO_CAMERA, m);
        expect(back.temperature / temperature).toBeCloseTo(1, 3);
        expect(back.tint).toBeCloseTo(tint, 1);
      }
    }
  });

  it('warms the image (more red gain) when the assumed illuminant gets cooler', () => {
    const tungsten = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 3000, 0);
    const daylight = multipliersFromTemperatureTint(Z6_XYZ_TO_CAMERA, 6500, 0);
    expect(tungsten.b).toBeGreaterThan(daylight.b);
    expect(tungsten.r).toBeLessThan(daylight.r);
  });

  it('uses the as-shot multipliers untouched when Temperature/Tint are absent', () => {
    const camera = cameraShotAt(5000, 5);
    const resolved = resolveWhiteBalance(camera, {});
    expect(resolved.multipliers).toEqual(camera.asShotMultipliers);
    expect(resolved.temperature).toBeCloseTo(5000, -1);
    expect(resolveWhiteBalance(camera, { WhiteBalance: 'As Shot' }).multipliers).toEqual(
      camera.asShotMultipliers,
    );
  });

  it('keeps the as-shot value of whichever of temperature/tint is absent', () => {
    const camera = cameraShotAt(5000, 20);
    const onlyTemp = resolveWhiteBalance(camera, { Temperature: 6000 });
    expect(onlyTemp.tint).toBeCloseTo(20, 0);
    expect(onlyTemp.temperature).toBe(6000);
    const onlyTint = resolveWhiteBalance(camera, { Tint: -10 });
    expect(onlyTint.temperature).toBeCloseTo(5000, -1);
    expect(onlyTint.tint).toBe(-10);
  });

  it('resolves named white balances to their fixed values unless overridden', () => {
    const camera = cameraShotAt(4300);
    for (const [mode, expected] of Object.entries(WHITE_BALANCE_PRESETS)) {
      const wb = resolveWhiteBalance(camera, { WhiteBalance: mode as keyof typeof WHITE_BALANCE_PRESETS });
      expect(wb.temperature).toBe(expected.temperature);
      expect(wb.tint).toBe(expected.tint);
    }
    expect(WHITE_BALANCE_PRESETS.Daylight).toEqual({ temperature: 5500, tint: 10 });
    const custom = resolveWhiteBalance(camera, { WhiteBalance: 'Daylight', Temperature: 4000 });
    expect(custom.temperature).toBe(4000);
    expect(custom.tint).toBe(10);
  });

  it('survives a camera without a usable matrix', () => {
    const camera: WhiteBalanceCamera = {
      xyzToCamera: new Array<number>(9).fill(0),
      asShotMultipliers: { r: 1.1, g: 1, b: 1.3 },
    };
    expect(() => resolveWhiteBalance(camera, { Temperature: 4000 })).not.toThrow();
    expect(resolveWhiteBalance(camera, {}).multipliers).toEqual(camera.asShotMultipliers);
  });
});
