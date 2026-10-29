import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExifToolService } from '../src/exiftool';
import { parseNefInfo, readLensShot, readNefInfo } from '../src/lens';
import { fixtureAvailable } from './helpers';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'raw');
const z6ii = join(FIXTURES, 'z6ii_CZP_0299.NEF');
const z30 = join(FIXTURES, 'z30_14bit.NEF');
const z50 = join(FIXTURES, 'z50_DSC_0441.NEF');

let service: ExifToolService;
beforeAll(() => {
  service = new ExifToolService();
});
afterAll(async () => {
  await service.close();
});

/** Evaluates ascending coefficients. */
const poly = (c: number[] | undefined, q: number): number =>
  (c ?? []).reduceRight((sum, k) => sum * q + k, 0);

describe.skipIf(!fixtureAvailable('z6ii_CZP_0299.NEF'))('Nikon Z built-in correction', () => {
  it('reads the camera’s correction of a lens that needs it (Z 6II, 24-200mm)', async () => {
    const shot = await readLensShot(z6ii, { width: 6048, height: 4024 }, service);
    expect(shot).toMatchObject({
      cameraModel: 'NIKON Z 6_2',
      lensModel: 'NIKKOR Z 24-200mm f/4-6.3 VR',
      focalLength: 70,
      fNumber: 6,
    });
    const builtin = shot?.builtin;
    // ExifTool's own reading of the same mode byte: "On (Required)".
    expect(builtin?.required).toBe(true);
    // The optical centre is within a few pixels of the image centre.
    expect(Math.abs(builtin?.centre.x ?? 1) * 6048).toBeLessThan(80);
    expect(Math.abs(builtin?.centre.y ?? 1) * 4024).toBeLessThan(80);
    // The farthest corner is a little over the half diagonal away from an off-centre axis.
    expect(builtin?.unit).toBeGreaterThan(1);
    expect(builtin?.unit).toBeLessThan(1.05);
    // A mild barrel/pincushion profile: the recorded radius is within 10 % of the corrected one.
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      expect(poly(builtin?.distortion, q)).toBeGreaterThan(0.9);
      expect(poly(builtin?.distortion, q)).toBeLessThan(1.1);
    }
    // Light falls off to the corners and the gain is never below 1.
    expect(poly(builtin?.vignetting, 0)).toBeCloseTo(1, 6);
    expect(poly(builtin?.vignetting, 1)).toBeGreaterThan(1.05);
    expect(poly(builtin?.vignetting, 1)).toBeLessThan(3);
    // Red and blue are within 0.5 % of green.
    for (const q of [0, 0.5, 1]) {
      expect(Math.abs(poly(builtin?.red, q) - 1)).toBeLessThan(0.005);
      expect(Math.abs(poly(builtin?.blue, q) - 1)).toBeLessThan(0.005);
    }
  });

  it('marks a lens whose correction is optional (Z 30, 40mm f/2)', async () => {
    if (!fixtureAvailable('z30_14bit.NEF')) return;
    const shot = await readLensShot(z30, { width: 5568, height: 3712 }, service);
    expect(shot?.lensModel).toBe('NIKKOR Z 40mm f/2');
    expect(shot?.builtin?.required).toBe(false);
    expect(shot?.builtin?.distortion).toBeDefined();
  });

  it('reads a DX zoom the camera must correct (Z 50, 16-50mm)', async () => {
    if (!fixtureAvailable('z50_DSC_0441.NEF')) return;
    const shot = await readLensShot(z50, { width: 5568, height: 3712 }, service);
    expect(shot?.builtin?.required).toBe(true);
    expect(shot?.focalLength35).toBeGreaterThan(shot?.focalLength ?? 99);
  });

  it('turns the centre offsets with the picture for a portrait raw', async () => {
    const blob = await readNefInfo(z6ii);
    expect(blob).toBeDefined();
    const landscape = parseNefInfo(blob!, { width: 6048, height: 4024, orientation: 1 });
    const portrait = parseNefInfo(blob!, { width: 4024, height: 6048, orientation: 6 });
    // A quarter turn swaps the axes: sensor x becomes display y, and sensor y becomes display -x.
    expect(portrait?.centre.x).toBeCloseTo(-(landscape?.centre.y ?? 0), 9);
    expect(portrait?.centre.y).toBeCloseTo(landscape?.centre.x ?? 0, 9);
    expect(Math.abs(landscape?.centre.x ?? 0)).toBeGreaterThan(0);
  });

  it('reads nothing from a file that is not a NEF', async () => {
    expect(
      await readLensShot(join(FIXTURES, 'missing.jpg'), { width: 10, height: 10 }, service),
    ).toBeUndefined();
    await expect(readNefInfo(z6ii.replace('.NEF', '.nope'))).rejects.toThrow();
  });
});
