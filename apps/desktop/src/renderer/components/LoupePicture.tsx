import type { Photo } from '@ee/contracts';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Size } from '../crop-view';
import {
  hasRetouchOps,
  loupeBase,
  loupeFrame,
  loupeUrls,
  neededUrl,
  type LoupeUrls,
} from '../loupe-view';
import { wholeDevicePixels, type ViewLayout } from '../view-transform';
import { useZoomControls, type ZoomControls } from '../zoom-view';
import styles from './LoupePicture.module.css';

/** A preview of another shape than the frame (a cropped one) is not stretched into it. */
const UNDERLAY_ASPECT_TOLERANCE = 0.02;

interface Loaded {
  url: string;
  size: Size;
}

const naturalSize = (image: HTMLImageElement): Size | undefined =>
  image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : undefined;

/** The stage in whole device pixels, which the zoom maths and the pixel grid need. */
function useStageSize(ref: React.RefObject<HTMLElement | null>, dpr: number): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void =>
      setSize((now) => {
        const next = {
          width: wholeDevicePixels(element.clientWidth, dpr),
          height: wholeDevicePixels(element.clientHeight, dpr),
        };
        return now.width === next.width && now.height === next.height ? now : next;
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, dpr]);
  return size;
}

export interface LoupePictureState {
  /** Callback refs, so the elements are handed over without exposing a ref object to render. */
  bindStage(element: HTMLDivElement | null): void;
  bindPreview(element: HTMLImageElement | null): void;
  bindFull(element: HTMLImageElement | null): void;
  dpr: number;
  zoom: ZoomControls;
  zoomed: boolean;
  urls: LoupeUrls | undefined;
  retouched: boolean;
  frame: Size;
  layout: ViewLayout;
  /** The image the photo needs now: the preview at Fit, the full-size JPEG zoomed. */
  needed: string | undefined;
  /** `needed` has loaded, so the photo on screen no longer waits for anything. */
  ready: boolean;
  fullReady: boolean;
  /** The data attributes the end-to-end tests read the view from. */
  stageData: Record<string, string | undefined>;
  setPreview(loaded: Loaded): void;
  setFull(loaded: Loaded): void;
  preview: Loaded | undefined;
  full: Loaded | undefined;
}

/**
 * What the Library loupe and the compare view share for one photo: the zoom (`zoomKey` names the
 * view that carries between photos), the preview and full-size JPEG as they load, and the frame
 * they are drawn into.
 */
export function useLoupePicture(photo: Photo | undefined, zoomKey: string): LoupePictureState {
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLImageElement>(null);
  const fullRef = useRef<HTMLImageElement>(null);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const container = useStageSize(stageRef, dpr);
  const [preview, setPreview] = useState<Loaded | undefined>();
  const [full, setFull] = useState<Loaded | undefined>();
  const urls = useMemo(() => (photo ? loupeUrls(photo) : undefined), [photo]);
  const retouched = photo !== undefined && hasRetouchOps(photo);

  const frame = useMemo(
    () =>
      photo
        ? loupeFrame({
            photo,
            full: full?.url === urls?.full ? full?.size : undefined,
            preview: preview?.url === urls?.preview ? preview?.size : undefined,
          })
        : { width: 4, height: 3 },
    [photo, full, preview, urls],
  );
  const base = useMemo(() => loupeBase(container, frame), [container, frame]);
  const zoom = useZoomControls(zoomKey, { base, image: frame, viewport: container, dpr }, stageRef);
  const zoomed = zoom.view.scale !== null;

  // An image that was fetched ahead is complete at once, so it counts as loaded without waiting
  // for its load event, and the preview underneath never shows for a frame.
  useLayoutEffect(() => {
    const image = previewRef.current;
    const size = image && naturalSize(image);
    if (image?.complete && size && urls) setPreview({ url: urls.preview, size });
  }, [urls?.preview]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const image = fullRef.current;
    const size = image && naturalSize(image);
    if (image?.complete && size && urls) setFull({ url: urls.full, size });
  }, [urls?.full, zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

  const needed = photo ? neededUrl(photo, zoomed) : undefined;
  const ready = needed !== undefined && (zoomed ? full?.url : preview?.url) === needed;
  const { layout } = zoom;
  const fullReady = zoomed && full !== undefined && full.url === urls?.full;
  const stageData = {
    'data-photo-id': photo?.id,
    'data-zoom': zoom.view.scale === null ? 'fit' : String(Math.round(zoom.view.scale * dpr * 100)),
    'data-view': `${layout.scale},${layout.offset.x},${layout.offset.y}`,
    'data-frame': `${frame.width}x${frame.height}`,
    'data-full-ready': fullReady && !retouched ? 'true' : 'false',
  };
  return {
    bindStage: (element) => {
      stageRef.current = element;
    },
    bindPreview: (element) => {
      previewRef.current = element;
    },
    bindFull: (element) => {
      fullRef.current = element;
    },
    dpr,
    zoom,
    zoomed,
    urls,
    retouched,
    frame,
    layout,
    needed,
    ready,
    fullReady,
    stageData,
    setPreview,
    setFull,
    preview,
    full,
  };
}

/* The picture hands over callback refs; the compiler rule takes the whole object for a ref. */
/* eslint-disable react-hooks/refs */
/**
 * The images of one photo in its stage: the preview, the full-size JPEG on top of it once zoomed,
 * and the layer that turns a Space-drag into a pan. The stage itself is the caller's, so it can
 * add its own markers.
 */
export function LoupePictureImages({
  photo,
  picture,
  fullTestId,
  panTestId,
}: {
  photo: Photo;
  picture: LoupePictureState;
  fullTestId: string;
  panTestId: string;
}) {
  const { urls, zoom, zoomed, layout, frame, preview, fullReady } = picture;
  if (!urls) return null;
  const rect = {
    left: layout.offset.x,
    top: layout.offset.y,
    width: frame.width * layout.scale,
    height: frame.height * layout.scale,
  };
  const previewSize = preview?.url === urls.preview ? preview?.size : undefined;
  const underlay =
    previewSize === undefined ||
    Math.abs(previewSize.width / previewSize.height / (frame.width / frame.height) - 1) <
      UNDERLAY_ASPECT_TOLERANCE;
  return (
    <>
      <img
        ref={picture.bindPreview}
        className={styles.preview}
        src={urls.preview}
        alt={photo.fileName}
        draggable={false}
        style={zoomed ? { ...rect, visibility: underlay ? 'visible' : 'hidden' } : undefined}
        data-zoomed={zoomed ? 'true' : undefined}
        onLoad={(event) => {
          const size = naturalSize(event.currentTarget);
          if (size) picture.setPreview({ url: urls.preview, size });
        }}
      />
      {zoomed && (
        <img
          ref={picture.bindFull}
          className={styles.full}
          src={urls.full}
          alt=""
          draggable={false}
          style={{ ...rect, visibility: fullReady ? 'visible' : 'hidden' }}
          data-testid={fullTestId}
          onLoad={(event) => {
            const size = naturalSize(event.currentTarget);
            if (size) picture.setFull({ url: urls.full, size });
          }}
        />
      )}
      {zoom.panHeld && (
        <div
          className={`${styles.panLayer} ${zoom.dragging ? styles.panDragging : ''}`}
          data-testid={panTestId}
          {...zoom.panHandlers}
        />
      )}
    </>
  );
}

/* eslint-enable react-hooks/refs */

export const loupeStageClass = styles.stage;
