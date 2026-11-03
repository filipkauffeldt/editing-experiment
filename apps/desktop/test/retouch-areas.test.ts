import { retouchOpsKey, type MosaicOp, type Rect } from '@ee/contracts';
import { describe, expect, it } from 'vitest';
import {
  altFlipsMode,
  areaIndexAt,
  areasFromOp,
  countAreas,
  opFromAreas,
  opHasAddedArea,
  withDetectedFaces,
  withoutFacesInside,
  type RetouchArea,
} from '../src/renderer/retouch-areas';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });
const drawn = (
  shape: RetouchArea['shape'],
  mode: RetouchArea['mode'] = 'add',
  enabled = true,
): RetouchArea => ({ kind: shape?.type === 'rect' ? 'rect' : 'lasso', mode, enabled, shape });
const face = (box: Rect, enabled = true, mode: RetouchArea['mode'] = 'add'): RetouchArea => ({
  kind: 'face',
  mode,
  enabled,
  face: { box, score: 0.9 },
});

describe('retouch areas and the saved op', () => {
  it('loads a version saved before areas existed as editable adds, wand outlines included', () => {
    const wandOutline = {
      type: 'polygon' as const,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.3, y: 0.1 },
        { x: 0.2, y: 0.3 },
      ],
    };
    const legacy: MosaicOp = {
      type: 'mosaic',
      shapes: [rect(0.1, 0.1, 0.2, 0.2), wandOutline],
      blockSizeRel: 0.012,
    };
    const areas = areasFromOp(legacy);
    expect(areas.map((area) => [area.kind, area.mode, area.enabled])).toEqual([
      ['rect', 'add', true],
      ['lasso', 'add', true],
    ]);
    // Saving it again keeps the shapes.
    expect(opFromAreas(areas, 0.012, 0.25, undefined).shapes).toEqual(legacy.shapes);
  });

  it('keeps order, modes, off switches, faces and padding through save and load', () => {
    const areas: RetouchArea[] = [
      drawn(rect(0, 0, 1, 1)),
      face(rect(0.4, 0.4, 0.1, 0.1), false),
      drawn(rect(0.2, 0.2, 0.2, 0.2), 'subtract'),
      drawn(rect(0.6, 0.6, 0.1, 0.1), 'add', false),
      face(rect(0.7, 0.2, 0.1, 0.1), true, 'subtract'),
    ];
    const op = opFromAreas(areas, 0.02, 0.3, undefined);
    expect(op.facePadding).toBe(0.3);
    // Only the enabled adds are in the legacy `shapes` field.
    expect(op.shapes).toHaveLength(1);
    // A save goes through JSON in the sidecar.
    const loaded = areasFromOp(JSON.parse(JSON.stringify(op)) as MosaicOp);
    expect(loaded).toEqual(
      areas.map((area) => ({ ...area, shape: area.shape ?? undefined })).map(strip),
    );
  });

  it('changes the ops key when an area is toggled, subtracted or reordered', () => {
    const base = [drawn(rect(0, 0, 0.5, 0.5)), drawn(rect(0.1, 0.1, 0.1, 0.1), 'subtract')];
    const key = (areas: RetouchArea[]): string =>
      retouchOpsKey([opFromAreas(areas, 0.01, 0.25, undefined)]);
    const keys = new Set([
      key(base),
      key([base[0]!, { ...base[1]!, enabled: false }]),
      key([base[0]!, { ...base[1]!, mode: 'add' }]),
      key([base[1]!, base[0]!]),
      key([base[0]!]),
    ]);
    expect(keys.size).toBe(5);
  });

  it('knows whether the op puts any mosaic on the picture', () => {
    expect(opHasAddedArea(opFromAreas([drawn(rect(0, 0, 1, 1))], 0.01, 0.25, undefined))).toBe(
      true,
    );
    expect(
      opHasAddedArea(opFromAreas([drawn(rect(0, 0, 1, 1), 'add', false)], 0.01, 0.25, undefined)),
    ).toBe(false);
    expect(
      opHasAddedArea(opFromAreas([drawn(rect(0, 0, 1, 1), 'subtract')], 0.01, 0.25, undefined)),
    ).toBe(false);
  });
});

const strip = (area: RetouchArea): RetouchArea => {
  const { shape, ...rest } = area;
  return shape === undefined ? rest : { ...rest, shape };
};

describe('hit testing and counts', () => {
  it('finds the topmost area under a point, faces by their padded outline', () => {
    const areas = [
      drawn(rect(0, 0, 0.6, 0.6)),
      drawn(rect(0.2, 0.2, 0.2, 0.2), 'subtract'),
      face(rect(0.7, 0.7, 0.1, 0.1)),
    ];
    expect(areaIndexAt(areas, { x: 0.3, y: 0.3 }, 0.25, undefined)).toBe(1);
    expect(areaIndexAt(areas, { x: 0.05, y: 0.05 }, 0.25, undefined)).toBe(0);
    expect(areaIndexAt(areas, { x: 0.75, y: 0.75 }, 0.25, undefined)).toBe(2);
    // Inside the padding but outside the raw box.
    expect(areaIndexAt(areas, { x: 0.69, y: 0.75 }, 0.25, undefined)).toBe(2);
    expect(areaIndexAt(areas, { x: 0.95, y: 0.05 }, 0.25, undefined)).toBe(-1);
  });

  it('hit-tests a lasso by its outline, not its bounding box', () => {
    const triangle = {
      type: 'polygon' as const,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.9 },
      ],
    };
    expect(areaIndexAt([drawn(triangle)], { x: 0.2, y: 0.2 }, 0.25, undefined)).toBe(0);
    expect(areaIndexAt([drawn(triangle)], { x: 0.8, y: 0.8 }, 0.25, undefined)).toBe(-1);
  });

  it('counts faces and drawn areas separately', () => {
    const areas = [
      drawn(rect(0, 0, 0.1, 0.1)),
      drawn(rect(0, 0, 0.1, 0.1), 'subtract', false),
      face(rect(0.5, 0.5, 0.1, 0.1)),
      face(rect(0.7, 0.5, 0.1, 0.1), false),
      face(rect(0.9, 0.5, 0.05, 0.1), false),
    ];
    expect(countAreas(areas)).toEqual({
      drawn: { on: 1, total: 2 },
      faces: { on: 1, total: 3 },
    });
  });
});

describe('detections are additive', () => {
  it('adds new faces after the old ones and skips a face found twice', () => {
    const first = rect(0.4, 0.4, 0.1, 0.1);
    const existing = [drawn(rect(0, 0, 0.2, 0.2)), face(first, false)];
    const next = withDetectedFaces(
      existing,
      [{ box: rect(0.41, 0.41, 0.1, 0.1) }, { box: rect(0.7, 0.4, 0.1, 0.1), score: 0.8 }],
      'subtract',
    );
    expect(next).toHaveLength(3);
    // Nothing that was there changed, not even the face that is off.
    expect(next.slice(0, 2)).toEqual(existing);
    expect(next[2]).toMatchObject({ kind: 'face', mode: 'subtract', enabled: true });
  });
});

describe('Alt flips the mode, AltGr never does', () => {
  const event = (init: Partial<Parameters<typeof altFlipsMode>[0]>) => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
  });
  it('flips on a plain Alt', () => {
    expect(altFlipsMode(event({ altKey: true }))).toBe(true);
    expect(altFlipsMode(event({}))).toBe(false);
  });
  it('ignores AltGr, reported as AltGraph or as Ctrl+Alt', () => {
    expect(altFlipsMode(event({ altKey: true, getModifierState: (k) => k === 'AltGraph' }))).toBe(
      false,
    );
    expect(altFlipsMode(event({ altKey: true, ctrlKey: true }))).toBe(false);
    expect(altFlipsMode(event({ altKey: true, metaKey: true }))).toBe(false);
  });
});

describe('withoutFacesInside', () => {
  const inside = face(rect(0.2, 0.2, 0.1, 0.1));
  const insideOff = face(rect(0.3, 0.3, 0.1, 0.1), false, 'subtract');
  const outside = face(rect(0.7, 0.7, 0.1, 0.1));
  const shape = drawn(rect(0.1, 0.1, 0.4, 0.4));

  it('drops the faces centred inside a rectangle, on or off, and keeps the rest', () => {
    const areas = [shape, inside, insideOff, outside];
    const kept = withoutFacesInside(areas, rect(0.1, 0.1, 0.4, 0.4), undefined);
    // The drawn area stays even though it lies in the region.
    expect(kept).toEqual([shape, outside]);
  });

  it('judges a face by its centre, not by overlap', () => {
    const straddling = face(rect(0.45, 0.2, 0.2, 0.1)); // centre x = 0.55
    const kept = withoutFacesInside([straddling], rect(0.1, 0.1, 0.4, 0.4), undefined);
    expect(kept).toEqual([straddling]);
  });

  it('uses the outline of a lasso, not its bounding box', () => {
    const triangle = {
      type: 'polygon' as const,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.9 },
      ],
    };
    const inTriangle = face(rect(0.2, 0.2, 0.1, 0.1));
    const inBoundsOutside = face(rect(0.7, 0.7, 0.1, 0.1));
    expect(withoutFacesInside([inTriangle, inBoundsOutside], triangle, undefined)).toEqual([
      inBoundsOutside,
    ]);
  });
});
