import type { Point, Polygon, Shape } from '@ee/contracts';
import { simplifyPolygon } from './geometry';
import { maskBounds, type Mask } from './mask';

export interface MagicWandOptions {
  /** CIE76 distance in Lab, 0..100. Default 10. */
  tolerance?: number;
  /** RDP epsilon for the outline, in normalised image units. Default 0.002. */
  simplify?: number;
}

export interface MagicWandResult {
  /** Contiguous selected pixels, 1 = selected. */
  mask: Mask;
  /** Outline of every selected region/hole, in normalised coordinates. */
  shapes: Shape[];
}

const D65_X = 0.95047;
const D65_Z = 1.08883;

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function labF(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65_X;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / D65_Z;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDistanceSquared(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

function maskAt(mask: Mask, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return mask[y * width + x]!;
}

const KEY_OFFSET = 2;

function contourKey(x: number, y: number, keyStride: number): number {
  // Marching-squares cells on the image border use coordinates -2/-1; the
  // offset keeps the packed key non-negative so it cannot collide with a row.
  return x + KEY_OFFSET + (y + KEY_OFFSET) * keyStride;
}

function contourPoint(key: number, keyStride: number): Point {
  const x = (key % keyStride) - KEY_OFFSET;
  const y = Math.floor(key / keyStride) - KEY_OFFSET;
  return { x: (x + 1) / 2, y: (y + 1) / 2 };
}

/**
 * Trace the boundary of a binary mask with marching squares and turn it into
 * simplified normalised polygons. Contours lie on pixel boundaries (halfway
 * between selected and unselected pixel centres).
 */
export function traceMaskOutline(
  mask: Mask,
  width: number,
  height: number,
  simplifyEpsilon = 0,
): Polygon[] {
  const bounds = maskBounds(mask, width, height);
  if (!bounds) return [];
  const keyStride = width * 2 + 4;
  const segments: Array<[number, number]> = [];
  const at = new Map<number, number[]>();

  const addSegment = (first: [number, number], second: [number, number]): void => {
    const a = contourKey(first[0], first[1], keyStride);
    const b = contourKey(second[0], second[1], keyStride);
    const index = segments.length;
    segments.push([a, b]);
    for (const key of [a, b]) {
      const list = at.get(key);
      if (list) list.push(index);
      else at.set(key, [index]);
    }
  };

  for (let cellY = bounds.y; cellY <= bounds.y + bounds.h; cellY++) {
    for (let cellX = bounds.x; cellX <= bounds.x + bounds.w; cellX++) {
      const topLeft = maskAt(mask, width, height, cellX - 1, cellY - 1);
      const topRight = maskAt(mask, width, height, cellX, cellY - 1);
      const bottomRight = maskAt(mask, width, height, cellX, cellY);
      const bottomLeft = maskAt(mask, width, height, cellX - 1, cellY);
      const code = topLeft * 8 + topRight * 4 + bottomRight * 2 + bottomLeft;
      if (code === 0 || code === 15) continue;

      const top: [number, number] = [cellX * 2 - 1, cellY * 2 - 2];
      const right: [number, number] = [cellX * 2, cellY * 2 - 1];
      const bottom: [number, number] = [cellX * 2 - 1, cellY * 2];
      const left: [number, number] = [cellX * 2 - 2, cellY * 2 - 1];

      switch (code) {
        case 1:
        case 14:
          addSegment(left, bottom);
          break;
        case 2:
        case 13:
          addSegment(bottom, right);
          break;
        case 3:
        case 12:
          addSegment(left, right);
          break;
        case 4:
        case 11:
          addSegment(top, right);
          break;
        case 5:
          addSegment(top, left);
          addSegment(bottom, right);
          break;
        case 6:
        case 9:
          addSegment(top, bottom);
          break;
        case 7:
        case 8:
          addSegment(top, left);
          break;
        case 10:
          addSegment(top, right);
          addSegment(left, bottom);
          break;
        default:
          break;
      }
    }
  }

  const visited = new Uint8Array(segments.length);
  const polygons: Polygon[] = [];
  for (let start = 0; start < segments.length; start++) {
    if (visited[start]) continue;
    const startKey = segments[start]![0];
    let segmentIndex = start;
    let key = startKey;
    const points: Point[] = [];
    for (;;) {
      visited[segmentIndex] = 1;
      points.push(contourPoint(key, keyStride));
      const [a, b] = segments[segmentIndex]!;
      const nextKey = a === key ? b : a;
      key = nextKey;
      if (key === startKey) break;
      const next = at.get(key)?.find((index) => !visited[index]);
      if (next === undefined) break;
      segmentIndex = next;
    }
    if (points.length < 3) continue;
    const normalized = points.map((point) => ({
      x: point.x / width,
      y: point.y / height,
    }));
    const simplified = simplifyPolygon(normalized, simplifyEpsilon);
    if (simplified.length >= 3) polygons.push({ type: 'polygon', points: simplified });
  }
  return polygons;
}

/**
 * Contiguous flood fill from a seed pixel in pixel coordinates. Colour distance
 * is CIE76 in Lab; only the connected component containing the seed is filled.
 */
export function magicWand(
  rgba: Uint8Array,
  width: number,
  height: number,
  seed: Point,
  options: MagicWandOptions = {},
): MagicWandResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`magicWand: invalid size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `magicWand: RGBA buffer is too small (${rgba.length} < ${width * height * 4})`,
    );
  }
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
    throw new RangeError(`magicWand: seed ${sx},${sy} is outside ${width}x${height}`);
  }
  const tolerance = options.tolerance ?? 10;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`magicWand: tolerance must be >= 0, got ${tolerance}`);
  }
  const simplifyEpsilon = options.simplify ?? 0.002;

  const seedIndex = (sy * width + sx) * 4;
  const target = rgbToLab(rgba[seedIndex]!, rgba[seedIndex + 1]!, rgba[seedIndex + 2]!);
  const toleranceSquared = tolerance * tolerance;
  const matches = (x: number, y: number): boolean => {
    const index = (y * width + x) * 4;
    const lab = rgbToLab(rgba[index]!, rgba[index + 1]!, rgba[index + 2]!);
    return labDistanceSquared(lab, target) <= toleranceSquared;
  };

  // 0 = unvisited, 1 = selected, 2 = queued.
  const mask: Mask = new Uint8Array(width * height);
  const stack: number[] = [sy * width + sx];
  mask[sy * width + sx] = 2;

  while (stack.length > 0) {
    const index = stack.pop()!;
    if (mask[index] !== 2) continue;
    const y = Math.floor(index / width);
    const x = index - y * width;
    const row = y * width;
    let left = x;
    while (left > 0 && mask[row + left - 1] !== 1 && matches(left - 1, y)) left--;
    let right = x;
    while (right + 1 < width && mask[row + right + 1] !== 1 && matches(right + 1, y)) right++;
    mask.fill(1, row + left, row + right + 1);

    for (const neighborY of [y - 1, y + 1]) {
      if (neighborY < 0 || neighborY >= height) continue;
      const neighborRow = neighborY * width;
      let nx = left;
      while (nx <= right) {
        if (mask[neighborRow + nx] === 0 && matches(nx, neighborY)) {
          const runStart = nx;
          while (nx <= right && mask[neighborRow + nx] === 0 && matches(nx, neighborY)) {
            mask[neighborRow + nx] = 2;
            nx++;
          }
          stack.push(neighborRow + runStart);
        } else {
          nx++;
        }
      }
    }
  }

  return { mask, shapes: traceMaskOutline(mask, width, height, simplifyEpsilon) };
}
