/**
 * A patch of 1 px black and white columns in a photo, and the check that reads it off a
 * screenshot, for tests that look at what the compositor shows at 100%.
 */

/** A patch of 1 px black (even x) and white (odd x) columns, in image pixels. */
export const STRIPES = { x: 1000, y: 500, w: 64, h: 64 };
/** The patch's black columns run from its first column to the last even one. */
export const BLACK_WIDTH = STRIPES.w - 1;
/**
 * Luma cutoffs for the patch. The WebGL-rendered gradient is darker than the bytes written into
 * the JPEG (its darkest corner is about 33), so a black stripe is not the only pixel below 40.
 */
export const BLACK_MAX = 16;
export const WHITE_MIN = 240;

export interface Shot {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export const luma = (shot: Shot, x: number, y: number): number => {
  const at = (y * shot.width + x) * 4;
  return (shot.rgba[at]! + shot.rgba[at + 1]! + shot.rgba[at + 2]!) / 3;
};

/**
 * Reads the stripe patch off a screenshot: it must be exactly `ratio * 64` rows tall, every
 * column across it black or white, and its edges must not be blended with the background.
 * Returns what is wrong, or nothing.
 */
export function stripeProblems(shot: Shot, ratio: number): string[] {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      if (luma(shot, x, y) > BLACK_MAX) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return ['no black stripe on screen (the patch is out of view or blended to grey)'];
  const problems: string[] = [];
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width !== BLACK_WIDTH * ratio)
    problems.push(`black width ${width}, want ${BLACK_WIDTH * ratio}`);
  if (height !== STRIPES.h * ratio)
    problems.push(`black height ${height}, want ${STRIPES.h * ratio}`);
  // Every column of the patch, on a row through its middle, is black or white (flat grey is blended).
  const row = Math.round((minY + maxY) / 2);
  let grey = 0;
  for (let x = minX; x <= maxX; x++) {
    const v = luma(shot, x, row);
    if (v > BLACK_MAX && v < WHITE_MIN) grey += 1;
  }
  if (grey > 0) problems.push(`${grey} columns on the middle row are neither black nor white`);
  // One device pixel outside the patch is the background, not a blend of it with a stripe.
  const background = luma(shot, Math.max(0, minX - 12), row);
  const ring = [
    luma(shot, Math.max(0, minX - 1), row),
    luma(shot, Math.min(shot.width - 1, maxX + 1), row),
    luma(shot, minX, Math.max(0, minY - 1)),
    luma(shot, minX, Math.min(shot.height - 1, maxY + 1)),
  ];
  // The patch's white edge column / row can legitimately be the neighbour of the first stripe, so
  // only the rows above and below and the column left of the first black column are compared.
  for (const at of [ring[0]!, ring[2]!, ring[3]!]) {
    if (Math.abs(at - background) > 14)
      problems.push(`edge pixel ${at.toFixed(0)} is not background ${background.toFixed(0)}`);
  }
  return problems;
}
