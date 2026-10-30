/** One Color Grading wheel's hue and saturation, as stored in `ColorGrade*Hue/Sat`. */
export interface WheelHueSat {
  /** Degrees 0..359 (360 is stored as 0). */
  hue: number;
  /** 0..100. */
  sat: number;
}

export type WheelDragMode = 'both' | 'hue' | 'sat';

export interface WheelModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** `event.getModifierState('AltGraph')`, when the browser exposes it. */
  altGraph?: boolean;
}

/**
 * Shift-drag changes saturation only, Ctrl/Cmd-drag hue only. AltGr reports
 * itself as Ctrl+Alt on Windows and Linux, so any Alt or AltGraph keeps the
 * normal drag instead of being read as Ctrl.
 */
export function wheelDragMode(modifiers: WheelModifiers): WheelDragMode {
  if (modifiers.altKey || modifiers.altGraph) return 'both';
  if (modifiers.shiftKey) return 'sat';
  if (modifiers.ctrlKey || modifiers.metaKey) return 'hue';
  return 'both';
}

/** Wrap any angle into 0..359; 360 and -0.4 both mean the same position as 0. */
export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  const wrapped = ((Math.round(hue) % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}

const clampSat = (sat: number): number =>
  Math.min(100, Math.max(0, Math.round(Number.isFinite(sat) ? sat : 0)));

/** Pointer offset from the wheel centre to hue and saturation. */
export function hueSatFromPoint(dx: number, dy: number, radius: number): WheelHueSat {
  if (radius <= 0) return { hue: 0, sat: 0 };
  const hue = normalizeHue((Math.atan2(-dy, dx) * 180) / Math.PI);
  const sat = clampSat((Math.hypot(dx, dy) / radius) * 100);
  return { hue, sat };
}

/** Puck offset from the centre for a stored hue and saturation (SVG y points down). */
export function pointFromHueSat(
  hue: number,
  sat: number,
  radius: number,
): { x: number; y: number } {
  const angle = (normalizeHue(hue) * Math.PI) / 180;
  const distance = (radius * clampSat(sat)) / 100;
  return { x: Math.cos(angle) * distance, y: -Math.sin(angle) * distance };
}

/**
 * Applies a drag from `start` to `point` according to the modifiers. The
 * unchanged coordinate is kept exactly, so a Shift-drag never nudges the hue.
 */
export function applyWheelDrag(
  start: WheelHueSat,
  dx: number,
  dy: number,
  radius: number,
  mode: WheelDragMode,
): WheelHueSat {
  const moved = hueSatFromPoint(dx, dy, radius);
  if (mode === 'hue') return { hue: moved.hue, sat: start.sat };
  if (mode === 'sat') return { hue: start.hue, sat: moved.sat };
  return moved;
}

/** Saturation as the sliders store it: a whole percentage in 0..100. */
export function clampSaturation(sat: number): number {
  return clampSat(sat);
}
