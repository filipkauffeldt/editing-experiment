/* The picture hands over callback refs; the compiler rule takes the whole object for a ref. */
/* eslint-disable react-hooks/refs */
import type { Photo, PhotoId } from '@ee/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { COMPARE_ZOOM_KEY } from '../compare-view';
import { ImagePreloader } from '../image-preloader';
import { neededUrl } from '../loupe-view';
import { useAppState, useAppStore } from '../store-context';
import { LoupePictureImages, loupeStageClass, useLoupePicture } from './LoupePicture';
import { ColorDot, RatingStars, TagSquare } from './PhotoOverlays';
import styles from './CompareView.module.css';

/**
 * One photo in the compare view. It draws like the loupe (`useLoupePicture`) and shares the one
 * zoom of the view, so every pane shows the same part of its photo.
 */
function ComparePane({ photo, active }: { photo: Photo; active: boolean }) {
  const store = useAppStore();
  const picture = useLoupePicture(photo, COMPARE_ZOOM_KEY);
  const { zoomed, ready } = picture;

  // As the loupe fetches ahead what the next step needs, a pane at Fit with its preview on screen
  // fetches the full-size JPEG that zooming shows, so a zoom does not wait for it.
  const preloader = useRef<ImagePreloader | undefined>(undefined);
  useEffect(() => {
    preloader.current = new ImagePreloader(1);
    const current = preloader.current;
    return () => current.clear();
  }, []);
  const zoomUrl = neededUrl(photo, true);
  useEffect(() => {
    if (!ready || zoomed) preloader.current?.clear();
    else preloader.current?.want([zoomUrl]);
  }, [ready, zoomed, zoomUrl]);

  return (
    <div
      className={`${styles.pane} ${active ? styles.active : ''}`}
      data-testid="compare-pane"
      data-photo-id={photo.id}
      data-active={active ? 'true' : 'false'}
      onPointerDown={() => store.setCompareActive(photo.id)}
    >
      <div
        ref={picture.bindStage}
        className={`${loupeStageClass} ${styles.stage}`}
        data-testid="compare-stage"
        {...picture.stageData}
      >
        <LoupePictureImages
          photo={photo}
          picture={picture}
          fullTestId="compare-full"
          panTestId="compare-pan-layer"
        />
      </div>
      <div className={styles.info}>
        <span className={`${styles.name} mono`}>{photo.fileName}</span>
        <span className={styles.flags} data-testid="compare-flags">
          <TagSquare tagged={photo.tagged} />
          <RatingStars rating={photo.rating} />
          <ColorDot colorClass={photo.colorClass} />
        </span>
      </div>
    </div>
  );
}

/**
 * V: two to four selected photos side by side, one zoom and pan for all of them, to pick the
 * sharpest frame of a burst. The active pane takes the label keys.
 */
export function CompareView() {
  const store = useAppStore();
  const { photos, library } = useAppState();
  const { compare } = library;
  const byId = useMemo(() => new Map(photos.map((photo) => [photo.id, photo] as const)), [photos]);
  const panes = (compare?.ids ?? [])
    .map((id: PhotoId) => byId.get(id))
    .filter((photo): photo is Photo => photo !== undefined);
  const enough = panes.length >= 2;

  // The store drops a removed photo from the view; a photo that is not loaded closes it here.
  useEffect(() => {
    if (!enough) store.closeCompare();
  }, [enough, store]);

  if (!compare || !enough) return null;
  return (
    <div className={styles.compare} data-testid="compare-view" data-count={panes.length}>
      {panes.map((photo) => (
        <ComparePane key={photo.id} photo={photo} active={photo.id === compare.activeId} />
      ))}
    </div>
  );
}
