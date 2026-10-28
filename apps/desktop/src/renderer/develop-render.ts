import { createDevelopRenderer, cropDevelopedRgba } from '@ee/develop-gl';
import { applyMosaic } from '@ee/retouch';
import type { EditParams, LinearImageHeader, RetouchOp } from '@ee/contracts';

export interface RenderRequest {
  header: LinearImageHeader;
  /** Raw f16/f32 samples from `app://linear`. Transferred to the worker. */
  data: ArrayBuffer;
  params: EditParams;
  ops: RetouchOp[];
  width: number;
  height: number;
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
  /** Renders the develop pipeline at `size`; a WebGL call in production, a stub in tests. */
  render(params: EditParams, size: { width: number; height: number }): Uint8Array;
}

/**
 * The full-resolution pixel path after the GL draw: apply retouch ops and crop.
 *
 * Mosaics live in uncropped source coordinates. When a crop is present the
 * source is rendered and mosaicked first, then cropped/rotated, so resampling
 * can only blur mosaic blocks, never expose a face that the mosaic covered.
 */
export function composeDevelopedRgba({
  params,
  ops,
  width,
  height,
  source,
  render,
}: ComposeRequest): Uint8Array {
  const mosaic = ops.filter((op) => op.type === 'mosaic');
  if (params.crop !== undefined && mosaic.length > 0) {
    const uncropped: EditParams = { ...params };
    delete uncropped.crop;
    const rgba = render(uncropped, source);
    for (const op of mosaic) applyMosaic(rgba, source.width, source.height, op, { inPlace: true });
    return cropDevelopedRgba(rgba, source, params.crop, { width, height });
  }

  const rgba = render(params, { width, height });
  for (const op of mosaic) applyMosaic(rgba, width, height, op, { inPlace: true });
  return rgba;
}

export function renderDevelopRgba(request: RenderRequest): RenderResult {
  const { header, data, params, ops, width, height } = request;
  const canvas = createCanvas();
  const renderer = createDevelopRenderer(canvas);
  try {
    renderer.setImage(header, data);
    request.onProgress?.(0.3);
    const rgba = composeDevelopedRgba({
      params,
      ops,
      width,
      height,
      source: { width: header.width, height: header.height },
      render: (renderParams, size) => renderer.renderToRGBA(renderParams, size),
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
}

export type DevelopWorkerResponse =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; ok: false; message: string };
