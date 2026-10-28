import type { Rect } from '@ee/contracts';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Padding around a detected face, as a fraction of its width. Height padding is
 * 1.4x wider and biased upward (65% above, 35% below) so hair and chins are
 * covered without swallowing much more of the frame.
 */
export const FACE_PADDING_VERTICAL = 1.4;
export const FACE_PADDING_UP_BIAS = 0.65;

/** Expand a normalized face box, clamped to the image. */
export function padFaceBox(box: Rect, padding: number): Rect {
  const horizontal = Math.max(0, box.w * padding);
  const vertical = Math.max(0, box.h * padding * FACE_PADDING_VERTICAL);
  const up = vertical * FACE_PADDING_UP_BIAS;
  const left = clamp(box.x - horizontal, 0, 1);
  const top = clamp(box.y - up, 0, 1);
  const right = clamp(box.x + box.w + horizontal, left, 1);
  const bottom = clamp(box.y + box.h + vertical - up, top, 1);
  return { type: 'rect', x: left, y: top, w: right - left, h: bottom - top };
}
