import type { CropParams } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  constrainCrop,
  cropAspect,
  cropCorners,
  cropDevelopedRgba,
  cropFromGeometry,
  cropGeometry,
  cropOutputPixels,
  cropOutputSize,
  croppedToSource,
  croppedToSourcePixels,
  isFullCrop,
  largestCropForAspect,
  resizeCropFromHandle,
  sanitizeCrop,
  sourceToCropped,
  sourceToCroppedPixels,
} from '../src/crop';

const IMAGE = { width: 6000, height: 4000 };
const full: CropParams = { left: 0, top: 0, right: 1, bottom: 1, angle: 0 };

describe('crop geometry', () => {
  it('is the identity for the full image', () => {
    expect(cropGeometry(full, IMAGE)).toMatchObject({
      centerX: 3000,
      centerY: 2000,
      width: 6000,
      height: 4000,
      angle: 0,
    });
    expect(cropOutputSize(full, IMAGE)).toEqual({ width: 6000, height: 4000 });
    expect(isFullCrop(full)).toBe(true);
  });

  it('round-trips the stored corners for any angle', () => {
    const geometry = {
      centerX: 2850,
      centerY: 1900,
      width: 3200,
      height: 2400,
      angle: 7.5,
    };
    const crop = cropFromGeometry(
      geometry.centerX,
      geometry.centerY,
      geometry.width,
      geometry.height,
      geometry.angle,
      IMAGE,
    );
    const back = cropGeometry(crop, IMAGE);
    expect(back.centerX).toBeCloseTo(geometry.centerX, 6);
    expect(back.centerY).toBeCloseTo(geometry.centerY, 6);
    expect(back.width).toBeCloseTo(geometry.width, 6);
    expect(back.height).toBeCloseTo(geometry.height, 6);
    expect(back.angle).toBe(geometry.angle);
  });

  it('reports a 1:1 crop as square after a 3 degree straighten', () => {
    const crop = largestCropForAspect(IMAGE, 3, 1);
    const output = cropOutputSize(crop, IMAGE);
    expect(output.width).toBeCloseTo(output.height, 6);
    expect(cropAspect(crop, IMAGE)).toBeCloseTo(1, 6);
  });

  it('maps points between cropped and uncropped coordinates and back', () => {
    const crop: CropParams = { left: 0.1, top: 0.2, right: 0.85, bottom: 0.9, angle: -5 };
    const output = cropOutputSize(crop, IMAGE);
    for (const point of [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.8 },
    ]) {
      const source = croppedToSource(crop, IMAGE, point);
      const back = sourceToCropped(crop, IMAGE, source);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
    const centre = croppedToSourcePixels(crop, IMAGE, {
      x: output.width / 2,
      y: output.height / 2,
    });
    expect(centre.x).toBeCloseTo(cropGeometry(crop, IMAGE).centerX, 6);
    expect(centre.y).toBeCloseTo(cropGeometry(crop, IMAGE).centerY, 6);
    const pixel = sourceToCroppedPixels(crop, IMAGE, centre);
    expect(pixel.x).toBeCloseTo(output.width / 2, 6);
    expect(pixel.y).toBeCloseTo(output.height / 2, 6);
  });

  it('keeps every corner inside the image for a constrained crop', () => {
    const crop: CropParams = { left: -0.1, top: -0.2, right: 1.1, bottom: 1.2, angle: 20 };
    const constrained = constrainCrop(crop, IMAGE);
    for (const corner of cropCorners(constrained, IMAGE)) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-9);
      expect(corner.x).toBeLessThanOrEqual(IMAGE.width + 1e-9);
      expect(corner.y).toBeGreaterThanOrEqual(-1e-9);
      expect(corner.y).toBeLessThanOrEqual(IMAGE.height + 1e-9);
    }
    expect(cropAspect(constrained, IMAGE)).toBeCloseTo(cropAspect(crop, IMAGE), 6);
    expect(constrained.angle).toBe(20);
  });

  it('fits the largest crop of an aspect inside a rotated image', () => {
    for (const angle of [0, 5, -5, 45, -45]) {
      const crop = largestCropForAspect(IMAGE, angle, 3 / 2);
      expect(cropAspect(crop, IMAGE)).toBeCloseTo(3 / 2, 6);
      for (const corner of cropCorners(crop, IMAGE)) {
        expect(corner.x).toBeGreaterThanOrEqual(-1e-9);
        expect(corner.x).toBeLessThanOrEqual(IMAGE.width + 1e-9);
        expect(corner.y).toBeGreaterThanOrEqual(-1e-9);
        expect(corner.y).toBeLessThanOrEqual(IMAGE.height + 1e-9);
      }
    }
    const unrotated = largestCropForAspect(IMAGE, 0);
    expect(cropOutputPixels(unrotated, IMAGE)).toEqual({ width: 6000, height: 4000 });
  });

  it('sanitises non-finite and out-of-range values', () => {
    const crop = sanitizeCrop({
      left: Number.NaN,
      top: -1,
      right: 2,
      bottom: 0.5,
      angle: 100,
    });
    expect(crop).toEqual({ left: 0, top: 0, right: 1, bottom: 0.5, angle: 45 });
  });
});

describe('cropDevelopedRgba', () => {
  const width = 8;
  const height = 6;
  const source = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      source[i] = x * 30;
      source[i + 1] = y * 40;
      source[i + 2] = 200;
      source[i + 3] = 255;
    }
  }

  it('returns the source for a full crop with no angle', () => {
    const out = cropDevelopedRgba(source, { width, height }, full);
    expect(out).toEqual(source);
  });

  it('samples the crop centre even when rotated', () => {
    const crop: CropParams = { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 5 };
    const out = cropDevelopedRgba(source, { width, height }, crop);
    const size = cropOutputPixels(crop, { width, height });
    expect(out).toHaveLength(size.width * size.height * 4);
    const centre = ((size.height >> 1) * size.width + (size.width >> 1)) * 4;
    expect(out[centre + 3]).toBe(255);
    expect(out[centre + 2]).toBeCloseTo(200, -1);
  });
});

describe('darktable cross-check', () => {
  /** Mirror of dt_lightroom_import's crop conversion in src/develop/lightroom.c. */
  function darktableCrop(crop: CropParams, image: { width: number; height: number }) {
    const deg2rad = (degrees: number): number => (degrees * Math.PI) / 180;
    const rotateX = (x: number, y: number, radians: number): number =>
      x * Math.cos(radians) + y * Math.sin(radians);
    const rotateY = (x: number, y: number, radians: number): number =>
      -x * Math.sin(radians) + y * Math.cos(radians);

    let cx = (crop.left - 0.5) * image.width;
    let cw = (crop.right - 0.5) * image.width;
    let cy = (crop.top - 0.5) * image.height;
    let ch = (crop.bottom - 0.5) * image.height;
    const pcAngle = -crop.angle;
    const rangle = deg2rad(pcAngle);
    const rotatedCx = rotateX(cx, cy, -rangle);
    const rotatedCy = rotateY(cx, cy, -rangle);
    const rotatedCw = rotateX(cw, ch, -rangle);
    const rotatedCh = rotateY(cw, ch, -rangle);
    cx = rotatedCx;
    cy = rotatedCy;
    cw = rotatedCw;
    ch = rotatedCh;
    const newWidth = rotateX(image.width, -image.height, -Math.abs(rangle));
    const newHeight = rotateY(image.width, image.height, -Math.abs(rangle));
    return {
      cx: cx / newWidth + 0.5,
      cw: cw / newWidth + 0.5,
      cy: cy / newHeight + 0.5,
      ch: ch / newHeight + 0.5,
      angle: -crop.angle,
    };
  }

  it('matches the darktable conversion for a non-zero angle', () => {
    const deg2rad = (degrees: number): number => (degrees * Math.PI) / 180;
    const rotateX = (x: number, y: number, radians: number): number =>
      x * Math.cos(radians) + y * Math.sin(radians);
    const rotateY = (x: number, y: number, radians: number): number =>
      -x * Math.sin(radians) + y * Math.cos(radians);

    for (const angle of [5, -7]) {
      const crop = cropFromGeometry(
        IMAGE.width * 0.43,
        IMAGE.height * 0.54,
        IMAGE.width * 0.52,
        IMAGE.height * 0.31,
        angle,
        IMAGE,
      );
      const dt = darktableCrop(crop, IMAGE);
      const geometry = cropGeometry(crop, IMAGE);

      // The displayed crop is axis-aligned in the frame darktable rotates into.
      const radians = deg2rad(crop.angle);
      const rotatedCenterX = rotateX(
        geometry.centerX - IMAGE.width / 2,
        geometry.centerY - IMAGE.height / 2,
        radians,
      );
      const rotatedCenterY = rotateY(
        geometry.centerX - IMAGE.width / 2,
        geometry.centerY - IMAGE.height / 2,
        radians,
      );
      const newWidth = rotateX(IMAGE.width, -IMAGE.height, -Math.abs(deg2rad(-crop.angle)));
      const newHeight = rotateY(IMAGE.width, IMAGE.height, -Math.abs(deg2rad(-crop.angle)));
      const expected = {
        cx: (rotatedCenterX - geometry.width / 2) / newWidth + 0.5,
        cw: (rotatedCenterX + geometry.width / 2) / newWidth + 0.5,
        cy: (rotatedCenterY - geometry.height / 2) / newHeight + 0.5,
        ch: (rotatedCenterY + geometry.height / 2) / newHeight + 0.5,
        angle: -crop.angle,
      };
      expect(dt.cx).toBeCloseTo(expected.cx, 9);
      expect(dt.cw).toBeCloseTo(expected.cw, 9);
      expect(dt.cy).toBeCloseTo(expected.cy, 9);
      expect(dt.ch).toBeCloseTo(expected.ch, 9);
      expect(dt.angle).toBe(-crop.angle);
    }
  });
});

describe('handle drags', () => {
  it('clamps a single dragged edge without moving the opposite edge', () => {
    const crop = largestCropForAspect(IMAGE, 0, 1);
    const before = cropGeometry(crop, IMAGE);
    const out = resizeCropFromHandle(crop, IMAGE, 'e', {
      x: IMAGE.width * 1.5,
      y: before.centerY,
    });
    const after = cropGeometry(out, IMAGE);
    expect(after.centerX - after.width / 2).toBeCloseTo(before.centerX - before.width / 2, 6);
    expect(after.width).toBeGreaterThan(before.width);
    for (const corner of cropCorners(out, IMAGE)) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.x).toBeLessThanOrEqual(IMAGE.width + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.y).toBeLessThanOrEqual(IMAGE.height + 1e-6);
    }
  });

  it('keeps the opposite corner fixed when a corner is dragged', () => {
    const crop = cropFromGeometry(
      IMAGE.width / 2,
      IMAGE.height / 2,
      IMAGE.width * 0.4,
      IMAGE.height * 0.27,
      10,
      IMAGE,
    );
    const before = cropGeometry(crop, IMAGE);
    const beforeCorners = cropCorners(crop, IMAGE);
    const point = cropCorners(crop, IMAGE)[2]!;
    const out = resizeCropFromHandle(crop, IMAGE, 'se', {
      x: point.x + IMAGE.width * 0.1,
      y: point.y + IMAGE.height * 0.1,
    });
    const afterCorners = cropCorners(out, IMAGE);
    expect(afterCorners[0]!.x).toBeCloseTo(beforeCorners[0]!.x, 5);
    expect(afterCorners[0]!.y).toBeCloseTo(beforeCorners[0]!.y, 5);
    expect(cropGeometry(out, IMAGE).width).toBeGreaterThan(before.width);
  });
});

describe('small, edge and portrait crops', () => {
  it('keeps a tiny crop usable', () => {
    const crop = cropFromGeometry(1200, 800, 6, 4, 15, IMAGE);
    const output = cropOutputSize(crop, IMAGE);
    expect(output.width).toBeGreaterThan(0);
    expect(output.height).toBeGreaterThan(0);
    const constrained = constrainCrop(crop, IMAGE);
    expect(cropGeometry(constrained, IMAGE).width).toBeGreaterThan(0);
  });

  it('constrains an edge-hugging crop without discarding the angle', () => {
    const crop = cropFromGeometry(8, 8, 80, 60, 30, IMAGE);
    const constrained = constrainCrop(crop, IMAGE);
    expect(constrained.angle).toBe(30);
    for (const corner of cropCorners(constrained, IMAGE)) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.x).toBeLessThanOrEqual(IMAGE.width + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.y).toBeLessThanOrEqual(IMAGE.height + 1e-6);
    }
  });

  it('keeps a zero-size crop at its centre instead of resetting to the frame', () => {
    const constrained = constrainCrop(
      { left: 0.5, top: 0.4, right: 0.5, bottom: 0.4, angle: 12 },
      IMAGE,
    );
    expect(constrained.angle).toBe(12);
    const geometry = cropGeometry(constrained, IMAGE);
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.centerX).toBeCloseTo(IMAGE.width * 0.5, 6);
    expect(geometry.centerY).toBeCloseTo(IMAGE.height * 0.4, 6);
  });

  it('handles a portrait image', () => {
    const portrait = { width: 4000, height: 6000 };
    const original = largestCropForAspect(portrait, 0);
    expect(cropOutputPixels(original, portrait)).toEqual({ width: 4000, height: 6000 });
    const landscape = largestCropForAspect(portrait, 5, 3 / 2);
    expect(cropAspect(landscape, portrait)).toBeCloseTo(3 / 2, 6);
    expect(cropOutputPixels(landscape, portrait).width).toBeGreaterThan(
      cropOutputPixels(landscape, portrait).height,
    );
    for (const corner of cropCorners(landscape, portrait)) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.x).toBeLessThanOrEqual(portrait.width + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6);
      expect(corner.y).toBeLessThanOrEqual(portrait.height + 1e-6);
    }
  });
});
