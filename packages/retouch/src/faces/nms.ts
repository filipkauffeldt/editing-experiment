import type { Point } from '@ee/contracts';
import type { PixelRect } from '../geometry';

export interface ScoredBox {
  box: PixelRect;
  score: number;
}

export interface MergeableDetection extends ScoredBox {
  landmarks: Point[];
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

function unionRect(a: PixelRect, b: PixelRect): PixelRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Merge overlapping detections into their union instead of suppressing one of
 * them. This matters at tile boundaries: each tile may see only part of a face
 * and NMS could otherwise keep a high-scoring fragment over the complete box.
 *
 * Boxes are merged when their IoU exceeds `iouThreshold`, or when most of the
 * smaller box lies inside the larger one. Landmarks and score come from the
 * highest-scoring member of the cluster.
 */
export function mergeOverlappingDetections<T extends MergeableDetection>(
  candidates: readonly T[],
  iouThreshold: number,
): T[] {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i]!.box;
    const areaA = a.w * a.h;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j]!.box;
      const areaB = b.w * b.h;
      const intersection = intersectionArea(a, b);
      if (intersection <= 0) continue;
      const iou = intersection / (areaA + areaB - intersection);
      const smallerOverlap = intersection / Math.min(areaA, areaB);
      if (iou >= iouThreshold || smallerOverlap >= 0.5) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  }

  const merged: T[] = [];
  for (const group of groups.values()) {
    let best = candidates[group[0]!]!;
    let box = best.box;
    for (const index of group.slice(1)) {
      const candidate = candidates[index]!;
      box = unionRect(box, candidate.box);
      if (candidate.score > best.score) best = candidate;
    }
    merged.push({ ...best, box, score: best.score, landmarks: best.landmarks });
  }
  return merged.sort((a, b) => b.score - a.score);
}
