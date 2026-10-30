import type { EditParams, LinearImageHeader } from '@ee/contracts';
import { cropOutputPixels } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { exportRenderSize } from '../src/renderer/export-render';

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

const none = { mode: 'none' as const };

describe('export render size', () => {
  it('uses the source size when there is no crop and no resize', () => {
    expect(exportRenderSize(header(), {}, none)).toEqual({ width: 6000, height: 4000 });
  });

  it('uses the crop pixel size based on the source size', () => {
    const params: EditParams = {
      crop: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9, angle: 5 },
    };
    expect(exportRenderSize(header(), params, none)).toEqual(
      cropOutputPixels(params.crop!, { width: 6000, height: 4000 }),
    );
  });

  it('applies the preset resize to the crop size, not the source size', () => {
    const params: EditParams = {
      crop: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75, angle: 0 },
    };
    expect(exportRenderSize(header(), params, { mode: 'longEdge', pixels: 1200 })).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('fits a long edge preset without changing the aspect ratio', () => {
    expect(
      exportRenderSize(header(), { crop: undefined }, { mode: 'longEdge', pixels: 1600 }),
    ).toEqual({ width: 1600, height: 1067 });
  });

  it('refuses a downscaled linear image instead of exporting a preview size', () => {
    expect(() =>
      exportRenderSize(
        header({ width: 2560, height: 1707, sourceWidth: 6000, sourceHeight: 4000 }),
        {},
        none,
      ),
    ).toThrow(/full-resolution linear image/);
  });

  it('refuses a header without source dimensions', () => {
    expect(() => exportRenderSize(header({ sourceWidth: 0, sourceHeight: 0 }), {}, none)).toThrow(
      /no source size/,
    );
  });
});
