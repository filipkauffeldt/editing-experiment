import type { CameraInfo } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import { shootingInfoLine, shutterLabel } from '../src/renderer/shooting-info';
import { mockPhotos } from '../src/shared/mock';

const photoWith = (camera: CameraInfo) => ({ ...mockPhotos()[0]!, camera });

describe('shutterLabel', () => {
  it('writes fast and slow exposure times', () => {
    expect(shutterLabel(1 / 2000)).toBe('1/2000s');
    expect(shutterLabel(0.5)).toBe('1/2s');
    expect(shutterLabel(2)).toBe('2.0s');
    expect(shutterLabel(10)).toBe('10s');
  });

  it('has nothing for a missing or unusable time', () => {
    expect(shutterLabel(undefined)).toBeUndefined();
    expect(shutterLabel(0)).toBeUndefined();
    expect(shutterLabel(Number.NaN)).toBeUndefined();
  });
});

describe('shootingInfoLine', () => {
  it('writes the shooting fields as one line', () => {
    expect(
      shootingInfoLine(
        photoWith({ iso: 3200, focalLength: 135, aperture: 2.8, shutter: 1 / 1000 }),
      ),
    ).toBe('ISO 3200 · 135mm · f/2.8 · 1/1000s');
  });

  it('rounds ISO and adds the camera body only when asked', () => {
    const photo = photoWith({
      model: 'NIKON Z 9',
      iso: 3199.6,
      focalLength: 24.4,
      aperture: 2.8,
      shutter: 0.5,
    });
    expect(shootingInfoLine(photo)).toBe('ISO 3200 · 24mm · f/2.8 · 1/2s');
    expect(shootingInfoLine(photo, { cameraBody: true })).toBe(
      'ISO 3200 · 24mm · f/2.8 · 1/2s · NIKON Z 9',
    );
  });

  it('leaves out fields the photo lacks', () => {
    expect(shootingInfoLine(photoWith({ aperture: 2.8 }))).toBe('f/2.8');
    expect(shootingInfoLine(photoWith({}))).toBeUndefined();
    expect(shootingInfoLine(undefined)).toBeUndefined();
  });
});
