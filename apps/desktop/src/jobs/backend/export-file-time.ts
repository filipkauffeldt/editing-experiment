import { utimes } from 'node:fs/promises';

const CAPTURE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

/**
 * The instant a photo was taken, from the index's `captureTime`.
 *
 * A camera raw records the clock face without a zone, so `2026-10-03T18:13:16`
 * means "18:13:16 wherever the photographer was". With an `OffsetTimeOriginal`
 * that pins the instant; without one the only honest reading is this
 * machine's local time (what ECMAScript does for a zone-less date-time), which
 * never shifts the clock face by hours. A date without a time (or anything
 * that is not a date-time) gives `undefined`: there is no moment to stamp.
 */
export function captureInstant(
  captureTime: string | undefined,
  offset: string | undefined,
): Date | undefined {
  if (captureTime === undefined) return undefined;
  const text = captureTime.trim();
  const match = CAPTURE_TIME.exec(text);
  if (match === null) return undefined;
  if (match[1] !== undefined) return validDate(text);
  if (offset !== undefined && OFFSET.test(offset)) {
    const pinned = validDate(`${text}${offset}`);
    if (pinned !== undefined) return pinned;
  }
  return validDate(text);
}

/** Whether `captureTime` already says which zone it is in, so no offset tag is needed. */
export function hasZone(captureTime: string | undefined): boolean {
  return captureTime !== undefined && /(?:Z|[+-]\d{2}:\d{2})$/.test(captureTime.trim());
}

function validDate(text: string): Date | undefined {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Sets the modified time of `file`; the access time is left at "now". A file
 * manager sorting by date then agrees with the camera. Returns whether it
 * worked: a file system that refuses the change must not fail an export.
 */
export async function setModifiedTime(
  file: string,
  when: Date,
  warn: (message: string) => void,
): Promise<boolean> {
  try {
    await utimes(file, new Date(), when);
    return true;
  } catch (error) {
    warn(
      `could not set the modified time of ${file} to ${when.toISOString()}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
