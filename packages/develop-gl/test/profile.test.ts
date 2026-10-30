import { describe, expect, it } from 'vitest';
import { parseDcp, ProfileParseError } from '../src/profile/dcp';
import { expandBigTable, compressBigTable, parseLookXmp } from '../src/profile/look';
import {
  applyTable,
  blendNumbers,
  illuminantWeight,
  lookupTable,
  scaledTable,
  tableData,
} from '../src/profile/render';
import {
  buildDcp,
  buildLookXmp,
  ILLUMINANT_A,
  ILLUMINANT_D65,
  identityTable,
  setNode,
} from './profile-support';

const A = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const B = [2, 0, 0, 0, 3, 0, 0, 0, 4];

describe('DCP parser', () => {
  it('round-trips every tag the pipeline reads', () => {
    const hue1 = setNode(identityTable(4, 2, 2), 1, 2, 1, [30, 1.25, 0.5]);
    const hue2 = setNode(identityTable(4, 2, 2), 0, 0, 0, [-15, 0.75, 1.5]);
    const look = identityTable(3, 2, 1, true);
    const bytes = buildDcp({
      name: 'Camera Standard',
      camera: 'Nikon Z 6',
      copyright: 'Test copyright',
      illuminants: [ILLUMINANT_A, ILLUMINANT_D65],
      color: [A, B],
      forward: [B, A],
      hueSat: [hue1, hue2],
      look,
      toneCurve: [0, 0, 0.25, 0.4, 1, 1],
      baselineExposureOffset: 0.5,
      defaultBlackRender: 1,
      embedPolicy: 3,
    });
    const p = parseDcp(bytes);
    expect(p).toMatchObject({
      name: 'Camera Standard',
      camera: 'Nikon Z 6',
      copyright: 'Test copyright',
      illuminants: [2856, 6504],
      colorMatrices: [A, B],
      forwardMatrices: [B, A],
      baselineExposureOffset: 0.5,
      defaultBlackRender: 'none',
      embedPolicy: 3,
    });
    expect(p.hueSatMaps).toHaveLength(2);
    expect(p.hueSatMaps[0]).toMatchObject({
      hueDivisions: 4,
      satDivisions: 2,
      valDivisions: 2,
      srgbEncoding: false,
    });
    expect(p.hueSatMaps[0]?.data).toEqual(hue1.data);
    expect(p.hueSatMaps[1]?.data).toEqual(hue2.data);
    expect(p.look).toMatchObject({ srgbEncoding: true, hueDivisions: 3 });
    expect(p.toneCurve).toEqual([0, 0, 0.25, 0.4000000059604645, 1, 1]);
  });

  it('orders a profile whose illuminants are listed warm-last by temperature', () => {
    const p = parseDcp(
      buildDcp({ illuminants: [ILLUMINANT_D65, ILLUMINANT_A], color: [A, B], forward: [A, B] }),
    );
    expect(p.illuminants).toEqual([2856, 6504]);
    expect(p.colorMatrices).toEqual([B, A]);
    expect(p.forwardMatrices).toEqual([B, A]);
  });

  it('defaults the optional tags', () => {
    const p = parseDcp(buildDcp({ color: [A] }));
    expect(p.baselineExposureOffset).toBe(0);
    expect(p.defaultBlackRender).toBe('auto');
    expect(p.toneCurve).toBeUndefined();
    expect(p.hueSatMaps).toEqual([]);
  });

  it('refuses what it cannot render faithfully', () => {
    expect(() => parseDcp(new Uint8Array([1, 2, 3]))).toThrow(ProfileParseError);
    expect(() => parseDcp(buildDcp({}))).toThrow(/neither a ColorMatrix/);
    expect(() =>
      parseDcp(
        buildDcp({
          color: [A],
          extraTags: [{ tag: 52531, type: 3, bytes: new Uint8Array([21, 0]), count: 1 }],
        }),
      ),
    ).toThrow(/third calibration illuminant/);
    expect(() => parseDcp(buildDcp({ color: [A], illuminants: [255, 21] }))).toThrow(/illuminant/);
  });

  it('reads big-endian files too', () => {
    const le = buildDcp({ color: [A], name: 'X' });
    // Re-encode as big endian: swap every field by rewriting the tiny file through a DataView.
    const be = new Uint8Array(le.length);
    const src = new DataView(le.buffer);
    const dst = new DataView(be.buffer);
    be.set([0x4d, 0x4d]);
    dst.setUint16(2, 0x4352, false);
    dst.setUint32(4, 8, false);
    const count = src.getUint16(8, true);
    dst.setUint16(8, count, false);
    const rationalIndex: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = 10 + i * 12;
      const type = src.getUint16(at + 2, true);
      const n = src.getUint32(at + 4, true);
      dst.setUint16(at, src.getUint16(at, true), false);
      dst.setUint16(at + 2, type, false);
      dst.setUint32(at + 4, n, false);
      const size = ({ 2: 1, 3: 2, 4: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      const total = size * n;
      const valueAt = total <= 4 ? at + 8 : src.getUint32(at + 8, true);
      if (total > 4) dst.setUint32(at + 8, valueAt, false);
      for (let k = 0; k < n; k++) {
        if (type === 3) dst.setUint16(valueAt + k * 2, src.getUint16(valueAt + k * 2, true), false);
        else if (type === 4)
          dst.setUint32(valueAt + k * 4, src.getUint32(valueAt + k * 4, true), false);
        else if (type === 10) {
          dst.setInt32(valueAt + k * 8, src.getInt32(valueAt + k * 8, true), false);
          dst.setInt32(valueAt + k * 8 + 4, src.getInt32(valueAt + k * 8 + 4, true), false);
        } else be[valueAt + k] = le[valueAt + k] ?? 0;
      }
      rationalIndex.push(type);
    }
    expect(parseDcp(be)).toMatchObject({ name: 'X', colorMatrices: [A] });
  });
});

describe('temperature interpolation (DNG SDK)', () => {
  const t1 = 2856;
  const t2 = 6504;

  it('is linear in inverse temperature between the illuminants and clamped outside', () => {
    expect(illuminantWeight(2000, [t1, t2])).toBe(0);
    expect(illuminantWeight(t1, [t1, t2])).toBe(0);
    expect(illuminantWeight(t2, [t1, t2])).toBe(1);
    expect(illuminantWeight(9000, [t1, t2])).toBe(1);
    // The SDK: (1/T - 1/T1) / (1/T2 - 1/T1).
    for (const t of [3200, 4000, 5000, 5500, 6000]) {
      const expected = (1 / t - 1 / t1) / (1 / t2 - 1 / t1);
      expect(illuminantWeight(t, [t1, t2])).toBeCloseTo(expected, 12);
    }
    // Not linear in kelvin: the midpoint in mired is not the midpoint in kelvin.
    const mired = 1 / ((1 / t1 + 1 / t2) / 2);
    expect(illuminantWeight(mired, [t1, t2])).toBeCloseTo(0.5, 12);
    expect(illuminantWeight((t1 + t2) / 2, [t1, t2])).not.toBeCloseTo(0.5, 2);
  });

  it('blends matrices with that weight and passes one matrix through', () => {
    const w = illuminantWeight(5000, [t1, t2]);
    const m = blendNumbers([A, B], w);
    m.forEach((v, i) => expect(v).toBeCloseTo((A[i] ?? 0) * (1 - w) + (B[i] ?? 0) * w, 12));
    expect(blendNumbers([A], 0.7)).toEqual(A);
    expect(illuminantWeight(5000, [t1])).toBe(0);
  });
});

describe('HueSatMap / LookTable lookup', () => {
  /** 6 hue steps of 60 degrees, 2 saturation and 2 value nodes. */
  const base = identityTable(6, 2, 2);

  it('hits a node exactly and interpolates trilinearly between nodes', () => {
    // Node (v=1, h=2, s=1) shifts by 30 degrees, scales saturation by 1.5 and value by 0.5.
    const table = tableData(setNode(base, 1, 2, 1, [30, 1.5, 0.5]));
    expect(lookupTable(table, 2 / 6, 1, 1)).toEqual([30, 1.5, 0.5]);
    // Halfway towards the next hue node, all other nodes identity: half of each delta.
    const half = lookupTable(table, 2.5 / 6, 1, 1);
    expect(half[0]).toBeCloseTo(15, 6);
    expect(half[1]).toBeCloseTo(1.25, 6);
    expect(half[2]).toBeCloseTo(0.75, 6);
    // Halfway in saturation and in value as well: an eighth of the delta in all three weights.
    const centre = lookupTable(table, 2 / 6, 0.5, 0.5);
    expect(centre[0]).toBeCloseTo(30 * 0.25, 6);
    expect(centre[1]).toBeCloseTo(1 + 0.5 * 0.25, 6);
    expect(centre[2]).toBeCloseTo(1 - 0.5 * 0.25, 6);
  });

  it('wraps the hue axis: just below 1 blends the last node with the first', () => {
    const table = tableData(setNode(setNode(base, 0, 5, 1, [40, 1, 1]), 0, 0, 1, [-20, 1, 1]));
    // Hue 5.5 / 6 sits halfway between node 5 (+40) and node 0 (-20).
    expect(lookupTable(table, 5.5 / 6, 1, 0)[0]).toBeCloseTo(10, 6);
    // Hue exactly 1 is hue 0, and a hue past 1 wraps.
    expect(lookupTable(table, 1, 1, 0)[0]).toBeCloseTo(-20, 6);
    expect(lookupTable(table, 1 + 2.5 / 6, 1, 0)[0]).toBeCloseTo(lookupTable(table, 2.5 / 6, 1, 0)[0] ?? NaN, 9);
    expect(lookupTable(table, -0.5 / 6, 1, 0)[0]).toBeCloseTo(10, 6);
  });

  it('clamps saturation and value to the table', () => {
    const table = tableData(setNode(base, 1, 0, 1, [10, 2, 3]));
    expect(lookupTable(table, 0, 5, 7)).toEqual([10, 2, 3]);
    expect(lookupTable(table, 0, -1, -1)).toEqual([0, 1, 1]);
  });

  it('shifts the hue of a colour on a node by the table amount, wrapping at red', () => {
    // Pure red is hue 0. A -60 degree shift on the whole red node moves it to magenta (hue 300).
    let t = identityTable(6, 2, 1);
    t = setNode(t, 0, 0, 1, [-60, 1, 1]);
    const [r, g, b] = applyTable(1, 0, 0, tableData(t), null, 0);
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(1, 6);
  });

  it('scales saturation and value, and an identity table changes nothing', () => {
    const id = tableData(identityTable(6, 3, 2));
    for (const rgb of [
      [0.2, 0.5, 0.7],
      [1, 0.1, 0.1],
      [0.4, 0.4, 0.4],
      [0, 0, 0],
    ] as const) {
      const out = applyTable(rgb[0], rgb[1], rgb[2], id, null, 0);
      out.forEach((v, i) => expect(v).toBeCloseTo(rgb[i] ?? 0, 6));
    }
    let t = identityTable(6, 2, 2);
    for (let v = 0; v < 2; v++) for (let h = 0; h < 6; h++) t = setNode(t, v, h, 1, [0, 0.5, 1]);
    // Fully saturated (the last saturation node): halving it lifts the minimum channel to v / 2.
    const [r, g, b] = applyTable(0.8, 0.4, 0, tableData(t), null, 0);
    expect(r).toBeCloseTo(0.8, 6);
    expect(b).toBeCloseTo(0.4, 6);
    expect(g).toBeCloseTo(0.6, 6);
  });

  it('blends two tables by the weight', () => {
    const a = tableData(setNode(identityTable(6, 2, 1), 0, 0, 1, [40, 1, 1]));
    const b = tableData(setNode(identityTable(6, 2, 1), 0, 0, 1, [-20, 1, 1]));
    expect(lookupTable(a, 0, 1, 0)[0]).toBe(40);
    const mixed = applyTable(1, 0, 0, a, b, 0.5);
    const direct = applyTable(1, 0, 0, tableData(setNode(identityTable(6, 2, 1), 0, 0, 1, [10, 1, 1])), null, 0);
    mixed.forEach((v, i) => expect(v).toBeCloseTo(direct[i] ?? 0, 6));
  });

  it('applies a table with sRGB encoded value to the encoded value', () => {
    // Value scale 0.5 on an sRGB encoded axis halves the encoded value, not the linear one.
    let t = identityTable(1, 2, 2, true);
    for (let v = 0; v < 2; v++) t = setNode(t, v, 0, 0, [0, 1, 0.5]);
    for (let v = 0; v < 2; v++) t = setNode(t, v, 0, 1, [0, 1, 0.5]);
    const [r] = applyTable(0.5, 0.5, 0.5, tableData(t), null, 0);
    const encoded = 1.055 * Math.pow(0.5, 1 / 2.4) - 0.055;
    const expected = Math.pow((encoded * 0.5 + 0.055) / 1.055, 2.4);
    expect(r).toBeCloseTo(expected, 6);
    expect(r).not.toBeCloseTo(0.25, 2);
  });

  it('scales a table towards identity for the look amount', () => {
    const t = tableData(setNode(identityTable(6, 2, 1), 0, 0, 1, [40, 2, 0.5]));
    const half = scaledTable(t, 0.5);
    expect(lookupTable(half, 0, 1, 0)).toEqual([20, 1.5, 0.75]);
    expect(scaledTable(t, 1)).toBe(t);
    expect(lookupTable(scaledTable(t, 0), 0, 1, 0)).toEqual([0, 1, 1]);
  });
});

describe('XMP look parser', () => {
  it('round-trips Adobe base 85 over zlib', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
    expect([...expandBigTable(compressBigTable(bytes))]).toEqual([...bytes]);
    expect(() => expandBigTable('not a table~')).toThrow(ProfileParseError);
  });

  it('reads a look with a table, curve, amount range and settings', () => {
    const table = setNode(identityTable(6, 2, 1), 0, 0, 1, [12, 1.1, 0.9]);
    const look = parseLookXmp(
      buildLookXmp({
        name: 'Test Color',
        base: 'Camera Standard',
        table,
        bounds: [0, 1.5],
        supportsAmount: true,
        curve: [
          [0, 0],
          [128, 140],
          [255, 255],
        ],
        attributes: { 'crs:Highlights2012': '-20', 'crs:Clarity2012': '10', 'crs:Shadows2012': '0' },
      }),
    );
    expect(look).toMatchObject({
      name: 'Test Color',
      group: 'Profiles',
      base: 'Camera Standard',
      supportsAmount: true,
      tableBounds: [0, 1.5],
      settings: { Highlights2012: -20, Clarity2012: 10 },
    });
    expect(look.table?.data.length).toBe(36);
    expect(look.table?.data[4]).toBeCloseTo(1.1, 6);
    expect(look.curve).toHaveLength(6);
    expect(look.curve?.[3]).toBeCloseTo(140 / 255, 9);
  });

  it('keeps the amount bounds at 1 unless the look supports an amount', () => {
    const look = parseLookXmp(
      buildLookXmp({ table: identityTable(2, 2, 1), bounds: [0, 2], supportsAmount: false }),
    );
    expect(look.tableBounds).toEqual([1, 1]);
  });

  it('refuses looks it cannot render, with the reason', () => {
    const table = identityTable(2, 2, 1);
    expect(() => parseLookXmp('<x/>')).toThrow(ProfileParseError);
    expect(() => parseLookXmp(buildLookXmp({ table, attributes: { 'crs:PresetType': 'Normal' } }))).toThrow(/not a look/);
    expect(() => parseLookXmp(buildLookXmp({ table, base: null }))).toThrow(/names no camera profile/);
    expect(() => parseLookXmp(buildLookXmp({ table, attributes: { 'crs:ConvertToGrayscale': 'True' } }))).toThrow(/Monochrome/);
    expect(() => parseLookXmp(buildLookXmp({ table, attributes: { 'crs:RGBTable': 'abc' } }))).toThrow(/RGB table/);
    expect(() => parseLookXmp(buildLookXmp({ table, attributes: { 'crs:Dehaze': '20' } }))).toThrow(/Dehaze/);
  });
});
