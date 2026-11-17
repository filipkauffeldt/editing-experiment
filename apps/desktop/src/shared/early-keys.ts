/**
 * Keys pressed while the page is still loading. The preload script runs before the renderer's
 * scripts, so it can see a key that arrives before the shell has mounted its keyboard handler.
 * The shell takes those keys once and replays them, so a key pressed as soon as the window
 * exists (a test, or a fast hand on a slow start) is not lost.
 */
export interface EarlyKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

export interface EarlyKeys {
  /** The keys so far, oldest first. The first call ends the collecting; later calls get none. */
  take(): EarlyKey[];
}

/** The part of a DOM `KeyboardEvent` read here, so this file needs no DOM types (the preload has none). */
type KeyPress = EarlyKey;

/** What the page's `window` offers, as far as this file goes. */
export interface KeyTarget {
  addEventListener(type: 'keydown', listener: (event: KeyPress) => void, capture: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: KeyPress) => void, capture: boolean): void;
}

/** Longest a key waits for the shell; an older one is a press the user has moved on from. */
export const EARLY_KEY_MAX_AGE_MS = 5_000;
const EARLY_KEY_LIMIT = 16;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'Dead']);

/**
 * Start collecting `keydown` events on `target`. Modifier and dead keys on their own are not
 * kept, and neither is any key with Ctrl and Alt together, which on a Swedish keyboard is AltGr
 * and must never become a command.
 */
export function collectEarlyKeys(target: KeyTarget, now: () => number = Date.now): EarlyKeys {
  const keys: { at: number; key: EarlyKey }[] = [];
  const onKeyDown = (press: KeyPress): void => {
    if (MODIFIER_KEYS.has(press.key) || (press.ctrlKey && press.altKey)) return;
    if (keys.length >= EARLY_KEY_LIMIT) return;
    keys.push({
      at: now(),
      key: {
        key: press.key,
        code: press.code,
        ctrlKey: press.ctrlKey,
        altKey: press.altKey,
        shiftKey: press.shiftKey,
        metaKey: press.metaKey,
        repeat: press.repeat,
      },
    });
  };
  target.addEventListener('keydown', onKeyDown, true);
  return {
    take: () => {
      target.removeEventListener('keydown', onKeyDown, true);
      const cutoff = now() - EARLY_KEY_MAX_AGE_MS;
      return keys
        .splice(0)
        .filter((entry) => entry.at >= cutoff)
        .map((entry) => entry.key);
    },
  };
}
