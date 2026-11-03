import { describe, expect, it } from 'vitest';
import * as retouch from '../src/index';

describe('@ee/retouch public API', () => {
  it('exports the browser-safe selection and mosaic helpers', () => {
    expect(typeof retouch.applyMosaic).toBe('function');
    expect(typeof retouch.rasterizeShapes).toBe('function');
    expect(typeof retouch.pointInPolygon).toBe('function');
  });
});
