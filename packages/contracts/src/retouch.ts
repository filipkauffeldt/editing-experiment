import type { Point, Rect, Shape } from './geometry';

/**
 * Pixelate (mosaic) the pixels inside the union of `shapes`.
 * Shapes are in normalized image coordinates (0..1) of the oriented, uncropped
 * image, so the op is resolution independent and applies to preview and export alike.
 */
export interface MosaicOp {
  type: 'mosaic';
  shapes: Shape[];
  /** Mosaic block edge relative to the image's longer edge (e.g. 0.01 = 1%). */
  blockSizeRel: number;
}

/** A retouch operation. Only mosaic exists for now; the union is where new ops go. */
export type RetouchOp = MosaicOp;

/** One detected face. */
export interface FaceDetection {
  /** Bounding box in normalized image coordinates. */
  box: Rect;
  /** Detector confidence, 0..1. */
  score: number;
  /** Optional facial landmarks (eyes, nose, mouth corners) in normalized image coordinates. */
  landmarks?: Point[];
}
