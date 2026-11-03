import {
  mapMosaicShapes,
  type CropParams,
  type MosaicOp,
  type Point,
  type Shape,
} from '@ee/contracts';
import { cropGeometry, cropMosaicOp, isUsableCrop, type CropViewTransform } from '@ee/develop-gl';
import { applyMosaic } from '@ee/retouch';
import type { Size } from './crop-view';
import type { ViewLayout } from './view-transform';

/**
 * What the canvas needs to draw a zoomed view: the transform the GL renderer takes, the size of
 * the picture, how sharp the uploaded image must be, and the mosaic over the zoomed pixels. All
 * of it is view-only; the develop render and the export never see it.
 */

/** The whole image as a crop: the retouch view and an uncropped develop view. */
export const WHOLE_IMAGE: CropParams = { left: 0, top: 0, right: 1, bottom: 1, angle: 0 };

/** The picture a develop or retouch view shows, in full-resolution pixels: the crop's output, or the whole image. */
export function pictureSize(crop: CropParams | undefined, image: Size): Size {
  if (crop === undefined || !isUsableCrop(crop)) return image;
  const geometry = cropGeometry(crop, image);
  return { width: Math.max(1, geometry.width), height: Math.max(1, geometry.height) };
}

export interface PictureViewRequest {
  /** The committed crop being shown, or {@link WHOLE_IMAGE}. */
  crop: CropParams;
  /** The full-resolution oriented image the crop is a fraction of. */
  image: Size;
  /** Pixel width of the uploaded linear image, which may be a downscale of `image`. */
  uploadedWidth: number;
  /** Where the picture sits in the stage, in CSS pixels. */
  layout: ViewLayout;
  /** Drawing-buffer pixels per CSS pixel. */
  bufferRatio: number;
  outside: [number, number, number];
}

/**
 * The transform that draws a zoomed picture on the canvas: the crop is the frame, placed where
 * the layout puts the picture, and outside it nothing is drawn. The frame is also what the
 * post-crop vignette measures against, so a zoomed view shows the same vignette as Fit.
 */
export function pictureViewTransform(request: PictureViewRequest): CropViewTransform {
  const { crop, image, layout, bufferRatio } = request;
  const geometry = cropGeometry(crop, image);
  const toBuffer = layout.scale * bufferRatio;
  const pivot = {
    x: (layout.offset.x + (geometry.width * layout.scale) / 2) * bufferRatio,
    y: (layout.offset.y + (geometry.height * layout.scale) / 2) * bufferRatio,
  };
  return {
    crop,
    pivot,
    // View units are pixels of the full image; the texture may be a downscale of it.
    scale: toBuffer * (image.width / request.uploadedWidth),
    frame: {
      x: pivot.x - (geometry.width * toBuffer) / 2,
      y: pivot.y - (geometry.height * toBuffer) / 2,
      w: geometry.width * toBuffer,
      h: geometry.height * toBuffer,
    },
    dim: 0,
    outside: request.outside,
  };
}

/** Long edges the linear image is requested at while zoomed, so wheel steps do not refetch each time. */
const EDGE_STEPS = [2560, 4096, 6144, 8192, 12288, 16384] as const;

/**
 * The `maxEdge` of the linear image that keeps a zoomed view sharp: enough pixels for the device
 * pixels the picture covers, never more than the image has. `undefined` is the full-resolution
 * decode (the one the export reuses). `deviceScale` is device pixels per full-resolution pixel.
 */
export function linearEdgeFor(deviceScale: number, fullLongEdge: number): number | undefined {
  const needed = fullLongEdge * Math.min(1, Math.max(0, deviceScale));
  const step = EDGE_STEPS.find((edge) => edge >= needed);
  return step === undefined || step >= fullLongEdge ? undefined : step;
}

/** Whether an uploaded image has the pixels a zoomed view asks for (it is never upscaled). */
export function hasDetailFor(uploadedLongEdge: number, deviceScale: number, fullLongEdge: number) {
  const wanted = linearEdgeFor(deviceScale, fullLongEdge) ?? fullLongEdge;
  return uploadedLongEdge >= Math.min(wanted, fullLongEdge) - 1;
}

export interface ZoomedMosaicRequest {
  /** The op with its shapes already moved into the corrected picture (lens correction). */
  op: MosaicOp;
  /** The committed crop being shown; absent in a retouch or uncropped view. */
  crop: CropParams | undefined;
  /** The full-resolution oriented image the shapes are normalised to. */
  image: Size;
  /** The picture shown, see {@link pictureSize}. */
  picture: Size;
  /** Where the picture sits in the stage, in CSS pixels. */
  layout: ViewLayout;
  bufferRatio: number;
}

/**
 * Mosaics the pixels of a zoomed canvas in place. The shapes are moved from the picture into
 * drawing-buffer space and the block size is scaled with them, so a block covers the same part
 * of the picture as it does in the export (relative to the long edge of the whole image).
 */
export function mosaicZoomedView(
  rgba: Uint8Array,
  buffer: Size,
  request: ZoomedMosaicRequest,
): void {
  const { image, picture, layout, bufferRatio } = request;
  const cropped =
    request.crop !== undefined && isUsableCrop(request.crop)
      ? cropMosaicOp(request.op, request.crop, image, picture)
      : request.op;
  // Picture-normalised coordinates to the buffer's own 0..1.
  const toBuffer = (point: Point): Point => ({
    x: ((layout.offset.x + point.x * picture.width * layout.scale) * bufferRatio) / buffer.width,
    y: ((layout.offset.y + point.y * picture.height * layout.scale) * bufferRatio) / buffer.height,
  });
  const moved = mapMosaicShapes(cropped, (shapes) =>
    shapes.map((shape): Shape => {
      if (shape.type === 'polygon') {
        return { type: 'polygon', points: shape.points.map(toBuffer) };
      }
      const from = toBuffer({ x: shape.x, y: shape.y });
      const to = toBuffer({ x: shape.x + shape.w, y: shape.y + shape.h });
      return { type: 'rect', x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y };
    }),
  );
  // The block is a fraction of the whole image's long edge, as in the export; on screen that edge
  // is this many buffer pixels, which `applyMosaic` takes as a fraction of the buffer's long edge.
  const wholeEdge = Math.max(image.width, image.height) * layout.scale * bufferRatio;
  const blockSizeRel = (moved.blockSizeRel * wholeEdge) / Math.max(buffer.width, buffer.height);
  applyMosaic(rgba, buffer.width, buffer.height, { ...moved, blockSizeRel }, { inPlace: true });
}
