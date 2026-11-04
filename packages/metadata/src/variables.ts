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

/**
 * Template paths that expand `{variables}` with different data. A variable is
 * listed in a picker only where the path supplies what its resolver reads.
 */
export type TemplateVariableContext = 'export' | 'ingest' | 'destination';

/** An accepted spelling with an argument, e.g. `{seq:4}` or `{date:YYYY-MM-DD}`. */
export interface TemplateVariableFormat {
  /** The text inserted by the picker, braces included. */
  readonly template: string;
  readonly description: string;
  readonly example: string;
  readonly contexts: readonly TemplateVariableContext[];
}

/** Structured metadata for one variable, shared by every template picker. */
export interface TemplateVariable {
  /** Canonical name, without braces. */
  readonly name: string;
  /** Other accepted spellings, without braces. */
  readonly aliases: readonly string[];
  readonly description: string;
  readonly example: string;
  readonly contexts: readonly TemplateVariableContext[];
  readonly formats: readonly TemplateVariableFormat[];
}

/**
 * Export folder/file names and ingest rename/subfolder templates get a full
 * photo context. A new row is listed in both without extra work; paths with a
 * narrower context (the destination remote path) opt in explicitly.
 */
const PHOTO_TEMPLATE_CONTEXTS: readonly TemplateVariableContext[] = ['export', 'ingest'];
const ALL_TEMPLATE_CONTEXTS: readonly TemplateVariableContext[] = [
  'export',
  'ingest',
  'destination',
];
const EXPORT_AND_DESTINATION: readonly TemplateVariableContext[] = ['export', 'destination'];
const INGEST_ONLY: readonly TemplateVariableContext[] = ['ingest'];

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

/*
 * Small path helpers instead of node:path: this module is bundled into the
 * sandboxed renderer for the variable picker, where node builtins do not exist.
 * They accept both separators, so a path from Windows or a POSIX path works.
 */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return trimmed.slice(index + 1);
}

function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return '.';
  if (index === 0) return trimmed.slice(0, 1);
  const dir = trimmed.slice(0, index);
  // Node's win32 dirname keeps the separator on a drive root: C:\
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

function extName(name: string): string {
  const base = baseName(name);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
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
  /** Overrides the example derived from {@link EXAMPLE_CONTEXT}. */
  readonly example?: string;
  /** Defaults to {@link PHOTO_TEMPLATE_CONTEXTS}. */
  readonly contexts?: readonly TemplateVariableContext[];
  readonly formats?: readonly TemplateVariableFormat[];
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
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => fileNameOf(context) ?? '',
  },
  {
    names: ['filenamebase', 'fbas'],
    description: 'File name without extension',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => fileNameBaseOf(context) ?? '',
  },
  {
    names: ['folder', 'fldr'],
    description: 'Containing folder name',
    resolve: (context) =>
      context.filePath === undefined ? '' : baseName(dirName(context.filePath)),
  },
  {
    names: ['folderpath', 'fpth'],
    description: 'Containing folder path',
    resolve: (context) => (context.filePath === undefined ? '' : dirName(context.filePath)),
  },
  {
    names: ['path'],
    description: 'Full file path',
    resolve: (context) => context.filePath ?? '',
  },
  {
    names: ['date', 'shot'],
    description: 'Capture date (ISO 8601; PM uses the OS short-date format)',
    contexts: ALL_TEMPLATE_CONTEXTS,
    formats: [
      {
        template: '{date:YYYY-MM-DD}',
        description: 'Capture date with a custom pattern (YYYY, MM, DD, HH, mm, ss)',
        example: '2026-10-27',
        contexts: INGEST_ONLY,
      },
    ],
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['time'],
    description: 'Capture time (HH:MM:SS)',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    },
  },
  {
    names: ['year4', 'yr4'],
    description: 'Four-digit capture year',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => String(resolveDateParts(context).year),
  },
  {
    names: ['year2', 'yr2'],
    description: 'Two-digit capture year',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).year % 100),
  },
  {
    names: ['month', 'mn'],
    description: 'Capture month, not padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => String(resolveDateParts(context).month),
  },
  {
    names: ['month0', 'mn0'],
    description: 'Capture month, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).month),
  },
  {
    names: ['day'],
    description: 'Capture day, not padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => String(resolveDateParts(context).day),
  },
  {
    names: ['day0'],
    description: 'Capture day, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).day),
  },
  {
    names: ['hour'],
    description: 'Capture hour, 12-hour clock, not padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => String(twelveHour(resolveDateParts(context).hour)),
  },
  {
    names: ['hour0', 'hr0'],
    description: 'Capture hour, 12-hour clock, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(twelveHour(resolveDateParts(context).hour)),
  },
  {
    names: ['hour24', 'h24'],
    description: 'Capture hour, 24-hour clock, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).hour),
  },
  {
    names: ['minute', 'min'],
    description: 'Capture minute, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).minute),
  },
  {
    names: ['second', 'sec'],
    description: 'Capture second, zero padded',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => pad(resolveDateParts(context).second),
  },
  {
    names: ['subsecond', 'ssec'],
    description: 'Capture sub-second',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return parts.millisecond === 0 ? '' : String(parts.millisecond).padStart(3, '0');
    },
  },
  {
    names: ['ampm'],
    description: 'AM or PM',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => (resolveDateParts(context).hour < 12 ? 'AM' : 'PM'),
  },
  {
    names: ['dow'],
    description: 'Day of week name',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => DAYS[dayOfWeek(resolveDateParts(context))] ?? '',
  },
  {
    names: ['dow3'],
    description: 'Day of week abbreviation',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => (DAYS[dayOfWeek(resolveDateParts(context))] ?? '').slice(0, 3),
  },
  {
    names: ['monthname', 'mnn'],
    description: 'Month name',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => MONTHS[resolveDateParts(context).month - 1] ?? '',
  },
  {
    names: ['monthname3', 'mnn3'],
    description: 'Month name abbreviation',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => (MONTHS[resolveDateParts(context).month - 1] ?? '').slice(0, 3),
  },
  {
    names: ['monthnameap', 'mnap'],
    description: 'Month name, AP style abbreviation',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => `${(MONTHS[resolveDateParts(context).month - 1] ?? '').slice(0, 3)}.`,
  },
  {
    names: ['datesort', 'dats'],
    description: 'Capture date, YYYYMMDD',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
    },
  },
  {
    names: ['datesortdash', 'dtsd'],
    description: 'Capture date, YYYY-MM-DD',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['timesort', 'tims'],
    description: 'Capture time, HHMMSS',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
    },
  },
  {
    names: ['timesortdash', 'tmsd'],
    description: 'Capture time, HH-MM-SS',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.hour)}-${pad(parts.minute)}-${pad(parts.second)}`;
    },
  },
  {
    names: ['datemil', 'datm'],
    description: 'Capture date, ddMONyy',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = resolveDateParts(context);
      return `${pad(parts.day)}${(MONTHS[parts.month - 1] ?? '').slice(0, 3).toUpperCase()}${pad(parts.year % 100)}`;
    },
  },
  {
    names: ['now'],
    description: 'Current date and time',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = parseDateParts(context.now ?? new Date(), new Date());
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
    },
  },
  {
    names: ['today', 'tday'],
    description: 'Current date',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: (context) => {
      const parts = parseDateParts(context.now ?? new Date(), new Date());
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    },
  },
  {
    names: ['make'],
    description: 'Camera make',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => context.camera?.make ?? '',
  },
  {
    names: ['model', 'modl'],
    description: 'Camera model',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => context.camera?.model ?? '',
  },
  {
    // PM has no {camera}; this alias is ours and documented as such.
    names: ['camera'],
    description: 'Camera model (ours; same as {model})',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => context.camera?.model ?? '',
  },
  {
    names: ['serial', 'serialnum', 'snum'],
    description: 'Camera serial number',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => context.camera?.serialNumber ?? '',
  },
  {
    names: ['sequence', 'seqn', 'auto'],
    // `{seq:N}` (zero-padded to N digits) is ours; PM only has {seqn}.
    description: 'Current sequence number',
    contexts: INGEST_ONLY,
    formats: [
      {
        template: '{seq:4}',
        description: 'Sequence number padded to four digits',
        example: '0007',
        contexts: INGEST_ONLY,
      },
    ],
    resolve: (context) => (context.sequence === undefined ? undefined : String(context.sequence)),
  },
  {
    names: ['nl'],
    description: 'New line',
    example: '\\n',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: () => '\n',
  },
  {
    names: ['tab'],
    description: 'Tab character',
    example: '\\t',
    contexts: ALL_TEMPLATE_CONTEXTS,
    resolve: () => '\t',
  },
  {
    names: ['iptcdate', 'idat'],
    description: 'IPTC date, YYYYMMDD',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => {
      const value = context.fields?.dateCreated;
      if (value === undefined) return '';
      return value.slice(0, 10).replace(/-/g, '');
    },
  },
  {
    names: ['iptctime', 'itim'],
    description: 'IPTC time, HHMMSS',
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => {
      const value = context.fields?.dateCreated;
      if (value === undefined || !value.includes('T')) return '';
      return value.slice(11, 19).replace(/:/g, '');
    },
  },
];

const IPTC_FIELD_DESCRIPTIONS: Readonly<Record<keyof IptcFields, string>> = {
  headline: 'Headline',
  caption: 'Caption / description',
  keywords: 'Keywords, comma separated',
  byline: 'Creator / photographer',
  bylineTitle: 'Creator job title',
  credit: 'Credit line',
  source: 'Source',
  copyright: 'Copyright notice',
  city: 'City',
  state: 'State or province',
  country: 'Country',
  countryCode: 'ISO country code',
  location: 'Sublocation',
  event: 'Event name',
  objectName: 'Object name / title',
  jobId: 'Job identifier',
  instructions: 'Special instructions',
  captionWriter: 'Caption writer',
  dateCreated: 'IPTC creation date',
};

// IPTC field variables are generated from one alias table so adding a field is
// a one-line change. Aliases of one field share one picker entry.
const IPTC_ALIASES = new Map<keyof IptcFields, string[]>();
for (const [name, field] of Object.entries(IPTC_VARIABLE_FIELDS)) {
  const names = IPTC_ALIASES.get(field) ?? [];
  names.push(name);
  IPTC_ALIASES.set(field, names);
}
for (const [field, names] of IPTC_ALIASES) {
  VARIABLES.push({
    names,
    description: IPTC_FIELD_DESCRIPTIONS[field],
    contexts: EXPORT_AND_DESTINATION,
    resolve: (context) => scalar(context.fields?.[field]),
  });
}

/** Values used to show an example for variables that do not override it. */
const EXAMPLE_CONTEXT: CaptionContext = {
  filePath: '/photos/card/2026-10-27_FCB_001.NEF',
  fileName: '2026-10-27_FCB_001.NEF',
  fileNameBase: '2026-10-27_FCB_001',
  captureTime: '2026-10-27T20:15:04.123+01:00',
  now: new Date(2026, 9, 27, 22, 10, 0),
  camera: {
    make: 'NIKON CORPORATION',
    model: 'NIKON Z 9',
    serialNumber: '6012345',
  },
  fields: {
    headline: 'FCB 2–1 Sevilla',
    caption: 'Lewandowski scores the winner',
    keywords: ['football', 'la liga'],
    byline: 'Ada Lind',
    bylineTitle: 'Staff photographer',
    credit: 'Sportfotografen',
    source: 'Sportfotografen',
    copyright: '© Ada Lind',
    city: 'Barcelona',
    state: 'Catalonia',
    country: 'Spain',
    countryCode: 'ES',
    location: 'Spotify Camp Nou',
    event: 'La Liga matchday 8',
    objectName: 'FCB-SEV-001',
    jobId: 'JOB-2026-042',
    instructions: 'Credit required',
    captionWriter: 'Ada Lind',
    dateCreated: '2026-10-27T20:15:04+01:00',
  },
  sequence: 7,
};

function templateVariableOf(spec: VariableSpec): TemplateVariable {
  return {
    name: spec.names[0] ?? '',
    aliases: spec.names.slice(1),
    description: spec.description,
    example: spec.example ?? spec.resolve(EXAMPLE_CONTEXT) ?? '',
    contexts: spec.contexts ?? PHOTO_TEMPLATE_CONTEXTS,
    formats: spec.formats ?? [],
  };
}

/**
 * Variables that only their own template path expands. `{preset}` is replaced
 * by the export service before `expandVariables`, and the ingest extras are
 * handled by `expandIngestTemplate`; none of them are Photo Mechanic caption
 * variables, so they stay out of {@link VARIABLE_LOOKUP}.
 */
const TEMPLATE_ONLY_VARIABLES: readonly TemplateVariable[] = [
  {
    name: 'preset',
    aliases: [],
    description: 'Active export preset name',
    example: 'Desk 2048',
    contexts: ['export'],
    formats: [],
  },
  {
    name: 'sourceName',
    aliases: [],
    description: 'Ingest source name',
    example: 'Card A',
    contexts: INGEST_ONLY,
    formats: [],
  },
  {
    name: 'sourceId',
    aliases: [],
    description: 'Ingest source id',
    example: 'card-a',
    contexts: INGEST_ONLY,
    formats: [],
  },
  {
    name: 'ext',
    aliases: [],
    description: 'File extension without the dot',
    example: 'NEF',
    contexts: INGEST_ONLY,
    formats: [],
  },
];

/** Structured metadata for every variable a template path can expand. */
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  ...VARIABLES.map(templateVariableOf),
  ...TEMPLATE_ONLY_VARIABLES,
];

/** The entries a picker for one template path should show. */
export function templateVariablesFor(
  context: TemplateVariableContext,
): readonly TemplateVariable[] {
  return TEMPLATE_VARIABLES.filter((variable) => variable.contexts.includes(context));
}

function knownTemplateNames(context: TemplateVariableContext): Set<string> {
  const names = new Set<string>();
  for (const variable of templateVariablesFor(context)) {
    names.add(variable.name.toLowerCase());
    for (const alias of variable.aliases) names.add(alias.toLowerCase());
  }
  return names;
}

function isKnownTemplateVariable(
  name: string,
  context: TemplateVariableContext,
  names: ReadonlySet<string>,
): boolean {
  const lower = name.toLowerCase();
  if (names.has(lower)) return true;
  if (context === 'ingest' && names.has('date') && /^date:.+$/i.test(name)) return true;
  const sequence = /^seq:(\d+)$/i.exec(name);
  if (sequence !== null && names.has('sequence')) {
    const width = Number(sequence[1]);
    return Number.isInteger(width) && width >= 1 && width <= 20;
  }
  return false;
}

/**
 * Names of placeholders in `text` that this template path does not expand,
 * without braces and reported as typed. Unlike {@link expandVariables}, this
 * also names a known variable whose data the path never supplies (a camera
 * variable in ingest, say), so a picker can say why it does nothing here.
 */
export function unknownTemplateVariables(text: string, context: TemplateVariableContext): string[] {
  const names = knownTemplateNames(context);
  const unknown = new Set<string>();
  for (const match of text.matchAll(/\{([^{}\r\n]+)\}/g)) {
    const raw = match[1] ?? '';
    if (isKnownTemplateVariable(raw.trim(), context, names)) continue;
    unknown.add(raw);
  }
  return [...unknown];
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
  if (context.filePath !== undefined) return baseName(context.filePath);
  return undefined;
}

function fileNameBaseOf(context: CaptionContext): string | undefined {
  if (context.fileNameBase !== undefined) return context.fileNameBase;
  const name = fileNameOf(context);
  if (name === undefined) return undefined;
  const extension = extName(name);
  return extension === '' ? name : name.slice(0, -extension.length);
}
