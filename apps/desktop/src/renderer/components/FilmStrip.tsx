import { appUrl, type Photo } from '@ee/contracts';
import { useEffect, useRef, useState } from 'react';
import { useAppState, useAppStore } from '../store-context';
import {
  CheckIcon,
  ClockIcon,
  CrossIcon,
  MetaDiffIcon,
  PenIcon,
  StackIcon,
  TagIcon,
  UploadIcon,
} from './icons';
import styles from './FilmStrip.module.css';

const ITEM_WIDTH = 112;
const ITEM_GAP = 6;
const STEP = ITEM_WIDTH + ITEM_GAP;
const OVERSCAN = 4;

/** Colour classes shown as a slim stripe on each frame. Index 0 means none. */
export const COLOR_CLASSES = [
  '',
  '#e05a58',
  '#e08a3c',
  '#d8c84a',
  '#58b86a',
  '#46b8b0',
  '#5a9be0',
  '#9a74d8',
  '#d96ba8',
] as const;

function UploadBadge({ state }: { state: Photo['status']['upload'] }) {
  if (state === 'none') return null;
  if (state === 'done') {
    return (
      <span className={`${styles.badge} ${styles.badgeDone}`} title="Uploaded">
        <CheckIcon />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className={`${styles.badge} ${styles.badgeFailed}`} title="Upload failed">
        <CrossIcon />
      </span>
    );
  }
  if (state === 'uploading') {
    return (
      <span className={`${styles.badge} ${styles.badgeUploading}`} title="Uploading">
        <UploadIcon />
      </span>
    );
  }
  return (
    <span className={`${styles.badge} ${styles.badgeQueued}`} title="Queued for upload">
      <ClockIcon />
    </span>
  );
}

function PhotoBadges({ photo }: { photo: Photo }) {
  const retouch = photo.versions.some((version) => version.kind === 'retouch');
  const color = COLOR_CLASSES[photo.colorClass] ?? '';
  return (
    <>
      {color && <span className={styles.colorClass} style={{ background: color }} />}
      <span className={styles.topRight}>
        {photo.tagged && (
          <span className={`${styles.badge} ${styles.badgeTagged}`} title="Tagged">
            <TagIcon />
          </span>
        )}
      </span>
      <span className={styles.bottomLeft}>
        {retouch ? (
          <span
            className={`${styles.badge} ${styles.badgeEdit} ${styles.badgeStack}`}
            title="Retouch version"
          >
            <StackIcon />
            <PenIcon className={styles.stackPen} size={8} />
          </span>
        ) : (
          photo.status.edited && (
            <span className={`${styles.badge} ${styles.badgeEdit}`} title="Edited">
              <PenIcon />
            </span>
          )
        )}
        {photo.status.metadataDiffersFromTemplate && (
          <span
            className={`${styles.badge} ${styles.badgeMeta}`}
            title="Metadata differs from template"
          >
            <MetaDiffIcon />
          </span>
        )}
      </span>
      <span className={styles.bottomRight}>
        <UploadBadge state={photo.status.upload} />
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
          return (
            <button
              key={photo.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={`${photo.fileName} — ${photo.captureTime ?? 'no capture time'}`}
              className={`${styles.frame} ${selected ? styles.selected : ''}`}
              style={{
                width: ITEM_WIDTH,
                height: Math.round(ITEM_WIDTH * (2 / 3)),
                left: index * STEP,
              }}
              onClick={() => store.select(photo.id)}
            >
              <img src={appUrl.thumb(photo.id)} alt={photo.fileName} draggable={false} />
              <PhotoBadges photo={photo} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
