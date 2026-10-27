/** A tag value as returned by ExifTool (parsed dates, numbers, lists, ...). */
export type RawTagValue = unknown;

export function asString(value: RawTagValue): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isIsoCapable(value)) {
    const iso = value.toISOString?.();
    if (iso !== undefined && iso !== null) return iso;
  }
  return undefined;
}

export function asStringList(value: RawTagValue): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const single = asString(item);
      return single === undefined ? [] : [single];
    });
  }
  const single = asString(value);
  return single === undefined ? [] : [single];
}

export function asNumber(value: RawTagValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function asBoolean(value: RawTagValue): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true' || lowered === 'yes' || lowered === '1') return true;
    if (lowered === 'false' || lowered === 'no' || lowered === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

interface IsoCapable {
  toISOString?: () => string | undefined | null;
}

function isIsoCapable(value: unknown): value is IsoCapable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IsoCapable).toISOString === 'function'
  );
}

/**
 * Normalise the date formats ExifTool hands back (`2024:05:06 07:08:09+02:00`,
 * parsed `ExifDateTime`/`ExifDate` objects, plain ISO strings) to ISO 8601.
 * Returns a date-only string when no time component was recorded.
 */
export function toIsoDate(value: RawTagValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (isIsoCapable(value)) {
    const iso = value.toISOString?.();
    return iso ?? undefined;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  const match =
    /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text,
    );
  if (match === null) return text;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (hour === undefined) return `${year}-${month}-${day}`;
  const seconds = second ?? '00';
  const zoneSuffix = zone === undefined ? '' : zone === 'Z' ? 'Z' : normaliseOffset(zone);
  return `${year}-${month}-${day}T${hour}:${minute}:${seconds}${zoneSuffix}`;
}

function normaliseOffset(zone: string): string {
  if (zone.includes(':')) return zone;
  return `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

export interface ExifDateParts {
  /** `YYYYMMDD`, as written to IIM 2:055. */
  date: string;
  /** `HH:MM:SS+HH:MM`, as written to IIM 2:060. */
  time?: string;
}

/** Split an ISO 8601 date/date-time into the two IIM date datasets. */
export function splitIsoDate(value: string): ExifDateParts | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value.trim(),
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (hour === undefined) return { date: `${year}${month}${day}` };
  const offset = zone === undefined ? '' : zone === 'Z' ? '+00:00' : normaliseOffset(zone);
  return {
    date: `${year}${month}${day}`,
    time: `${hour}:${minute}:${second ?? '00'}${offset}`,
  };
}

/** Build an ISO date-time from a raw IIM date (`YYYYMMDD`) and time (`HH:MM:SS±HH:MM`). */
export function combineIimDate(date: unknown, time: unknown): string | undefined {
  const dateText = asString(date);
  if (dateText === undefined) return undefined;
  const digits = dateText.replace(/\D/g, '');
  if (digits.length !== 8) return undefined;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const timeText = asString(time);
  if (timeText === undefined) return iso;
  const timeMatch = /^(\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    timeText.trim(),
  );
  if (timeMatch === null) return iso;
  const [, hour, minute, second, zone] = timeMatch;
  const offset = zone === undefined ? '' : zone === 'Z' ? 'Z' : normaliseOffset(zone);
  return `${iso}T${hour}:${minute}:${second}${offset}`;
}
