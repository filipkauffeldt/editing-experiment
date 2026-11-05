import {
  addedShapes,
  mosaicAreas,
  type MosaicArea,
  type MosaicOp,
  type Rect,
  type Shape,
} from '@ee/contracts';
import { pointInPolygon, rectToPolygon } from '@ee/retouch';
import { facesInLasso, faceStoredShape, type PhotoLensContext } from './retouch-geometry';

/** Whether a new area adds mosaic or takes it away again (Lightroom's mask add/subtract). */
export type RetouchMode = 'add' | 'subtract';

/** A detected face kept with its area, so it can be toggled and re-padded after a resume. */
export interface RetouchFaceBox {
  /** The raw detector box in normalized image coordinates; padding is applied when rendering. */
  box: Rect;
  score?: number;
}

/**
 * One area of the retouch session, in render order. A rectangle or lasso keeps the shape that was
 * drawn; a face keeps the detector's box, and its outline follows the padding slider.
 */
export interface RetouchArea {
  kind: 'rect' | 'lasso' | 'face';
  mode: RetouchMode;
  /** An area that is off stays in the list so it can be switched on again. */
  enabled: boolean;
  shape?: Shape;
  face?: RetouchFaceBox;
}

export const isFaceArea = (area: RetouchArea): boolean => area.kind === 'face';

/** The outline an area is drawn and rendered with. */
export function areaShape(
  area: RetouchArea,
  facePadding: number,
  lens: PhotoLensContext | undefined,
): Shape {
  if (area.face) return faceStoredShape(area.face.box, facePadding, lens);
  if (!area.shape) throw new Error('a retouch area has neither a shape nor a face');
  return area.shape;
}

const cloneShape = (shape: Shape): Shape =>
  shape.type === 'rect' ? { ...shape } : { ...shape, points: shape.points.map((p) => ({ ...p })) };

/**
 * The editable areas of a saved op. A version saved before areas existed holds plain shapes
 * (rectangles, lassos and the polygons the removed wand made), which load as editable adds.
 */
export function areasFromOp(op: MosaicOp): RetouchArea[] {
  return mosaicAreas(op).map((saved): RetouchArea => {
    const mode: RetouchMode = saved.mode === 'subtract' ? 'subtract' : 'add';
    const enabled = saved.enabled !== false;
    if (saved.face) {
      return {
        kind: 'face',
        mode,
        enabled,
        face: {
          box: { ...saved.face.box },
          ...(saved.face.score === undefined ? {} : { score: saved.face.score }),
        },
      };
    }
    return {
      kind: saved.shape.type === 'rect' ? 'rect' : 'lasso',
      mode,
      enabled,
      shape: cloneShape(saved.shape),
    };
  });
}

/**
 * The op a session saves and previews. Defaults are left out of the JSON (an add that is on has
 * neither field), and `shapes` holds the enabled adds for readers that only know the union.
 */
export function opFromAreas(
  areas: readonly RetouchArea[],
  blockSizeRel: number,
  facePadding: number,
  lens: PhotoLensContext | undefined,
): MosaicOp {
  const saved = areas.map((area): MosaicArea => {
    return {
      shape: areaShape(area, facePadding, lens),
      ...(area.mode === 'subtract' ? { mode: 'subtract' as const } : {}),
      ...(area.enabled ? {} : { enabled: false }),
      ...(area.face ? { face: area.face } : {}),
    };
  });
  const hasFaces = areas.some(isFaceArea);
  return {
    type: 'mosaic',
    shapes: addedShapes(saved),
    blockSizeRel,
    areas: saved,
    ...(hasFaces ? { facePadding } : {}),
  };
}

/** Whether the op puts any mosaic on the picture: an enabled add that is not only subtracted. */
export const opHasAddedArea = (op: MosaicOp): boolean =>
  mosaicAreas(op).some((area) => area.enabled !== false && area.mode !== 'subtract');

/** The topmost area (last drawn) whose outline holds the point, or -1. */
export function areaIndexAt(
  areas: readonly RetouchArea[],
  point: { x: number; y: number },
  facePadding: number,
  lens: PhotoLensContext | undefined,
): number {
  for (let i = areas.length - 1; i >= 0; i--) {
    const shape = areaShape(areas[i]!, facePadding, lens);
    const inside =
      shape.type === 'rect'
        ? point.x >= shape.x &&
          point.x <= shape.x + shape.w &&
          point.y >= shape.y &&
          point.y <= shape.y + shape.h
        : pointInPolygon(point, shape.points);
    if (inside) return i;
  }
  return -1;
}

export interface AreaCount {
  on: number;
  total: number;
}

/** "x of y on" for the detected faces and for the hand-drawn areas. */
export function countAreas(areas: readonly RetouchArea[]): { faces: AreaCount; drawn: AreaCount } {
  const count = (list: readonly RetouchArea[]): AreaCount => ({
    on: list.filter((area) => area.enabled).length,
    total: list.length,
  });
  return {
    faces: count(areas.filter(isFaceArea)),
    drawn: count(areas.filter((area) => !isFaceArea(area))),
  };
}

/**
 * New detections added to the session. A face the detector finds again in a second search is
 * already there when its box holds the new box's centre, and is not added twice.
 */
export function withDetectedFaces(
  areas: readonly RetouchArea[],
  detections: readonly RetouchFaceBox[],
  mode: RetouchMode,
): RetouchArea[] {
  const known = areas.flatMap((area) => (area.face ? [area.face.box] : []));
  const fresh = detections.filter((found) => {
    const cx = found.box.x + found.box.w / 2;
    const cy = found.box.y + found.box.h / 2;
    return !known.some(
      (box) => cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h,
    );
  });
  return [
    ...areas,
    ...fresh.map((found): RetouchArea => ({
      kind: 'face',
      mode,
      enabled: true,
      face: { ...found },
    })),
  ];
}

/**
 * The areas without the detected faces whose box centre lies inside `region`, a rectangle or a
 * lasso (the rule the lasso search uses). Face areas go whether they are on or off, added or
 * subtracted; drawn areas are never touched.
 */
export function withoutFacesInside(
  areas: readonly RetouchArea[],
  region: Shape,
  lens: PhotoLensContext | undefined,
): RetouchArea[] {
  const outline = (region.type === 'rect' ? rectToPolygon(region) : region).points;
  const faces = areas.flatMap((area) => (area.face ? [{ box: area.face.box, area }] : []));
  const doomed = new Set(facesInLasso(faces, outline, lens).map((face) => face.area));
  return areas.filter((area) => !doomed.has(area));
}

/**
 * Whether Alt is held as a modifier for one drawing: it picks the lasso for a face search and flips
 * Add and Subtract for Rectangle and Lasso. AltGr (Ctrl+Alt on Windows/Linux, or the
 * AltGraph modifier) types characters on a Swedish keyboard and must never count.
 */
export function altHeld(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  getModifierState?: (key: 'AltGraph') => boolean;
}): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.getModifierState?.('AltGraph') !== true
  );
}
