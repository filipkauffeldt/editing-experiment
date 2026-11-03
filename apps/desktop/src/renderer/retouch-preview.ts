import type { EditParams, MosaicOp } from '@ee/contracts';
import { cropDevelopedRgba } from '@ee/develop-gl';
import { applyMosaic } from '@ee/retouch';

export interface MosaicPreviewRequest {
  /** The op with its shapes already moved into the corrected picture (lens correction). */
  op: MosaicOp;
  params: EditParams;
  /** The pixel size of the recorded picture the shapes are drawn on. */
  source: { width: number; height: number };
  /** The size of the canvas the preview is painted at. */
  output: { width: number; height: number };
  /** Develop render of `params` at `size`. */
  render(params: EditParams, size: { width: number; height: number }): Uint8Array;
}

/**
 * The mosaicked pixels the canvas paints over the develop render. With a crop the mosaic is
 * applied in source space and then cropped and rotated, like the full-resolution path; without
 * one it is applied at the canvas size. Add, subtract and off areas go through `applyMosaic`
 * either way, as they do in the export and the film strip thumbnail.
 */
export function renderMosaicPreview({
  op,
  params,
  source,
  output,
  render,
}: MosaicPreviewRequest): Uint8Array {
  if (params.crop !== undefined) {
    const uncropped = { ...params };
    delete uncropped.crop;
    const sourceRgba = render(uncropped, source);
    applyMosaic(sourceRgba, source.width, source.height, op, { inPlace: true });
    return cropDevelopedRgba(sourceRgba, source, params.crop, output);
  }
  const rgba = render(params, output);
  applyMosaic(rgba, output.width, output.height, op, { inPlace: true });
  return rgba;
}
