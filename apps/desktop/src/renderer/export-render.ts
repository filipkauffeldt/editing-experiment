import {
  LINEAR_IMAGE_HEADER,
  appUrl,
  type EditParams,
  type ExportResize,
  type LinearImageHeader,
  type Photo,
  type RenderedImage,
  type RetouchOp,
} from '@ee/contracts';
import { cropOutputPixels, grainSeedFromId } from '@ee/develop-gl';
import { outputSizeForResize } from '@ee/export/output-size';
import {
  renderDevelopRgba,
  type DevelopWorkerRequest,
  type DevelopWorkerResponse,
} from './develop-render';

export interface FullResolutionRenderRequest {
  photo: Photo;
  params: EditParams;
  ops: RetouchOp[];
  /** The export preset's resize; the renderer draws directly at that size. */
  resize: ExportResize;
  onProgress?: (progress: { label: string; percent?: number }) => void;
}

interface FetchProgress {
  onProgress?: FullResolutionRenderRequest['onProgress'];
}

/** Fetch the linear image (full size unless `maxEdge` is given) and parse its header. */
export async function fetchLinear(
  photoId: Photo['id'],
  { onProgress }: FetchProgress,
  maxEdge?: number,
): Promise<{ header: LinearImageHeader; data: ArrayBuffer }> {
  onProgress?.({ label: 'Loading the full-resolution image…' });
  const response = await fetch(appUrl.linear(photoId, maxEdge));
  if (!response.ok) {
    throw new Error(`could not load the full-resolution image (${response.status})`);
  }
  const raw = response.headers.get(LINEAR_IMAGE_HEADER);
  if (!raw) throw new Error('the full-resolution image has no header');
  const header = JSON.parse(raw) as LinearImageHeader;
  const data = await response.arrayBuffer();
  const bytesPerSample = header.sampleType === 'f16' ? 2 : 4;
  if (data.byteLength !== header.width * header.height * 4 * bytesPerSample) {
    throw new Error('the full-resolution image has an unexpected size');
  }
  return { header, data };
}

export interface OutputSize {
  width: number;
  height: number;
}

/**
 * Pixel size of the export render: the crop's pixels at full resolution, then
 * the preset's resize. Rendering at this size is both faster and the same
 * pixels the jobs process would otherwise produce by downscaling.
 */
export function exportRenderSize(
  header: LinearImageHeader,
  params: EditParams,
  resize: ExportResize,
): OutputSize {
  const source = { width: header.sourceWidth, height: header.sourceHeight };
  if (!(source.width > 0) || !(source.height > 0)) {
    throw new Error(
      `the full-resolution image has no source size (${source.width}x${source.height})`,
    );
  }
  if (header.width !== source.width || header.height !== source.height) {
    throw new Error(
      `expected a full-resolution linear image (${source.width}x${source.height}), got ${header.width}x${header.height}`,
    );
  }
  const cropped = params.crop ? cropOutputPixels(params.crop, source) : source;
  return outputSizeForResize(cropped.width, cropped.height, resize);
}

const workerTimeoutMs = 120_000;

/** Render through a dedicated worker so slider/UI frames keep flowing. */
export function renderInWorker(
  header: LinearImageHeader,
  data: ArrayBuffer,
  params: EditParams,
  ops: RetouchOp[],
  width: number,
  height: number,
  grainSeed: number,
): Promise<RenderedImage> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./develop-render.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (error) {
      reject(error);
      return;
    }
    const id = 1;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('the export render timed out'));
    }, workerTimeoutMs);
    const finish = (run: () => void): void => {
      clearTimeout(timer);
      worker.terminate();
      run();
    };
    worker.addEventListener('message', (event: MessageEvent<DevelopWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (!response.ok) {
        finish(() => reject(new Error(response.message)));
        return;
      }
      finish(() =>
        resolve({
          width: response.width,
          height: response.height,
          rgba: new Uint8Array(response.rgba),
        }),
      );
    });
    worker.addEventListener('error', (event) =>
      finish(() => reject(new Error(event.message || 'the render worker failed'))),
    );
    const request: DevelopWorkerRequest = {
      id,
      header,
      data,
      params,
      ops,
      width,
      height,
      grainSeed,
    };
    worker.postMessage(request, [data]);
  });
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Export render: the develop pipeline drawn directly at the preset's output
 * size, then every retouch op (the newest retouch version's mosaic).
 * Runs in a worker when the renderer can create one, with a yielding main
 * thread fallback.
 */
export async function renderFullResolution({
  photo,
  params,
  ops,
  resize,
  onProgress,
}: FullResolutionRenderRequest): Promise<RenderedImage> {
  // No `maxEdge`: export always starts from the full-resolution source, so a
  // preset can never export a preview-sized file. Only `resize: none` renders
  // at the source size; every other preset renders at its output size.
  const { header, data } = await fetchLinear(photo.id, { onProgress });
  const grainSeed = grainSeedFromId(photo.id);
  const output = exportRenderSize(header, params, resize);
  onProgress?.({ label: 'Rendering at export size…', percent: 20 });

  try {
    const rendered = await renderInWorker(
      header,
      data,
      params,
      ops,
      output.width,
      output.height,
      grainSeed,
    );
    onProgress?.({ label: 'Rendering at export size…', percent: 90 });
    return rendered;
  } catch {
    // No worker/OffscreenCanvas support (or the worker failed): render here,
    // yielding first so the progress label paints. The worker may have taken
    // the buffer with it, so fetch again when it is detached.
    onProgress?.({ label: 'Rendering at export size…', percent: 25 });
    await yieldToUi();
    const fallbackData =
      data.byteLength === 0 ? (await fetchLinear(photo.id, { onProgress })).data : data;
    const rendered = renderDevelopRgba({
      header,
      data: fallbackData,
      params,
      ops,
      width: output.width,
      height: output.height,
      grainSeed,
    });
    onProgress?.({ label: 'Rendering at export size…', percent: 90 });
    await yieldToUi();
    return rendered;
  }
}
