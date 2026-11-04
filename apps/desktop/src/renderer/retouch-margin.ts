import type { Point } from '@ee/contracts';

/**
 * The strip just outside the picture where a Retouch drag may start, in CSS pixels. The drawing
 * is clipped to the picture, so this is how an area reaches the very edge.
 */
export const HIT_MARGIN = 24;

/** A point as a fraction of the picture, pulled onto it. */
export const clampToPicture = (point: Point): Point => ({
  x: Math.min(1, Math.max(0, point.x)),
  y: Math.min(1, Math.max(0, point.y)),
});

/** Whether a point (a fraction of the picture, unclamped) is on the picture itself. */
export const isOnPicture = (point: Point): boolean =>
  point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the Retouch overlay sits in the stage, and the part of the picture's 0..1 space its
 * viewBox shows. The overlay covers the picture plus {@link HIT_MARGIN} on every side, cut off at
 * `room` (the canvas area, in stage pixels): a picture bigger than the canvas has no margin on
 * that side, and the margin never reaches the toolbar or the panels.
 */
export function overlayFrame(
  picture: Box,
  room: Box,
  margin: number = HIT_MARGIN,
): { box: Box; viewBox: string } {
  const left = Math.max(picture.x - margin, room.x);
  const top = Math.max(picture.y - margin, room.y);
  const right = Math.min(picture.x + picture.w + margin, room.x + room.w);
  const bottom = Math.min(picture.y + picture.h + margin, room.y + room.h);
  const box = { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  const w = Math.max(1e-9, picture.w);
  const h = Math.max(1e-9, picture.h);
  return {
    box,
    viewBox: `${(left - picture.x) / w} ${(top - picture.y) / h} ${box.w / w} ${box.h / h}`,
  };
}
