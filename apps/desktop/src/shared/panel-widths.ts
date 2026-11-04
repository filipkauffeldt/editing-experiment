import type { PanelWidthId, PanelWidths } from '@ee/contracts';

/** How wide one side panel may become, and where it starts. */
export interface PanelWidthSpec {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

/** Narrowest the photo, grid or settings area may become between the panels. */
export const CENTRE_MIN_WIDTH = 320;

/**
 * Defaults, limits and the contents each limit is chosen for. The minimums are
 * the widths where the panel's own rows still fit without clipping labels or
 * slider values; the maximums leave the centre usable on a 1440 px window.
 */
export const PANEL_WIDTH_SPECS: Record<PanelWidthId, PanelWidthSpec> = {
  'library-sidebar': { defaultWidth: 220, minWidth: 160, maxWidth: 520 },
  'library-inspector': { defaultWidth: 300, minWidth: 240, maxWidth: 560 },
  'develop-metadata': { defaultWidth: 320, minWidth: 260, maxWidth: 620 },
  'develop-panel': { defaultWidth: 300, minWidth: 260, maxWidth: 620 },
  'ingest-sources': { defaultWidth: 360, minWidth: 260, maxWidth: 680 },
};

export const PANEL_WIDTH_IDS = Object.keys(PANEL_WIDTH_SPECS) as PanelWidthId[];

/** The widths a fresh install uses, before the user drags anything. */
export function defaultPanelWidths(): PanelWidths {
  const widths: PanelWidths = {};
  for (const id of PANEL_WIDTH_IDS) widths[id] = PANEL_WIDTH_SPECS[id].defaultWidth;
  return widths;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Clamp one width to the panel's own limits; a non-finite value becomes its default. */
export function clampPanelWidth(id: PanelWidthId, value: number): number {
  const spec = PANEL_WIDTH_SPECS[id];
  if (!Number.isFinite(value)) return spec.defaultWidth;
  return Math.round(Math.min(spec.maxWidth, Math.max(spec.minWidth, value)));
}

/**
 * Keep only known panels with finite widths, clamped to today's limits. A
 * settings file from before the panels existed has no object at all and keeps
 * every default until the user drags.
 */
export function sanitizePanelWidths(value: unknown): PanelWidths | undefined {
  if (!isObject(value)) return undefined;
  const widths: PanelWidths = {};
  for (const id of PANEL_WIDTH_IDS) {
    const width = value[id];
    if (typeof width !== 'number' || !Number.isFinite(width)) continue;
    widths[id] = clampPanelWidth(id, width);
  }
  return Object.keys(widths).length === 0 ? undefined : widths;
}

/**
 * Fit a dragged width between its own limits and the room left beside the
 * other visible panels. A small window stops the drag at the centre's minimum
 * instead of squeezing it away.
 */
export function fitPanelWidth(
  id: PanelWidthId,
  requested: number,
  otherWidths: readonly number[],
  containerWidth: number | undefined,
): number {
  const clamped = clampPanelWidth(id, requested);
  if (containerWidth === undefined || !Number.isFinite(containerWidth)) return clamped;
  const spec = PANEL_WIDTH_SPECS[id];
  const other = otherWidths.reduce((total, width) => total + width, 0);
  const room = containerWidth - CENTRE_MIN_WIDTH - other;
  return Math.round(Math.min(clamped, Math.max(spec.minWidth, room)));
}

/**
 * The widths the view actually shows. Preferences are used as they are when
 * they fit; a smaller window shrinks the panels above their minimums in
 * proportion, without changing the stored preference, and gives them back when
 * it grows again.
 */
export function layoutPanelWidths(
  ids: readonly PanelWidthId[],
  preferred: PanelWidths | undefined,
  containerWidth: number | undefined,
): PanelWidths {
  const widths: PanelWidths = {};
  for (const id of ids) {
    widths[id] = clampPanelWidth(id, preferred?.[id] ?? PANEL_WIDTH_SPECS[id].defaultWidth);
  }
  if (containerWidth === undefined || !Number.isFinite(containerWidth)) return widths;

  const available = containerWidth - CENTRE_MIN_WIDTH;
  const total = ids.reduce((sum, id) => sum + (widths[id] ?? 0), 0);
  if (total <= available) return widths;

  const minimum = ids.reduce((sum, id) => sum + PANEL_WIDTH_SPECS[id].minWidth, 0);
  if (available <= minimum) {
    for (const id of ids) widths[id] = PANEL_WIDTH_SPECS[id].minWidth;
    return widths;
  }

  const room = available - minimum;
  for (const id of ids) {
    const spec = PANEL_WIDTH_SPECS[id];
    const extra = (widths[id] ?? spec.minWidth) - spec.minWidth;
    widths[id] = spec.minWidth + (extra / (total - minimum)) * room;
  }
  return widths;
}
