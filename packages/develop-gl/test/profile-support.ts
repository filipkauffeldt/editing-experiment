import type { CameraProfileData, ProfileTable } from '@ee/contracts';
import { compressBigTable } from '../src/profile/look';

/**
 * Synthetic camera profiles for the tests. Nothing here is, or is derived from, an Adobe profile:
 * the DCPs are written byte by byte from numbers chosen in the test.
 */

interface RawTag {
  tag: number;
  type: number;
  bytes: Uint8Array;
  count: number;
}

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_SRATIONAL = 10;
const TYPE_FLOAT = 11;

function floats(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}

function rationals(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setInt32(i * 8, Math.round(v * 10000), true);
    view.setInt32(i * 8 + 4, 10000, true);
  });
  return out;
}

function ints(type: number, values: readonly number[]): Uint8Array {
  const size = type === TYPE_SHORT ? 2 : 4;
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  values.forEach((v, i) =>
    type === TYPE_SHORT ? view.setUint16(i * size, v, true) : view.setUint32(i * size, v, true),
  );
  return out;
}

/** Writes a `.dcp`: little endian, magic `0x4352`, one IFD. Tags are `[number, type, bytes, count]`. */
export function writeTiffProfile(tags: readonly RawTag[]): Uint8Array {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const ifdSize = 2 + sorted.length * 12 + 4;
  let extra = 8 + ifdSize;
  const chunks: { at: number; bytes: Uint8Array }[] = [];
  const out: number[] = [];
  const header = new Uint8Array(8 + ifdSize);
  const view = new DataView(header.buffer);
  header.set([0x49, 0x49]);
  view.setUint16(2, 0x4352, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, sorted.length, true);
  sorted.forEach((t, i) => {
    const at = 10 + i * 12;
    view.setUint16(at, t.tag, true);
    view.setUint16(at + 2, t.type, true);
    view.setUint32(at + 4, t.count, true);
    if (t.bytes.length <= 4) {
      header.set(t.bytes, at + 8);
    } else {
      view.setUint32(at + 8, extra, true);
      chunks.push({ at: extra, bytes: t.bytes });
      extra += t.bytes.length + (t.bytes.length % 2);
    }
  });
  const file = new Uint8Array(extra);
  file.set(header);
  for (const c of chunks) file.set(c.bytes, c.at);
  void out;
  return file;
}

const ascii = (tag: number, text: string): RawTag => {
  const bytes = new TextEncoder().encode(`${text}\0`);
  return { tag, type: TYPE_ASCII, bytes, count: bytes.length };
};
const longs = (tag: number, values: number[]): RawTag => ({
  tag,
  type: TYPE_LONG,
  bytes: ints(TYPE_LONG, values),
  count: values.length,
});
const shorts = (tag: number, values: number[]): RawTag => ({
  tag,
  type: TYPE_SHORT,
  bytes: ints(TYPE_SHORT, values),
  count: values.length,
});
const floatTag = (tag: number, values: number[]): RawTag => ({
  tag,
  type: TYPE_FLOAT,
  bytes: floats(values),
  count: values.length,
});
const matrixTag = (tag: number, values: number[]): RawTag => ({
  tag,
  type: TYPE_SRATIONAL,
  bytes: rationals(values),
  count: values.length,
});

/** EXIF LightSource codes used by the tests. */
export const ILLUMINANT_A = 17;
export const ILLUMINANT_D65 = 21;

export interface DcpSpec {
  name?: string;
  camera?: string;
  copyright?: string;
  /** `[CalibrationIlluminant1, CalibrationIlluminant2]` as EXIF LightSource codes. */
  illuminants?: [number, number];
  color?: [number[], number[]?];
  forward?: [number[], number[]?];
  hueSat?: [ProfileTable, ProfileTable?];
  look?: ProfileTable;
  toneCurve?: number[];
  baselineExposureOffset?: number;
  defaultBlackRender?: number;
  embedPolicy?: number;
  extraTags?: RawTag[];
}

export function buildDcp(spec: DcpSpec): Uint8Array {
  const tags: RawTag[] = [
    ascii(50708, spec.camera ?? 'Test Camera'),
    ascii(50936, spec.name ?? 'Test Standard'),
    ascii(50942, spec.copyright ?? 'Synthetic test profile'),
    shorts(50778, [spec.illuminants?.[0] ?? ILLUMINANT_A]),
    shorts(50779, [spec.illuminants?.[1] ?? ILLUMINANT_D65]),
    longs(50941, [spec.embedPolicy ?? 0]),
  ];
  const color = spec.color;
  if (color?.[0]) tags.push(matrixTag(50721, color[0]));
  if (color?.[1]) tags.push(matrixTag(50722, color[1]));
  const forward = spec.forward;
  if (forward?.[0]) tags.push(matrixTag(50964, forward[0]));
  if (forward?.[1]) tags.push(matrixTag(50965, forward[1]));
  const first = spec.hueSat?.[0];
  if (first) {
    tags.push(longs(50937, [first.hueDivisions, first.satDivisions, first.valDivisions]));
    tags.push(floatTag(50938, first.data));
    tags.push(longs(51107, [first.srgbEncoding ? 1 : 0]));
    const second = spec.hueSat?.[1];
    if (second) tags.push(floatTag(50939, second.data));
  }
  if (spec.look) {
    const l = spec.look;
    tags.push(longs(50981, [l.hueDivisions, l.satDivisions, l.valDivisions]));
    tags.push(floatTag(50982, l.data));
    tags.push(longs(51108, [l.srgbEncoding ? 1 : 0]));
  }
  if (spec.toneCurve) tags.push(floatTag(50940, spec.toneCurve));
  if (spec.baselineExposureOffset !== undefined) {
    tags.push({
      tag: 51109,
      type: TYPE_SRATIONAL,
      bytes: rationals([spec.baselineExposureOffset]),
      count: 1,
    });
  }
  if (spec.defaultBlackRender !== undefined) tags.push(longs(51110, [spec.defaultBlackRender]));
  tags.push(...(spec.extraTags ?? []));
  return writeTiffProfile(tags);
}

/** A table whose every node leaves the colour as it is (no hue shift, scales of 1). */
export function identityTable(hue = 6, sat = 3, val = 2, srgbEncoding = false): ProfileTable {
  const data: number[] = [];
  for (let i = 0; i < hue * sat * val; i++) data.push(0, 1, 1);
  return { hueDivisions: hue, satDivisions: sat, valDivisions: val, srgbEncoding, data };
}

/** Sets one node of a table (value index, hue index, saturation index). */
export function setNode(
  table: ProfileTable,
  v: number,
  h: number,
  s: number,
  node: [shift: number, sat: number, val: number],
): ProfileTable {
  const data = [...table.data];
  const at = ((v * table.hueDivisions + h) * table.satDivisions + s) * 3;
  data[at] = node[0];
  data[at + 1] = node[1];
  data[at + 2] = node[2];
  return { ...table, data };
}

export const IDENTITY_TONE = [0, 0, 1, 1];

/** A profile as the parser returns it, for tests that do not need a file. */
export function profileData(over: Partial<CameraProfileData> = {}): CameraProfileData {
  return {
    name: 'Test Standard',
    camera: 'Test Camera',
    copyright: '',
    illuminants: [2856, 6504],
    colorMatrices: [],
    forwardMatrices: [],
    hueSatMaps: [],
    baselineExposureOffset: 0,
    defaultBlackRender: 'auto',
    embedPolicy: 0,
    ...over,
  };
}

// --- XMP looks ---------------------------------------------------------------------------------

/** The bytes of a version 1 or 2 HSV big table, the way Adobe stores a look's table. */
export function bigTableBytes(table: ProfileTable, bounds?: [number, number]): Uint8Array {
  const count = table.data.length / 3;
  const version = bounds ? 2 : 1;
  const tail = version === 2 ? 20 : 4;
  const out = Buffer.alloc(20 + count * 12 + tail);
  out.writeUInt32LE(0, 0);
  out.writeUInt32LE(version, 4);
  out.writeUInt32LE(table.hueDivisions, 8);
  out.writeUInt32LE(table.satDivisions, 12);
  out.writeUInt32LE(table.valDivisions, 16);
  table.data.forEach((v, i) => out.writeFloatLE(v, 20 + i * 4));
  const end = 20 + count * 12;
  out.writeUInt32LE(table.srgbEncoding ? 1 : 0, end);
  if (bounds) {
    out.writeDoubleLE(bounds[0], end + 4);
    out.writeDoubleLE(bounds[1], end + 12);
  }
  return out;
}

export interface LookSpec {
  name?: string;
  uuid?: string;
  base?: string | null;
  table?: ProfileTable;
  bounds?: [number, number];
  supportsAmount?: boolean;
  /** `crs:ToneCurvePV2012` points on 0..255. */
  curve?: [number, number][];
  attributes?: Record<string, string>;
}

const TABLE_ID = '0123456789abcdef0123456789abcdef';

/** A look profile `.xmp`, in the shape Camera Raw writes (attributes on the description, curve as `rdf:Seq`). */
export function buildLookXmp(spec: LookSpec): string {
  const attrs: Record<string, string> = {
    'crs:PresetType': 'Look',
    'crs:UUID': spec.uuid ?? 'B952C231111CD8E0ECCF14B86BAA7077',
    'crs:SupportsAmount': spec.supportsAmount ? 'True' : 'False',
    'crs:Version': '14.3',
    'crs:ProcessVersion': '11.0',
    'crs:ConvertToGrayscale': 'False',
    ...(spec.base === null ? {} : { 'crs:CameraProfile': spec.base ?? 'Test Standard' }),
    ...spec.attributes,
  };
  if (spec.table) {
    attrs['crs:LookTable'] = TABLE_ID;
    attrs[`crs:Table_${TABLE_ID}`] = compressBigTable(bigTableBytes(spec.table, spec.bounds));
  }
  const attributeText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const curve = spec.curve
    ? `<crs:ToneCurvePV2012><rdf:Seq>${spec.curve
        .map(([x, y]) => `<rdf:li>${x}, ${y}</rdf:li>`)
        .join('')}</rdf:Seq></crs:ToneCurvePV2012>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributeText}>
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">${spec.name ?? 'Test Color'}</rdf:li></rdf:Alt></crs:Name>
   <crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Profiles</rdf:li></rdf:Alt></crs:Group>
   ${curve}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}
