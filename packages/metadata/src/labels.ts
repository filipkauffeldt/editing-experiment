import { MetadataError } from './errors';
import { getExifToolService, type ExifToolService, type ExifToolTagValue } from './exiftool';
import {
  ensureMetadataTarget,
  fileExists,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';

/** Tag and colour class as Photo Mechanic stores them. */
export interface PhotoLabels {
  tagged: boolean;
  /** 0 = none, 1..8. */
  colorClass: number;
}

/** Colour class names Photo Mechanic / Lightroom write to `xmp:Label`, indexed 1..8. */
export const COLOR_CLASS_NAMES = [
  '',
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Blue',
  'Purple',
  'Pink',
  'Grey',
] as const;

const TAGS = {
  tagged: 'XMP-photomech:Tagged',
  colorClass: 'XMP-photomech:ColorClass',
  label: 'XMP-xmp:Label',
} as const;

export function emptyLabels(): PhotoLabels {
  return { tagged: false, colorClass: 0 };
}

export function isValidColorClass(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 8;
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

const colorClassFromLabel = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const index = COLOR_CLASS_NAMES.findIndex(
    (name) => name !== '' && name.toLowerCase() === value.trim().toLowerCase(),
  );
  return index > 0 ? index : undefined;
};

/** Labels from a sidecar (raws) or the file's embedded XMP (JPEG/TIFF). */
export async function readPhotoLabels(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<PhotoLabels> {
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) return emptyLabels();
  const tags = await service.read(target);
  const colorClass = asColorClass(tags[TAGS.colorClass]) ?? colorClassFromLabel(tags[TAGS.label]);
  return {
    tagged: asBoolean(tags[TAGS.tagged]) ?? false,
    colorClass: colorClass ?? 0,
  };
}

export interface WritePhotoLabelsOptions {
  service?: ExifToolService;
}

/**
 * Persist labels the way Photo Mechanic does: `photomechanic:Tagged` and
 * `photomechanic:ColorClass`, plus the matching `xmp:Label` name so Lightroom
 * and other XMP consumers see the colour class too.
 *
 * Raws are never written: labels go to `<basename>.xmp`. JPEG/TIFF labels are
 * embedded.
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
  const service = options.service ?? getExifToolService();
  const tags: Record<string, ExifToolTagValue> = {};
  // ExifTool's PhotoMechanic Tagged boolean uses the "Yes"/"No" print values.
  if (labels.tagged !== undefined) tags[TAGS.tagged] = labels.tagged ? 'Yes' : null;
  if (labels.colorClass !== undefined) {
    tags[TAGS.colorClass] = labels.colorClass === 0 ? null : labels.colorClass;
    tags[TAGS.label] =
      labels.colorClass === 0 ? null : (COLOR_CLASS_NAMES[labels.colorClass] ?? null);
  }
  if (Object.keys(tags).length === 0) return;
  const target = await ensureMetadataTarget(path);
  await service.write(target, tags);
}
