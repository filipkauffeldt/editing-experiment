import { createDevelopRenderer } from '@ee/develop-gl';
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
export function renderDevelopRgba(request: RenderRequest): RenderResult {
  const { header, data, params, ops, width, height } = request;
  const canvas = createCanvas();
  const renderer = createDevelopRenderer(canvas);
  try {
    renderer.setImage(header, data);
    request.onProgress?.(0.3);
    const rgba = renderer.renderToRGBA(params, { width, height });
    request.onProgress?.(0.8);
    if (ops.length > 0) {
      for (const op of ops) {
        if (op.type === 'mosaic') applyMosaic(rgba, width, height, op, { inPlace: true });
      }
      request.onProgress?.(0.95);
    }
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
