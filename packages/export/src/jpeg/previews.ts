import { readFile } from 'node:fs/promises';
import { ExportError } from '../errors';

/** Where a preview/thumbnail or an unexpected metadata block was found. */
export type PreviewFindingKind =
  | 'exif-ifd1'
  | 'exif-thumbnail-tags'
  | 'exif-jpgfromraw'
  | 'exif-previewimage'
  | 'exif-embedded-jpeg'
  | 'photoshop-thumbnail'
  | 'xmp-thumbnail'
  | 'jfif-thumbnail'
  | 'unexpected-app'
  | 'unexpected-app0'
  | 'unexpected-app2'
  | 'unexpected-app13'
  | 'malformed-app'
  | 'malformed-exif'
  | 'malformed-photoshop'
  | 'malformed-jpeg'
  | 'trailing-data'
  | 'second-soi';

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
const EOI = 0xd9;
const SOS = 0xda;

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_STANDARD = 'http://ns.adobe.com/xap/1.0/';
const XMP_EXTENDED = 'http://ns.adobe.com/xmp/extension/';
const PHOTOSHOP_HEADER = 'Photoshop 3.0\0';
const ICC_HEADER = 'ICC_PROFILE\0';

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
 * Finds anything that could carry a preview of the original image.
 *
 * This is an allowlist: only the metadata blocks an export is allowed to have
 * are accepted (JFIF with no thumbnail, ICC, clean EXIF, clean XMP, clean
 * Photoshop IRB). Unknown APPn segments, malformed metadata, a second SOI or
 * bytes after EOI all fail closed.
 */
export function inspectJpegPreviews(data: Uint8Array): PreviewFinding[] {
  const findings: PreviewFinding[] = [];

  if (data.length < 4 || readU16BE(data, 0) !== SOI) {
    throw new ExportError('invalid_image', 'Not a JPEG file (missing SOI marker)');
  }

  const secondSoi = indexOfBytes(data, [0xff, 0xd8, 0xff], 2);
  if (secondSoi >= 0) {
    findings.push({ kind: 'second-soi', detail: `second SOI at offset ${secondSoi}` });
  }

  let offset = 2;
  let terminated = false;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      findings.push({ kind: 'malformed-jpeg', detail: `expected marker at offset ${offset}` });
      break;
    }
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated marker' });
      break;
    }
    const marker = data[offset]!;
    offset++;

    if (marker === EOI) {
      terminated = true;
      if (offset < data.length) {
        findings.push({
          kind: 'trailing-data',
          detail: `${data.length - offset} byte(s) after EOI`,
        });
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated segment header' });
      break;
    }
    const length = readU16BE(data, offset);
    if (length === undefined || length < 2 || offset + length > data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated segment' });
      break;
    }
    const payload = data.subarray(offset + 2, offset + length);
    offset += length;

    if (marker >= 0xe0 && marker <= 0xef) inspectAppSegment(marker, payload, findings);

    if (marker === SOS) {
      const eoi = findEoi(data, offset);
      if (eoi < 0) {
        findings.push({ kind: 'malformed-jpeg', detail: 'missing EOI' });
      } else {
        terminated = true;
        if (eoi + 2 < data.length) {
          findings.push({
            kind: 'trailing-data',
            detail: `${data.length - (eoi + 2)} byte(s) after EOI`,
          });
        }
      }
      break;
    }
  }

  if (!terminated && findings.length === 0) {
    findings.push({ kind: 'malformed-jpeg', detail: 'no EOI marker' });
  }

  return dedupe(findings);
}

/** Reads a JPEG from disk and returns every embedded preview finding. */
export async function findEmbeddedPreviews(jpegPath: string): Promise<PreviewFinding[]> {
  const data = await readFile(jpegPath);
  return inspectJpegPreviews(data);
}

/**
 * Throws {@link EmbeddedPreviewError} when the JPEG contains a thumbnail, a
 * preview or metadata that cannot be proven clean. Export runs this after the
 * metadata hook, so a hook that copies an original preview fails the export
 * instead of leaking it.
 */
export async function assertNoEmbeddedPreviews(jpegPath: string): Promise<void> {
  const findings = await findEmbeddedPreviews(jpegPath);
  if (findings.length > 0) throw new EmbeddedPreviewError(jpegPath, findings);
}

function inspectAppSegment(marker: number, payload: Uint8Array, findings: PreviewFinding[]): void {
  if (marker === 0xe0) {
    inspectJfif(payload, findings);
    return;
  }
  if (marker === 0xe1) {
    inspectApp1(payload, findings);
    return;
  }
  if (marker === 0xe2) {
    inspectApp2(payload, findings);
    return;
  }
  if (marker === 0xed) {
    inspectApp13(payload, findings);
    return;
  }
  findings.push({
    kind: 'unexpected-app',
    detail: `APP${marker - 0xe0} segment is not part of the export allowlist`,
  });
}

function inspectJfif(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, Buffer.from('JFIF\0', 'latin1'))) {
    findings.push({
      kind: 'unexpected-app0',
      detail: 'APP0 is not JFIF (JFXX and vendor APP0 blocks may carry previews)',
    });
    return;
  }
  // Identifier (5), version (2), units (1), densities (4), thumbnail size (2).
  if (payload.length < 14) {
    findings.push({ kind: 'malformed-app', detail: 'truncated JFIF header' });
    return;
  }
  const thumbnailWidth = payload[12]!;
  const thumbnailHeight = payload[13]!;
  if (thumbnailWidth !== 0 || thumbnailHeight !== 0) {
    findings.push({
      kind: 'jfif-thumbnail',
      detail: `JFIF thumbnail ${thumbnailWidth}x${thumbnailHeight}`,
    });
    return;
  }
  if (payload.length !== 14) {
    findings.push({ kind: 'malformed-app', detail: 'unexpected data after JFIF header' });
  }
}

function inspectApp2(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, Buffer.from(ICC_HEADER, 'latin1'))) {
    findings.push({
      kind: 'unexpected-app2',
      detail: 'APP2 is not an ICC profile (MPF and other APP2 blocks may carry previews)',
    });
    return;
  }
  // Header (12), sequence number (1), profile count (1).
  if (payload.length < 14) {
    findings.push({ kind: 'malformed-app', detail: 'truncated ICC profile header' });
  }
}

function inspectApp1(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (startsWith(payload, EXIF_HEADER)) {
    inspectTiff(payload.subarray(EXIF_HEADER.length), findings);
    return;
  }
  const headerLength = xmpHeaderLength(payload);
  if (headerLength !== undefined) {
    inspectXmp(payload.subarray(headerLength), findings);
    return;
  }
  findings.push({
    kind: 'unexpected-app',
    detail: 'APP1 is neither EXIF nor XMP',
  });
}

function inspectApp13(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, Buffer.from(PHOTOSHOP_HEADER, 'latin1'))) {
    findings.push({
      kind: 'unexpected-app13',
      detail: 'APP13 is not a Photoshop IRB',
    });
    return;
  }
  inspectPhotoshopIrbs(payload.subarray(PHOTOSHOP_HEADER.length), findings);
}

function inspectTiff(tiff: Uint8Array, findings: PreviewFinding[]): void {
  if (tiff.length < 8) {
    findings.push({ kind: 'malformed-exif', detail: 'truncated TIFF header' });
    return;
  }
  const byteOrder = latin1(tiff, 0, 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') {
    findings.push({ kind: 'malformed-exif', detail: `invalid TIFF byte order ${byteOrder}` });
    return;
  }

  const u16 = (at: number): number | undefined =>
    little ? readU16LE(tiff, at) : readU16BE(tiff, at);
  const u32 = (at: number): number | undefined =>
    little ? readU32LE(tiff, at) : readU32BE(tiff, at);

  if (u16(2) !== 42) {
    findings.push({ kind: 'malformed-exif', detail: 'invalid TIFF magic' });
    return;
  }
  const ifd0 = u32(4);
  if (ifd0 === undefined || ifd0 < 8 || ifd0 >= tiff.length) {
    findings.push({ kind: 'malformed-exif', detail: `invalid IFD0 offset ${String(ifd0)}` });
    return;
  }

  const visited = new Set<number>();
  const queue: { offset: number; thumbnailIfd: boolean; label: string }[] = [
    { offset: ifd0, thumbnailIfd: false, label: 'IFD0' },
  ];

  while (queue.length > 0) {
    if (visited.size >= 64) {
      findings.push({ kind: 'malformed-exif', detail: 'too many IFDs' });
      return;
    }
    const current = queue.shift()!;
    if (visited.has(current.offset)) {
      findings.push({
        kind: 'malformed-exif',
        detail: `IFD cycle at TIFF offset ${current.offset}`,
      });
      continue;
    }
    visited.add(current.offset);

    if (current.thumbnailIfd) {
      findings.push({
        kind: 'exif-ifd1',
        detail: `${current.label} at TIFF offset ${current.offset}`,
      });
    }

    const count = u16(current.offset);
    if (count === undefined || count > 512) {
      findings.push({
        kind: 'malformed-exif',
        detail: `invalid entry count at TIFF offset ${current.offset}`,
      });
      continue;
    }
    const entriesStart = current.offset + 2;
    const nextOffsetAt = entriesStart + count * 12;
    if (nextOffsetAt + 4 > tiff.length) {
      findings.push({
        kind: 'malformed-exif',
        detail: `truncated ${current.label} at TIFF offset ${current.offset}`,
      });
      continue;
    }

    for (let index = 0; index < count; index++) {
      const entry = entriesStart + index * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      if (tag === undefined || type === undefined || valueCount === undefined) {
        findings.push({
          kind: 'malformed-exif',
          detail: `truncated entry in ${current.label}`,
        });
        break;
      }

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
      if (tag === TAG_STRIP_OFFSETS || tag === TAG_STRIP_BYTE_COUNTS) {
        if (current.thumbnailIfd) {
          findings.push({
            kind: 'exif-ifd1',
            detail: `strips in ${current.label} at TIFF offset ${current.offset}`,
          });
        }
      }
      if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === TAG_INTEROP_IFD) {
        const offsets = readOffsets(tiff, little, type, valueCount, entry);
        if (offsets === undefined || offsets.length === 0) {
          findings.push({
            kind: 'malformed-exif',
            detail: `invalid ${labelForTag(tag)} pointer`,
          });
          continue;
        }
        for (const target of offsets) {
          if (target < 8 || target >= tiff.length) {
            findings.push({
              kind: 'malformed-exif',
              detail: `${labelForTag(tag)} offset ${target} is out of range`,
            });
            continue;
          }
          queue.push({ offset: target, thumbnailIfd: false, label: labelForTag(tag) });
        }
      } else if (tag === TAG_SUB_IFDS) {
        const offsets = readOffsets(tiff, little, type, valueCount, entry);
        if (offsets === undefined || offsets.length === 0) {
          findings.push({ kind: 'malformed-exif', detail: 'invalid SubIFD pointer' });
          continue;
        }
        for (const target of offsets) {
          if (target < 8 || target >= tiff.length) {
            findings.push({
              kind: 'malformed-exif',
              detail: `SubIFD offset ${target} is out of range`,
            });
            continue;
          }
          queue.push({ offset: target, thumbnailIfd: false, label: 'SubIFD' });
        }
      }
    }

    const next = u32(nextOffsetAt);
    if (next === undefined) {
      findings.push({ kind: 'malformed-exif', detail: 'truncated next-IFD pointer' });
      continue;
    }
    if (next !== 0) {
      if (next < 8 || next >= tiff.length) {
        findings.push({
          kind: 'malformed-exif',
          detail: `${current.label} next IFD offset ${next} is out of range`,
        });
      } else {
        queue.push({ offset: next, thumbnailIfd: true, label: 'IFD1' });
      }
    }
  }

  // Any JPEG stream inside EXIF (a maker note, an unlinked thumbnail, ...) is
  // also a preview of the image and must not survive an export.
  const embeddedAt = indexOfBytes(tiff, [0xff, 0xd8, 0xff], 0);
  if (embeddedAt >= 0) {
    findings.push({
      kind: 'exif-embedded-jpeg',
      detail: `JPEG stream at TIFF offset ${embeddedAt}`,
    });
  }
}

/** `undefined` means the value set is truncated or structurally invalid. */
function readOffsets(
  tiff: Uint8Array,
  little: boolean,
  type: number,
  count: number,
  entry: number,
): number[] | undefined {
  const unit = TYPE_SIZES[type];
  if (unit === undefined || count === 0 || count > 64) return undefined;
  const size = unit * count;
  let base: number;
  if (size <= 4) {
    base = entry + 8;
  } else {
    const offset = little ? readU32LE(tiff, entry + 8) : readU32BE(tiff, entry + 8);
    if (offset === undefined) return undefined;
    base = offset;
  }
  if (base + size > tiff.length) return undefined;

  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = base + index * unit;
    if (type === 3) {
      const value = little ? readU16LE(tiff, at) : readU16BE(tiff, at);
      if (value === undefined) return undefined;
      offsets.push(value);
    } else if (type === 4 || type === 13) {
      const value = little ? readU32LE(tiff, at) : readU32BE(tiff, at);
      if (value === undefined) return undefined;
      offsets.push(value);
    } else {
      return undefined;
    }
  }
  return offsets;
}

function inspectPhotoshopIrbs(data: Uint8Array, findings: PreviewFinding[]): void {
  if (data.length === 0) {
    findings.push({ kind: 'malformed-photoshop', detail: 'empty Photoshop IRB' });
    return;
  }

  let offset = 0;
  while (offset < data.length) {
    if (offset + 12 > data.length) {
      findings.push({
        kind: 'malformed-photoshop',
        detail: `truncated IRB block at offset ${offset}`,
      });
      return;
    }
    if (latin1(data, offset, offset + 4) !== '8BIM') {
      findings.push({
        kind: 'malformed-photoshop',
        detail: `invalid IRB signature at offset ${offset}`,
      });
      return;
    }
    const resourceId = readU16BE(data, offset + 4);
    if (resourceId === undefined) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource id' });
      return;
    }
    const nameLength = data[offset + 6]!;
    let nameFieldLength = 1 + nameLength;
    if (nameFieldLength % 2 !== 0) nameFieldLength++;
    const sizeAt = offset + 6 + nameFieldLength;
    const size = readU32BE(data, sizeAt);
    if (size === undefined) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource size' });
      return;
    }
    const dataAt = sizeAt + 4;
    if (dataAt + size > data.length) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource data' });
      return;
    }

    // 0x0409: ThumbnailResource, 0x040c: ThumbnailResource (Photoshop 4).
    if (resourceId === 0x0409 || resourceId === 0x040c) {
      findings.push({
        kind: 'photoshop-thumbnail',
        detail: `IRB resource 0x${resourceId.toString(16)}`,
      });
    }
    // XMP inside IRB can also carry a thumbnail.
    if (resourceId === 0x0424) {
      inspectXmp(data.subarray(dataAt, dataAt + size), findings);
    }

    offset = dataAt + size + (size % 2);
  }
}

function inspectXmp(body: Uint8Array, findings: PreviewFinding[]): void {
  const variants = [
    Buffer.from(body).toString('utf8'),
    Buffer.from(body).toString('utf16le'),
    decodeUtf16be(body),
  ];

  for (const text of variants) {
    const lower = text.toLowerCase();
    if (lower.includes('xmpgimg:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpGImg:image' });
    }
    if (lower.includes('xapgimg:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xapGImg:image' });
    }
    if (lower.includes('xmptng:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpTng:image' });
    }
    if (lower.includes('ns.adobe.com/xap/1.0/g/img/')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpGImg namespace' });
    }
    if (/:thumbnails[\s>]/i.test(text)) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'Thumbnails property' });
    }
  }
}

function decodeUtf16be(body: Uint8Array): string {
  if (body.length < 2) return '';
  const even = body.length - (body.length % 2);
  const copy = Buffer.from(body.subarray(0, even));
  copy.swap16();
  return copy.toString('utf16le');
}

function xmpHeaderLength(payload: Uint8Array): number | undefined {
  const head = latin1(payload, 0, Math.min(payload.length, 64));
  if (head.startsWith(XMP_STANDARD)) return XMP_STANDARD.length + 1;
  if (head.startsWith(XMP_EXTENDED)) return XMP_EXTENDED.length + 1;
  return undefined;
}

function labelForTag(tag: number): string {
  if (tag === TAG_EXIF_IFD) return 'ExifIFD';
  if (tag === TAG_GPS_IFD) return 'GPSIFD';
  return 'InteropIFD';
}

function findEoi(data: Uint8Array, from: number): number {
  for (let index = from; index + 1 < data.length; index++) {
    if (data[index] === 0xff && data[index + 1] === 0xd9) return index;
  }
  return -1;
}

function indexOfBytes(data: Uint8Array, needle: readonly number[], from: number): number {
  for (let index = Math.max(0, from); index + needle.length <= data.length; index++) {
    let matches = true;
    for (let at = 0; at < needle.length; at++) {
      if (data[index + at] !== needle[at]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
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
