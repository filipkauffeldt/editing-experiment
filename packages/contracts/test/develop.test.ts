import { describe, expect, it } from 'vitest';
import { DETAIL_DEFAULT_PARAMS, RAW_DETAIL_DEFAULTS, SLIDER_SPECS, withDefaults } from '../src';

describe('raw detail defaults', () => {
  it('stay inside the slider ranges and only name detail settings', () => {
    for (const [name, value] of Object.entries(RAW_DETAIL_DEFAULTS)) {
      expect(DETAIL_DEFAULT_PARAMS).toContain(name);
      const spec = SLIDER_SPECS[name as keyof typeof SLIDER_SPECS];
      expect(value).toBeGreaterThanOrEqual(spec.min);
      expect(value).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('withDefaults', () => {
  it('lets explicit values win, including an explicit zero', () => {
    expect(
      withDefaults({ Sharpness: 0, Exposure2012: 1 }, { Sharpness: 40, SharpenRadius: 1 }),
    ).toEqual({
      Sharpness: 0,
      SharpenRadius: 1,
      Exposure2012: 1,
    });
  });

  it('returns the params untouched without defaults', () => {
    const params = { Contrast2012: 5 };
    expect(withDefaults(params, undefined)).toBe(params);
    expect(withDefaults(params, {})).toBe(params);
  });

  it('ignores undefined values in the params', () => {
    expect(withDefaults({ Sharpness: undefined }, { Sharpness: 40 })).toEqual({ Sharpness: 40 });
  });
});
