import { MIN_BLOCK_SIZE } from '@ee/retouch';

/**
 * The toolbar shows the mosaic block in pixels of the full-resolution photo, the way a photographer
 * thinks about it. The stored value stays `blockSizeRel` (a fraction of the longer image edge), so
 * saved retouch versions keep working and a smaller export render looks the same as the
 * full-resolution one. This module converts at that boundary.
 */
export const BLOCK_SIZE_PX = { min: MIN_BLOCK_SIZE, max: 256, step: 1 } as const;

/**
 * The percent slider, used only while the photo's long edge is unknown. The
 * stored value is still relative, so a saved version looks the same at any
 * render size.
 */
export const BLOCK_SIZE_REL_RANGE = { min: 0.002, max: 0.04, step: 0.001 } as const;

/** The longer edge of the full-resolution photo, or undefined while its size is unknown. */
export function photoLongEdge(photo: { width?: number; height?: number }): number | undefined {
  const { width, height } = photo;
  if (width === undefined || height === undefined) return undefined;
  const edge = Math.max(width, height);
  return Number.isFinite(edge) && edge > 0 ? edge : undefined;
}

/** A block edge in whole pixels of the full-resolution photo, never below one pixel. */
export function blockSizeRelToPx(blockSizeRel: number, longEdge: number): number {
  return Math.max(1, Math.round(blockSizeRel * longEdge));
}

export function blockSizePxToRel(px: number, longEdge: number): number {
  return Math.max(1, Math.round(px)) / longEdge;
}

/**
 * Slider bounds for a photo. A saved version made with the old percent slider can sit above the
 * fixed maximum on a large photo; the range stretches so the thumb never hides it.
 */
export function blockSizePxRange(currentPx: number): { min: number; max: number; step: number } {
  return {
    min: Math.min(BLOCK_SIZE_PX.min, currentPx),
    max: Math.max(BLOCK_SIZE_PX.max, currentPx),
    step: BLOCK_SIZE_PX.step,
  };
}
