import { readFile } from 'node:fs/promises';
import { ExportError } from '../errors';

/** Where a preview/thumbnail was found inside a JPEG. */
export type PreviewFindingKind =
  | 'exif-ifd1'
  | 'exif-thumbnail-tags'
  | 'exif-jpgfromraw'
  | 'exif-previewimage'
  | 'exif-embedded-jpeg'
  | 'photoshop-thumbnail'
  | 'xmp-thumbnail';

export interface PreviewFinding {
  kind: PreviewFindingKind;
  /** Human-readable location, e.g. the TIFF offset or IRB resource id. */
  detail: string;
}

/** The encoded JPEG still contains a thumbnail or preview of the unretouched image. */
export class EmbeddedPreviewError extends ExportError {
  readonly findings: PreviewFinding[];

  constructor(path: string, findings: PreviewFinding[]) {
    super('embedded_preview', `JPEG contains embedded preview data: ${path}`, { cause: undefined });
    this.name = 'EmbeddedPreviewError';
    this.findings = findings;
  }
}

const SOI = 0xffd8;
const APP1 = 0xe1;
const APP13 = 0xed;
const SOS = 0xda;
const EOI = 0xd9;

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_STANDARD = 'http://ns.adobe.com/xap/1.0/';
const XMP_EXTENDED = 'http://ns.adobe.com/xmp/extension/';
const PHOTOSHOP_HEADER = 'Photoshop 3.0\0';

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;
const TAG_SUB_IFDS = 0x014a;
const TAG_JPEG_INTERCHANGE_FORMAT = 0x0201;
const TAG_JPEG_INTERCHANGE_FORMAT_LENGTH = 0x0202;
const TAG_STRIP_OFFSETS = 0x0111;
const TAG_STRIP_BYTE_COUNTS = 0x0117;
const TAG_JPEG_FROM_RAW = 0x002e;
const TAG_PREVIEW_IMAGE = 0xc51b;

/**
 * Finds thumbnails and previews embedded in a JPEG (EXIF IFD1, JpgFromRaw,
 * PreviewImage, Photoshop IRB thumbnails and XMP thumbnails).
 *
 * This is deliberately structural rather than a byte-pattern scan for the
 * metadata containers, so a clean file passes even when its image data happens
 * to contain arbitrary bytes.
 */
export function inspectJpegPreviews(data: Uint8Array): PreviewFinding[] {
  const findings: PreviewFinding[] = [];

  if (data.length < 4 || readU16BE(data, 0) !== SOI) {
    throw new ExportError('invalid_image', 'Not a JPEG file (missing SOI marker)');
  }

  let offset = 2;
  while (offset < data.length) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    if (data[offset] !== 0xff) {
      throw new ExportError('invalid_image', `Malformed JPEG marker at offset ${offset}`);
    }
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset]!;
    offset++;

    if (marker === EOI) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > data.length) {
      throw new ExportError('invalid_image', 'Truncated JPEG segment header');
    }
    const length = readU16BE(data, offset)!;
    if (length < 2 || offset + length > data.length) {
      throw new ExportError('invalid_image', 'Truncated JPEG segment');
    }
    const payload = data.subarray(offset + 2, offset + length);
    offset += length;

    if (marker === APP1) inspectApp1(payload, findings);
    else if (marker === APP13) inspectApp13(payload, findings);

    // Image data follows SOS; metadata segments cannot appear after it.
    if (marker === SOS) break;
  }

  return dedupe(findings);
}

/** Reads a JPEG from disk and returns every embedded preview finding. */
export async function findEmbeddedPreviews(jpegPath: string): Promise<PreviewFinding[]> {
  const data = await readFile(jpegPath);
  return inspectJpegPreviews(data);
}

/**
 * Throws {@link EmbeddedPreviewError} when the JPEG contains any thumbnail or
 * preview. Export runs this after the metadata hook, so a hook that copies an
 * original preview fails the export instead of leaking it.
 */
export async function assertNoEmbeddedPreviews(jpegPath: string): Promise<void> {
  const findings = await findEmbeddedPreviews(jpegPath);
  if (findings.length > 0) throw new EmbeddedPreviewError(jpegPath, findings);
}

function inspectApp1(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (startsWith(payload, EXIF_HEADER)) {
    inspectTiff(payload.subarray(EXIF_HEADER.length), findings);
    return;
  }
  const head = latin1(payload, 0, Math.min(payload.length, 64));
  if (head.startsWith(XMP_STANDARD) || head.startsWith(XMP_EXTENDED)) {
    inspectXmp(payload, findings);
  }
}

function inspectApp13(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, Buffer.from(PHOTOSHOP_HEADER, 'latin1'))) return;
  inspectPhotoshopIrbs(payload.subarray(PHOTOSHOP_HEADER.length), findings);
}

function inspectTiff(tiff: Uint8Array, findings: PreviewFinding[]): void {
  if (tiff.length < 8) return;
  const byteOrder = latin1(tiff, 0, 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') return;

  const u16 = (at: number): number | undefined =>
    little ? readU16LE(tiff, at) : readU16BE(tiff, at);
  const u32 = (at: number): number | undefined =>
    little ? readU32LE(tiff, at) : readU32BE(tiff, at);

  if (u16(2) !== 42) return;
  const ifd0 = u32(4);
  if (ifd0 === undefined || ifd0 >= tiff.length) return;

  const visited = new Set<number>();
  const queue: { offset: number; thumbnailIfd: boolean; label: string }[] = [
    { offset: ifd0, thumbnailIfd: false, label: 'IFD0' },
  ];

  while (queue.length > 0 && visited.size < 64) {
    const current = queue.shift()!;
    if (visited.has(current.offset)) continue;
    visited.add(current.offset);

    if (current.thumbnailIfd) {
      findings.push({
        kind: 'exif-ifd1',
        detail: `${current.label} at TIFF offset ${current.offset}`,
      });
    }

    const count = u16(current.offset);
    if (count === undefined || count > 512) continue;
    const entriesStart = current.offset + 2;
    const nextOffsetAt = entriesStart + count * 12;
    if (nextOffsetAt + 4 > tiff.length) continue;

    for (let index = 0; index < count; index++) {
      const entry = entriesStart + index * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      if (tag === undefined || type === undefined || valueCount === undefined) break;

      if (tag === TAG_JPEG_INTERCHANGE_FORMAT || tag === TAG_JPEG_INTERCHANGE_FORMAT_LENGTH) {
        findings.push({
          kind: 'exif-thumbnail-tags',
          detail: `tag 0x${tag.toString(16)} in ${current.label}`,
        });
      }
      if (tag === TAG_JPEG_FROM_RAW) {
        findings.push({ kind: 'exif-jpgfromraw', detail: `tag 0x002e in ${current.label}` });
      }
      if (tag === TAG_PREVIEW_IMAGE) {
        findings.push({ kind: 'exif-previewimage', detail: `tag 0xc51b in ${current.label}` });
      }
      if (current.thumbnailIfd && (tag === TAG_STRIP_OFFSETS || tag === TAG_STRIP_BYTE_COUNTS)) {
        findings.push({
          kind: 'exif-ifd1',
          detail: `strips in ${current.label} at TIFF offset ${current.offset}`,
        });
      }

      if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === TAG_INTEROP_IFD) {
        const target = readSingleOffset(tiff, little, type, valueCount, entry);
        if (target !== undefined) {
          queue.push({ offset: target, thumbnailIfd: false, label: labelForTag(tag) });
        }
      } else if (tag === TAG_SUB_IFDS) {
        for (const target of readOffsets(tiff, little, type, valueCount, entry)) {
          queue.push({ offset: target, thumbnailIfd: false, label: 'SubIFD' });
        }
      }
    }

    const next = u32(nextOffsetAt);
    if (next !== undefined && next !== 0 && next < tiff.length) {
      queue.push({ offset: next, thumbnailIfd: true, label: 'IFD1' });
    }
  }

  // Any JPEG stream inside EXIF (a maker note, an unlinked thumbnail, ...) is
  // also a preview of the image and must not survive an export.
  const embeddedAt = indexOfJpegStart(tiff);
  if (embeddedAt >= 0) {
    findings.push({
      kind: 'exif-embedded-jpeg',
      detail: `JPEG stream at TIFF offset ${embeddedAt}`,
    });
  }
}

function readSingleOffset(
  tiff: Uint8Array,
  little: boolean,
  type: number,
  count: number,
  entry: number,
): number | undefined {
  const offsets = readOffsets(tiff, little, type, count, entry);
  return offsets[0];
}

function readOffsets(
  tiff: Uint8Array,
  little: boolean,
  type: number,
  count: number,
  entry: number,
): number[] {
  const unit = TYPE_SIZES[type];
  if (unit === undefined || count === 0 || count > 64) return [];
  const size = unit * count;
  let base: number;
  if (size <= 4) {
    base = entry + 8;
  } else {
    const offset = little ? readU32LE(tiff, entry + 8) : readU32BE(tiff, entry + 8);
    if (offset === undefined) return [];
    base = offset;
  }
  if (base + size > tiff.length) return [];

  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = base + index * unit;
    if (type === 3) {
      const value = little ? readU16LE(tiff, at) : readU16BE(tiff, at);
      if (value !== undefined) offsets.push(value);
    } else if (type === 4 || type === 13) {
      const value = little ? readU32LE(tiff, at) : readU32BE(tiff, at);
      if (value !== undefined) offsets.push(value);
    }
  }
  return offsets;
}

function inspectPhotoshopIrbs(data: Uint8Array, findings: PreviewFinding[]): void {
  let offset = 0;
  while (offset + 12 <= data.length) {
    if (latin1(data, offset, offset + 4) !== '8BIM') return;
    const resourceId = readU16BE(data, offset + 4);
    if (resourceId === undefined) return;
    const nameLength = data[offset + 6]!;
    let nameFieldLength = 1 + nameLength;
    if (nameFieldLength % 2 !== 0) nameFieldLength++;
    const sizeAt = offset + 6 + nameFieldLength;
    const size = readU32BE(data, sizeAt);
    if (size === undefined) return;
    const dataAt = sizeAt + 4;
    if (dataAt + size > data.length) return;

    // 0x0409: ThumbnailResource, 0x040c: ThumbnailResource (Photoshop 4).
    if (resourceId === 0x0409 || resourceId === 0x040c) {
      findings.push({
        kind: 'photoshop-thumbnail',
        detail: `IRB resource 0x${resourceId.toString(16)}`,
      });
    }

    offset = dataAt + size + (size % 2);
  }
}

function inspectXmp(payload: Uint8Array, findings: PreviewFinding[]): void {
  const text = latin1(payload, 0, payload.length).toLowerCase();
  const markers: [string, string][] = [
    ['xmptng:image', 'xmptng:image'],
    ['xmpgimg:image', 'xmpGImg:image'],
    ['xapgimg:image', 'xapGImg:image'],
    ['xmp:thumbnails', 'xmp:Thumbnails'],
    ['xap:thumbnails', 'xap:Thumbnails'],
    ['ns.adobe.com/xap/1.0/g/img/', 'xmpGImg namespace'],
  ];
  for (const [needle, detail] of markers) {
    if (text.includes(needle)) findings.push({ kind: 'xmp-thumbnail', detail });
  }
}

function labelForTag(tag: number): string {
  if (tag === TAG_EXIF_IFD) return 'ExifIFD';
  if (tag === TAG_GPS_IFD) return 'GPSIFD';
  return 'InteropIFD';
}

function indexOfJpegStart(data: Uint8Array): number {
  for (let index = 0; index + 2 < data.length; index++) {
    if (data[index] === 0xff && data[index + 1] === 0xd8 && data[index + 2] === 0xff) {
      return index;
    }
  }
  return -1;
}

function dedupe(findings: PreviewFinding[]): PreviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.kind}\0${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

function latin1(data: Uint8Array, start: number, end: number): string {
  return Buffer.from(data.buffer, data.byteOffset + start, Math.max(0, end - start)).toString(
    'latin1',
  );
}

function readU16BE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > data.length) return undefined;
  return (data[offset]! << 8) | data[offset + 1]!;
}

function readU16LE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > data.length) return undefined;
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32BE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  return (
    data[offset]! * 0x1000000 +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  );
}

function readU32LE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  return (
    data[offset]! +
    (data[offset + 1]! << 8) +
    (data[offset + 2]! << 16) +
    data[offset + 3]! * 0x1000000
  );
}
