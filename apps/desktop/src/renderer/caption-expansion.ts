/** The part of a text that differs: `[start, end)` of the old text became `text`. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

/**
 * The one stretch that turns `before` into `after`: what is left after cutting the shared start
 * and the shared end. Replacing just that stretch keeps the rest of the field as the browser's
 * own edit history knows it.
 */
export function changedRange(before: string, after: string): TextChange {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  let trailing = 0;
  while (
    trailing < shortest - start &&
    before[before.length - 1 - trailing] === after[after.length - 1 - trailing]
  ) {
    trailing++;
  }
  return {
    start,
    end: before.length - trailing,
    text: after.slice(start, after.length - trailing),
  };
}

/** Where a caret of the old text is in the new one: kept in what stayed, after what replaced it. */
export function caretThroughChange(caret: number, change: TextChange): number {
  if (caret <= change.start) return caret;
  if (caret >= change.end) return caret - (change.end - change.start) + change.text.length;
  return change.start + change.text.length;
}
