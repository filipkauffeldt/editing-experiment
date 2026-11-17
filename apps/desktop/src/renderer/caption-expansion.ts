import type { ReplacedRange } from '@ee/contracts';

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

/** A stretch `[from, to)` of a text. */
export interface Span {
  from: number;
  to: number;
}

/** A position of the text a pass made, in the text the pass was given. */
function positionBeforePass(
  position: number,
  edits: readonly ReplacedRange[],
  end: boolean,
): number {
  let shift = 0;
  for (const edit of edits) {
    // Before this replacement. A stretch that ends where one starts stays before it.
    if (position < edit.newFrom || (end && position === edit.newFrom)) break;
    // Inside what a replacement wrote: the whole replaced stretch of the older text.
    if (position < edit.newTo) return end ? edit.to : edit.from;
    shift += edit.newTo - edit.newFrom - (edit.to - edit.from);
  }
  return position - shift;
}

/**
 * Where the codes and `{variables}` an expansion replaced stood in the text as it was typed. Each
 * pass reports its stretches in the text it was given, so the later pass is carried back through
 * the earlier one. A variable that a code wrote is part of that code's stretch.
 */
export function typedSpans(passes: readonly (readonly ReplacedRange[])[]): Span[] {
  let spans: Span[] = [];
  for (let index = passes.length - 1; index >= 0; index--) {
    const edits = passes[index] ?? [];
    spans = [
      ...spans.map((span) => ({
        from: positionBeforePass(span.from, edits, false),
        to: positionBeforePass(span.to, edits, true),
      })),
      ...edits.map((edit) => ({ from: edit.from, to: edit.to })),
    ];
  }
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** A text with stretches taken out, and where a position of the old text is in the new one. */
export interface Removal {
  text: string;
  caretAt(position: number): number;
}

/**
 * The typed text as if the codes in `spans` had never been typed. Where that would leave two
 * spaces side by side (a space on each side of what was removed) one of them goes too. A caret in
 * or at the end of a removed stretch ends where the stretch was.
 */
export function removeSpans(text: string, spans: readonly Span[]): Removal {
  const keep = Array.from({ length: text.length }, () => true);
  for (const span of spans) {
    for (let at = Math.max(0, span.from); at < Math.min(text.length, span.to); at++)
      keep[at] = false;
  }
  for (const span of spans) {
    let before = span.from - 1;
    while (before >= 0 && !keep[before]) before--;
    const after = span.to;
    if (
      before >= 0 &&
      after < text.length &&
      keep[after] &&
      text[before] === ' ' &&
      text[after] === ' '
    ) {
      keep[after] = false;
    }
  }
  // Kept characters before each position, for the caret.
  const kept: number[] = [0];
  for (let at = 0; at < text.length; at++) kept.push((kept[at] ?? 0) + (keep[at] ? 1 : 0));
  return {
    text: [...text].filter((_, at) => keep[at]).join(''),
    caretAt: (position) => kept[Math.max(0, Math.min(text.length, position))] ?? 0,
  };
}
