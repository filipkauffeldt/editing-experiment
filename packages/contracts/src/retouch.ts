import type { Point, Rect, Shape } from './geometry';

/**
 * A detection kept with a mosaic area so the face can be switched on and off, and its padding
 * changed, when the photo is retouched again.
 */
export interface MosaicFace {
  /** The raw detector box in normalized image coordinates; padding is applied on top. */
  box: Rect;
  /** Detector confidence, 0..1. */
  score?: number;
}

/**
 * One entry of a mosaic's ordered area list. Areas are applied in order: an add area covers its
 * shape with mosaic, a subtract area takes mosaic away again, and a later add covers the same
 * pixels once more.
 */
export interface MosaicArea {
  /** The shape in normalized image coordinates; for a face, its padded outline. */
  shape: Shape;
  /** Absent means `add`. */
  mode?: 'add' | 'subtract';
  /** `false` keeps the area so it can be switched on again, but it changes nothing. Absent means on. */
  enabled?: boolean;
  /** Set on an area made by face detection. */
  face?: MosaicFace;
}

/**
 * Pixelate (mosaic) the pixels inside the shapes of the op.
 * Shapes are in normalized image coordinates (0..1) of the oriented, uncropped
 * image, so the op is resolution independent and applies to preview and export alike.
 *
 * `areas` is the editable, ordered form and, when present, the one that is rendered. `shapes` is
 * what versions saved before `areas` existed hold (all of them added together); new versions also
 * write the shapes of their enabled add areas there, for readers that only know the union. Use
 * {@link mosaicAreas} to read either form.
 */
export interface MosaicOp {
  type: 'mosaic';
  shapes: Shape[];
  /** Mosaic block edge relative to the image's longer edge (e.g. 0.01 = 1%). */
  blockSizeRel: number;
  areas?: MosaicArea[];
  /** Padding the face areas were made with, as a fraction of the face width. */
  facePadding?: number;
}

/** The areas of an op in render order; a version saved without `areas` is all adds. */
export function mosaicAreas(op: Pick<MosaicOp, 'shapes' | 'areas'>): MosaicArea[] {
  return op.areas ?? op.shapes.map((shape): MosaicArea => ({ shape }));
}

/** The shapes of the enabled add areas: what the `shapes` field of a saved op holds. */
export function addedShapes(areas: readonly MosaicArea[]): Shape[] {
  return areas
    .filter((area) => area.enabled !== false && area.mode !== 'subtract')
    .map((area) => area.shape);
}

/**
 * The op with every shape moved by `map` (lens correction, crop). `map` must return one shape per
 * shape it is given, in the same order.
 */
export function mapMosaicShapes(
  op: MosaicOp,
  map: (shapes: readonly Shape[]) => Shape[],
): MosaicOp {
  const shapes = map(op.shapes);
  if (!op.areas) return { ...op, shapes };
  const moved = map(op.areas.map((area) => area.shape));
  if (moved.length !== op.areas.length) {
    throw new RangeError(`mapMosaicShapes: ${op.areas.length} areas became ${moved.length} shapes`);
  }
  return { ...op, shapes, areas: op.areas.map((area, i) => ({ ...area, shape: moved[i]! })) };
}

/** A retouch operation. Only mosaic exists for now; the union is where new ops go. */
export type RetouchOp = MosaicOp;

/**
 * Identity of the ops a render applied. Export asks for this key and refuses a
 * render that echoes another one, so a stale mosaic-less render cannot be used.
 */
export function retouchOpsKey(ops: readonly RetouchOp[]): string {
  return ops.length === 0 ? '' : JSON.stringify(ops);
}

/** One detected face. */
export interface FaceDetection {
  /** Bounding box in normalized image coordinates. */
  box: Rect;
  /** Detector confidence, 0..1. */
  score: number;
  /** Optional facial landmarks (eyes, nose, mouth corners) in normalized image coordinates. */
  landmarks?: Point[];
}
