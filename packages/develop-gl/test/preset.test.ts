import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLIDER_SPECS } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  parsePreset,
  parsePresetLrtemplate,
  parsePresetXmp,
  PresetParseError,
} from '../src/preset';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('Lightroom .xmp preset', () => {
  const { preset, unsupported } = parsePresetXmp(fixture('lightroom-preset.xmp'), {
    path: '/presets/Stadium Night.xmp',
  });

  it('reads the name, id and path', () => {
    expect(preset.name).toBe('Stadium Night');
    expect(preset.id).toBe('B3A6C7D2-5D0E-4D1F-9F7A-2C1E8A4F6B10');
    expect(preset.path).toBe('/presets/Stadium Night.xmp');
  });

  it('reads the crs: attributes, including signed values', () => {
    expect(preset.params).toMatchObject({
      ProcessVersion: '15.4',
      WhiteBalance: 'Custom',
      Temperature: 5200,
      Tint: 12,
      Exposure2012: 0.35,
      Contrast2012: 28,
      Highlights2012: -42,
      Shadows2012: 31,
      Whites2012: 9,
      Blacks2012: -14,
      Vibrance: 22,
      Saturation: -4,
    });
  });

  it('reads the rdf:Seq tone curves', () => {
    expect(preset.params.ToneCurvePV2012).toEqual([
      [0, 0],
      [64, 52],
      [192, 205],
      [255, 255],
    ]);
    expect(preset.params.ToneCurvePV2012Blue).toEqual([
      [0, 12],
      [255, 240],
    ]);
    expect(preset.params.ToneCurvePV2012Green).toBeUndefined();
  });

  it('reports unsupported settings but not bookkeeping or zero defaults', () => {
    expect(unsupported).toEqual([
      'Texture',
      'Clarity2012',
      'Dehaze',
      'Sharpness',
      'ColorNoiseReduction',
    ]);
  });
});

describe('element form and bad values', () => {
  const { preset, unsupported } = parsePresetXmp(fixture('element-form.xmp'));

  it('reads settings given as child elements, using whatever prefix the file binds to the namespace', () => {
    expect(preset.params.WhiteBalance).toBe('Daylight');
  });

  it('clamps values to SLIDER_SPECS', () => {
    expect(preset.params.Exposure2012).toBe(SLIDER_SPECS.Exposure2012.min);
    expect(preset.params.Highlights2012).toBe(-100);
    expect(preset.params.Temperature).toBe(SLIDER_SPECS.Temperature.min);
  });

  it('drops unparsable values and curve points, clamps and sorts the rest', () => {
    expect(preset.params.Vibrance).toBeUndefined();
    expect(preset.params.ToneCurvePV2012).toEqual([
      [0, 255],
      [255, 255],
    ]);
  });

  it('lists what it could not use, and names a nameless preset after its file', () => {
    expect(unsupported).toEqual(['Vibrance', 'ParametricCurve']);
    const named = parsePresetXmp(fixture('element-form.xmp'), { path: '/x/Night Games.xmp' });
    expect(named.preset.name).toBe('Night Games');
    expect(named.preset.id).toBe(
      parsePresetXmp(fixture('element-form.xmp'), { path: '/x/Night Games.xmp' }).preset.id,
    );
  });
});

describe('white balance in presets', () => {
  it('drops the restated temperature and tint of an "As Shot" preset', () => {
    const { preset } = parsePresetXmp(fixture('as-shot.xmp'));
    expect(preset.params).toEqual({ WhiteBalance: 'As Shot', Contrast2012: 10 });
  });

  it('applyPreset overlays the preset and clears a manual white balance when the preset says As Shot', () => {
    const { preset } = parsePresetXmp(fixture('as-shot.xmp'));
    expect(
      applyPreset({ Temperature: 3200, Tint: 5, Exposure2012: 1, Contrast2012: -5 }, preset),
    ).toEqual({
      WhiteBalance: 'As Shot',
      Exposure2012: 1,
      Contrast2012: 10,
    });
    const custom = parsePresetXmp(fixture('lightroom-preset.xmp')).preset;
    expect(applyPreset({ Temperature: 3200, Saturation: 30 }, custom).Temperature).toBe(5200);
  });
});

describe('crop in presets', () => {
  const preset = (
    crop: string,
    hasCrop = 'True',
  ): string => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:PresetType="Normal"
      crs:Name="Cropped"
      crs:Exposure2012="0.2"
      crs:HasCrop="${hasCrop}"
      ${crop} />
  </rdf:RDF>
</x:xmpmeta>`;

  it('carries the crop rectangle and angle when the preset has one', () => {
    const parsed = parsePresetXmp(
      preset(
        'crs:CropLeft="0.1" crs:CropTop="0.15" crs:CropRight="0.9" crs:CropBottom="0.85" crs:CropAngle="-3.5"',
      ),
    );
    expect(parsed.preset.params).toEqual({
      Exposure2012: 0.2,
      crop: { left: 0.1, top: 0.15, right: 0.9, bottom: 0.85, angle: -3.5 },
    });
    expect(parsed.unsupported).toEqual([]);
  });

  it('ignores the rectangle when HasCrop is false', () => {
    const parsed = parsePresetXmp(
      preset(
        'crs:CropLeft="0.1" crs:CropTop="0.15" crs:CropRight="0.9" crs:CropBottom="0.85"',
        'False',
      ),
    );
    expect(parsed.preset.params.crop).toBeUndefined();
    expect(parsed.unsupported).toEqual([]);
  });
});

describe('.lrtemplate preset', () => {
  const { preset, unsupported } = parsePresetLrtemplate(fixture('classic.lrtemplate'));

  it('reads name, id, settings and the flat tone curve list', () => {
    expect(preset.name).toBe('Flat Portrait');
    expect(preset.id).toBe('6E3F0F8E-0C6A-4A4B-8E0D-8F3B2C1A9D77');
    expect(preset.params).toEqual({
      ProcessVersion: '6.7',
      WhiteBalance: 'Flash',
      Exposure2012: 0.25,
      Contrast2012: -20,
      Highlights2012: -35,
      Shadows2012: 40,
      Whites2012: 0,
      Vibrance: 15,
      Saturation: -5,
      ToneCurvePV2012: [
        [0, 10],
        [128, 140],
        [255, 250],
      ],
    });
    expect(unsupported).toEqual(['Clarity2012']);
  });

  it('rejects text that is not a preset', () => {
    expect(() => parsePresetLrtemplate('s = { title = "x" }')).toThrow(PresetParseError);
    expect(() => parsePresetLrtemplate('s = { value = { settings = ')).toThrow(PresetParseError);
    expect(() => parsePresetLrtemplate('')).toThrow(PresetParseError);
  });
});

describe('parsePreset', () => {
  it('picks the parser from the extension or the content', () => {
    expect(parsePreset(fixture('classic.lrtemplate'), { path: 'a.lrtemplate' }).preset.name).toBe(
      'Flat Portrait',
    );
    expect(parsePreset(fixture('classic.lrtemplate')).preset.name).toBe('Flat Portrait');
    expect(parsePreset(fixture('lightroom-preset.xmp')).preset.name).toBe('Stadium Night');
  });

  it('refuses things that are not presets', () => {
    expect(() => parsePreset('hello')).toThrow(PresetParseError);
    expect(() =>
      parsePresetXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"/></x:xmpmeta>'),
    ).toThrow(/not a Lightroom preset/);
    expect(() => parsePresetXmp('<a><b></a>')).toThrow(PresetParseError);
  });
});
