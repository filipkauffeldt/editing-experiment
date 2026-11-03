import { isMacPlatform, type ShortcutKeyEvent } from './rating-keys';

/**
 * Zoom keys. Like the rating and colour-class keys they match what the layout prints
 * (`event.key`), never a physical key: on a Swedish keyboard `+` and `-` are plain keys at the
 * physical Minus and Slash positions, so `event.code` would zoom the wrong way.
 *
 * - `Z` toggles Fit and the chosen level;
 * - Ctrl/Cmd and `+` (or `=`, the unshifted US key, or the numpad `+`) zooms in a step;
 * - Ctrl/Cmd and `-` (or the numpad `-`) zooms out a step.
 *
 * Ctrl/Cmd+0 is not here: it clears the colour class.
 */
export type ZoomKeyAction = 'toggle' | 'in' | 'out';

export interface ZoomKeyEvent extends ShortcutKeyEvent {
  repeat?: boolean;
}

const isAltGraph = (event: ZoomKeyEvent): boolean => event.getModifierState?.('AltGraph') === true;

export function zoomKeyAction(
  event: ZoomKeyEvent,
  mac = isMacPlatform(),
): ZoomKeyAction | undefined {
  // AltGr reaches us as Ctrl+Alt on Windows/Linux: it types a character, it never zooms.
  if (event.altKey || isAltGraph(event)) return undefined;
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  if (secondary) return undefined;
  if (!primary) {
    return event.key === 'z' || event.key === 'Z' ? 'toggle' : undefined;
  }
  // The numpad keys report `+` and `-` too, but keep the code as a fallback for layouts
  // where a modifier changes the key value.
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'out';
  return undefined;
}
