import type { BuiltinLensCorrection, CropParams, MosaicOp, Rect, Shape } from '@ee/contracts';
import {
  correctedShapes,
  lensCorrectedPosition,
  renderCpu,
  resolveLens,
  withoutLensGeometry,
} from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { composeDevelopedRgba } from '../src/renderer/develop-render';
import { detectionRegion, faceStoredShape } from '../src/renderer/retouch-geometry';

const W = 300;
const H = 200;

/** A wide-angle lens that records the corners at 0.8 of their true radius (strong barrel). */
const BARREL: BuiltinLensCorrection = {
  source: 'Nikon built-in',
  required: true,
  centre: { x: 0, y: 0 },
  unit: 1,
  distortion: [1, 0, -0.2],
};

/** The recorded picture: a fine checker inside the face rectangle, flat grey elsewhere. */
function recorded(face: Rect): { header: ReturnType<typeof makeHeader>; data: Float32Array } {
  const header = makeHeader();
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside =
        x >= face.x * W &&
        x < (face.x + face.w) * W &&
        y >= face.y * H &&
        y < (face.y + face.h) * H;
      const checker = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0;
      const v = inside ? (checker ? 0.8 : 0.02) : 0.2;
      data.set([v, v, v, 1], (y * W + x) * 4);
    }
  }
  return { header, data };
}

function makeHeader() {
  return {
    width: W,
    height: H,
    sourceWidth: W,
    sourceHeight: H,
    sampleType: 'f32' as const,
    asShotMultipliers: { r: 1, g: 1, b: 1 },
    cameraToSrgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    lens: { cameraModel: 'NIKON Z 6', lensModel: 'NIKKOR Z 24-70mm f/4 S', builtin: BARREL },
  };
}

/** Corrected-picture pixels whose recorded position is inside `face`. */
function facePixels(face: Rect, header: ReturnType<typeof makeHeader>): number[] {
  const { uniforms } = resolveLens(header, {});
  const inside: number[] = [];
  // Invert through the forward map: sample every corrected pixel's recorded position.
  const cx = W / 2;
  const cy = H / 2;
  const unit = uniforms.distortion!.unit;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const q = Math.hypot(dx, dy) / unit;
      const g = uniforms.distortion!.coefficients.reduceRight((s, k) => s * q + k, 0);
      const rx = (cx + dx * g) / W;
      const ry = (cy + dy * g) / H;
      // The inner margin keeps out pixels whose bilinear sample straddles the face's edge.
      const m = 1.5 / W;
      if (
        rx > face.x + m &&
        rx < face.x + face.w - m &&
        ry > face.y + m * 1.5 &&
        ry < face.y + face.h - m * 1.5
      )
        inside.push(y * W + x);
    }
  }
  return inside;
}

describe('mosaic after a lens correction', () => {
  // Near the top-left corner, where the correction moves things the most.
  const face: Rect = { type: 'rect', x: 0.03, y: 0.04, w: 0.17, h: 0.27 };
  const op: MosaicOp = { type: 'mosaic', shapes: [face], blockSizeRel: 0.02 };
  const { header, data } = recorded(face);
  const render = (params: object, size: { width: number; height: number }): Uint8Array =>
    renderCpu(header, data, params, size);
  const pixels = facePixels(face, header);

  /** Pixels of the face region that still show the checker (a value far from the flat mid-grey). */
  const sharp = (rgba: Uint8Array): number =>
    pixels.filter((p) => Math.abs((rgba[p * 4] ?? 0) - 135) > 55).length;

  it('has a face region that is clearly visible before the mosaic', () => {
    const reference = render({}, { width: W, height: H });
    expect(pixels.length).toBeGreaterThan(1000);
    expect(sharp(reference) / pixels.length).toBeGreaterThan(0.5);
  });

  it('covers every pixel of the face once the shape is mapped into the corrected picture', () => {
    const rgba = composeDevelopedRgba({
      params: {},
      ops: [op],
      width: W,
      height: H,
      source: { width: W, height: H },
      mapShapes: (shapes) => correctedShapes(shapes, header, {}),
      render,
    });
    expect(sharp(rgba)).toBe(0);
  });

  it('would leave the face showing if the stored shape were used unmapped', () => {
    const rgba = composeDevelopedRgba({
      params: {},
      ops: [op],
      width: W,
      height: H,
      source: { width: W, height: H },
      render,
    });
    expect(sharp(rgba) / pixels.length).toBeGreaterThan(0.1);
  });

  it('covers the face in a cropped, straightened export too', () => {
    const crop: CropParams = { left: 0.0, top: 0.0, right: 0.7, bottom: 0.8, angle: 0 };
    const out = { width: 210, height: 160 };
    const rgba = composeDevelopedRgba({
      params: { crop },
      ops: [op],
      width: out.width,
      height: out.height,
      source: { width: W, height: H },
      mapShapes: (shapes) => correctedShapes(shapes, header, { crop }),
      render,
    });
    // The crop is the top-left 70 % x 80 %: output pixel (x, y) is corrected pixel (x, y) at this scale.
    let leaked = 0;
    for (const p of pixels) {
      const x = p % W;
      const y = Math.floor(p / W);
      if (x >= out.width || y >= out.height) continue;
      if (Math.abs((rgba[(y * out.width + x) * 4] ?? 0) - 135) > 55) leaked++;
    }
    expect(leaked).toBe(0);
  });

  it('draws and stores shapes on the recorded picture while a retouch session is open', () => {
    const plain = resolveLens(header, withoutLensGeometry({}));
    expect(plain.uniforms.geometry).toBe(false);
    const [same] = correctedShapes([face], header, withoutLensGeometry({}));
    expect(same).toEqual(face);
  });
});

describe('a face detected on the camera-corrected preview', () => {
  // Detection sees the camera's own corrected picture, so its box is in the corrected frame; the
  // lens is a strong barrel one, which moves a corner face by about 25 px between the two frames.
  const box: Rect = { type: 'rect', x: 0.03, y: 0.04, w: 0.17, h: 0.27 };
  const header = makeHeader();
  const { uniforms } = resolveLens(header, {});
  const context = { lens: header.lens, width: W, height: H };
  const op = (shape: Shape): MosaicOp => ({ type: 'mosaic', shapes: [shape], blockSizeRel: 0.02 });

  /** The recorded picture of a scene whose face is a 3 px checker inside `box` of the corrected frame. */
  const data = (() => {
    const out = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = lensCorrectedPosition(uniforms, x + 0.5, y + 0.5);
        const inside =
          c.x >= box.x * W &&
          c.x < (box.x + box.w) * W &&
          c.y >= box.y * H &&
          c.y < (box.y + box.h) * H;
        const checker = (Math.floor(c.x / 3) + Math.floor(c.y / 3)) % 2 === 0;
        const v = inside ? (checker ? 0.8 : 0.02) : 0.2;
        out.set([v, v, v, 1], (y * W + x) * 4);
      }
    }
    return out;
  })();
  const render = (params: object, size: { width: number; height: number }): Uint8Array =>
    renderCpu(header, data, params, size);

  /** Corrected-frame pixels well inside the face. */
  const face: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = 2;
      if (
        x + 0.5 > box.x * W + m &&
        x + 0.5 < (box.x + box.w) * W - m &&
        y + 0.5 > box.y * H + m &&
        y + 0.5 < (box.y + box.h) * H - m
      )
        face.push(y * W + x);
    }
  }
  const sharp = (rgba: Uint8Array): number =>
    face.filter((p) => Math.abs((rgba[p * 4] ?? 0) - 135) > 55).length;
  const exported = (stored: Shape): Uint8Array =>
    composeDevelopedRgba({
      params: {},
      ops: [op(stored)],
      width: W,
      height: H,
      source: { width: W, height: H },
      mapShapes: (shapes) => correctedShapes(shapes, header, {}),
      render,
    });

  it('shows the face in the corrected render before anything is mosaicked', () => {
    expect(face.length).toBeGreaterThan(1000);
    expect(sharp(render({}, { width: W, height: H })) / face.length).toBeGreaterThan(0.5);
  });

  it('is fully mosaicked in the export once the box is taken through the lens map', () => {
    const stored = faceStoredShape(box, 0, context);
    expect(stored.type).toBe('polygon');
    expect(sharp(exported(stored))).toBe(0);
  });

  it('would stay visible if the detected box were stored as it is', () => {
    // Dozens of face pixels left uncovered: the leak the mapping prevents.
    expect(sharp(exported(box))).toBeGreaterThan(50);
  });

  it('looks for the face where the camera put it when the region is drawn on the recorded picture', () => {
    // The recorded footprint of the box, as a user would drag a rectangle over it.
    const corners = [
      [box.x, box.y],
      [box.x + box.w, box.y + box.h],
    ].map(([x, y]) => {
      const s = faceStoredShape({ type: 'rect', x: x!, y: y!, w: 0, h: 0 }, 0, context);
      const points = s.type === 'polygon' ? s.points : [];
      return { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
    });
    const region: Rect = {
      type: 'rect',
      x: Math.min(...corners.map((c) => c.x)) - 0.02,
      y: Math.min(...corners.map((c) => c.y)) - 0.02,
      w: Math.abs(corners[1]!.x - corners[0]!.x) + 0.04,
      h: Math.abs(corners[1]!.y - corners[0]!.y) + 0.04,
    };
    const searched = detectionRegion(region, context);
    expect(searched.x).toBeLessThanOrEqual(box.x + 0.005);
    expect(searched.y).toBeLessThanOrEqual(box.y + 0.005);
    expect(searched.x + searched.w).toBeGreaterThanOrEqual(box.x + box.w - 0.005);
    expect(searched.y + searched.h).toBeGreaterThanOrEqual(box.y + box.h - 0.005);
  });

  it('is left alone for a picture whose preview is as recorded', () => {
    expect(faceStoredShape(box, 0, undefined)).toEqual(box);
    expect(faceStoredShape(box, 0, { lens: undefined, width: W, height: H })).toEqual(box);
    expect(detectionRegion(box, undefined)).toEqual(box);
  });
});
