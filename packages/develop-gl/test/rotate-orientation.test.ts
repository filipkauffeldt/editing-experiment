import type { CropParams } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  composeOrientation,
  cropOrientedToStored,
  cropStoredToOriented,
  normalizeTurns,
  turnsBetweenOrientations,
} from '../src/crop';

describe('composeOrientation', () => {
  it('turns an upright camera frame into the orientation Lightroom writes', () => {
    expect(composeOrientation(1, 0)).toBe(1);
    expect(composeOrientation(1, 1)).toBe(6);
    expect(composeOrientation(1, 2)).toBe(3);
    expect(composeOrientation(1, 3)).toBe(8);
  });

  it('applies the turn on top of the camera orientation', () => {
    // A camera held for a portrait (6) turned right again is upside down (3), left again upright.
    expect(composeOrientation(6, 1)).toBe(3);
    expect(composeOrientation(6, 3)).toBe(1);
    expect(composeOrientation(3, 1)).toBe(8);
    expect(composeOrientation(8, 1)).toBe(1);
  });

  it('keeps a mirrored camera frame mirrored', () => {
    expect(composeOrientation(2, 0)).toBe(2);
    expect(composeOrientation(2, 1)).toBe(7);
    expect(composeOrientation(2, 2)).toBe(4);
    expect(composeOrientation(5, 1)).toBe(2);
  });

  it('wraps turns and counts a left turn as three right turns', () => {
    expect(normalizeTurns(-1)).toBe(3);
    expect(normalizeTurns(5)).toBe(1);
    expect(composeOrientation(1, -1)).toBe(8);
    expect(composeOrientation(1, 4)).toBe(1);
  });
});

describe('turnsBetweenOrientations', () => {
  it('reads a sidecar orientation back as the turns the user made', () => {
    for (const base of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const turns of [0, 1, 2, 3] as const) {
        expect(turnsBetweenOrientations(base, composeOrientation(base, turns))).toBe(turns);
      }
    }
  });

  it('has no answer when the two differ by a mirror', () => {
    expect(turnsBetweenOrientations(1, 2)).toBeUndefined();
    expect(turnsBetweenOrientations(6, 5)).toBeUndefined();
  });
});

describe('a stored crop under a new orientation', () => {
  // The sidecar keeps the crop in the sensor's pixel space, so a rotation writes no crop at all:
  // reading it back under the new orientation has to land on the same picture content.
  it('follows the picture through a right turn', () => {
    const landscape = { width: 6000, height: 4000 };
    const crop: CropParams = { left: 0.1, top: 0.2, right: 0.5, bottom: 0.9, angle: 0 };
    const stored = cropOrientedToStored(crop, landscape, 1);
    const turned = cropStoredToOriented(
      stored,
      { width: landscape.height, height: landscape.width },
      composeOrientation(1, 1),
    );
    // The right edge of the old picture is the bottom of the new one: x' = 1 - y, y' = x.
    expect(turned.left).toBeCloseTo(0.1, 9);
    expect(turned.top).toBeCloseTo(0.1, 9);
    expect(turned.right).toBeCloseTo(0.8, 9);
    expect(turned.bottom).toBeCloseTo(0.5, 9);
    expect(turned.angle).toBeCloseTo(0, 9);
  });

  it('is back where it was after a right and a left turn', () => {
    const landscape = { width: 6000, height: 4000 };
    const crop: CropParams = { left: 0.15, top: 0.05, right: 0.65, bottom: 0.95, angle: 3.5 };
    const stored = cropOrientedToStored(crop, landscape, 6);
    const there = cropStoredToOriented(stored, landscape, 6);
    expect(there.left).toBeCloseTo(crop.left, 9);
    expect(there.bottom).toBeCloseTo(crop.bottom, 9);
    expect(there.angle).toBeCloseTo(crop.angle, 9);
    const right = cropStoredToOriented(stored, landscape, composeOrientation(6, 1));
    const back = cropOrientedToStored(right, landscape, composeOrientation(6, 1));
    expect(back.left).toBeCloseTo(stored.left, 9);
    expect(back.top).toBeCloseTo(stored.top, 9);
    expect(back.right).toBeCloseTo(stored.right, 9);
    expect(back.bottom).toBeCloseTo(stored.bottom, 9);
  });
});
