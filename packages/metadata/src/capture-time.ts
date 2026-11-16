import { stat, utimes } from 'node:fs/promises';
import {
  formatCaptureDateTime,
  formatExifDateTime,
  formatIimDate,
  formatIimTime,
  parseCaptureDateTime,
  shiftCaptureDateTime,
  type CaptureDateTimeParts,
} from './capture-time-value';
import { MetadataError } from './errors';
import { getExifToolService, type ExifToolService, type ExifToolTags } from './exiftool';
import {
  ensureSidecar,
  fileExists,
  isEmbeddedMetadataPath,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { combineIimDate, toIsoDate } from './values';

/**
 * What a shift changed, as ISO 8601. `after` is the new capture time (the sidecar's
 * `exif:DateTimeOriginal` for a raw) and `dateCreated` the new IPTC/XMP creation date.
 */
export interface CaptureTimeShift {
  before: string;
  after: string;
  dateCreated: string;
}

export interface ShiftCaptureTimeOptions {
  /** Reuse an existing ExifTool service (the default is the process-wide one). */
  service?: ExifToolService;
}

/** The XMP properties Lightroom writes for a raw's capture time, in sidecar order. */
const SIDECAR_CAPTURE_TAGS = [
  'XMP-exif:DateTimeOriginal',
  'XMP-photoshop:DateCreated',
  'XMP-xmp:CreateDate',
] as const;

/** Where a raw's time may live, sidecar first. ModifyDate is never a capture time. */
const RAW_TAGS = [
  'ExifIFD:DateTimeOriginal',
  'IFD0:DateTimeOriginal',
  'XMP-exif:DateTimeOriginal',
  'XMP-photoshop:DateCreated',
  'XMP-xmp:CreateDate',
] as const;

/** Embedded metadata: EXIF is the camera's own clock, then XMP, then the file's modify time. */
const EMBEDDED_TAGS = [
  'ExifIFD:DateTimeOriginal',
  'IFD0:DateTimeOriginal',
  'XMP-exif:DateTimeOriginal',
  'XMP-photoshop:DateCreated',
  'XMP-xmp:CreateDate',
  'IFD0:ModifyDate',
] as const;

interface TimeValue {
  parts: CaptureDateTimeParts;
  iso: string;
}

function timeValue(value: unknown): TimeValue | undefined {
  const iso = toIsoDate(value);
  if (iso === undefined) return undefined;
  const parts = parseCaptureDateTime(iso);
  return parts === undefined ? undefined : { parts, iso };
}

function firstTime(
  tags: Readonly<Record<string, unknown>>,
  names: readonly string[],
): TimeValue | undefined {
  for (const name of names) {
    const value = timeValue(tags[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function shiftedParts(
  value: unknown,
  fallback: CaptureDateTimeParts,
  offsetSeconds: number,
): CaptureDateTimeParts {
  return shiftCaptureDateTime(timeValue(value)?.parts ?? fallback, offsetSeconds);
}

/**
 * The capture time an XMP sidecar says, or `undefined` when it has none. This is what wins over
 * a raw's own EXIF from the moment the sidecar records a time.
 */
export async function readSidecarCaptureTime(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<string | undefined> {
  const sidecar = sidecarPathFor(path);
  if (!(await fileExists(sidecar))) return undefined;
  return firstTime(await service.read(sidecar), SIDECAR_CAPTURE_TAGS)?.iso;
}

/**
 * Read a photo's capture time from disk. Raws use their sidecar first and their own EXIF
 * second; embedded formats use the file itself.
 */
export async function readCaptureTime(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<string | undefined> {
  // Raws and the other sidecar formats: the sidecar wins, the file itself is the fallback.
  if (isRawPath(path) || !isEmbeddedMetadataPath(path)) {
    const fromSidecar = await readSidecarCaptureTime(path, service);
    if (fromSidecar !== undefined) return fromSidecar;
    if (!isRawPath(path)) {
      const target = metadataTargetFor(path);
      if (await fileExists(target)) {
        return firstTime(await service.read(target), SIDECAR_CAPTURE_TAGS)?.iso;
      }
    }
    if (!(await fileExists(path))) return undefined;
    return firstTime(await service.read(path), RAW_TAGS)?.iso;
  }
  const target = metadataTargetFor(path);
  if (!(await fileExists(target))) {
    throw new MetadataError('FILE_NOT_FOUND', `File not found: ${target}`);
  }
  return firstTime(await service.read(target), EMBEDDED_TAGS)?.iso;
}

/**
 * Shift one photo's capture time by whole seconds.
 *
 * - A raw is never written. The shifted `exif:DateTimeOriginal`, `xmp:CreateDate` and
 *   `photoshop:DateCreated` go into its XMP sidecar, which is what Lightroom and Photo
 *   Mechanic read back. The raw's EXIF sub-second and offset tags stay as they are.
 * - A JPEG/TIFF gets the same EXIF date, XMP dates and IIM date/time, with its sub-second
 *   and offset tags left alone and its modified time put back after the write.
 *
 * Returns `undefined`, and writes nothing, when the file has no clock time.
 */
export async function shiftCaptureTime(
  path: string,
  offsetSeconds: number,
  options: ShiftCaptureTimeOptions = {},
): Promise<CaptureTimeShift | undefined> {
  if (!Number.isInteger(offsetSeconds)) {
    throw new MetadataError('INVALID_XMP', 'The capture time offset must be whole seconds');
  }
  const service = options.service ?? getExifToolService();
  return isEmbeddedMetadataPath(path)
    ? shiftEmbedded(path, offsetSeconds, service)
    : shiftSidecar(path, offsetSeconds, service);
}

async function shiftSidecar(
  path: string,
  offsetSeconds: number,
  service: ExifToolService,
): Promise<CaptureTimeShift | undefined> {
  const sidecar = sidecarPathFor(path);
  const sidecarTags: Readonly<Record<string, unknown>> = (await fileExists(sidecar))
    ? await service.read(sidecar)
    : {};
  const fromSidecar = firstTime(sidecarTags, SIDECAR_CAPTURE_TAGS);
  const base =
    fromSidecar ??
    ((await fileExists(path)) ? firstTime(await service.read(path), RAW_TAGS) : undefined);
  if (base === undefined) return undefined;

  const tags: Record<string, string> = {};
  for (const name of SIDECAR_CAPTURE_TAGS) {
    tags[name] = formatCaptureDateTime(shiftedParts(sidecarTags[name], base.parts, offsetSeconds));
  }
  await ensureSidecar(path);
  await service.write(sidecar, tags);
  return {
    before: base.iso,
    after: tags['XMP-exif:DateTimeOriginal']!,
    dateCreated: tags['XMP-photoshop:DateCreated']!,
  };
}

async function shiftEmbedded(
  path: string,
  offsetSeconds: number,
  service: ExifToolService,
): Promise<CaptureTimeShift | undefined> {
  const target = metadataTargetFor(path);
  if (!(await fileExists(target))) {
    throw new MetadataError('FILE_NOT_FOUND', `File not found: ${target}`);
  }
  const tags = await service.read(target);
  const base = firstTime(tags, EMBEDDED_TAGS);
  if (base === undefined) return undefined;

  const exifOriginal = shiftedParts(
    tags['ExifIFD:DateTimeOriginal'] ?? tags['IFD0:DateTimeOriginal'],
    base.parts,
    offsetSeconds,
  );
  const exifCreate = shiftedParts(tags['ExifIFD:CreateDate'], base.parts, offsetSeconds);
  const xmpExif = shiftedParts(tags['XMP-exif:DateTimeOriginal'], base.parts, offsetSeconds);
  const xmpCreate = shiftedParts(tags['XMP-xmp:CreateDate'], base.parts, offsetSeconds);
  const photoshop = shiftedParts(tags['XMP-photoshop:DateCreated'], base.parts, offsetSeconds);
  const iim =
    timeValue(combineIimDate(tags['IPTC:DateCreated'], tags['IPTC:TimeCreated']))?.parts ??
    base.parts;
  const iimShifted = shiftCaptureDateTime(iim, offsetSeconds);

  const written: ExifToolTags = {
    'EXIF:DateTimeOriginal': formatExifDateTime(exifOriginal),
    'EXIF:CreateDate': formatExifDateTime(exifCreate),
    'XMP-exif:DateTimeOriginal': formatCaptureDateTime(xmpExif),
    'XMP-xmp:CreateDate': formatCaptureDateTime(xmpCreate),
    'XMP-photoshop:DateCreated': formatCaptureDateTime(photoshop),
    'IPTC:DateCreated': formatIimDate(iimShifted),
    'IPTC:TimeCreated': formatIimTime(iimShifted),
  };

  // ExifTool's rewrite resets the modified time; the copy was made to keep the file's own.
  const before = await stat(target);
  let failure: unknown;
  try {
    await service.write(target, written);
  } catch (error) {
    failure = error;
  }
  try {
    await utimes(target, before.atime, before.mtime);
  } catch (error) {
    if (failure === undefined) throw error;
  }
  if (failure !== undefined) throw failure;

  return {
    before: base.iso,
    after: formatCaptureDateTime(exifOriginal),
    dateCreated: formatCaptureDateTime(photoshop),
  };
}
