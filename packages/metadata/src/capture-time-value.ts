/** A capture time split into wall-clock parts, with the fraction and zone as they were written. */
export interface CaptureDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fractional seconds including the dot, e.g. `.310`. */
  fraction?: string;
  /** `Z` or `+HH:MM`/`+HHMM`, exactly as it was read. */
  zone?: string;
}

// Seconds are required: a capture time without them is a date, not a clock time.
const DATE_TIME =
  /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse an ISO 8601 or ExifTool date-time without shifting it through the machine's zone. */
export function parseCaptureDateTime(value: string): CaptureDateTimeParts | undefined {
  const match = DATE_TIME.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    ...(fraction === undefined ? {} : { fraction }),
    ...(zone === undefined ? {} : { zone }),
  };
}

/** Move the wall clock by `offsetSeconds`, keeping the fraction and zone. */
export function shiftCaptureDateTime(
  parts: CaptureDateTimeParts,
  offsetSeconds: number,
): CaptureDateTimeParts {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) +
      offsetSeconds * 1000,
  );
  return {
    ...parts,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** The ISO 8601 form used in XMP. */
export function formatCaptureDateTime(parts: CaptureDateTimeParts): string {
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    `${parts.fraction ?? ''}${parts.zone ?? ''}`
  );
}

/** The EXIF form (`YYYY:MM:DD HH:MM:SS`); fractions and zones live in their own tags. */
export function formatExifDateTime(parts: CaptureDateTimeParts): string {
  return (
    `${parts.year}:${pad(parts.month)}:${pad(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

/** IIM 2:055 (`YYYYMMDD`). */
export function formatIimDate(parts: CaptureDateTimeParts): string {
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
}

/** IIM 2:060 (`HH:MM:SS±HH:MM`). */
export function formatIimTime(parts: CaptureDateTimeParts): string {
  const zone = parts.zone === 'Z' ? '+00:00' : parts.zone;
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${zone ?? ''}`;
}

/** Shift an ISO/EXIF value and return the ISO form, or `undefined` when it has no clock time. */
export function shiftCaptureTimeValue(value: string, offsetSeconds: number): string | undefined {
  const parts = parseCaptureDateTime(value);
  if (parts === undefined) return undefined;
  return formatCaptureDateTime(shiftCaptureDateTime(parts, offsetSeconds));
}
