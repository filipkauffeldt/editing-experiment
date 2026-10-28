import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { cropOutputPixels } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { fullResolutionOutput } from '../src/renderer/export-render';

function header(overrides: Partial<LinearImageHeader> = {}): LinearImageHeader {
  return {
    width: 6000,
    height: 4000,
    sourceWidth: 6000,
    sourceHeight: 4000,
    sampleType: 'f16',
    asShotMultipliers: { r: 1, g: 1, b: 1 },
    cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    ...overrides,
  };
}

describe('full-resolution export size', () => {
  it('uses the source size when there is no crop', () => {
    expect(fullResolutionOutput(header(), {})).toEqual({ width: 6000, height: 4000 });
  });

  it('uses the crop pixel size based on the source size', () => {
    const params: EditParams = {
      crop: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9, angle: 5 },
    };
    expect(fullResolutionOutput(header(), params)).toEqual(
      cropOutputPixels(params.crop!, { width: 6000, height: 4000 }),
    );
  });

  it('refuses a downscaled linear image instead of exporting a preview size', () => {
    expect(() =>
      fullResolutionOutput(
        header({ width: 2560, height: 1707, sourceWidth: 6000, sourceHeight: 4000 }),
        {},
      ),
    ).toThrow(/full-resolution linear image/);
  });

  it('refuses a header without source dimensions', () => {
    expect(() => fullResolutionOutput(header({ sourceWidth: 0, sourceHeight: 0 }), {})).toThrow(
      /no source size/,
    );
  });
});
