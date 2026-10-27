import type { PixelRect } from '../geometry';

export interface ScoredBox {
  box: PixelRect;
  score: number;
}

function intersectionArea(a: PixelRect, b: PixelRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

export function intersectionOverUnion(a: PixelRect, b: PixelRect): number {
  const intersection = intersectionArea(a, b);
  if (intersection === 0) return 0;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Greedy non-maximum suppression, highest score first. */
export function nonMaximumSuppression<T extends ScoredBox>(
  candidates: readonly T[],
  iouThreshold: number,
  topK = 5000,
): T[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const candidate of sorted) {
    if (kept.length >= topK) break;
    let overlaps = false;
    for (const other of kept) {
      if (intersectionOverUnion(candidate.box, other.box) > iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}
