/**
 * Star-rating and colour-class keys. Digits are matched by what the layout
 * prints (`event.key`), so the top row and the numpad work on Swedish and
 * other non-US layouts. With a command modifier held, some layouts report a
 * different `event.key`, so the physical `Digit*`/`Numpad*` code is the
 * fallback.
 */

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

/** The platform's primary command modifier: ⌘ on macOS, Ctrl elsewhere. */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

function digitFromKey(key: string): number | undefined {
  return /^[0-9]$/.test(key) ? Number(key) : undefined;
}

function digitFromCode(code: string): number | undefined {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function isAltGraph(event: ShortcutKeyEvent): boolean {
  return event.getModifierState?.('AltGraph') === true;
}

/** A plain digit sets the rating; 0 clears it. Shift+digit is a symbol, not a rating. */
export function ratingFromKey(event: ShortcutKeyEvent): number | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isAltGraph(event)) {
    return undefined;
  }
  const digit = digitFromKey(event.key);
  return digit !== undefined && digit <= 5 ? digit : undefined;
}

/** The primary modifier plus a digit sets the colour class; 0 clears it. */
export function colorClassFromKey(
  event: ShortcutKeyEvent,
  mac = isMacPlatform(),
): number | undefined {
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  if (!primary || secondary || event.altKey || event.shiftKey || isAltGraph(event)) {
    return undefined;
  }
  const digit = digitFromKey(event.key) ?? digitFromCode(event.code);
  return digit !== undefined && digit <= 8 ? digit : undefined;
}
