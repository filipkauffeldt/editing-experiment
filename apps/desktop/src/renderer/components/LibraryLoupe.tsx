/* The picture hands over callback refs; the compiler rule takes the whole object for a ref. */
/* eslint-disable react-hooks/refs */
import type { Photo } from '@ee/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { ImagePreloader } from '../image-preloader';
import { LOUPE_ZOOM_KEY, neededUrl, neighbours } from '../loupe-view';
import { activePhoto, panelsAreHidden } from '../store';
import { useAppState } from '../store-context';
import { shootingInfoLine } from '../shooting-info';
import { FilmStrip } from './FilmStrip';
import styles from './LibraryLoupe.module.css';
import { LoupePictureImages, loupeStageClass, useLoupePicture } from './LoupePicture';

/** Neighbours fetched ahead: the next photo and the previous one. */
const PRELOAD_LIMIT = 2;

/**
 * E: one photo large, with the grid's photos as a strip beneath. Fit shows the cached preview.
 * Zooming (the keys and mouse of Develop) shows the camera's full-size JPEG, so 100% needs no raw
 * decode, and the zoom carries to the next photo so a burst is checked at the same spot.
 */
export function LibraryLoupe({ photos }: { photos: Photo[] }) {
  const state = useAppState();
  const photo = activePhoto(state);
  const picture = useLoupePicture(photo, LOUPE_ZOOM_KEY);
  const { zoomed, needed, ready } = picture;
  const shooting = photo ? shootingInfoLine(photo, { cameraBody: true }) : undefined;
  const panelsHidden = panelsAreHidden(state);

  // Fetch the neighbours' images ahead, at what they will need: the preview at Fit, the full-size
  // JPEG when zoomed. Only once the photo on screen has its own image, so it never waits for them,
  // and what is not wanted any more is dropped as soon as the selection moves on.
  const preloader = useRef<ImagePreloader | undefined>(undefined);
  useEffect(() => {
    preloader.current = new ImagePreloader(PRELOAD_LIMIT);
    const current = preloader.current;
    return () => current.clear();
  }, []);
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

  return (
    <div className={styles.loupe} data-testid="library-loupe">
      <div
        ref={picture.bindStage}
        className={loupeStageClass}
        data-testid="loupe-stage"
        {...picture.stageData}
      >
        {photo ? (
          <>
            <LoupePictureImages
              photo={photo}
              picture={picture}
              fullTestId="loupe-full"
              panTestId="loupe-pan-layer"
            />
            {shooting && !panelsHidden && (
              <div className={styles.shootingInfo} data-testid="loupe-shooting-info">
                {shooting}
              </div>
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
