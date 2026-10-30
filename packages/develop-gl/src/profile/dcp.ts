import type { CameraProfileData, ProfileTable } from '@ee/contracts';

/**
 * Reader for DNG Camera Profiles (`.dcp`): a TIFF-like file (byte order mark, magic `0x4352` "RC"
 * instead of 42, one IFD of profile tags) defined by the DNG specification 1.6. Only the tags the
 * develop pipeline uses are read. The files are the user's (Adobe's); nothing here ships a profile.
 *
 * Tag numbers and semantics are from the DNG specification; the interpretation (which table is
 * which, the node order of a HueSatMap) follows the Adobe DNG SDK (`dng_camera_profile`,
 * `dng_hue_sat_map`), which is distributed under a permissive licence, and RAWmakase (MIT).
 */

export class ProfileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileParseError';
  }
}

const TAG = {
  uniqueCameraModel: 50708,
  colorMatrix1: 50721,
  colorMatrix2: 50722,
  calibrationIlluminant1: 50778,
  calibrationIlluminant2: 50779,
  profileName: 50936,
  hueSatMapDims: 50937,
  hueSatMapData1: 50938,
  hueSatMapData2: 50939,
  toneCurve: 50940,
  embedPolicy: 50941,
  copyright: 50942,
  forwardMatrix1: 50964,
  forwardMatrix2: 50965,
  lookTableDims: 50981,
  lookTableData: 50982,
  hueSatMapEncoding: 51107,
  lookTableEncoding: 51108,
  baselineExposureOffset: 51109,
  defaultBlackRender: 51110,
} as const;

/** DNG 1.6 profile tags this reader does not understand: a profile using them would render wrongly. */
const UNSUPPORTED_TAGS: ReadonlyMap<number, string> = new Map([
  [52531, 'a third calibration illuminant'],
  [52537, 'a third colour matrix'],
  [52538, 'a third forward matrix'],
  [52551, 'HDR profile data'],
]);

const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

const MAX_FILE_BYTES = 16_000_000;
const MAX_TABLE_NODES = 1_000_000;

interface Entry {
  type: number;
  count: number;
  /** Offset of the value bytes in the file. */
  offset: number;
}

/**
 * `CalibrationIlluminant` (an EXIF LightSource code) to a correlated colour temperature in kelvin,
 * as the DNG SDK's `LightSourceToColorTemp` takes it. Codes the SDK cannot place (`255` "other",
 * which DNG 1.6 pairs with illuminant data) are refused.
 */
export function illuminantKelvin(code: number): number {
  switch (code) {
    case 0: // unknown: the SDK treats the profile as D65-like
      return 6504;
    case 1: // daylight
    case 4: // flash
    case 9: // fine weather
    case 18: // standard light B
      return 5500;
    case 2:
      return 4200; // fluorescent
    case 3: // tungsten
    case 17: // standard light A
      return 2856;
    case 10: // cloudy weather
    case 19: // standard light C
      return 6500;
    case 11:
      return 7500; // shade
    case 12:
      return 6400; // daylight fluorescent
    case 13:
      return 5000; // day white fluorescent
    case 14:
      return 4000; // cool white fluorescent
    case 15:
      return 3500; // white fluorescent
    case 16:
      return 3000; // warm white fluorescent
    case 20: // D55
      return 5503;
    case 21: // D65
      return 6504;
    case 22: // D75
      return 7504;
    case 23: // D50
      return 5003;
    case 24: // ISO studio tungsten
      return 3200;
    default:
      throw new ProfileParseError(`Unsupported calibration illuminant ${code}`);
  }
}

class Ifd {
  private readonly view: DataView;
  private readonly little: boolean;
  private readonly entries = new Map<number, Entry>();
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length < 8 || bytes.length > MAX_FILE_BYTES) {
      throw new ProfileParseError('Not a DNG camera profile (bad size)');
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
    if (order !== 'II' && order !== 'MM') {
      throw new ProfileParseError('Not a DNG camera profile (bad byte order)');
    }
    this.little = order === 'II';
    const magic = this.view.getUint16(2, this.little);
    // Camera profiles use 0x4352 ("CR" read little endian); some tools write a plain TIFF 42.
    if (magic !== 0x4352 && magic !== 42) {
      throw new ProfileParseError('Not a DNG camera profile (bad header)');
    }
    const ifd = this.view.getUint32(4, this.little);
    this.require(ifd, 2);
    const count = this.view.getUint16(ifd, this.little);
    if (count > 512) throw new ProfileParseError('Too many profile tags');
    this.require(ifd + 2, count * 12);
    for (let i = 0; i < count; i++) {
      const at = ifd + 2 + i * 12;
      const tag = this.view.getUint16(at, this.little);
      const type = this.view.getUint16(at + 2, this.little);
      const n = this.view.getUint32(at + 4, this.little);
      const unit = TYPE_SIZE[type];
      if (unit === undefined) throw new ProfileParseError(`Unsupported tag type ${type}`);
      const size = n * unit;
      if (!Number.isSafeInteger(size)) throw new ProfileParseError('Tag size overflow');
      const offset = size <= 4 ? at + 8 : this.view.getUint32(at + 8, this.little);
      this.require(offset, size);
      this.entries.set(tag, { type, count: n, offset });
    }
  }

  private require(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.bytes.length) {
      throw new ProfileParseError('Profile tag lies outside the file');
    }
  }

  has(tag: number): boolean {
    return this.entries.has(tag);
  }

  tags(): number[] {
    return [...this.entries.keys()];
  }

  /** All values of a numeric tag; rationals are divided. */
  numbers(tag: number): number[] {
    const e = this.entries.get(tag);
    if (!e) throw new ProfileParseError(`Missing profile tag ${tag}`);
    const out: number[] = new Array<number>(e.count);
    const le = this.little;
    for (let i = 0; i < e.count; i++) {
      let v: number;
      switch (e.type) {
        case 1:
        case 7:
          v = this.view.getUint8(e.offset + i);
          break;
        case 6:
          v = this.view.getInt8(e.offset + i);
          break;
        case 3:
          v = this.view.getUint16(e.offset + i * 2, le);
          break;
        case 8:
          v = this.view.getInt16(e.offset + i * 2, le);
          break;
        case 4:
          v = this.view.getUint32(e.offset + i * 4, le);
          break;
        case 9:
          v = this.view.getInt32(e.offset + i * 4, le);
          break;
        case 5:
          v =
            this.view.getUint32(e.offset + i * 8, le) /
            this.view.getUint32(e.offset + i * 8 + 4, le);
          break;
        case 10:
          v =
            this.view.getInt32(e.offset + i * 8, le) / this.view.getInt32(e.offset + i * 8 + 4, le);
          break;
        case 11:
          v = this.view.getFloat32(e.offset + i * 4, le);
          break;
        case 12:
          v = this.view.getFloat64(e.offset + i * 8, le);
          break;
        default:
          throw new ProfileParseError(`Tag ${tag} is not numeric`);
      }
      if (!Number.isFinite(v)) throw new ProfileParseError(`Invalid number in profile tag ${tag}`);
      out[i] = v;
    }
    return out;
  }

  scalar(tag: number, fallback: number): number {
    if (!this.has(tag)) return fallback;
    const v = this.numbers(tag);
    if (v.length !== 1) throw new ProfileParseError(`Profile tag ${tag} should hold one value`);
    return v[0] ?? fallback;
  }

  text(tag: number): string {
    const e = this.entries.get(tag);
    if (!e) return '';
    const raw = this.bytes.subarray(e.offset, e.offset + e.count);
    return new TextDecoder('utf-8').decode(raw).replace(/\0+$/, '');
  }
}

function readMatrix(ifd: Ifd, tag: number): number[] | undefined {
  if (!ifd.has(tag)) return undefined;
  const m = ifd.numbers(tag);
  if (m.length !== 9) {
    throw new ProfileParseError('Only three-channel (RGB) camera profiles are supported');
  }
  return m;
}

/** Validates a table's dimensions and values. HSV tables hold hue shifts (degrees), then two scales. */
export function checkTable(table: ProfileTable): void {
  const { hueDivisions: h, satDivisions: s, valDivisions: v } = table;
  const dims = [h, s, v];
  if (!dims.every((d) => Number.isInteger(d) && d >= 1 && d <= 256)) {
    throw new ProfileParseError('Invalid profile table dimensions');
  }
  const nodes = h * s * v;
  if (nodes > MAX_TABLE_NODES || table.data.length !== nodes * 3) {
    throw new ProfileParseError('Invalid profile table size');
  }
  for (let i = 0; i < table.data.length; i += 3) {
    const shift = table.data[i] ?? 0;
    const sat = table.data[i + 1] ?? 0;
    const val = table.data[i + 2] ?? 0;
    if (!(Math.abs(shift) <= 360 && sat >= 0 && sat <= 10 && val >= 0 && val <= 10)) {
      throw new ProfileParseError('Invalid profile table value');
    }
  }
}

function readTable(
  ifd: Ifd,
  dims: number,
  data: number,
  encoding: number,
): ProfileTable | undefined {
  if (!ifd.has(data)) return undefined;
  const d = ifd.numbers(dims);
  if (d.length !== 3) throw new ProfileParseError('Invalid profile table dimensions');
  const enc = ifd.scalar(encoding, 0);
  if (enc !== 0 && enc !== 1) throw new ProfileParseError('Unsupported profile table encoding');
  const table: ProfileTable = {
    hueDivisions: d[0] ?? 0,
    satDivisions: d[1] ?? 0,
    valDivisions: d[2] ?? 0,
    srgbEncoding: enc === 1,
    data: ifd.numbers(data),
  };
  checkTable(table);
  return table;
}

/** Parses the bytes of a `.dcp` file. Throws {@link ProfileParseError} for anything it cannot render faithfully. */
export function parseDcp(bytes: Uint8Array): CameraProfileData {
  const ifd = new Ifd(bytes);
  for (const tag of ifd.tags()) {
    const what = UNSUPPORTED_TAGS.get(tag);
    if (what) throw new ProfileParseError(`This profile uses ${what}, which is not supported`);
  }

  const k1 = illuminantKelvin(ifd.scalar(TAG.calibrationIlluminant1, 21));
  const k2 = ifd.has(TAG.calibrationIlluminant2)
    ? illuminantKelvin(ifd.scalar(TAG.calibrationIlluminant2, 21))
    : k1;

  const color = [readMatrix(ifd, TAG.colorMatrix1), readMatrix(ifd, TAG.colorMatrix2)];
  const forward = [readMatrix(ifd, TAG.forwardMatrix1), readMatrix(ifd, TAG.forwardMatrix2)];
  if (!color[0] && !forward[0]) {
    throw new ProfileParseError('The profile has neither a ColorMatrix nor a ForwardMatrix');
  }

  const dims = TAG.hueSatMapDims;
  const encoding = TAG.hueSatMapEncoding;
  const maps = [
    readTable(ifd, dims, TAG.hueSatMapData1, encoding),
    readTable(ifd, dims, TAG.hueSatMapData2, encoding),
  ];
  if (!maps[0] && maps[1]) {
    throw new ProfileParseError('The profile has HueSatMap data for one illuminant only');
  }

  // Order everything by the illuminant's temperature, so the interpolation weight runs 0..1.
  const swap = k1 > k2;
  const pick = <T>(pair: (T | undefined)[]): T[] => {
    const first = pair[0];
    const second = pair[1];
    if (first === undefined) return [];
    if (second === undefined) return [first];
    return swap ? [second, first] : [first, second];
  };

  const toneCurve = ifd.has(TAG.toneCurve) ? ifd.numbers(TAG.toneCurve) : undefined;
  if (toneCurve && (toneCurve.length < 4 || toneCurve.length % 2 !== 0)) {
    throw new ProfileParseError('Invalid profile tone curve');
  }

  const look = readTable(ifd, TAG.lookTableDims, TAG.lookTableData, TAG.lookTableEncoding);

  return {
    name: ifd.text(TAG.profileName),
    camera: ifd.text(TAG.uniqueCameraModel),
    copyright: ifd.text(TAG.copyright),
    illuminants: k1 === k2 ? [k1] : swap ? [k2, k1] : [k1, k2],
    colorMatrices: pick(color),
    forwardMatrices: pick(forward),
    hueSatMaps: pick(maps),
    ...(look ? { look } : {}),
    ...(toneCurve ? { toneCurve } : {}),
    baselineExposureOffset: ifd.scalar(TAG.baselineExposureOffset, 0),
    // DNG 1.4: 1 is None; 0 (Auto) and every reserved value render as Auto.
    defaultBlackRender: ifd.scalar(TAG.defaultBlackRender, 0) === 1 ? 'none' : 'auto',
    embedPolicy: ifd.scalar(TAG.embedPolicy, 0),
  };
}
