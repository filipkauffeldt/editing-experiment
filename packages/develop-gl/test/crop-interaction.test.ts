import type { CropParams } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  cropAspect,
  cropCorners,
  cropFitsImage,
  cropFromGeometry,
  cropGeometry,
  cropImageToView,
  cropViewToImage,
  croppedToSourcePixels,
  drawCrop,
  isStorableCrop,
  largestCropForAspect,
  panCrop,
  pointerAngleDelta,
  quantizeAngle,
  resizeCropFromHandle,
  rotateCrop,
  shrinkCropToImage,
  storableAngleRange,
  straightenAngleFromLine,
} from '../src/crop';

const LANDSCAPE = { width: 6000, height: 4000 };
const PORTRAIT = { width: 4000, height: 6000 };
const images = [
  ['landscape', LANDSCAPE],
  ['portrait', PORTRAIT],
] as const;
const angles = [-45, -17.3, 0, 3, 45];

const center = (image: { width: number; height: number }) => ({
  x: image.width / 2,
  y: image.height / 2,
});

describe('crop view mapping', () => {
  it('puts the crop centre at the pivot and round-trips any point', () => {
    const geometry = cropGeometry(
      cropFromGeometry(2500, 1800, 2000, 1200, 12, LANDSCAPE),
      LANDSCAPE,
    );
    const pivot = { x: 900, y: 700 };
    const atCentre = cropImageToView(geometry, pivot, { x: 2500, y: 1800 });
    expect(atCentre.x).toBeCloseTo(900, 9);
    expect(atCentre.y).toBeCloseTo(700, 9);
    const back = cropViewToImage(
      geometry,
      pivot,
      cropImageToView(geometry, pivot, { x: 10, y: 4000 }),
    );
    expect(back.x).toBeCloseTo(10, 6);
    expect(back.y).toBeCloseTo(4000, 6);
  });

  it('shows the cropped output unrotated: view points map like cropped pixels', () => {
    const crop = cropFromGeometry(3100, 1900, 2400, 1500, -9, LANDSCAPE);
    const geometry = cropGeometry(crop, LANDSCAPE);
    const pivot = { x: 500, y: 300 };
    // A point 100 px right of and 40 px below the frame's top-left corner.
    const view = { x: pivot.x - geometry.width / 2 + 100, y: pivot.y - geometry.height / 2 + 40 };
    const viaView = cropViewToImage(geometry, pivot, view);
    const viaOutput = croppedToSourcePixels(crop, LANDSCAPE, { x: 100, y: 40 });
    expect(viaView.x).toBeCloseTo(viaOutput.x, 6);
    expect(viaView.y).toBeCloseTo(viaOutput.y, 6);
  });

  it('turns the image against the crop angle', () => {
    const geometry = cropGeometry(
      cropFromGeometry(3000, 2000, 2000, 1000, 10, LANDSCAPE),
      LANDSCAPE,
    );
    const pivot = { x: 0, y: 0 };
    // Image point straight right of the centre ends up above the pivot line: the
    // image is turned counter-clockwise by the (clockwise) crop angle.
    const view = cropImageToView(geometry, pivot, { x: 4000, y: 2000 });
    expect(view.y).toBeLessThan(0);
    expect(Math.atan2(view.y, view.x)).toBeCloseTo((-10 * Math.PI) / 180, 9);
  });
});

describe('pointerAngleDelta', () => {
  const pivot = { x: 100, y: 100 };
  it('is positive for a clockwise sweep on screen', () => {
    expect(pointerAngleDelta(pivot, { x: 200, y: 100 }, { x: 100, y: 200 })).toBeCloseTo(90, 9);
    expect(pointerAngleDelta(pivot, { x: 200, y: 100 }, { x: 100, y: 0 })).toBeCloseTo(-90, 9);
  });

  it('takes the short way across the +-180 degree seam', () => {
    const from = { x: 0, y: 99 };
    const to = { x: 0, y: 101 };
    const delta = pointerAngleDelta(pivot, from, to);
    expect(Math.abs(delta)).toBeLessThan(2);
    expect(delta).toBeLessThan(0);
  });

  it('is zero when the pointer does not move around the pivot', () => {
    expect(pointerAngleDelta(pivot, { x: 150, y: 100 }, { x: 300, y: 100 })).toBeCloseTo(0, 9);
  });
});

describe('quantizeAngle', () => {
  it('keeps 0.1 degree precision', () => {
    expect(quantizeAngle(3.14159)).toBe(3.1);
    expect(quantizeAngle(-3.16)).toBe(-3.2);
  });

  it('snaps to whole degrees with Shift', () => {
    expect(quantizeAngle(3.4, true)).toBe(3);
    expect(quantizeAngle(-3.6, true)).toBe(-4);
  });

  it('limits to +-45 degrees and never returns -0 or NaN', () => {
    expect(quantizeAngle(80)).toBe(45);
    expect(quantizeAngle(-80, true)).toBe(-45);
    expect(Object.is(quantizeAngle(-0.01), 0)).toBe(true);
    expect(quantizeAngle(Number.NaN)).toBe(0);
  });
});

describe('straightenAngleFromLine', () => {
  it('leaves a horizontal line alone', () => {
    expect(straightenAngleFromLine(4, { x: 0, y: 10 }, { x: 500, y: 10 })).toBe(4);
  });

  it('turns a line that runs downhill to the right clockwise', () => {
    // 100 px right, 10 px down is about 5.7 degrees clockwise on screen.
    expect(straightenAngleFromLine(0, { x: 0, y: 0 }, { x: 100, y: 10 })).toBe(5.7);
  });

  it('adds to the current angle because the line is measured on screen', () => {
    expect(straightenAngleFromLine(10, { x: 0, y: 0 }, { x: 100, y: 10 })).toBe(15.7);
  });

  it('works for a line drawn right to left', () => {
    expect(straightenAngleFromLine(0, { x: 100, y: 10 }, { x: 0, y: 0 })).toBe(5.7);
  });
});

describe.each(images)('panCrop (%s)', (_name, image) => {
  it.each(angles)('moves the image under the frame at %s degrees', (angle) => {
    const crop = cropFromGeometry(image.width / 2, image.height / 2, 800, 600, angle, image);
    const panned = panCrop(crop, image, { x: 30, y: -20 });
    const before = cropGeometry(crop, image);
    const after = cropGeometry(panned, image);
    // The image moved by (30, -20) in view units: the image point now under the
    // frame centre is the one that was at (-30, 20) from it.
    const view = cropImageToView(before, { x: 0, y: 0 }, { x: after.centerX, y: after.centerY });
    expect(view.x).toBeCloseTo(-30, 6);
    expect(view.y).toBeCloseTo(20, 6);
    expect(after.width).toBeCloseTo(before.width, 9);
    expect(after.height).toBeCloseTo(before.height, 9);
    expect(after.angle).toBe(angle);
  });

  it.each(angles)('stops at the image edge at %s degrees', (angle) => {
    const crop = largestCropForAspect(image, angle, 1);
    for (const delta of [
      { x: 1e6, y: 0 },
      { x: -1e6, y: 0 },
      { x: 0, y: 1e6 },
      { x: 0, y: -1e6 },
      { x: 1e6, y: -1e6 },
    ]) {
      const panned = panCrop(crop, image, delta);
      expect(cropFitsImage(panned, image)).toBe(true);
      expect(cropAspect(panned, image)).toBeCloseTo(1, 6);
    }
  });

  it('slides along an edge when only one axis is blocked', () => {
    const crop = cropFromGeometry(image.width / 2, image.height / 2, 800, 600, 0, image);
    const flush = panCrop(crop, image, { x: 1e6, y: 0 });
    const slid = panCrop(flush, image, { x: 1e6, y: -100 });
    expect(cropGeometry(slid, image).centerX).toBeCloseTo(cropGeometry(flush, image).centerX, 6);
    expect(cropGeometry(slid, image).centerY).toBeCloseTo(
      cropGeometry(flush, image).centerY + 100,
      6,
    );
  });
});

describe.each(images)('shrinkCropToImage and rotateCrop (%s)', (_name, image) => {
  it('leaves a crop that already fits untouched', () => {
    const crop = cropFromGeometry(image.width / 2, image.height / 2, 500, 300, 20, image);
    expect(shrinkCropToImage(crop, image)).toBe(crop);
  });

  it.each(angles)('matches the largest centred crop at %s degrees', (angle) => {
    const full: CropParams = { left: 0, top: 0, right: 1, bottom: 1, angle: 0 };
    const rotated = rotateCrop(full, image, angle);
    // The full frame's shape limits how far it can tilt and still be saved.
    const range = storableAngleRange(image.width, image.height);
    const reached = Math.min(range.max, Math.max(range.min, quantizeAngle(angle)));
    const expected = largestCropForAspect(image, reached, image.width / image.height);
    const got = cropGeometry(rotated, image);
    const want = cropGeometry(expected, image);
    expect(got.width).toBeCloseTo(want.width, 3);
    expect(got.height).toBeCloseTo(want.height, 3);
    expect(got.centerX).toBeCloseTo(image.width / 2, 6);
    expect(got.angle).toBe(reached);
    expect(cropFitsImage(rotated, image)).toBe(true);
  });

  it.each(angles)('keeps the frame centre and aspect when off-centre at %s degrees', (angle) => {
    const crop = cropFromGeometry(image.width * 0.3, image.height * 0.6, 900, 600, 0, image);
    const rotated = rotateCrop(crop, image, angle);
    const before = cropGeometry(crop, image);
    const after = cropGeometry(rotated, image);
    expect(after.centerX).toBeCloseTo(before.centerX, 6);
    expect(after.centerY).toBeCloseTo(before.centerY, 6);
    expect(after.width / after.height).toBeCloseTo(1.5, 6);
    expect(cropFitsImage(rotated, image)).toBe(true);
  });

  it('restores the wanted size when the angle comes back', () => {
    const wanted = { width: image.width * 0.9, height: image.height * 0.9 };
    const crop = cropFromGeometry(
      image.width / 2,
      image.height / 2,
      wanted.width,
      wanted.height,
      0,
      image,
    );
    const tilted = rotateCrop(crop, image, 30, wanted);
    expect(cropGeometry(tilted, image).width).toBeLessThan(wanted.width);
    const back = cropGeometry(rotateCrop(tilted, image, 0, wanted), image);
    expect(back.width).toBeCloseTo(wanted.width, 6);
    expect(back.height).toBeCloseTo(wanted.height, 6);
  });

  it('clamps to +-45 degrees and 0.1 precision', () => {
    const crop = largestCropForAspect(image, 0, 1);
    // A square frame is the one shape that reaches (almost) +-45 either way.
    expect(rotateCrop(crop, image, 99).angle).toBe(44.9);
    expect(rotateCrop(crop, image, -99).angle).toBe(-44.9);
    expect(rotateCrop(crop, image, 2.04).angle).toBe(2);
  });
});

describe.each(images)('resizeCropFromHandle options (%s)', (_name, image) => {
  const start = (angle: number) =>
    cropFromGeometry(
      image.width / 2,
      image.height / 2,
      image.width * 0.4,
      image.height * 0.3,
      angle,
      image,
    );
  const cornersOf = (crop: CropParams) => cropCorners(crop, image);

  it.each([0, 10, -45, 45])('Alt resizes about the centre at %s degrees', (angle) => {
    const crop = start(angle);
    const before = cropGeometry(crop, image);
    const corner = cornersOf(crop)[2]!;
    const out = resizeCropFromHandle(
      crop,
      image,
      'se',
      {
        x: corner.x + 60 * Math.cos((angle * Math.PI) / 180),
        y: corner.y + 60 * Math.sin((angle * Math.PI) / 180),
      },
      undefined,
      true,
    );
    const after = cropGeometry(out, image);
    expect(after.centerX).toBeCloseTo(before.centerX, 6);
    expect(after.centerY).toBeCloseTo(before.centerY, 6);
    expect(after.width).toBeCloseTo(before.width + 120, 5);
    expect(after.height).toBeCloseTo(before.height, 5);
  });

  it('shrinks symmetrically on an edge handle', () => {
    const crop = start(0);
    const before = cropGeometry(crop, image);
    const out = resizeCropFromHandle(
      crop,
      image,
      'w',
      { x: before.centerX - before.width / 2 + 100, y: before.centerY },
      undefined,
      true,
    );
    const after = cropGeometry(out, image);
    expect(after.width).toBeCloseTo(before.width - 200, 6);
    expect(after.centerX).toBeCloseTo(before.centerX, 6);
  });

  it.each([0, 20, -45, 45])('keeps a 1:1 lock square on a corner at %s degrees', (angle) => {
    const crop = largestCropForAspect(image, angle, 1);
    const smaller = resizeCropFromHandle(crop, image, 'nw', cornersOf(crop)[2]!, 1);
    // Dragging the corner far inside shrinks to the minimum, still square.
    expect(cropAspect(smaller, image)).toBeCloseTo(1, 6);
    const middle = cropGeometry(crop, image);
    const target = cropViewToImage(
      middle,
      { x: 0, y: 0 },
      { x: -middle.width * 0.1, y: -middle.height * 0.3 },
    );
    const out = resizeCropFromHandle(crop, image, 'nw', target, 1);
    expect(cropAspect(out, image)).toBeCloseTo(1, 6);
    // The opposite (south-east) corner is the anchor.
    expect(cornersOf(out)[2]!.x).toBeCloseTo(cornersOf(crop)[2]!.x, 5);
    expect(cornersOf(out)[2]!.y).toBeCloseTo(cornersOf(crop)[2]!.y, 5);
  });

  it('lets a locked corner reach the pointer on the longer axis', () => {
    const crop = cropFromGeometry(2000, 2000, 1000, 1000, 0, image);
    // Pointer far to the right but only slightly lower: width wins.
    const wide = resizeCropFromHandle(crop, image, 'se', { x: 2900, y: 2550 }, 1);
    expect(cropGeometry(wide, image).width).toBeCloseTo(1400, 5);
    // Pointer far below but only slightly right: height wins.
    const tall = resizeCropFromHandle(crop, image, 'se', { x: 2550, y: 2900 }, 1);
    expect(cropGeometry(tall, image).height).toBeCloseTo(1400, 5);
  });

  it('resizes an edge with a lock about the other axis centre', () => {
    const crop = cropFromGeometry(2000, 2000, 1200, 800, 0, image);
    const out = resizeCropFromHandle(crop, image, 'e', { x: 2900, y: 2000 }, 1.5);
    const after = cropGeometry(out, image);
    expect(after.width).toBeCloseTo(2900 - 1400, 3);
    expect(after.width / after.height).toBeCloseTo(1.5, 6);
    expect(after.centerY).toBeCloseTo(2000, 6);
    expect(after.centerX - after.width / 2).toBeCloseTo(1400, 6);
  });

  it('never leaves the image while locked and symmetric', () => {
    for (const angle of [0, 45, -45]) {
      const crop = largestCropForAspect(image, angle, 16 / 9);
      const out = resizeCropFromHandle(
        crop,
        image,
        'ne',
        { x: image.width * 2, y: -image.height },
        16 / 9,
        true,
      );
      expect(cropFitsImage(out, image)).toBe(true);
    }
  });
});

describe.each(images)('drawCrop (%s)', (_name, image) => {
  const pivot = center(image);
  const upright = cropFromGeometry(
    image.width / 2,
    image.height / 2,
    image.width,
    image.height,
    0,
    image,
  );

  it('draws an axis-aligned frame between the two view points', () => {
    const drawn = drawCrop(upright, image, pivot, { x: 1000, y: 1200 }, { x: 2000, y: 1800 });
    if (!drawn) throw new Error('no crop');
    const geometry = cropGeometry(drawn.crop, image);
    expect(geometry.width).toBeCloseTo(1000, 6);
    expect(geometry.height).toBeCloseTo(600, 6);
    expect(geometry.centerX).toBeCloseTo(1500, 6);
    expect(geometry.centerY).toBeCloseTo(1500, 6);
    expect(drawn.pivot).toEqual({ x: 1500, y: 1500 });
  });

  it('draws in any direction from the anchor', () => {
    const drawn = drawCrop(upright, image, pivot, { x: 2000, y: 1800 }, { x: 1000, y: 1200 });
    const geometry = cropGeometry(drawn!.crop, image);
    expect(geometry.centerX).toBeCloseTo(1500, 6);
    expect(geometry.centerY).toBeCloseTo(1500, 6);
  });

  it('locks the aspect and draws about the anchor with Alt', () => {
    const locked = drawCrop(upright, image, pivot, { x: 1000, y: 1000 }, { x: 1600, y: 1100 }, 1);
    expect(cropAspect(locked!.crop, image)).toBeCloseTo(1, 9);
    expect(cropGeometry(locked!.crop, image).width).toBeCloseTo(600, 6);
    const symmetric = drawCrop(
      upright,
      image,
      pivot,
      { x: 2000, y: 2000 },
      { x: 2300, y: 2200 },
      undefined,
      true,
    );
    const geometry = cropGeometry(symmetric!.crop, image);
    expect(geometry.centerX).toBeCloseTo(2000, 6);
    expect(geometry.width).toBeCloseTo(600, 6);
    expect(geometry.height).toBeCloseTo(400, 6);
  });

  it.each([-45, -8, 20, 45])('keeps the angle and fits the image at %s degrees', (angle) => {
    const crop = largestCropForAspect(image, angle, 1);
    const geometry = cropGeometry(crop, image);
    const anchor = { x: pivot.x - 100, y: pivot.y - 100 };
    const drawn = drawCrop(crop, image, { x: pivot.x, y: pivot.y }, anchor, {
      x: pivot.x + 1e5,
      y: pivot.y + 1e5,
    });
    if (!drawn) throw new Error('no crop');
    expect(drawn.crop.angle).toBe(angle);
    expect(cropFitsImage(drawn.crop, image)).toBe(true);
    // The drawn frame is axis-aligned in view space: its view corners form the rectangle.
    const next = cropGeometry(drawn.crop, image);
    const corner = cropCorners(drawn.crop, image)[0]!;
    const view = cropImageToView(next, drawn.pivot, corner);
    expect(view.x).toBeCloseTo(drawn.pivot.x - next.width / 2, 6);
    expect(view.y).toBeCloseTo(drawn.pivot.y - next.height / 2, 6);
    // A frame drawn from the same anchor in the same view stays on that anchor.
    const topLeft = cropImageToView(
      geometry,
      pivot,
      cropViewToImage(next, drawn.pivot, {
        x: drawn.pivot.x - next.width / 2,
        y: drawn.pivot.y - next.height / 2,
      }),
    );
    expect(topLeft.x).toBeCloseTo(anchor.x, 3);
    expect(topLeft.y).toBeCloseTo(anchor.y, 3);
  });

  it('does not start on the empty corner of a rotated image', () => {
    const crop = largestCropForAspect(image, 30, undefined);
    const geometry = cropGeometry(crop, image);
    // The view position of an image corner's outside: beyond the rotated image.
    const outside = cropImageToView(geometry, pivot, { x: -50, y: -50 });
    expect(
      drawCrop(crop, image, pivot, outside, { x: outside.x + 400, y: outside.y + 400 }),
    ).toBeUndefined();
  });
});

describe('storable angles', () => {
  it('limits a wide frame counter-clockwise and a tall one clockwise', () => {
    // atan(2/3) = 33.69 degrees.
    expect(storableAngleRange(3000, 2000)).toEqual({ min: -33.6, max: 45 });
    expect(storableAngleRange(2000, 3000)).toEqual({ min: -45, max: 33.6 });
  });

  it('keeps a square frame just inside +-45', () => {
    expect(storableAngleRange(1000, 1000)).toEqual({ min: -44.9, max: 44.9 });
  });

  it('matches what the stored corners can express', () => {
    for (const [width, height] of [
      [3000, 2000],
      [2000, 3000],
      [1000, 1000],
      [1600, 900],
      [900, 1600],
    ] as const) {
      const range = storableAngleRange(width, height);
      for (const angle of [range.min, range.max, 0]) {
        const crop = cropFromGeometry(3000, 3000, width, height, angle, {
          width: 6000,
          height: 6000,
        });
        expect(isStorableCrop(crop), `${width}x${height} at ${angle}`).toBe(true);
      }
      for (const angle of [range.min - 0.2, range.max + 0.2]) {
        if (Math.abs(angle) > 45) continue;
        const crop = cropFromGeometry(3000, 3000, width, height, angle, {
          width: 6000,
          height: 6000,
        });
        expect(isStorableCrop(crop), `${width}x${height} at ${angle}`).toBe(false);
      }
    }
  });

  it.each(images)('rotateCrop never produces a crop that cannot be saved (%s)', (_name, image) => {
    for (const aspect of [3 / 2, 2 / 3, 1, 16 / 9, 4 / 5]) {
      for (const angle of [-45, -40, -33, 0, 33, 40, 45]) {
        const crop = rotateCrop(
          largestCropForAspect(image, 0, aspect),
          image,
          angle,
          cropGeometry(largestCropForAspect(image, 0, aspect), image),
        );
        expect(isStorableCrop(crop), `aspect ${aspect} at ${angle}`).toBe(true);
        expect(cropFitsImage(crop, image)).toBe(true);
      }
    }
  });
});
