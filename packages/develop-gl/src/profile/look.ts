import { deflateSync, inflateSync } from 'node:zlib';
import { LOOK_SETTING_KEYS, type LookProfileData, type ProfileTable } from '@ee/contracts';
import { XMLParser } from 'fast-xml-parser';
import { checkTable, ProfileParseError } from './dcp';

/**
 * Reader for XMP profiles (Lightroom's "looks": Adobe Color, Landscape, Portrait, Vivid, Neutral).
 * An XMP profile is a `crs:` description with `PresetType="Look"` that names the camera profile it
 * goes over (`crs:CameraProfile`), an HSV table (`crs:LookTable` names a `crs:Table_<md5>`
 * attribute holding it) and a tone curve (`crs:ToneCurvePV2012`).
 *
 * The table encoding (Adobe's base 85 over zlib, a DNG SDK "big table") and the meaning of the
 * attributes follow the Adobe DNG SDK and RAWmakase (MIT, `crates/rawmakase-model/src/camera_profiles/enhanced.rs`
 * and `docs/lightroom-profiles.md`).
 *
 * Not supported, and refused with a reason instead of rendered wrongly: RGB tables (creative looks:
 * Artistic, Vintage, Modern, and the camera-matching looks that carry one), monochrome looks, looks
 * that need the photo's own RGB tables, and any develop setting inside a look other than
 * {@link LOOK_SETTING_KEYS}.
 */

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';

const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`'|()[]{}@%$#";
const DIGIT = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

const MAX_TEXT = 16_000_000;
const MAX_EXPANDED = 12_000_048;

/** The attributes that describe the look and are not develop settings. */
const META_ATTRIBUTES: ReadonlySet<string> = new Set([
  'PresetType',
  'Cluster',
  'UUID',
  'SupportsAmount',
  'SupportsColor',
  'SupportsMonochrome',
  'SupportsHighDynamicRange',
  'SupportsNormalDynamicRange',
  'SupportsSceneReferred',
  'SupportsOutputReferred',
  'CameraModelRestriction',
  'Copyright',
  'ContactInfo',
  'Version',
  'ProcessVersion',
  'ConvertToGrayscale',
  'CameraProfile',
  'LookTable',
  'RGBTable',
  'RGBTableAmount',
  'RequiresRGBTables',
  'ShowInPresets',
  'ShowInQuickActions',
  'HasSettings',
]);

/** Adobe's base 85 over zlib, the expanded length (u32 LE) first: the bytes of a big table. */
export function expandBigTable(text: string): Buffer {
  if (text.length > MAX_TEXT) throw new ProfileParseError('Look table too large');
  const digits = [...text].filter((c) => !/\s/.test(c));
  if (digits.length % 5 === 1) throw new ProfileParseError('Truncated base 85 table');
  const compressed = Buffer.alloc(Math.floor((digits.length * 4) / 5));
  let out = 0;
  for (let i = 0; i < digits.length; i += 5) {
    const chunk = digits.slice(i, i + 5);
    let value = 0;
    let power = 1;
    for (const c of chunk) {
      const d = DIGIT.get(c);
      if (d === undefined) throw new ProfileParseError('Invalid base 85 table');
      value += d * power;
      power *= 85;
    }
    if (value > 0xffffffff) throw new ProfileParseError('Base 85 overflow');
    for (let b = 0; b < chunk.length - 1; b++)
      compressed[out++] = Math.floor(value / 256 ** b) & 255;
  }
  if (compressed.length < 5) throw new ProfileParseError('Truncated compressed table');
  const expected = compressed.readUInt32LE(0);
  if (expected > MAX_EXPANDED) throw new ProfileParseError('Expanded look table too large');
  let data: Buffer;
  try {
    data = inflateSync(compressed.subarray(4), { maxOutputLength: expected + 1 });
  } catch {
    throw new ProfileParseError('Invalid compressed look table');
  }
  if (data.length !== expected) throw new ProfileParseError('Invalid expanded table size');
  return data;
}

/** The inverse of {@link expandBigTable}; used to build test profiles. */
export function compressBigTable(bytes: Uint8Array): string {
  const body = deflateSync(bytes);
  const compressed = Buffer.alloc(4 + body.length);
  compressed.writeUInt32LE(bytes.length, 0);
  body.copy(compressed, 4);
  let text = '';
  for (let i = 0; i < compressed.length; i += 4) {
    let value = 0;
    const n = Math.min(4, compressed.length - i);
    for (let b = 0; b < n; b++) value += (compressed[i + b] ?? 0) * 256 ** b;
    for (let d = 0; d < n + 1; d++) {
      text += ALPHABET[value % 85];
      value = Math.floor(value / 85);
    }
  }
  return text;
}

interface DecodedLookTable {
  table: ProfileTable;
  bounds: [number, number];
}

/** A DNG SDK big table of type 0 (HSV, "look table"), version 1 or 2. */
export function decodeLookTable(text: string): DecodedLookTable {
  const data = expandBigTable(text);
  if (data.length < 24) throw new ProfileParseError('Invalid expanded table size');
  const word = (at: number): number => data.readUInt32LE(at);
  if (word(0) !== 0 || (word(4) !== 1 && word(4) !== 2)) {
    throw new ProfileParseError('Unsupported big table type (an HSV look table is required)');
  }
  const dims = [word(8), word(12), word(16)] as const;
  if (!dims.every((d) => d >= 1 && d <= 256)) {
    throw new ProfileParseError('Invalid look table dimensions');
  }
  const count = dims[0] * dims[1] * dims[2];
  if (count > 1_000_000) throw new ProfileParseError('Look table too large');
  const end = 20 + count * 12;
  const tail = word(4) === 2 ? 20 : 4;
  if (data.length !== end + tail && data.length !== end + tail + 4) {
    throw new ProfileParseError('Invalid look table payload size');
  }
  const encoding = word(end);
  if (encoding > 1) throw new ProfileParseError('Unsupported look table encoding');
  let bounds: [number, number] = [1, 1];
  if (word(4) === 2) {
    const min = data.readDoubleLE(end + 4);
    const max = data.readDoubleLE(end + 12);
    if (!(min >= 0 && min <= 1 && max >= 1 && Number.isFinite(max))) {
      throw new ProfileParseError('Invalid look table amount bounds');
    }
    bounds = [min, Math.min(max, 2)];
  }
  if (data.length === end + tail + 4 && word(end + tail) !== 0) {
    throw new ProfileParseError('Unsupported look table flags');
  }
  const values: number[] = new Array<number>(count * 3);
  for (let i = 0; i < count * 3; i++) values[i] = data.readFloatLE(20 + i * 4);
  const table: ProfileTable = {
    hueDivisions: dims[0],
    satDivisions: dims[1],
    valDivisions: dims[2],
    srgbEncoding: encoding === 1,
    data: values,
  };
  checkTable(table);
  return { table, bounds };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => name === 'rdf:li',
});

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isNode(v) && typeof v['#text'] === 'string') return v['#text'];
  return undefined;
}

function listItems(v: unknown): unknown[] | undefined {
  if (!isNode(v)) return undefined;
  for (const kind of ['rdf:Seq', 'rdf:Bag', 'rdf:Alt']) {
    const inner = v[kind];
    if (isNode(inner) && Array.isArray(inner['rdf:li'])) return inner['rdf:li'] as unknown[];
  }
  return undefined;
}

/** A language alternative's `x-default` text, else the first entry. */
function altText(v: unknown): string | undefined {
  const items = listItems(v);
  if (!items) return textOf(v);
  const preferred = items.find((i) => isNode(i) && i['@_xml:lang'] === 'x-default') ?? items[0];
  return textOf(preferred);
}

function findRdfDescription(doc: unknown): Node | undefined {
  if (!isNode(doc)) return undefined;
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'rdf:Description') {
      const first = Array.isArray(value) ? value[0] : value;
      if (isNode(first)) return first;
    } else if (!key.startsWith('@_')) {
      const found = findRdfDescription(value);
      if (found) return found;
    }
  }
  return undefined;
}

const boolean = (v: string | undefined): boolean | undefined => {
  if (v === undefined || v === '') return undefined;
  const t = v.toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  throw new ProfileParseError(`Invalid boolean "${v}"`);
};

/** Reads a curve from `rdf:li` items `"x, y"` on 0..255; returns `[x0, y0, ...]` in 0..1. */
function readCurve(items: unknown[]): number[] {
  const out: number[] = [];
  for (const item of items) {
    const [x, y] = (textOf(item) ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ProfileParseError('Invalid look curve point');
    }
    out.push(Math.min(1, Math.max(0, x / 255)), Math.min(1, Math.max(0, y / 255)));
  }
  return out;
}

const isIdentityPoints = (c: number[]): boolean =>
  c.length === 4 && c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1;

/** Parses an XMP look profile. Throws {@link ProfileParseError} for a file that is not one, or not one we render. */
export function parseLookXmp(text: string): LookProfileData {
  let doc: unknown;
  try {
    doc = xml.parse(text);
  } catch (error) {
    throw new ProfileParseError(
      `Not valid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const d = findRdfDescription(doc);
  if (!d) throw new ProfileParseError('No profile description in the file');

  // The conventional prefix is `crs`, but honour whatever the file binds to the namespace.
  let prefix = 'crs';
  for (const [key, value] of Object.entries(d)) {
    if (key.startsWith('@_xmlns:') && value === CRS) prefix = key.slice('@_xmlns:'.length);
  }
  const tag = `${prefix}:`;
  const attr = (name: string): string | undefined => {
    const v = d[`@_${tag}${name}`];
    return typeof v === 'string' ? v : undefined;
  };
  if (attr('PresetType') !== 'Look') throw new ProfileParseError('The XMP is not a look profile');

  const attributes = Object.keys(d)
    .filter((k) => k.startsWith(`@_${tag}`))
    .map((k) => k.slice(2 + tag.length));
  const settings: LookProfileData['settings'] = {};
  for (const name of attributes) {
    if (META_ATTRIBUTES.has(name) || name.startsWith('Table_')) continue;
    if ((LOOK_SETTING_KEYS as readonly string[]).includes(name)) {
      const n = Number(attr(name));
      if (!Number.isFinite(n)) throw new ProfileParseError(`Invalid ${name}`);
      if (n !== 0) settings[name as keyof typeof settings] = n;
      continue;
    }
    throw new ProfileParseError(`The look sets ${name}, which is not supported inside a profile`);
  }

  if (boolean(attr('ConvertToGrayscale')) === true) {
    throw new ProfileParseError('Monochrome looks are not supported');
  }
  if (boolean(attr('RequiresRGBTables')) === true) {
    throw new ProfileParseError("The look needs the photo's own RGB tables");
  }
  if (attr('RGBTable')) {
    throw new ProfileParseError('Looks with an RGB table are not supported');
  }

  const name = altText(d[`${tag}Name`]) ?? attr('Name');
  if (!name) throw new ProfileParseError('The look has no name');
  const base = attr('CameraProfile') ?? '';
  if (base === '') {
    throw new ProfileParseError(
      'The look names no camera profile (creative looks are not supported)',
    );
  }

  const tableId = attr('LookTable');
  let table: ProfileTable | undefined;
  let bounds: [number, number] = [1, 1];
  if (tableId) {
    if (!/^[0-9a-f]{32}$/i.test(tableId)) throw new ProfileParseError('Invalid LookTable id');
    const encoded = attr(`Table_${tableId}`);
    if (encoded === undefined) throw new ProfileParseError("The look's table is not in the file");
    ({ table, bounds } = decodeLookTable(encoded));
  }

  let curve: number[] | undefined;
  for (const [key, value] of Object.entries(d)) {
    if (!key.startsWith(`${tag}ToneCurvePV2012`)) continue;
    const items = listItems(value);
    if (!items) continue;
    const points = readCurve(items);
    if (key === `${tag}ToneCurvePV2012`) {
      if (!isIdentityPoints(points)) curve = points;
    } else if (!isIdentityPoints(points)) {
      throw new ProfileParseError(`Per-channel curve ${key.slice(tag.length)} is not supported`);
    }
  }
  if (!table && !curve && Object.keys(settings).length === 0) {
    throw new ProfileParseError('The look changes nothing this app can render');
  }

  const supportsAmount = boolean(attr('SupportsAmount')) === true;
  return {
    name,
    uuid: attr('UUID') ?? '',
    group: altText(d[`${tag}Group`]) ?? '',
    base,
    restriction: attr('CameraModelRestriction') ?? '',
    copyright: attr('Copyright') ?? '',
    supportsAmount,
    ...(table ? { table } : {}),
    tableBounds: supportsAmount ? bounds : [1, 1],
    ...(curve ? { curve } : {}),
    settings,
  };
}
