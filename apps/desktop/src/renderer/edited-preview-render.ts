import { cropOutputPixels, grainSeedFromId } from '@ee/develop-gl';
import type { EditParams, Photo, RenderedImage, ResolvedProfile, RetouchOp } from '@ee/contracts';
import { renderDevelopRgba } from './develop-render';
import { fetchLinear, renderInWorker } from './export-render';

export interface EditedPreviewOptions {
  /** Long edge of the preview. Default 2560, as the camera preview cached at ingest. */
  maxEdge?: number;
  /** Long edge of the film strip thumbnail. Default 320. */
  thumbEdge?: number;
  /** The camera profile (and look) the photo's settings name, when it is on this machine. */
  profile?: ResolvedProfile | null;
}

export interface EditedPreviewImages {
  thumb: RenderedImage;
  preview: RenderedImage;
}

const DEFAULT_MAX_EDGE = 2560;
const DEFAULT_THUMB_EDGE = 320;

interface Size {
  width: number;
  height: number;
}

/**
 * Pixel size of a render that fits `edge`: the crop's size when cropped (so the
 * thumbnail has the crop's aspect ratio), never larger than the source.
 */
export function editedPreviewSize(params: EditParams, source: Size, edge: number): Size {
  const full = params.crop ? cropOutputPixels(params.crop, source) : source;
  const scale = Math.min(1, edge / Math.max(full.width, full.height));
  return {
    width: Math.max(1, Math.round(full.width * scale)),
    height: Math.max(1, Math.round(full.height * scale)),
  };
}

/**
 * Render a photo as it is edited: develop, the top retouch version's mosaic, then
 * crop and straighten. This is the same composition as the export render
 * (`composeDevelopedRgba`) at preview size, so what the film strip shows is what
 * "Finish & next" produces. It runs in render workers and yields the pixels for
 * `photos:setEditedPreview`; JPEG encoding stays in the jobs process.
 */
export async function renderEditedPreview(
  photo: Photo,
  params: EditParams,
  ops: RetouchOp[],
  options: EditedPreviewOptions = {},
): Promise<EditedPreviewImages> {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const thumbEdge = options.thumbEdge ?? DEFAULT_THUMB_EDGE;
  const { header, data } = await fetchLinear(photo.id, {}, maxEdge);
  const source = { width: header.width, height: header.height };
  const previewSize = editedPreviewSize(params, source, maxEdge);
  const thumbSize = editedPreviewSize(params, source, thumbEdge);
  // The same per-photo seed as the canvas and the export, so the grain matches.
  const grainSeed = grainSeedFromId(photo.id);

  try {
    // A worker takes the buffer with it, so each render gets its own copy.
    const [preview, thumb] = await Promise.all([
      renderInWorker(
        header,
        data.slice(0),
        params,
        ops,
        previewSize.width,
        previewSize.height,
        grainSeed,
        options.profile ?? null,
      ),
      renderInWorker(
        header,
        data,
        params,
        ops,
        thumbSize.width,
        thumbSize.height,
        grainSeed,
        options.profile ?? null,
      ),
    ]);
    return { preview, thumb };
  } catch {
    // No worker/OffscreenCanvas support, or the worker failed: draw here.
    const again = (await fetchLinear(photo.id, {}, maxEdge)).data;
    const render = (size: Size, buffer: ArrayBuffer): RenderedImage =>
      renderDevelopRgba({
        header,
        data: buffer,
        params,
        ops,
        grainSeed,
        profile: options.profile ?? null,
        ...size,
      });
    return { preview: render(previewSize, again.slice(0)), thumb: render(thumbSize, again) };
  }
}
