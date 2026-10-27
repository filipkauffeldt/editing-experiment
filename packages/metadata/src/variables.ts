import { basename, dirname, extname } from 'node:path';
import type { CameraInfo, IptcFields } from '@ee/contracts';

/** Values available to `{variable}` expansion for one photo. */
export interface CaptionContext {
  /** Absolute path of the photo; used for filename/folder variables. */
  filePath?: string;
  /** Overrides the file name derived from `filePath`. */
  fileName?: string;
  /** Overrides the base name derived from `filePath`. */
  fileNameBase?: string;
  /** Capture time as ISO 8601 (with or without offset) or a `Date`. */
  captureTime?: string | Date;
  /** Falls back for date/time variables when `captureTime` is absent. */
  fileModifiedTime?: string | Date;
  /** Clock used for `{now}`/`{today}`; defaults to the real clock. */
  now?: Date;
  camera?: CameraInfo;
  /** IPTC fields for `{headline}`, `{city}`, ... variables. */
  fields?: IptcFields;
  /** Current sequence number for `{seqn}` / `{seq:N}`. */
  sequence?: number;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Parse capture times without shifting them through UTC. A camera records
 * local wall-clock time; `{hour}` must show that hour even when the machine
 * running the app is in another timezone.
 */
function parseDateParts(value: string | Date | undefined, fallback: Date): DateParts {
  if (value instanceof Date) {
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
      millisecond: value.getMilliseconds(),
    };
  }
  if (typeof value === 'string') {
    const match =
      /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
        value.trim(),
      );
    if (match !== null) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4] ?? 0),
        minute: Number(match[5] ?? 0),
        second: Number(match[6] ?? 0),
        millisecond: match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0')),
      };
    }
  }
  return parseDateParts(fallback, fallback);
}

function dayOfWeek(parts: DateParts): number {
  return new Date(parts.year, parts.month - 1, parts.day).getDay();
}

function resolveDateParts(context: CaptionContext): DateParts {
  const now = context.now ?? new Date();
  const source = context.captureTime ?? context.fileModifiedTime;
  return parseDateParts(source, now);
}

function twelveHour(hour24: number): number {
  const hour = hour24 % 12;
  return hour === 0 ? 12 : hour;
}

function scalar(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}

const IPTC_VARIABLE_FIELDS: Readonly<Record<string, keyof IptcFields>> = {
  caption: 'caption',
  capt: 'caption',
  headline: 'headline',
  head: 'headline',
  keywords: 'keywords',
  keyw: 'keywords',
  byline: 'byline',
  byln: 'byline',
  name: 'byline',
  photog: 'byline',
  phtg: 'byline',
  photographer: 'byline',
  // PM's {title} is the creator's job title, not the object name.
  title: 'bylineTitle',
  titl: 'bylineTitle',
  credit: 'credit',
  cred: 'credit',
  source: 'source',
  srce: 'source',
  copyright: 'copyright',
  copy: 'copyright',
  city: 'city',
  state: 'state',
  stat: 'state',
  province: 'state',
  prov: 'state',
  country: 'country',
  cnty: 'country',
  countrycode: 'countryCode',
  ccod: 'countryCode',
  location: 'location',
  loc: 'location',
  event: 'event',
  evnt: 'event',
  object: 'objectName',
  objt: 'objectName',
  slug: 'objectName',
  objectname: 'objectName',
  // Not a PM name: kept for callers that expect title-like naming.
  iptctitle: 'objectName',
  transref: 'jobId',
  tref: 'jobId',
  jobid: 'jobId',
  instructions: 'instructions',
  inst: 'instructions',
  captionwriter: 'captionWriter',
  cwrt: 'captionWriter',
};

type Resolver = (context: CaptionContext) => string | undefined;

interface VariableSpec {
  readonly names: readonly string[];
  readonly resolve: Resolver;
  readonly description: string;
}

/**
 * Variable table. Add new PM variables by appending a row; aliases share a
 * resolver. Names are matched case-insensitively (reported as typed).
 *
 * Reference: https://docs.camerabits.com/support/solutions/articles/48000358438-list-of-photo-mechanic-variables
 */
const VARIABLES: VariableSpec[] = [
  {
    names: ['filename', 'file'],
    description: 'File name with extension',
    resolve: (context) => fileNameOf(context) ?? '',
  },
  {
    names: ['filenamebase', 'fbas'],
    description: 'File name without extension',
    resolve: (context) => fileNameBaseOf(context) ?? '',
  },
  {
    names: ['folder', 'fldr'],
    description: 'Containing folder name',
    resolve: (context) =>
      context.filePath === undefined ? '' : basename(dirname(context.filePath)),
  },
  {
    names: ['folderpath', 'fpth'],
    description: 'Containing folder path',
    resolve: (context) => (context.filePath === undefined ? '' : dirname(context.filePath)),
  },
  {
    names: ['path'],
    description: 'Full file path',
    resolve: (context) => context.filePath ?? '',
  },
  {
    names: ['date', 'shot'],
    description: 'Capture date (ISO 8601; PM uses the OS short-date format)',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['time'],
    description: 'Capture time (HH:MM:SS)',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    },
  },
  {
    names: ['year4', 'yr4'],
    description: 'Four-digit capture year',
    resolve: (context) => String(resolveDateParts(context).year),
  },
  {
    names: ['year2', 'yr2'],
    description: 'Two-digit capture year',
    resolve: (context) => pad(resolveDateParts(context).year % 100),
  },
  {
    names: ['month', 'mn'],
    description: 'Capture month, not padded',
    resolve: (context) => String(resolveDateParts(context).month),
  },
  {
    names: ['month0', 'mn0'],
    description: 'Capture month, zero padded',
    resolve: (context) => pad(resolveDateParts(context).month),
  },
  {
    names: ['day'],
    description: 'Capture day, not padded',
    resolve: (context) => String(resolveDateParts(context).day),
  },
  {
    names: ['day0'],
    description: 'Capture day, zero padded',
    resolve: (context) => pad(resolveDateParts(context).day),
  },
  {
    names: ['hour'],
    description: 'Capture hour, 12-hour clock, not padded',
    resolve: (context) => String(twelveHour(resolveDateParts(context).hour)),
  },
  {
    names: ['hour0', 'hr0'],
    description: 'Capture hour, 12-hour clock, zero padded',
    resolve: (context) => pad(twelveHour(resolveDateParts(context).hour)),
  },
  {
    names: ['hour24', 'h24'],
    description: 'Capture hour, 24-hour clock, zero padded',
    resolve: (context) => pad(resolveDateParts(context).hour),
  },
  {
    names: ['minute', 'min'],
    description: 'Capture minute, zero padded',
    resolve: (context) => pad(resolveDateParts(context).minute),
  },
  {
    names: ['second', 'sec'],
    description: 'Capture second, zero padded',
    resolve: (context) => pad(resolveDateParts(context).second),
  },
  {
    names: ['subsecond', 'ssec'],
    description: 'Capture sub-second',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return parts.millisecond === 0 ? '' : String(parts.millisecond).padStart(3, '0');
    },
  },
  {
    names: ['ampm'],
    description: 'AM or PM',
    resolve: (context) => (resolveDateParts(context).hour < 12 ? 'AM' : 'PM'),
  },
  {
    names: ['dow'],
    description: 'Day of week name',
    resolve: (context) => DAYS[dayOfWeek(resolveDateParts(context))] ?? '',
  },
  {
    names: ['dow3'],
    description: 'Day of week abbreviation',
    resolve: (context) => (DAYS[dayOfWeek(resolveDateParts(context))] ?? '').slice(0, 3),
  },
  {
    names: ['monthname', 'mnn'],
    description: 'Month name',
    resolve: (context) => MONTHS[resolveDateParts(context).month - 1] ?? '',
  },
  {
    names: ['monthname3', 'mnn3'],
    description: 'Month name abbreviation',
    resolve: (context) => (MONTHS[resolveDateParts(context).month - 1] ?? '').slice(0, 3),
  },
  {
    names: ['monthnameap', 'mnap'],
    description: 'Month name, AP style abbreviation',
    resolve: (context) => `${(MONTHS[resolveDateParts(context).month - 1] ?? '').slice(0, 3)}.`,
  },
  {
    names: ['datesort', 'dats'],
    description: 'Capture date, YYYYMMDD',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
    },
  },
  {
    names: ['datesortdash', 'dtsd'],
    description: 'Capture date, YYYY-MM-DD',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['timesort', 'tims'],
    description: 'Capture time, HHMMSS',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
    },
  },
  {
    names: ['timesortdash', 'tmsd'],
    description: 'Capture time, HH-MM-SS',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}-${pad(parts.minute)}-${pad(parts.second)}`;
    },
  },
  {
    names: ['datemil', 'datm'],
    description: 'Capture date, ddMONyy',
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.day)}${(MONTHS[parts.month - 1] ?? '').slice(0, 3).toUpperCase()}${pad(parts.year % 100)}`;
    },
  },
  {
    names: ['now'],
    description: 'Current date and time',
    resolve: (context) => {
      const parts = parseDateParts(context.now ?? new Date(), new Date());
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    },
  },
  {
    names: ['today', 'tday'],
    description: 'Current date',
    resolve: (context) => {
      const parts = parseDateParts(context.now ?? new Date(), new Date());
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['make'],
    description: 'Camera make',
    resolve: (context) => context.camera?.make ?? '',
  },
  {
    names: ['model', 'modl'],
    description: 'Camera model',
    resolve: (context) => context.camera?.model ?? '',
  },
  {
    // PM has no {camera}; this alias is ours and documented as such.
    names: ['camera'],
    description: 'Camera model (ours; same as {model})',
    resolve: (context) => context.camera?.model ?? '',
  },
  {
    names: ['serial', 'serialnum', 'snum'],
    description: 'Camera serial number',
    resolve: (context) => context.camera?.serialNumber ?? '',
  },
  {
    names: ['sequence', 'seqn', 'auto'],
    // `{seq:N}` (zero-padded to N digits) is ours; PM only has {seqn}.
    description: 'Current sequence number',
    resolve: (context) => (context.sequence === undefined ? undefined : String(context.sequence)),
  },
  {
    names: ['nl'],
    description: 'New line',
    resolve: () => '\n',
  },
  {
    names: ['tab'],
    description: 'Tab character',
    resolve: () => '\t',
  },
  {
    names: ['iptcdate', 'idat'],
    description: 'IPTC date, YYYYMMDD',
    resolve: (context) => {
      const value = context.fields?.dateCreated;
      if (value === undefined) return '';
      return value.slice(0, 10).replace(/-/g, '');
    },
  },
  {
    names: ['iptctime', 'itim'],
    description: 'IPTC time, HHMMSS',
    resolve: (context) => {
      const value = context.fields?.dateCreated;
      if (value === undefined || !value.includes('T')) return '';
      return value.slice(11, 19).replace(/:/g, '');
    },
  },
];

// IPTC field variables are generated from one alias table so adding a field is
// a one-line change.
for (const [name, field] of Object.entries(IPTC_VARIABLE_FIELDS)) {
  VARIABLES.push({
    names: [name],
    description: `IPTC field ${field}`,
    resolve: (context) => scalar(context.fields?.[field]),
  });
}

const VARIABLE_LOOKUP = new Map<string, VariableSpec>();
for (const spec of VARIABLES) {
  for (const name of spec.names) VARIABLE_LOOKUP.set(name.toLowerCase(), spec);
}

/** Variable names supported by {@link expandVariables}, sorted, without braces. */
export const VARIABLE_NAMES: readonly string[] = [...VARIABLE_LOOKUP.keys()].sort();

export interface ExpandVariablesResult {
  text: string;
  unknownVariables: string[];
}

/**
 * Expand `{variables}`. Unknown names are left verbatim and reported (without
 * their braces); known variables with no value expand to the empty string, as
 * Photo Mechanic does.
 */
export function expandVariables(text: string, context: CaptionContext): ExpandVariablesResult {
  const unknown = new Set<string>();
  const expanded = text.replace(/\{([^{}\r\n]+)\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    const sequenceMatch = /^seq:(\d+)$/i.exec(name);
    if (sequenceMatch !== null) {
      if (context.sequence === undefined) {
        unknown.add(rawName);
        return match;
      }
      const width = Number(sequenceMatch[1]);
      if (!Number.isInteger(width) || width < 1 || width > 20) {
        unknown.add(rawName);
        return match;
      }
      return String(context.sequence).padStart(width, '0');
    }
    const spec = VARIABLE_LOOKUP.get(name.toLowerCase());
    if (spec === undefined) {
      unknown.add(rawName);
      return match;
    }
    const value = spec.resolve(context);
    if (value === undefined) {
      unknown.add(rawName);
      return match;
    }
    return value;
  });
  return { text: expanded, unknownVariables: [...unknown] };
}

function fileNameOf(context: CaptionContext): string | undefined {
  if (context.fileName !== undefined) return context.fileName;
  if (context.filePath !== undefined) return basename(context.filePath);
  return undefined;
}

function fileNameBaseOf(context: CaptionContext): string | undefined {
  if (context.fileNameBase !== undefined) return context.fileNameBase;
  const name = fileNameOf(context);
  if (name === undefined) return undefined;
  const extension = extname(name);
  return extension === '' ? name : name.slice(0, -extension.length);
}
