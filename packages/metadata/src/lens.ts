import type { BuiltinLensCorrection, LensShotInfo } from '@ee/contracts';
import { open } from 'node:fs/promises';
import { getExifToolService, type ExifToolService } from './exiftool';
import { isRawPath } from './paths';
import { asNumber, asString } from './values';

/**
 * What the lens correction needs to know about a raw: the lens facts from EXIF and, for Nikon Z
 * bodies, the correction the camera stores in the NEF.
 *
 * Nikon keeps it in tag 0xC7D5 of the raw SubIFD ("NikonNEFInfo"), a small TIFF after a
 * `Nikon\0` header and four version bytes. Its entries 5 to 8 are records led by "0100":
 * distortion, vignetting, lateral CA and the optical centre. ExifTool does not decode them, so
 * they are read here. The layout was worked out by RAWmakase (MIT, `src/lens/embedded.rs`), which
 * compared it with Adobe's own output; see `docs/ARCHITECTURE.md`.
 */

const SUB_IFDS = 0x14a;
const NEF_INFO = 0xc7d5;
/** Where the inner TIFF starts in the NEFInfo blob: "Nikon\0" and four version bytes. */
const INNER_TIFF = 10;

class FileReader {
  constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}
  async bytes(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }
}

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  /** The 4 value/offset bytes. */
  field: Buffer;
}

const TYPE_SIZE: Record<number, number> = {
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
};

function numbers(little: boolean): {
  u16: (b: Buffer, o: number) => number;
  u32: (b: Buffer, o: number) => number;
} {
  return {
    u16: (b, o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o)),
    u32: (b, o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o)),
  };
}

async function readEntries(
  reader: FileReader,
  base: number,
  offset: number,
  little: boolean,
): Promise<TiffEntry[]> {
  const { u16, u32 } = numbers(little);
  const head = await reader.bytes(base + offset, 2);
  if (head.length < 2) return [];
  const count = u16(head, 0);
  if (count === 0 || count > 2000) return [];
  const raw = await reader.bytes(base + offset + 2, count * 12);
  const entries: TiffEntry[] = [];
  for (let i = 0; i + 12 <= raw.length; i += 12) {
    entries.push({
      tag: u16(raw, i),
      type: u16(raw, i + 2),
      count: u32(raw, i + 4),
      field: raw.subarray(i + 8, i + 12),
    });
  }
  return entries;
}

/** The value bytes of an entry, inline or at its offset (relative to `base`). */
async function entryBytes(
  reader: FileReader,
  base: number,
  entry: TiffEntry,
  little: boolean,
): Promise<Buffer> {
  const size = (TYPE_SIZE[entry.type] ?? 1) * entry.count;
  if (size <= 4) return entry.field.subarray(0, size);
  if (size > 1 << 20) return Buffer.alloc(0);
  return reader.bytes(base + numbers(little).u32(entry.field, 0), size);
}

function byteOrder(head: Buffer): boolean | undefined {
  const mark = head.toString('latin1', 0, 2);
  if (mark === 'II') return true;
  if (mark === 'MM') return false;
  return undefined;
}

/** The raw NEFInfo blob of a NEF, or undefined for anything else. */
export async function readNefInfo(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, 'r');
  try {
    const reader = new FileReader(handle);
    const head = await reader.bytes(0, 8);
    const little = byteOrder(head);
    if (head.length < 8 || little === undefined) return undefined;
    const { u32 } = numbers(little);
    const subIfds = (await readEntries(reader, 0, u32(head, 4), little)).find(
      (entry) => entry.tag === SUB_IFDS,
    );
    if (!subIfds) return undefined;
    const raw = await entryBytes(reader, 0, subIfds, little);
    for (let i = 0; i + 4 <= raw.length; i += 4) {
      const entries = await readEntries(reader, 0, u32(raw, i), little);
      const info = entries.find((entry) => entry.tag === NEF_INFO);
      if (info) return entryBytes(reader, 0, info, little);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Rationals (signed num/den) and integers of one record. */
function recordReader(record: Buffer, little: boolean) {
  const int = (at: number): number | undefined =>
    at + 4 <= record.length
      ? little
        ? record.readInt32LE(at)
        : record.readInt32BE(at)
      : undefined;
  const rational = (at: number): number | undefined => {
    const num = int(at);
    const den = int(at + 4);
    return num === undefined || den === undefined || den === 0 ? undefined : num / den;
  };
  /** `n` rationals after a count of `n` at `at`. */
  const list = (at: number, n: number): number[] | undefined => {
    if (int(at) !== n) return undefined;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const value = rational(at + 4 + 8 * i);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  };
  return { int, rational, list, byte: (at: number): number => record[at] ?? 0 };
}

/**
 * Polynomial with coefficients for descending powers of `q` down to `q^1`, as Nikon stores
 * them, as ascending coefficients from `q^0` with `constant` first.
 */
const ascending = (descending: readonly number[], constant: number, scale = 1): number[] => [
  constant,
  ...[...descending].reverse().map((c) => c * scale),
];

export interface NefFrame {
  /** Display (oriented) size of the full-resolution image, in pixels. */
  width: number;
  height: number;
  /** EXIF orientation of the stored raw. */
  orientation?: number;
}

/** Offsets in the sensor's frame as they appear in the displayed (oriented) picture. */
function orientOffset(dx: number, dy: number, orientation: number): [number, number] {
  switch (orientation) {
    case 3:
      return [-dx, -dy];
    case 6:
      return [-dy, dx];
    case 8:
      return [dy, -dx];
    default:
      return [dx, dy];
  }
}

/**
 * Parses NEFInfo. Returns undefined when the camera did not apply its distortion control
 * (bit 0 of the mode byte clear: Adobe applies nothing then, not even the vignetting) or the
 * records are not the ones this reads.
 */
export function parseNefInfo(blob: Buffer, frame: NefFrame): BuiltinLensCorrection | undefined {
  if (blob.length < INNER_TIFF + 8 || blob.toString('latin1', 0, 6) !== 'Nikon\0') return undefined;
  const inner = blob.subarray(INNER_TIFF);
  const little = byteOrder(inner);
  if (little === undefined) return undefined;
  const { u32 } = numbers(little);
  const { u16 } = numbers(little);
  const ifd = u32(inner, 4);
  if (ifd + 2 > inner.length) return undefined;
  const count = u16(inner, ifd);
  const records = new Map<number, Buffer>();
  for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= inner.length; i++) {
    const at = ifd + 2 + i * 12;
    const tag = u16(inner, at);
    const length = u32(inner, at + 4) * (TYPE_SIZE[u16(inner, at + 2)] ?? 1);
    const where = length <= 4 ? at + 8 : u32(inner, at + 8);
    const record = inner.subarray(where, where + length);
    if (record.length === length && record.toString('latin1', 0, 4) === '0100') {
      records.set(tag, record);
    }
  }
  const d = records.get(5);
  if (!d || d.length < 0x48) return undefined;
  const mode = d[4] ?? 0;
  if ((mode & 1) === 0) return undefined;
  const distortion = recordReader(d, little);
  const k = distortion.list(0x10, 4);
  const fill = distortion.rational(0x40);
  if (!k || fill === undefined) return undefined;
  const scale = 1 / (1 + fill);
  if (!(scale > 0) || !Number.isFinite(scale)) return undefined;

  const { width, height } = frame;
  const centreRecord = records.get(8);
  let dx = 0;
  let dy = 0;
  if (centreRecord && centreRecord.length >= 0x14) {
    const c = recordReader(centreRecord, little);
    [dx, dy] = orientOffset(c.rational(4) ?? 0, c.rational(12) ?? 0, frame.orientation ?? 1);
  }
  // q = 1 at the corner of the frame that is farthest from the optical centre.
  const cx = width / 2 + dx;
  const cy = height / 2 + dy;
  const farthest = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
  const half = Math.hypot(width, height) / 2;
  if (!(half > 0 && farthest > 0)) return undefined;

  const result: BuiltinLensCorrection = {
    source: 'Nikon built-in',
    // Bit 1: the lens needs the correction, which Camera Raw applies whatever the user chose.
    required: (mode & 2) !== 0,
    centre: { x: dx / width, y: dy / height },
    unit: farthest / half,
    distortion: ascending(k, scale, scale),
  };

  const v = records.get(6);
  if (v && v.length >= 0x68) {
    const vignette = recordReader(v, little);
    const coefficients = vignette.list(0x10, 8);
    const strength = vignette.rational(0x60);
    if (coefficients && strength !== undefined) {
      result.vignetting = ascending(coefficients, 1, strength);
    }
  }

  const ca = records.get(7);
  if (ca && ca.length >= 0x58) {
    const chroma = recordReader(ca, little);
    const plane = (at: number): number[] | undefined => {
      const c = chroma.list(at, 3);
      const constant = chroma.rational(at + 28);
      return c && constant !== undefined ? ascending(c, 1 + constant) : undefined;
    };
    const red = plane(0x10);
    const blue = plane(0x34);
    if (red && blue) {
      result.red = red;
      result.blue = blue;
    }
  }
  return result;
}

const leadingNumber = (value: unknown): number | undefined => {
  const direct = asNumber(value);
  if (direct !== undefined) return direct;
  const text = asString(value);
  const match = text === undefined ? null : /^\s*(-?\d+(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) : undefined;
};

/**
 * Lens facts of a raw file, or undefined when it is not a raw or names no lens. `frame` is the
 * full-resolution size of the decoded (oriented) image, which the camera's offsets refer to.
 */
export async function readLensShot(
  path: string,
  frame: { width: number; height: number },
  service: ExifToolService = getExifToolService(),
): Promise<LensShotInfo | undefined> {
  if (!isRawPath(path)) return undefined;
  const tags = await service.read(path);
  const make = asString(tags['IFD0:Make']);
  const shot: LensShotInfo = {};
  const set = <K extends keyof LensShotInfo>(key: K, value: LensShotInfo[K] | undefined): void => {
    if (value !== undefined && value !== '') shot[key] = value;
  };
  set('cameraMake', make);
  set('cameraModel', asString(tags['IFD0:Model']));
  set('lensModel', asString(tags['ExifIFD:LensModel']));
  set('focalLength', leadingNumber(tags['ExifIFD:FocalLength']));
  set('focalLength35', leadingNumber(tags['ExifIFD:FocalLengthIn35mmFormat']));
  set('fNumber', leadingNumber(tags['ExifIFD:FNumber']));
  set('focusDistance', leadingNumber(tags['Nikon:FocusDistance']));

  if (make?.toUpperCase().includes('NIKON')) {
    const blob = await readNefInfo(path).catch(() => undefined);
    const orientation = asNumber(tags['IFD0:Orientation']);
    const builtin =
      blob === undefined
        ? undefined
        : parseNefInfo(blob, { ...frame, ...(orientation === undefined ? {} : { orientation }) });
    if (builtin) shot.builtin = builtin;
  }
  return shot.lensModel !== undefined || shot.builtin !== undefined ? shot : undefined;
}
