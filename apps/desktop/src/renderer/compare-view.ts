import type { PhotoId } from '@ee/contracts';

/**
 * The Library compare view: two to four photos of a burst side by side, to pick the sharpest.
 * Pure helpers here, the state is `LibraryState.compare`.
 */

/** The compare view's zoom belongs to the view, so every pane shows the same part of its photo. */
export const COMPARE_ZOOM_KEY = 'compare';

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

/** Whether this many selected photos can be compared. */
export const canCompare = (count: number): boolean => count >= COMPARE_MIN && count <= COMPARE_MAX;

/** The button's tooltip while it is disabled. */
export const COMPARE_HINT = `Select ${COMPARE_MIN} to ${COMPARE_MAX} photos to compare`;

/** The selected photos in the grid's order. Photos the grid does not list keep their order, last. */
export function compareOrder(
  selection: readonly PhotoId[],
  gridOrder: readonly { id: PhotoId }[],
): PhotoId[] {
  const position = new Map(gridOrder.map((photo, index) => [photo.id, index] as const));
  const rank = (id: PhotoId): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...selection].sort((a, b) => rank(a) - rank(b));
}

/** The pane next to the active one, stopping at the first and the last. */
export function movedActive(ids: readonly PhotoId[], activeId: PhotoId, delta: number): PhotoId {
  const index = ids.indexOf(activeId);
  const target = Math.max(0, Math.min(ids.length - 1, (index < 0 ? 0 : index) + delta));
  return ids[target] ?? activeId;
}
