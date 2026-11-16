import { appUrl, type Photo, type PhotoId } from '@ee/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { usePanelLayout, type ResizablePanelDefinition } from '../panel-resize';
import { PanelResizeHandle } from './ui/PanelResizeHandle';
import {
  ColorDot,
  RatingStars,
  StatusIcons,
  TagSquare,
  exportBadgesByPhoto,
  uploadPercent,
  uploadsByPhoto,
  type PhotoExportBadge,
} from './PhotoOverlays';
import styles from './FilmStrip.module.css';

const PANELS = [
  { id: 'film-strip', side: 'bottom' },
] as const satisfies readonly ResizablePanelDefinition[];

const ITEM_GAP = 6;
const OVERSCAN = 4;
/** The part of the strip's height the thumbnail does not use: the top inset and the bottom padding. */
const FRAME_INSET = 17;
const MIN_FRAME_HEIGHT = 48;
const FRAME_ASPECT = 3 / 2;

function PhotoBadges({
  photo,
  percent,
  exportState,
}: {
  photo: Photo;
  percent?: number;
  exportState?: PhotoExportBadge;
}) {
  return (
    <>
      <span className={styles.topLeft}>{photo.tagged && <TagSquare tagged />}</span>
      <span className={styles.topRight}>
        <RatingStars rating={photo.rating} />
        <ColorDot colorClass={photo.colorClass} />
      </span>
      <span className={styles.bottomLeft}>
        <StatusIcons photo={photo} percent={percent} exportState={exportState} />
      </span>
    </>
  );
}

/**
 * Horizontally virtualised film strip. Only frames around the viewport are in
 * the DOM, so a 2 000-photo ingest stays smooth. Its top edge is the shared
 * resize handle; Develop and the Library loupe use one saved height.
 */
export function FilmStrip({ photos }: { photos: Photo[] }) {
  const store = useAppStore();
  const state = useAppState();
  const { panels } = usePanelLayout(PANELS);
  const strip = panels['film-strip'];
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const uploads = useMemo(() => uploadsByPhoto(state.uploads), [state.uploads]);
  const exports = useMemo(() => exportBadgesByPhoto(state.exportJobs), [state.exportJobs]);

  const height = Math.round(strip.size);
  const frameHeight = Math.max(MIN_FRAME_HEIGHT, height - FRAME_INSET);
  const frameWidth = Math.round(frameHeight * FRAME_ASPECT);
  const step = frameWidth + ITEM_GAP;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = (): void => setViewportWidth(viewport.clientWidth || 1200);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = photos.findIndex((photo) => photo.id === state.selectedId);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || selectedIndex < 0) return;
    const left = selectedIndex * step;
    const right = left + frameWidth;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = right - viewport.clientWidth + 4;
    }
  }, [selectedIndex, step, frameWidth]);

  const start = Math.max(0, Math.floor(scrollLeft / step) - OVERSCAN);
  const end = Math.min(photos.length, Math.ceil((scrollLeft + viewportWidth) / step) + OVERSCAN);

  // Photos edited before ingest (or whose cache was lost) only show the camera preview
  // until their edited thumbnail is drawn. Tell the store which frames are on screen so
  // it draws those, and nothing that has scrolled past. The stale ones are in the key
  // because a photo can turn stale while it stays in view.
  const visibleSlice = photos.slice(start, end);
  const visibleKey = visibleSlice.map((photo) => photo.id).join(',');
  const staleKey = visibleSlice
    .filter((photo) => photo.status.edited && photo.previewStale)
    .map((photo) => photo.id)
    .join(',');
  useEffect(() => {
    store.setVisibleEditedPreviews(visibleKey === '' ? [] : (visibleKey.split(',') as PhotoId[]));
  }, [store, visibleKey, staleKey]);

  return (
    <div className={styles.strip} style={{ height }} data-testid="film-strip-panel">
      <PanelResizeHandle
        panel="film-strip"
        label="Film strip"
        side="bottom"
        controller={strip}
        className={styles.stripHandle}
      />
      <div
        ref={viewportRef}
        className={styles.viewport}
        data-testid="film-strip"
        role="listbox"
        aria-label="Film strip"
        tabIndex={0}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        {photos.length === 0 ? (
          <div className={styles.empty}>No photos match the current filters.</div>
        ) : (
          <div className={styles.track} style={{ width: photos.length * step }}>
            {photos.slice(start, end).map((photo, offset) => {
              const index = start + offset;
              const selected = photo.id === state.selectedId;
              const inSelection = state.selection.includes(photo.id);
              return (
                <button
                  key={photo.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={`${photo.fileName} — ${photo.captureTime ?? 'no capture time'}`}
                  className={`${styles.frame} ${selected ? styles.selected : ''} ${
                    inSelection && !selected ? styles.inSelection : ''
                  }`}
                  style={{
                    width: frameWidth,
                    height: frameHeight,
                    left: index * step,
                  }}
                  onClick={(event) =>
                    store.select(
                      photo.id,
                      event.shiftKey
                        ? 'range'
                        : event.ctrlKey || event.metaKey
                          ? 'toggle'
                          : 'replace',
                    )
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    store.openPhotoMenu(photo.id, event.clientX, event.clientY);
                  }}
                >
                  <img
                    src={appUrl.thumb(photo.id, photo.previewRevision)}
                    alt={photo.fileName}
                    decoding="async"
                    draggable={false}
                  />
                  <PhotoBadges
                    photo={photo}
                    percent={uploadPercent(uploads.get(photo.id))}
                    exportState={exports.get(photo.id)}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
