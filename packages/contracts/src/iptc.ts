/**
 * IPTC Core plus the commonly used Extension fields. Everything is optional:
 * an absent field means "not set", an empty string means "explicitly empty".
 * Field names map to XMP `photoshop:`/`dc:`/`Iptc4xmpCore:` properties and the
 * matching IIM datasets; the mapping lives in `packages/metadata`.
 */
export interface IptcFields {
  headline?: string;
  /** Caption/description (IIM Caption-Abstract, XMP `dc:description`). */
  caption?: string;
  keywords?: string[];
  /** Creator (IIM By-line, XMP `dc:creator`). */
  byline?: string;
  bylineTitle?: string;
  credit?: string;
  source?: string;
  copyright?: string;
  city?: string;
  /** State or province. */
  state?: string;
  country?: string;
  /** ISO 3166 code, `Iptc4xmpCore:CountryCode`. */
  countryCode?: string;
  /** Sublocation (`Iptc4xmpCore:Location`). */
  location?: string;
  /** Event name (`Iptc4xmpExt:Event`). */
  event?: string;
  /** Object name / title. */
  objectName?: string;
  /** Job identifier / transmission reference. */
  jobId?: string;
  instructions?: string;
  captionWriter?: string;
  /** Date the content was created, ISO 8601 date or date-time. */
  dateCreated?: string;
}

/** Every key of {@link IptcFields}, for iterating over fields in UIs and templates. */
export const IPTC_FIELD_NAMES = [
  'headline',
  'caption',
  'keywords',
  'byline',
  'bylineTitle',
  'credit',
  'source',
  'copyright',
  'city',
  'state',
  'country',
  'countryCode',
  'location',
  'event',
  'objectName',
  'jobId',
  'instructions',
  'captionWriter',
  'dateCreated',
] as const satisfies readonly (keyof IptcFields)[];
