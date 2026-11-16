import type { PanelWidthId, PanelWidths } from '@ee/contracts';

export type PanelAxis = 'horizontal' | 'vertical';

/** How large one panel may become, and where it starts. A width, or the film strip's height. */
export interface PanelSizeSpec {
  axis: PanelAxis;
  defaultSize: number;
  minSize: number;
  maxSize: number;
}

/** Narrowest the photo, grid or settings area may become between the side panels. */
export const CENTRE_MIN_WIDTH = 320;

/** The film strip never takes more than this share of the window height. */
const FILM_STRIP_WINDOW_DIVISOR = 3;

/**
 * Defaults, limits and the contents each limit is chosen for. The side panel minimums are the
 * widths where the panel's own rows still fit without clipping labels or slider values; their
 * maximums leave the centre usable on a 1440 px window. The film strip starts at its old height,
 * goes a little smaller, and stops at a third of the window.
 */
export const PANEL_SIZE_SPECS: Record<PanelWidthId, PanelSizeSpec> = {
  'library-sidebar': {
    axis: 'horizontal',
    defaultSize: 220,
    minSize: 160,
    maxSize: 520,
  },
  'library-inspector': {
    axis: 'horizontal',
    defaultSize: 300,
    minSize: 240,
    maxSize: 560,
  },
  'develop-metadata': {
    axis: 'horizontal',
    defaultSize: 280,
    minSize: 260,
    maxSize: 620,
  },
  'develop-panel': {
    axis: 'horizontal',
    defaultSize: 280,
    minSize: 260,
    maxSize: 620,
  },
  'ingest-sources': {
    axis: 'horizontal',
    defaultSize: 360,
    minSize: 260,
    maxSize: 680,
  },
  'film-strip': { axis: 'vertical', defaultSize: 92, minSize: 72, maxSize: 480 },
};

export const PANEL_WIDTH_IDS = Object.keys(PANEL_SIZE_SPECS) as PanelWidthId[];

/** The room a layout has for its panels: a width for side panels, a height for the film strip. */
export interface PanelContainerSize {
  width?: number;
  height?: number;
}

/** The widths a fresh install uses, before the user drags anything. */
export function defaultPanelWidths(): PanelWidths {
  const widths: PanelWidths = {};
  for (const id of PANEL_WIDTH_IDS) widths[id] = PANEL_SIZE_SPECS[id].defaultSize;
  return widths;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Clamp one size to the panel's own limits; a non-finite value becomes its default. */
export function clampPanelSize(id: PanelWidthId, value: number): number {
  const spec = PANEL_SIZE_SPECS[id];
  if (!Number.isFinite(value)) return spec.defaultSize;
  return Math.round(Math.min(spec.maxSize, Math.max(spec.minSize, value)));
}

/** The limits the panel has in the room it is in now. The vertical maximum follows the window. */
export function panelSizeLimits(
  id: PanelWidthId,
  container: PanelContainerSize | undefined,
): { min: number; max: number } {
  const spec = PANEL_SIZE_SPECS[id];
  if (
    spec.axis !== 'vertical' ||
    container?.height === undefined ||
    !Number.isFinite(container.height)
  ) {
    return { min: spec.minSize, max: spec.maxSize };
  }
  const share = Math.floor(container.height / FILM_STRIP_WINDOW_DIVISOR);
  return { min: spec.minSize, max: Math.max(spec.minSize, Math.min(spec.maxSize, share)) };
}

/**
 * Keep only known panels with finite sizes, clamped to today's limits. A
 * settings file from before the panels existed has no object at all and keeps
 * every default until the user drags.
 */
export function sanitizePanelWidths(value: unknown): PanelWidths | undefined {
  if (!isObject(value)) return undefined;
  const widths: PanelWidths = {};
  for (const id of PANEL_WIDTH_IDS) {
    const width = value[id];
    if (typeof width !== 'number' || !Number.isFinite(width)) continue;
    widths[id] = clampPanelSize(id, width);
  }
  return Object.keys(widths).length === 0 ? undefined : widths;
}

/**
 * Fit a dragged size between its own limits and the room left beside the other
 * visible panels. A small window stops the drag at the centre's minimum
 * instead of squeezing it away.
 */
export function fitPanelSize(
  id: PanelWidthId,
  requested: number,
  otherSizes: readonly number[],
  container: PanelContainerSize | undefined,
): number {
  const spec = PANEL_SIZE_SPECS[id];
  const limits = panelSizeLimits(id, container);
  const clamped = Math.min(limits.max, clampPanelSize(id, requested));
  if (spec.axis === 'vertical') return clamped;
  if (container?.width === undefined || !Number.isFinite(container.width)) return clamped;
  const other = otherSizes.reduce((total, size) => total + size, 0);
  const room = container.width - CENTRE_MIN_WIDTH - other;
  return Math.round(Math.min(clamped, Math.max(spec.minSize, room)));
}

/**
 * The sizes the view actually shows. Preferences are used as they are when
 * they fit; a smaller window shrinks the side panels above their minimums in
 * proportion, without changing the stored preference, and gives them back when
 * it grows again. The film strip's height is capped at a third of the window.
 */
export function layoutPanelSizes(
  ids: readonly PanelWidthId[],
  preferred: PanelWidths | undefined,
  container: PanelContainerSize | undefined,
): PanelWidths {
  const sizes: PanelWidths = {};
  for (const id of ids) {
    const limits = panelSizeLimits(id, container);
    const size = clampPanelSize(id, preferred?.[id] ?? PANEL_SIZE_SPECS[id].defaultSize);
    sizes[id] = Math.min(limits.max, size);
  }
  if (container?.width === undefined || !Number.isFinite(container.width)) return sizes;

  const horizontal = ids.filter((id) => PANEL_SIZE_SPECS[id].axis === 'horizontal');
  const available = container.width - CENTRE_MIN_WIDTH;
  const total = horizontal.reduce((sum, id) => sum + (sizes[id] ?? 0), 0);
  if (total <= available) return sizes;

  const minimum = horizontal.reduce((sum, id) => sum + PANEL_SIZE_SPECS[id].minSize, 0);
  if (available <= minimum) {
    for (const id of horizontal) sizes[id] = PANEL_SIZE_SPECS[id].minSize;
    return sizes;
  }

  const room = available - minimum;
  for (const id of horizontal) {
    const spec = PANEL_SIZE_SPECS[id];
    const extra = (sizes[id] ?? spec.minSize) - spec.minSize;
    sizes[id] = spec.minSize + (extra / (total - minimum)) * room;
  }
  return sizes;
}
