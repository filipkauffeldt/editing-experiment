import type { IptcFields } from '@ee/contracts';
import { IPTC_FIELD_NAMES } from '@ee/contracts';
import { MetadataError } from './errors';
import { getExifToolService, type ExifToolTagValue, type ExifToolService } from './exiftool';
import {
  ensureMetadataTarget,
  fileExists,
  isEmbeddedMetadataPath,
  isRawPath,
  metadataTargetFor,
  sidecarPathFor,
} from './paths';
import { asString, asStringList, combineIimDate, splitIsoDate, toIsoDate } from './values';

/**
 * One row of the IPTC Photo Metadata / MWG mapping used by both IIM and XMP.
 *
 * Sources:
 * - IPTC Photo Metadata Standard (property → XMP / IIM tables):
 *   https://iptc.org/std/photometadata/specification/IPTC-PhotoMetadata
 * - ExifTool's own MWG mappings:
 *   https://github.com/exiftool/exiftool/blob/master/arg_files/iptc2xmp.args
 *   https://github.com/exiftool/exiftool/blob/master/arg_files/xmp2iptc.args
 */
export interface IptcTagMapping {
  readonly field: keyof IptcFields;
  /** ExifTool `Family1:Tag` name for the XMP property. */
  readonly xmp: string;
  /** ExifTool `Family1:Tag` name for the IIM dataset, when one exists. */
  readonly iim?: string;
  /**
   * EXIF tag that MWG keeps consistent with this field in embedded metadata.
   * Raws are never written, so this only applies to JPEG/TIFF.
   */
  readonly exif?: string;
  /** XMP representation of a contract-scalar field is an RDF list (e.g. `dc:creator`). */
  readonly xmpList?: boolean;
  /** Contract field is a list (keywords). */
  readonly list?: boolean;
  /** Date handled by `photoshop:DateCreated` plus IIM DateCreated/TimeCreated. */
  readonly date?: boolean;
}

export const IPTC_TAG_MAP: readonly IptcTagMapping[] = [
  { field: 'headline', xmp: 'XMP-photoshop:Headline', iim: 'IPTC:Headline' },
  { field: 'caption', xmp: 'XMP-dc:Description', iim: 'IPTC:Caption-Abstract' },
  { field: 'keywords', xmp: 'XMP-dc:Subject', iim: 'IPTC:Keywords', list: true },
  {
    field: 'byline',
    xmp: 'XMP-dc:Creator',
    iim: 'IPTC:By-line',
    xmpList: true,
    exif: 'EXIF:Artist',
  },
  { field: 'bylineTitle', xmp: 'XMP-photoshop:AuthorsPosition', iim: 'IPTC:By-lineTitle' },
  { field: 'credit', xmp: 'XMP-photoshop:Credit', iim: 'IPTC:Credit' },
  { field: 'source', xmp: 'XMP-photoshop:Source', iim: 'IPTC:Source' },
  { field: 'copyright', xmp: 'XMP-dc:Rights', iim: 'IPTC:CopyrightNotice', exif: 'EXIF:Copyright' },
  { field: 'city', xmp: 'XMP-photoshop:City', iim: 'IPTC:City' },
  { field: 'state', xmp: 'XMP-photoshop:State', iim: 'IPTC:Province-State' },
  { field: 'country', xmp: 'XMP-photoshop:Country', iim: 'IPTC:Country-PrimaryLocationName' },
  {
    field: 'countryCode',
    xmp: 'XMP-iptcCore:CountryCode',
    iim: 'IPTC:Country-PrimaryLocationCode',
  },
  { field: 'location', xmp: 'XMP-iptcCore:Location', iim: 'IPTC:Sub-location' },
  // IPTC Extension Event has no IIM equivalent.
  { field: 'event', xmp: 'XMP-iptcExt:Event' },
  { field: 'objectName', xmp: 'XMP-dc:Title', iim: 'IPTC:ObjectName' },
  {
    field: 'jobId',
    xmp: 'XMP-photoshop:TransmissionReference',
    iim: 'IPTC:OriginalTransmissionReference',
  },
  { field: 'instructions', xmp: 'XMP-photoshop:Instructions', iim: 'IPTC:SpecialInstructions' },
  { field: 'captionWriter', xmp: 'XMP-photoshop:CaptionWriter', iim: 'IPTC:Writer-Editor' },
  { field: 'dateCreated', xmp: 'XMP-photoshop:DateCreated', date: true },
];

const BY_FIELD = new Map(IPTC_TAG_MAP.map((mapping) => [mapping.field, mapping]));

function isEmptyValue(value: IptcFields[keyof IptcFields]): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === '';
}

/**
 * Build {@link IptcFields} from ExifTool's `-G1` tag map. XMP wins over IIM
 * when both exist (XMP is the authoritative copy in our workflow).
 */
export function iptcFieldsFromTags(tags: Readonly<Record<string, unknown>>): IptcFields {
  const fields: IptcFields = {};

  for (const mapping of IPTC_TAG_MAP) {
    if (mapping.date === true) {
      const fromXmp = toIsoDate(tags[mapping.xmp]);
      const fromIim = combineIimDate(tags['IPTC:DateCreated'], tags['IPTC:TimeCreated']);
      const date = nonEmpty(fromXmp) ?? nonEmpty(fromIim);
      if (date !== undefined) fields.dateCreated = date;
      continue;
    }

    const xmpValue = tags[mapping.xmp];
    const xmpList = asStringList(xmpValue).filter((item) => item !== '');
    if (mapping.list === true) {
      if (xmpList.length > 0) {
        fields.keywords = xmpList;
        continue;
      }
      const iimList =
        mapping.iim === undefined
          ? []
          : asStringList(tags[mapping.iim]).filter((item) => item !== '');
      if (iimList.length > 0) fields.keywords = iimList;
      continue;
    }

    const fromXmp = xmpList.join(', ');
    if (fromXmp !== '') {
      assignScalar(fields, mapping.field, fromXmp);
      continue;
    }
    if (mapping.iim === undefined) continue;
    const fromIim = asString(tags[mapping.iim]);
    if (fromIim !== undefined && fromIim !== '') {
      assignScalar(fields, mapping.field, fromIim);
    }
  }

  return fields;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function assignScalar(fields: IptcFields, field: keyof IptcFields, value: string): void {
  // All non-list fields in the contract are strings. The switch keeps the
  // assignment type-safe under `exactOptionalPropertyTypes`-style checking.
  switch (field) {
    case 'keywords':
    case 'dateCreated':
      return;
    default:
      fields[field] = value;
  }
}

/** ExifTool tags for a photo path: sidecar for raws, embedded for JPEG/TIFF. */
async function readTagsForPhoto(
  path: string,
  service: ExifToolService,
): Promise<Record<string, unknown>> {
  const target = isRawPath(path) ? sidecarPathFor(path) : metadataTargetFor(path);
  if (!(await fileExists(target))) {
    if (isRawPath(path)) return {};
    throw new MetadataError('EXIFTOOL', `Metadata file not found: ${target}`);
  }
  return service.read(target);
}

/**
 * Read user IPTC fields.
 *
 * Raws are read from their `<basename>.xmp` sidecar only. Nikon NEFs carry an
 * embedded XMP packet with `crd:` camera-raw-defaults (and some `crs:`-like
 * values); reading the raw itself would mistake camera defaults for user
 * edits, so the raw is never parsed for IPTC.
 */
export async function readIptc(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<IptcFields> {
  const tags = await readTagsForPhoto(path, service);
  return iptcFieldsFromTags(tags);
}

/** Read IPTC fields from an XMP file (Photo Mechanic template or sidecar). */
export async function readIptcFromXmpFile(
  path: string,
  service: ExifToolService = getExifToolService(),
): Promise<IptcFields> {
  if (!(await fileExists(path))) {
    throw new MetadataError('SIDECAR_MISSING', `XMP file not found: ${path}`);
  }
  return iptcFieldsFromTags(await service.read(path));
}

export interface WriteIptcOptions {
  /** Reuse an existing service (the default is the process-wide one). */
  service?: ExifToolService;
}

/**
 * Write IPTC fields. Only keys present in `fields` are touched; `undefined`
 * leaves a field alone, an empty string / empty array deletes it.
 *
 * - Raws: creates or merges `<basename>.xmp`; the raw file is never opened for
 *   writing.
 * - JPEG/TIFF: writes IIM and XMP together, with IIM coded as UTF-8 (1:90).
 */
export async function writeIptc(
  target: string,
  fields: Partial<IptcFields>,
  options: WriteIptcOptions = {},
): Promise<void> {
  const service = options.service ?? getExifToolService();
  const embedded = isEmbeddedMetadataPath(target);
  const tags: Record<string, ExifToolTagValue> = {};

  if (embedded) tags['IPTC:CodedCharacterSet'] = 'UTF8';

  for (const fieldName of IPTC_FIELD_NAMES) {
    if (!(fieldName in fields)) continue;
    const value = fields[fieldName];
    if (value === undefined) continue;
    const mapping = BY_FIELD.get(fieldName);
    if (mapping === undefined) continue;

    if (mapping.date === true) {
      writeDate(tags, mapping, value, embedded);
      continue;
    }

    if (isEmptyValue(value)) {
      tags[mapping.xmp] = null;
      if (embedded && mapping.iim !== undefined) tags[mapping.iim] = null;
      if (embedded && mapping.exif !== undefined) tags[mapping.exif] = null;
      continue;
    }

    if (mapping.list === true) {
      const list = Array.isArray(value) ? value : [String(value)];
      tags[mapping.xmp] = list;
      if (embedded && mapping.iim !== undefined) tags[mapping.iim] = list;
      continue;
    }

    if (Array.isArray(value)) continue;
    const text = String(value);
    tags[mapping.xmp] = mapping.xmpList === true ? [text] : text;
    if (embedded && mapping.iim !== undefined) tags[mapping.iim] = text;
    // MWG: EXIF Artist/Copyright must agree with XMP/IPTC when both exist in one file.
    if (embedded && mapping.exif !== undefined) tags[mapping.exif] = text;
  }

  if (Object.keys(tags).length === 0) return;
  const writePath = await ensureMetadataTarget(target);
  await service.write(writePath, tags);
}

function writeDate(
  tags: Record<string, ExifToolTagValue>,
  mapping: IptcTagMapping,
  value: IptcFields[keyof IptcFields],
  embedded: boolean,
): void {
  if (Array.isArray(value)) return;
  const text = value === undefined ? '' : String(value);
  if (text === '') {
    tags[mapping.xmp] = null;
    if (embedded) {
      tags['IPTC:DateCreated'] = null;
      tags['IPTC:TimeCreated'] = null;
    }
    return;
  }
  const parts = splitIsoDate(text);
  if (parts === undefined) {
    throw new MetadataError(
      'INVALID_XMP',
      `dateCreated must be an ISO 8601 date or date-time, got ${JSON.stringify(text)}`,
    );
  }
  tags[mapping.xmp] = text;
  if (embedded) {
    tags['IPTC:DateCreated'] = parts.date;
    tags['IPTC:TimeCreated'] = parts.time ?? null;
  }
}
