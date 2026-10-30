import {
  correctedShapes,
  createDevelopRenderer,
  cropMosaicOp,
  needsNeighbourhood,
  renderCpu,
  withLookSettings,
} from '@ee/develop-gl';
import { applyMosaic } from '@ee/retouch';
import type {
  EditParams,
  LinearImageHeader,
  ResolvedProfile,
  RetouchOp,
  Shape,
} from '@ee/contracts';

export interface RenderRequest {
  header: LinearImageHeader;
  /** Raw f16/f32 samples from `app://linear`. Transferred to the worker. */
  data: ArrayBuffer;
  params: EditParams;
  ops: RetouchOp[];
  width: number;
  height: number;
  /** Stable per-photo grain seed, so preview and export render the same grain. */
  grainSeed?: number;
  /** The camera profile (and look) to render through; absent renders with the decoder's camera matrix. */
  profile?: ResolvedProfile | null;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function createCanvas(): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

/**
 * Develop a full-resolution linear image and apply the retouch ops.
 *
 * `createDevelopRenderer` tiles both the source textures and the output, so
 * sensor-sized images are fine as long as the sample buffer fits in memory.
 * This function blocks while the GPU draws; callers run it in a worker.
 */
export interface ComposeRequest {
  params: EditParams;
  ops: RetouchOp[];
  /** Output size in pixels (the crop size for a cropped export). */
  width: number;
  height: number;
  /** Size of the rendered source buffer, in pixels. */
  source: { width: number; height: number };
  /**
   * Moves retouch shapes (stored in the recorded picture) into the picture `render` draws, when
   * a lens correction resamples it. Identity when absent.
   */
  mapShapes?(shapes: readonly Shape[]): Shape[];
  /** Renders the develop pipeline at `size`; a WebGL call in production, a stub in tests. */
  render(params: EditParams, size: { width: number; height: number }): Uint8Array;
}

/**
 * The pixel path after the GL draw: apply retouch ops at the output size.
 *
 * The develop pass renders directly at `width` x `height`, lens correction,
 * crop and straighten included. Mosaic shapes are stored in the recorded
 * (uncorrected, uncropped) picture. A lens correction resamples the picture, so
 * the stored shapes are first moved into the corrected picture (`mapShapes`,
 * outlines padded by a pixel and a half); a crop then moves them into the
 * cropped output. No resampling happens after the mosaic, so blocks stay
 * exactly constant and a face the shape covered cannot reappear.
 */
export function composeDevelopedRgba({
  params,
  ops,
  width,
  height,
  source,
  mapShapes,
  render,
}: ComposeRequest): Uint8Array {
  const rgba = render(params, { width, height });
  for (const op of ops) {
    if (op.type !== 'mosaic') continue;
    const corrected = mapShapes ? { ...op, shapes: mapShapes(op.shapes) } : op;
    const mapped =
      params.crop === undefined
        ? corrected
        : cropMosaicOp(corrected, params.crop, source, { width, height });
    applyMosaic(rgba, width, height, mapped, { inPlace: true });
  }
  return rgba;
}

/**
 * Largest picture (source or output, in pixels) the CPU reference renders for an export
 * when the GPU cannot draw Texture, Clarity, Dehaze, sharpening or noise reduction.
 * It holds several float planes per pixel (about 100 bytes), so beyond this it would
 * run out of memory; the render fails with a clear message instead.
 */
export const CPU_FALLBACK_MAX_PIXELS = 16_000_000;

/**
 * Renders with `renderer`, or, when the settings need the neighbourhood passes and the GPU
 * has no float render targets, with the CPU reference (the same maths, slower), so an export
 * is never silently drawn without the settings. Too large for the CPU: throws.
 */
export function renderWithFallback(
  renderer: ReturnType<typeof createDevelopRenderer>,
  header: LinearImageHeader,
  data: ArrayBuffer,
  params: EditParams,
  size: { width: number; height: number },
  grainSeed?: number,
  profile: ResolvedProfile | null = null,
): Uint8Array {
  // A look carries settings of its own (Clarity), which the GPU's neighbourhood support gates too.
  if (renderer.supportsNeighbourhood || !needsNeighbourhood(withLookSettings(params, profile))) {
    return renderer.renderToRGBA(params, size);
  }
  // The CPU reference works at the output size; the source is only sampled.
  const pixels = size.width * size.height;
  if (pixels > CPU_FALLBACK_MAX_PIXELS) {
    throw new Error(
      'Texture, Clarity, Dehaze, sharpening and noise reduction need GPU float support ' +
        '(EXT_color_buffer_float), which this GPU lacks, and this picture is too large to ' +
        'render them on the CPU. Set those sliders to 0 or export a smaller size.',
    );
  }
  return renderCpu(header, data, params, size, {
    ...(grainSeed === undefined ? {} : { grainSeed }),
    profile,
  });
}

export function renderDevelopRgba(request: RenderRequest): RenderResult {
  const { header, data, params, ops, width, height, grainSeed, profile = null } = request;
  const canvas = createCanvas();
  const renderer = createDevelopRenderer(canvas, { grainSeed });
  try {
    renderer.setImage(header, data);
    renderer.setProfile(profile);
    request.onProgress?.(0.3);
    const rgba = composeDevelopedRgba({
      params,
      ops,
      width,
      height,
      source: { width: header.width, height: header.height },
      mapShapes: (shapes) => correctedShapes(shapes, header, params),
      render: (renderParams, size) =>
        renderWithFallback(renderer, header, data, renderParams, size, grainSeed, profile),
    });
    request.onProgress?.(0.95);
    return { width, height, rgba };
  } finally {
    renderer.dispose();
  }
}

/** A worker request/response pair; `data` and `rgba` travel as transferable buffers. */
export interface DevelopWorkerRequest {
  id: number;
  header: LinearImageHeader;
  data: ArrayBuffer;
  params: EditParams;
  ops: RetouchOp[];
  width: number;
  height: number;
  grainSeed?: number;
  profile?: ResolvedProfile | null;
}

export type DevelopWorkerResponse =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; ok: false; message: string };
