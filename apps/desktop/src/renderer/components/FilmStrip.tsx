import { appUrl, type Photo, type PhotoId } from '@ee/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { ColorDot, StatusLabels, TagSquare, uploadPercent, uploadsByPhoto } from './PhotoOverlays';
import styles from './FilmStrip.module.css';

const ITEM_WIDTH = 112;
const ITEM_GAP = 6;
const STEP = ITEM_WIDTH + ITEM_GAP;
const OVERSCAN = 4;

function PhotoBadges({ photo, percent }: { photo: Photo; percent?: number }) {
  return (
    <>
      <span className={styles.topLeft}>{photo.tagged && <TagSquare tagged />}</span>
      <span className={styles.topRight}>
        <ColorDot colorClass={photo.colorClass} />
      </span>
      <span className={styles.bottomLeft}>
        <StatusLabels photo={photo} percent={percent} />
      </span>
    </>
  );
}

/**
 * Horizontally virtualised film strip. Only frames around the viewport are in
 * the DOM, so a 2 000-photo ingest stays smooth.
 */
export function FilmStrip({ photos }: { photos: Photo[] }) {
  const store = useAppStore();
  const state = useAppState();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const uploads = useMemo(() => uploadsByPhoto(state.uploads), [state.uploads]);

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
    const left = selectedIndex * STEP;
    const right = left + ITEM_WIDTH;
    if (left < viewport.scrollLeft) viewport.scrollLeft = left;
    else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollLeft = right - viewport.clientWidth + 4;
    }
  }, [selectedIndex]);

  const start = Math.max(0, Math.floor(scrollLeft / STEP) - OVERSCAN);
  const end = Math.min(photos.length, Math.ceil((scrollLeft + viewportWidth) / STEP) + OVERSCAN);

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

  if (photos.length === 0) {
    return <div className={styles.empty}>No photos match the current filters.</div>;
  }

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      data-testid="film-strip"
      role="listbox"
      aria-label="Film strip"
      tabIndex={0}
      onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
    >
      <div className={styles.track} style={{ width: photos.length * STEP }}>
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
                width: ITEM_WIDTH,
                height: Math.round(ITEM_WIDTH * (2 / 3)),
                left: index * STEP,
              }}
              onClick={(event) =>
                store.select(
                  photo.id,
                  event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
                )
              }
            >
              <img
                src={appUrl.thumb(photo.id, photo.previewRevision)}
                alt={photo.fileName}
                draggable={false}
              />
              <PhotoBadges photo={photo} percent={uploadPercent(uploads.get(photo.id))} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
