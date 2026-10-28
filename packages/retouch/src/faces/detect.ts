import type { FaceDetection, Point, Rect } from '@ee/contracts';
import { resizeRgba } from '@ee/core';
import { clamp } from '../geometry';
import type { PixelRect } from '../geometry';
import { defaultModelPath } from './model';
import { mergeOverlappingDetections } from './nms';
import { runYuNet, type FaceCandidate } from './yunet';

export interface DetectFacesOptions {
  /** Detector confidence, 0..1. Default 0.6. */
  scoreThreshold?: number;
  /** IoU threshold for merging overlapping boxes. Default 0.3. */
  nmsThreshold?: number;
  /** Path to the YuNet ONNX model. Defaults to the fetched fixtures model. */
  modelPath?: string;
  /** Maximum tile/input edge in pixels. Default 640. */
  maxInputEdge?: number;
  /** Tile overlap fraction when a region is given. Default 0.2. */
  tileOverlap?: number;
  /** Maximum number of faces returned. Default 5000. */
  topK?: number;
}

function validateOptions(
  options: DetectFacesOptions,
): Required<Omit<DetectFacesOptions, 'modelPath'>> & { modelPath: string } {
  const scoreThreshold = options.scoreThreshold ?? 0.6;
  const nmsThreshold = options.nmsThreshold ?? 0.3;
  const maxInputEdge = options.maxInputEdge ?? 640;
  const tileOverlap = options.tileOverlap ?? 0.2;
  const topK = options.topK ?? 5000;
  if (scoreThreshold < 0 || scoreThreshold > 1) {
    throw new RangeError(`detectFaces: scoreThreshold must be 0..1, got ${scoreThreshold}`);
  }
  if (nmsThreshold < 0 || nmsThreshold > 1) {
    throw new RangeError(`detectFaces: nmsThreshold must be 0..1, got ${nmsThreshold}`);
  }
  if (!Number.isFinite(maxInputEdge) || maxInputEdge < 32) {
    throw new RangeError(`detectFaces: maxInputEdge must be >= 32, got ${maxInputEdge}`);
  }
  if (tileOverlap < 0 || tileOverlap >= 1) {
    throw new RangeError(`detectFaces: tileOverlap must be 0..<1, got ${tileOverlap}`);
  }
  return {
    scoreThreshold,
    nmsThreshold,
    maxInputEdge,
    tileOverlap,
    topK,
    modelPath: options.modelPath ?? defaultModelPath(),
  };
}

/** Copies the `regionWidth` x `regionHeight` window at (`regionX`, `regionY`) out of `rgba`. */
function cropRgba(
  rgba: Uint8Array,
  width: number,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
): Uint8Array {
  const out = new Uint8Array(regionWidth * regionHeight * 4);
  for (let row = 0; row < regionHeight; row++) {
    const start = ((regionY + row) * width + regionX) * 4;
    out.set(rgba.subarray(start, start + regionWidth * 4), row * regionWidth * 4);
  }
  return out;
}

interface MappedCandidate extends FaceCandidate {
  box: PixelRect;
}

function mapCandidate(
  candidate: FaceCandidate,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
): MappedCandidate {
  return {
    box: {
      x: offsetX + candidate.box.x * scaleX,
      y: offsetY + candidate.box.y * scaleY,
      w: candidate.box.w * scaleX,
      h: candidate.box.h * scaleY,
    },
    score: candidate.score,
    landmarks: candidate.landmarks.map((point) => ({
      x: offsetX + point.x * scaleX,
      y: offsetY + point.y * scaleY,
    })),
  };
}

function toDetection(
  candidate: MappedCandidate,
  width: number,
  height: number,
): FaceDetection | undefined {
  const x = clamp(candidate.box.x, 0, width);
  const y = clamp(candidate.box.y, 0, height);
  const right = clamp(candidate.box.x + candidate.box.w, 0, width);
  const bottom = clamp(candidate.box.y + candidate.box.h, 0, height);
  if (right <= x || bottom <= y) return undefined;
  const landmarks: Point[] = candidate.landmarks.map((point) => ({
    x: clamp(point.x / width, 0, 1),
    y: clamp(point.y / height, 0, 1),
  }));
  return {
    box: {
      type: 'rect',
      x: x / width,
      y: y / height,
      w: (right - x) / width,
      h: (bottom - y) / height,
    },
    score: candidate.score,
    landmarks,
  };
}

/**
 * Detect faces in an RGBA buffer.
 *
 * Without a region the whole image is scaled down to at most `maxInputEdge`
 * pixels before inference. With a region the crop is kept at full resolution
 * and split into overlapping tiles, so small faces in a crowd stay detectable.
 * Returned boxes and landmarks are normalised against the full image.
 */
export async function detectFaces(
  rgba: Uint8Array,
  width: number,
  height: number,
  region?: Rect,
  options: DetectFacesOptions = {},
): Promise<FaceDetection[]> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`detectFaces: invalid size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `detectFaces: RGBA buffer is too small (${rgba.length} < ${width * height * 4})`,
    );
  }
  const settings = validateOptions(options);
  const candidates: MappedCandidate[] = [];

  if (region) {
    const regionX = clamp(Math.floor(region.x * width), 0, width);
    const regionY = clamp(Math.floor(region.y * height), 0, height);
    const regionRight = clamp(Math.ceil((region.x + region.w) * width), regionX, width);
    const regionBottom = clamp(Math.ceil((region.y + region.h) * height), regionY, height);
    const regionWidth = regionRight - regionX;
    const regionHeight = regionBottom - regionY;
    if (regionWidth <= 0 || regionHeight <= 0) return [];

    const tileWidth = Math.min(regionWidth, settings.maxInputEdge);
    const tileHeight = Math.min(regionHeight, settings.maxInputEdge);
    const stepX = Math.max(1, Math.floor(tileWidth * (1 - settings.tileOverlap)));
    const stepY = Math.max(1, Math.floor(tileHeight * (1 - settings.tileOverlap)));
    for (let tileY = 0; tileY < regionHeight; tileY += stepY) {
      const tileHeightHere = Math.min(tileHeight, regionHeight - tileY);
      for (let tileX = 0; tileX < regionWidth; tileX += stepX) {
        const tileWidthHere = Math.min(tileWidth, regionWidth - tileX);
        const found = await runYuNet(
          settings.modelPath,
          rgba,
          width,
          height,
          regionX + tileX,
          regionY + tileY,
          tileWidthHere,
          tileHeightHere,
          settings.scoreThreshold,
        );
        for (const candidate of found) {
          candidates.push(mapCandidate(candidate, regionX + tileX, regionY + tileY, 1, 1));
        }
      }
    }

    // A face wider than a tile is cut into fragments by the tiled pass. Run the
    // whole region once at `maxInputEdge` so such faces stay intact.
    const longestSide = Math.max(regionWidth, regionHeight);
    if (longestSide > settings.maxInputEdge) {
      const region = cropRgba(rgba, width, regionX, regionY, regionWidth, regionHeight);
      // The native resize returns the exact size it chose; map back with that.
      const scaled = await resizeRgba(region, regionWidth, regionHeight, {
        maxEdge: Math.floor(settings.maxInputEdge),
      });
      const { width: scaledWidth, height: scaledHeight } = scaled;
      const regionRgba = scaled.rgba;
      const found = await runYuNet(
        settings.modelPath,
        regionRgba,
        scaledWidth,
        scaledHeight,
        0,
        0,
        scaledWidth,
        scaledHeight,
        settings.scoreThreshold,
      );
      const scaleX = regionWidth / scaledWidth;
      const scaleY = regionHeight / scaledHeight;
      for (const candidate of found) {
        candidates.push(mapCandidate(candidate, regionX, regionY, scaleX, scaleY));
      }
    }
  } else {
    const maxEdge = Math.floor(settings.maxInputEdge);
    const resized =
      Math.max(width, height) > maxEdge
        ? await resizeRgba(rgba.subarray(0, width * height * 4), width, height, { maxEdge })
        : { rgba, width, height };
    const resizedWidth = resized.width;
    const resizedHeight = resized.height;
    const source = resized.rgba;
    const sourceWidth = resizedWidth;
    const sourceHeight = resizedHeight;
    const found = await runYuNet(
      settings.modelPath,
      source,
      sourceWidth,
      sourceHeight,
      0,
      0,
      resizedWidth,
      resizedHeight,
      settings.scoreThreshold,
    );
    const scaleX = width / resizedWidth;
    const scaleY = height / resizedHeight;
    for (const candidate of found) {
      candidates.push(mapCandidate(candidate, 0, 0, scaleX, scaleY));
    }
  }

  const merged = mergeOverlappingDetections(candidates, settings.nmsThreshold).slice(
    0,
    settings.topK,
  );
  const detections: FaceDetection[] = [];
  for (const candidate of merged) {
    const detection = toDetection(candidate, width, height);
    if (detection) detections.push(detection);
  }
  return detections;
}
