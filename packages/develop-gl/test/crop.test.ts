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
