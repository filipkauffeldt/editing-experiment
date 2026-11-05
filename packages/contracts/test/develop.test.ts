import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COPY_SETTING_GROUPS,
  DEVELOP_SETTING_GROUPS,
  DETAIL_DEFAULT_PARAMS,
  EDIT_PARAM_KEYS,
  RAW_DETAIL_DEFAULTS,
  SLIDER_SPECS,
  applyDevelopSettingGroups,
  developSettingFields,
  withDefaults,
} from '../src';

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

describe('copy settings groups', () => {
  it('assigns every EditParams field to exactly one group', () => {
    const fields = DEVELOP_SETTING_GROUPS.flatMap((group) => group.fields);
    // The compile-time guard in contracts makes a new EditParams field fail the
    // build; this catches a field that was listed but not put in a group, and a
    // field put in two groups.
    expect([...fields].sort()).toEqual([...EDIT_PARAM_KEYS].sort());
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('shows the Lightroom groups in order and leaves Crop out of the defaults', () => {
    expect(DEVELOP_SETTING_GROUPS.map((group) => group.label)).toEqual([
      'Treatment & Profile',
      'White Balance',
      'Basic Tone',
      'Presence',
      'Tone Curve',
      'Color Mixer',
      'Color Grading',
      'Detail',
      'Lens Corrections',
      'Effects',
      'Calibration',
      'Crop',
    ]);
    expect(DEFAULT_COPY_SETTING_GROUPS).not.toContain('crop');
    expect(DEFAULT_COPY_SETTING_GROUPS).toHaveLength(DEVELOP_SETTING_GROUPS.length - 1);
  });

  it('copies selected groups, resets fields the source leaves neutral, and keeps the rest', () => {
    const target = {
      Exposure2012: -1,
      Contrast2012: 5,
      Saturation: 30,
      GrainAmount: 20,
      crop: { left: 0, top: 0, right: 1, bottom: 1, angle: 0 },
    };
    const source = { Exposure2012: 0.5, GrainAmount: 8 };
    const next = applyDevelopSettingGroups(target, source, ['basicTone', 'effects']);
    expect(next).toEqual({
      Exposure2012: 0.5,
      Saturation: 30,
      GrainAmount: 8,
      crop: target.crop,
    });
    expect(next.Contrast2012).toBeUndefined();
  });

  it('copies only the profile the source names, so the target keeps or gets the default of its own camera', () => {
    // The default profile is not a setting, so a source that only has the default copies nothing:
    // the target's explicit profile is cleared and it falls back to its own camera's default.
    const target = { CameraProfile: 'Adobe Standard', LookName: 'Adobe Color', Exposure2012: 1 };
    expect(applyDevelopSettingGroups(target, { Exposure2012: 0.5 }, ['profile'])).toEqual({
      Exposure2012: 1,
    });
    // An explicit "Camera matrix" is a setting and travels, replacing a profile on the target.
    expect(applyDevelopSettingGroups(target, { CameraProfileChoice: 'none' }, ['profile'])).toEqual(
      { CameraProfileChoice: 'none', Exposure2012: 1 },
    );
    // A group that is not ticked leaves the target's profile alone.
    expect(applyDevelopSettingGroups(target, { Exposure2012: 0.5 }, ['basicTone'])).toMatchObject({
      CameraProfile: 'Adobe Standard',
    });
  });

  it('does not copy retouch data because it is not a develop setting', () => {
    expect(EDIT_PARAM_KEYS.some((key) => /retouch|mosaic/i.test(key))).toBe(false);
    expect(developSettingFields(['crop'])).toEqual(['crop']);
  });
});
