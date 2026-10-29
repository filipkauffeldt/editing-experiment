import { appUrl, type Photo, type PhotoId } from '@ee/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import { ColorDot, StatusLabels, TagSquare, uploadPercent, uploadsByPhoto } from './PhotoOverlays';
import styles from './LibraryGrid.module.css';

const GAP = 14;
const PAD = 16;
const INFO_HEIGHT = 20;
const OVERSCAN_ROWS = 2;

/**
 * Virtualised contact sheet. Cells have a fixed size per width, so the rows in view follow from
 * the scroll offset and only those (plus a margin) are in the DOM.
 */
export function LibraryGrid({ photos }: { photos: Photo[] }) {
  const store = useAppStore();
  const state = useAppState();
  const { thumbSize } = state.library;
  const { selection } = state;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const selected = useMemo(() => new Set<PhotoId>(selection), [selection]);
  const uploads = useMemo(() => uploadsByPhoto(state.uploads), [state.uploads]);

  useEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const measure = (): void =>
      setSize({ width: viewport.clientWidth || 900, height: viewport.clientHeight || 600 });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((size.width - PAD * 2 + GAP) / (thumbSize + GAP)));
  const cellWidth = (size.width - PAD * 2 - GAP * (columns - 1)) / columns;
  const thumbHeight = Math.round((cellWidth * 2) / 3);
  const rowHeight = thumbHeight + INFO_HEIGHT + GAP;
  const rows = Math.ceil(photos.length / columns);

  useEffect(() => {
    store.setLibraryColumns(columns);
  }, [store, columns]);

  // Keep the open photo in view when the arrow keys move it.
  const activeIndex = photos.findIndex((photo) => photo.id === state.selectedId);
  useEffect(() => {
    const viewport = ref.current;
    if (!viewport || activeIndex < 0) return;
    const top = PAD + Math.floor(activeIndex / columns) * rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top - PAD;
    else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + rowHeight - viewport.clientHeight;
    }
  }, [activeIndex, columns, rowHeight]);

  const firstRow = Math.max(0, Math.floor((scrollTop - PAD) / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN_ROWS);
  const visible = photos.slice(firstRow * columns, lastRow * columns);

  // Same as the film strip: tell the store which thumbnails are on screen so stale ones are drawn.
  const visibleKey = visible.map((photo) => photo.id).join(',');
  useEffect(() => {
    store.setVisibleEditedPreviews(visibleKey === '' ? [] : (visibleKey.split(',') as PhotoId[]));
  }, [store, visibleKey]);

  if (photos.length === 0) {
    return <div className={styles.empty}>No photos match the current filters.</div>;
  }

  return (
    <div
      ref={ref}
      className={styles.viewport}
      data-testid="library-grid"
      role="listbox"
      aria-multiselectable
      aria-label="Photos"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className={styles.canvas} style={{ height: rows * rowHeight + PAD * 2 - GAP }}>
        {visible.map((photo, offset) => {
          const index = firstRow * columns + offset;
          const isSelected = selected.has(photo.id);
          return (
            <div
              key={photo.id}
              role="option"
              aria-selected={isSelected}
              data-testid="library-cell"
              data-photo-id={photo.id}
              title={`${photo.fileName} — ${photo.captureTime ?? 'no capture time'}`}
              className={`${styles.cell} ${isSelected ? styles.selected : ''}`}
              style={{
                width: cellWidth,
                left: PAD + (index % columns) * (cellWidth + GAP),
                top: PAD + Math.floor(index / columns) * rowHeight,
              }}
              onClick={(event) =>
                store.select(
                  photo.id,
                  event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
                )
              }
              onDoubleClick={() => store.openLibrary('loupe')}
            >
              <div className={styles.thumb} style={{ height: thumbHeight }}>
                <img
                  src={appUrl.thumb(photo.id, photo.previewRevision)}
                  alt={photo.fileName}
                  draggable={false}
                />
                <span className={styles.tag}>
                  <TagSquare tagged={photo.tagged} onToggle={() => store.toggleTag(photo.id)} />
                </span>
                <span className={styles.labels}>
                  <StatusLabels photo={photo} percent={uploadPercent(uploads.get(photo.id))} />
                </span>
              </div>
              <div className={styles.info}>
                <span className={`${styles.fileName} mono`}>{photo.fileName}</span>
                <ColorDot colorClass={photo.colorClass} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
