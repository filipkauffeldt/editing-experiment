import { MetadataError } from './errors';
import { getExifToolService, type ExifToolService, type ExifToolTagValue } from './exiftool';
import {
  ensureMetadataTarget,
  fileExists,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { asString } from './values';

/** Tag, colour class and rating as Photo Mechanic stores them. */
export interface PhotoLabels {
  tagged: boolean;
  /** 0 = none, 1..8. */
  colorClass: number;
  /** 0 = none, 1..5. */
  rating: number;
}

/**
 * Photo Mechanic's default colour class names, indexed 1..8. PM lets users
 * rename classes, so callers can pass their own table through
 * `colorClassNames`; these defaults are also what PM "synchronizes" to
 * `xmp:Label`.
 */
export const COLOR_CLASS_NAMES: readonly string[] = [
  '',
  'Winner',
  'Winner alt',
  'Superior',
  'Superior alt',
  'Typical',
  'Typical alt',
  'Extras',
  'Trash',
];

/**
 * Tags in Photo Mechanic's XMP namespace
 * (`http://ns.camerabits.com/photomechanic/1.0/`, prefix `photomechanic`).
 * ExifTool calls the family 1 group `XMP-photomech`.
 *
 * - https://exiftool.org/TagNames/PhotoMechanic.html
 * - https://forums.camerabits.com//index.php?topic=1282.0
 */
const TAGS = {
  tagged: 'XMP-photomech:Tagged',
  colorClass: 'XMP-photomech:ColorClass',
  prefs: 'XMP-photomech:Prefs',
  label: 'XMP-xmp:Label',
  rating: 'XMP-xmp:Rating',
} as const;

export function emptyLabels(): PhotoLabels {
  return { tagged: false, colorClass: 0, rating: 0 };
}

export function isValidColorClass(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 8;
}

export function isValidRating(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === 'yes' || text === '1') return true;
    if (text === 'false' || text === 'no' || text === '0' || text === '') return false;
  }
  return undefined;
};

const asColorClass = (value: unknown): number | undefined => {
  // ExifTool's print conversion reads "3 (Superior)", so take the leading integer.
  const match = /^\s*(\d+)/.exec(String(value ?? ''));
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 8) return undefined;
  return number;
};

function colorClassFromLabel(value: unknown, names: readonly string[]): number | undefined {
  const label = asString(value);
  if (label === undefined) return undefined;
  const wanted = label.trim().toLowerCase();
  if (wanted === '') return undefined;
  const index = names.findIndex(
    (name, position) => position > 0 && name !== '' && name.toLowerCase() === wanted,
  );
  return index > 0 ? index : undefined;
}

/**
 * Photo Mechanic stores tag, colour class, star rating and frame number in one
 * `photomechanic:Prefs` string, e.g. `0:3:4:1234` (tagged, colorClass, rating,
 * frameNum). ExifTool's print conversion displays it as
 * `Tagged:0, ColorClass:3, Rating:4, FrameNum:1234`; accept both forms so a
 * value written by PM or by us round-trips.
 *
 * https://exiftool.org/TagNames/PhotoMechanic.html
 * https://forums.camerabits.com//index.php?topic=1282.0
 */
interface PhotoMechanicPrefs {
  tagged?: boolean;
  colorClass?: number;
  /** Kept as text so an existing value is preserved exactly. */
  rating?: string;
  /** Kept as text so an existing value is preserved exactly. */
  frameNum?: string;
}

const PREFS_PRINTED =
  /Tagged:\s*(\d+)[\s,]*ColorClass:\s*(\d+)[\s,]*Rating:\s*(\d*)[\s,]*FrameNum:\s*(\S*)/i;
const PREFS_RAW = /^\s*(\d+)\s*:\s*(\d+)\s*:\s*(\d*)\s*:\s*(\S*)\s*$/;

function parsePrefs(value: unknown): PhotoMechanicPrefs | undefined {
  const text = asString(value);
  if (text === undefined || text.trim() === '') return undefined;
  const match = PREFS_PRINTED.exec(text) ?? PREFS_RAW.exec(text);
  if (match === null) return undefined;

  const [, tagged, colorClass, rating, frameNum] = match;
  if (tagged === undefined || colorClass === undefined) return undefined;

  const classNumber = Number(colorClass);
  return {
    tagged: Number(tagged) !== 0,
    ...(Number.isInteger(classNumber) && classNumber >= 0 && classNumber <= 8
      ? { colorClass: classNumber }
      : {}),
    rating: rating ?? '0',
    frameNum: frameNum ?? '0',
  };
}

function asRating(value: unknown): number | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const match = /^\s*(-?\d+)/.exec(text);
  if (!match) return undefined;
  const rating = Number(match[1]);
  return isValidRating(rating) ? rating : undefined;
}

export interface ReadPhotoLabelsOptions {
  /** Reuse an existing service (the default is the process-wide one). */
  service?: ExifToolService;
  /** Colour class names used to map `xmp:Label` back to a class (1..8). */
  colorClassNames?: readonly string[];
}

/** Labels from a sidecar (raws) or the file's embedded XMP (JPEG/TIFF). */
export async function readPhotoLabels(
  path: string,
  options: ReadPhotoLabelsOptions = {},
): Promise<PhotoLabels> {
  const service = options.service ?? getExifToolService();
  const names = options.colorClassNames ?? COLOR_CLASS_NAMES;
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) return emptyLabels();
  const tags = await service.read(target);

  // PM's combined Prefs value wins, then the separate XMP properties, then a
  // label written by PM's "Synchronize Color Class with IPTC/XMP Label".
  const prefs = parsePrefs(tags[TAGS.prefs]);
  const colorClass =
    prefs?.colorClass ??
    asColorClass(tags[TAGS.colorClass]) ??
    colorClassFromLabel(tags[TAGS.label], names) ??
    0;
  return {
    tagged: prefs?.tagged ?? asBoolean(tags[TAGS.tagged]) ?? false,
    colorClass,
    rating: asRating(prefs?.rating) ?? asRating(tags[TAGS.rating]) ?? 0,
  };
}

export interface WritePhotoLabelsOptions extends ReadPhotoLabelsOptions {
  /**
   * Mirror the colour class name to `xmp:Label` (Photo Mechanic's
   * "Synchronize Color Class with IPTC/XMP Label"). Defaults to true.
   */
  syncLabel?: boolean;
}

/**
 * Persist labels the way Photo Mechanic does: `photomechanic:Tagged`,
 * `photomechanic:ColorClass` and the combined `photomechanic:Prefs` string
 * (`tagged:colorClass:rating:frameNum`), plus the matching `xmp:Label` name so
 * Lightroom and other XMP consumers see the colour class too.
 *
 * An existing Prefs value keeps its star rating and frame number. When there
 * is none, the rating comes from `xmp:Rating` (or 0) and the frame number is 0.
 * The rating is mirrored to `xmp:Rating` (0 removes it, as Lightroom does), so
 * the combined Prefs string and `xmp:Rating` never disagree.
 *
 * Raws are never written: labels go to `<basename>.xmp`. JPEG/TIFF labels are
 * embedded.
 *
 * Namespace and tag table: https://exiftool.org/TagNames/PhotoMechanic.html
 * Prefs format: https://forums.camerabits.com//index.php?topic=1282.0
 */
export async function writePhotoLabels(
  path: string,
  labels: Partial<PhotoLabels>,
  options: WritePhotoLabelsOptions = {},
): Promise<void> {
  if (labels.colorClass !== undefined && !isValidColorClass(labels.colorClass)) {
    throw new MetadataError(
      'INVALID_XMP',
      `colorClass must be 0..8, got ${String(labels.colorClass)}`,
    );
  }
  if (labels.rating !== undefined && !isValidRating(labels.rating)) {
    throw new MetadataError('INVALID_XMP', `rating must be 0..5, got ${String(labels.rating)}`);
  }
  if (labels.tagged === undefined && labels.colorClass === undefined && labels.rating === undefined)
    return;

  const service = options.service ?? getExifToolService();
  const names = options.colorClassNames ?? COLOR_CLASS_NAMES;
  const syncLabel = options.syncLabel ?? true;

  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  const existing: Record<string, unknown> = (await fileExists(target))
    ? await service.read(target)
    : {};
  const existingPrefs = parsePrefs(existing[TAGS.prefs]);

  const tagged =
    labels.tagged ?? existingPrefs?.tagged ?? asBoolean(existing[TAGS.tagged]) ?? false;
  const colorClass =
    labels.colorClass ??
    existingPrefs?.colorClass ??
    asColorClass(existing[TAGS.colorClass]) ??
    colorClassFromLabel(existing[TAGS.label], names) ??
    0;
  const rating =
    labels.rating ?? asRating(existingPrefs?.rating) ?? asRating(existing[TAGS.rating]) ?? 0;
  const frameNum = existingPrefs?.frameNum ?? '0';

  const tags: Record<string, ExifToolTagValue> = {
    // ExifTool's PhotoMechanic Tagged boolean uses the "Yes"/"No" print values.
    ...(labels.tagged === undefined ? {} : { [TAGS.tagged]: labels.tagged ? 'Yes' : null }),
    ...(labels.colorClass === undefined
      ? {}
      : { [TAGS.colorClass]: labels.colorClass === 0 ? null : labels.colorClass }),
    [TAGS.prefs]: `${tagged ? 1 : 0}:${colorClass}:${rating}:${frameNum}`,
    // Lightroom's clear is no xmp:Rating at all; always mirror the effective value.
    [TAGS.rating]: rating === 0 ? null : rating,
  };

  if (labels.colorClass !== undefined && syncLabel) {
    if (colorClass === 0) {
      // Only remove a label that came from our own colour class table; a label
      // the user set in another app is not ours to delete.
      const existingLabel = asString(existing[TAGS.label]);
      if (existingLabel !== undefined && colorClassFromLabel(existingLabel, names) !== undefined) {
        tags[TAGS.label] = null;
      }
    } else {
      const name = names[colorClass];
      tags[TAGS.label] = name === undefined || name === '' ? null : name;
    }
  }

  const writePath = await ensureMetadataTarget(path);
  await service.write(writePath, tags);
}
