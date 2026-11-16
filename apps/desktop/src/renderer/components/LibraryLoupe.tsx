import type { Photo } from '@ee/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Size } from '../crop-view';
import { ImagePreloader } from '../image-preloader';
import {
  LOUPE_ZOOM_KEY,
  hasRetouchOps,
  loupeBase,
  loupeFrame,
  loupeUrls,
  neededUrl,
  neighbours,
} from '../loupe-view';
import { activePhoto } from '../store';
import { useAppState } from '../store-context';
import { wholeDevicePixels } from '../view-transform';
import { useZoomControls } from '../zoom-view';
import { FilmStrip } from './FilmStrip';
import styles from './LibraryLoupe.module.css';

/** Neighbours fetched ahead: the next photo and the previous one. */
const PRELOAD_LIMIT = 2;
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

/**
 * E: one photo large, with the grid's photos as a strip beneath. Fit shows the cached preview.
 * Zooming (the keys and mouse of Develop) shows the camera's full-size JPEG, so 100% needs no raw
 * decode, and the zoom carries to the next photo so a burst is checked at the same spot.
 */
export function LibraryLoupe({ photos }: { photos: Photo[] }) {
  const state = useAppState();
  const photo = activePhoto(state);
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
  const zoom = useZoomControls(
    LOUPE_ZOOM_KEY,
    { base, image: frame, viewport: container, dpr },
    stageRef,
  );
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

  // Fetch the neighbours' images ahead, at what they will need: the preview at Fit, the full-size
  // JPEG when zoomed. Only once the photo on screen has its own image, so it never waits for them,
  // and what is not wanted any more is dropped as soon as the selection moves on.
  const preloader = useRef<ImagePreloader | undefined>(undefined);
  useEffect(() => {
    preloader.current = new ImagePreloader(PRELOAD_LIMIT);
    const current = preloader.current;
    return () => current.clear();
  }, []);
  const needed = photo ? neededUrl(photo, zoomed) : undefined;
  const ready = needed !== undefined && (zoomed ? full?.url : preview?.url) === needed;
  const around = useMemo(() => neighbours(photos, photo?.id), [photos, photo?.id]);
  // A neighbour whose URL changed (it was retouched) drops what was held for the old one at once.
  const wantedUrls = around.map((next) => neededUrl(next, zoomed));
  const wantedKey = wantedUrls.join('\n');
  useEffect(() => {
    preloader.current?.keepOnly(needed === undefined ? wantedUrls : [needed, ...wantedUrls]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, wantedKey]);
  useEffect(() => {
    if (!ready) return;
    preloader.current?.want(around.map((next) => neededUrl(next, zoomed)));
  }, [ready, around, zoomed]);

  const { layout } = zoom;
  const rect = {
    left: layout.offset.x,
    top: layout.offset.y,
    width: frame.width * layout.scale,
    height: frame.height * layout.scale,
  };
  const previewSize = preview?.url === urls?.preview ? preview?.size : undefined;
  const underlay =
    previewSize === undefined ||
    Math.abs(previewSize.width / previewSize.height / (frame.width / frame.height) - 1) <
      UNDERLAY_ASPECT_TOLERANCE;
  const fullReady = zoomed && full !== undefined && full.url === urls?.full;

  return (
    <div className={styles.loupe} data-testid="library-loupe">
      <div
        ref={stageRef}
        className={styles.stage}
        data-testid="loupe-stage"
        data-photo-id={photo?.id}
        data-zoom={
          zoom.view.scale === null ? 'fit' : String(Math.round(zoom.view.scale * dpr * 100))
        }
        data-view={`${layout.scale},${layout.offset.x},${layout.offset.y}`}
        data-frame={`${frame.width}x${frame.height}`}
        data-full-ready={fullReady && !retouched ? 'true' : 'false'}
      >
        {photo && urls ? (
          <>
            <img
              ref={previewRef}
              className={styles.preview}
              src={urls.preview}
              alt={photo.fileName}
              draggable={false}
              style={zoomed ? { ...rect, visibility: underlay ? 'visible' : 'hidden' } : undefined}
              data-zoomed={zoomed ? 'true' : undefined}
              onLoad={(event) => {
                const size = naturalSize(event.currentTarget);
                if (size) setPreview({ url: urls.preview, size });
              }}
            />
            {zoomed && (
              <img
                ref={fullRef}
                className={styles.full}
                src={urls.full}
                alt=""
                draggable={false}
                style={{ ...rect, visibility: fullReady ? 'visible' : 'hidden' }}
                data-testid="loupe-full"
                onLoad={(event) => {
                  const size = naturalSize(event.currentTarget);
                  if (size) setFull({ url: urls.full, size });
                }}
              />
            )}
            {zoom.panHeld && (
              <div
                className={`${styles.panLayer} ${zoom.dragging ? styles.panDragging : ''}`}
                data-testid="loupe-pan-layer"
                {...zoom.panHandlers}
              />
            )}
          </>
        ) : (
          <span className={styles.empty}>No photo selected</span>
        )}
      </div>
      <div className={styles.strip}>
        <FilmStrip photos={photos} />
      </div>
    </div>
  );
}
