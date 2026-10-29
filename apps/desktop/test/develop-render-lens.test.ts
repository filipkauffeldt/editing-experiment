import type { BuiltinLensCorrection, CropParams, MosaicOp, Rect } from '@ee/contracts';
import { correctedShapes, renderCpu, resolveLens, withoutLensGeometry } from '@ee/develop-gl';
import { describe, expect, it } from 'vitest';
import { composeDevelopedRgba } from '../src/renderer/develop-render';

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
