import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../jobs/backend/atomic-json';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is remembered of the main window. Position is the normal (not maximised) rectangle. */
export interface WindowState extends Rect {
  maximized: boolean;
}

/** Its own file, not `settings.json`: settings are meant to be shared between computers, a window is not. */
export const WINDOW_STATE_FILE = 'window-state.json';
export const windowStateFile = (userDataDir: string): string =>
  join(userDataDir, WINDOW_STATE_FILE);

/** How much of the window has to be on a screen before the saved position is trusted. */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 50;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The saved state, or `undefined` when there is none or the file is not one of ours. */
export function readWindowState(file: string): WindowState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState> | null;
    if (!value || typeof value !== 'object') return undefined;
    const { x, y, width, height, maximized } = value;
    if (!isCount(x) || !isCount(y) || !isCount(width) || !isCount(height)) return undefined;
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      maximized: maximized === true,
    };
  } catch {
    // A damaged file only costs the remembered window.
    return undefined;
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  writeJsonAtomic(file, state);
}

const overlap = (a: Rect, b: Rect): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

export interface WindowPlacement {
  width: number;
  height: number;
  /** Absent: let the system place the window (centred), as on a first run. */
  x?: number;
  y?: number;
  maximized: boolean;
}

/**
 * Where to open the window. `workAreas` are the usable areas of the displays that exist now. A saved
 * position that is not on any of them (a monitor that was unplugged) falls back to the default
 * size and placement. The maximised flag is kept either way.
 */
export function placeWindow(
  saved: WindowState | undefined,
  workAreas: readonly Rect[],
  defaults: { width: number; height: number; minWidth: number; minHeight: number },
): WindowPlacement {
  const fallback = { width: defaults.width, height: defaults.height };
  if (!saved) return { ...fallback, maximized: false };
  const width = Math.max(defaults.minWidth, saved.width);
  const height = Math.max(defaults.minHeight, saved.height);
  const onScreen = workAreas.some((area) => {
    const shared = overlap({ x: saved.x, y: saved.y, width, height }, area);
    return shared.width >= MIN_VISIBLE_WIDTH && shared.height >= MIN_VISIBLE_HEIGHT;
  });
  if (!onScreen) return { ...fallback, maximized: saved.maximized };
  return { x: saved.x, y: saved.y, width, height, maximized: saved.maximized };
}
