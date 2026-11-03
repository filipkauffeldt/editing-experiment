import type { Photo } from '@ee/contracts';
import { useAppState, useAppStore } from '../store-context';
import { FIT_VIEW, ZOOM_LEVELS, zoomPercent } from '../view-transform';
import { useZoomState, zoomCommands, zoomKey } from '../zoom-view';
import { PhotoCanvas } from './PhotoCanvas';
import { CropIcon, PenIcon, StackIcon } from './icons';
import styles from './PhotoView.module.css';

interface PhotoViewProps {
  className?: string;
  photo: Photo | undefined;
}

/**
 * Fit and the zoom levels. A level zooms to it and is what `Z` zooms to; `Z` on a zoomed photo
 * goes back to Fit. A zoom between the levels (the wheel, Ctrl/Cmd + and -) shows its percentage.
 */
function ZoomLevels({ photo, mode }: { photo: Photo; mode: 'develop' | 'crop' | 'retouch' }) {
  const state = useZoomState();
  const view = state.key === zoomKey(photo.id, mode) ? state.view : FIT_VIEW;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const percent = view.scale === null ? undefined : zoomPercent(view.scale, dpr);
  const matches = (level: number): boolean =>
    percent !== undefined && Math.abs(percent - level * 100) < 0.5;
  const between = percent !== undefined && !ZOOM_LEVELS.some(matches);
  const choose = (event: React.MouseEvent<HTMLButtonElement>, level: number | 'fit'): void => {
    zoomCommands.setLevel(level);
    // A focused button would take the Space that pans.
    event.currentTarget.blur();
  };
  return (
    <span className={styles.zoomLevels} role="group" aria-label="Zoom" data-testid="zoom-levels">
      <button
        type="button"
        className={`${styles.zoomLevel} ${percent === undefined ? styles.zoomLevelActive : ''}`}
        aria-pressed={percent === undefined}
        title={`Fit the photo (Z toggles Fit and ${Math.round(state.level * 100)}%)`}
        onClick={(event) => choose(event, 'fit')}
      >
        Fit
      </button>
      {ZOOM_LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          className={`${styles.zoomLevel} ${matches(level) ? styles.zoomLevelActive : ''}`}
          aria-pressed={matches(level)}
          title={
            level === 1
              ? 'Zoom to 100%, one image pixel per screen pixel (Z)'
              : `Zoom to ${Math.round(level * 100)}% (Z)`
          }
          onClick={(event) => choose(event, level)}
        >
          {Math.round(level * 100)}%
        </button>
      ))}
      {between && percent !== undefined && (
        <span
          className={`${styles.zoomLevel} ${styles.zoomLevelActive}`}
          data-testid="zoom-percent"
        >
          {Math.round(percent)}%
        </span>
      )}
    </span>
  );
}

/** Centre view: preview canvas plus a compact file strip beneath it. */
export function PhotoView({ className, photo }: PhotoViewProps) {
  const store = useAppStore();
  const state = useAppState();
  const retouching = photo !== undefined && state.retouch?.photoId === photo.id;
  const cropping = photo !== undefined && state.crop?.photoId === photo.id;
  return (
    <main className={`${styles.view} ${className ?? ''}`} data-testid="photo-view">
      <div className={styles.canvasArea}>
        <PhotoCanvas photo={photo} />
      </div>
      <footer className={styles.footer}>
        {photo ? (
          <>
            <span className={styles.fileName}>{photo.fileName}</span>
            <span className={styles.spacer} />
            <span className={styles.detail}>
              {photo.width && photo.height ? `${photo.width} × ${photo.height}` : '—'}
            </span>
            <span className={styles.detail}>{photo.camera?.lens ?? photo.camera?.model ?? ''}</span>
            <span className={styles.detail}>{photo.captureTime?.replace('T', ' ') ?? ''}</span>
            <button
              type="button"
              className={`${styles.retouch} ${cropping ? styles.retouchActive : ''}`}
              onClick={() => store.toggleCrop()}
              title="Crop and straighten (C)"
              data-testid="toggle-crop"
              disabled={retouching || !photo.width || !photo.height}
            >
              <CropIcon size={11} /> {cropping ? 'Apply crop' : 'Crop'}
            </button>
            <button
              type="button"
              className={`${styles.retouch} ${retouching ? styles.retouchActive : ''}`}
              onClick={() => store.toggleRetouch()}
              title={retouching ? 'Leave retouch mode (R or Esc)' : 'Retouch mode (R)'}
              data-testid="toggle-retouch"
              disabled={cropping}
            >
              {photo.versions.some((version) => version.kind === 'retouch') ? (
                <StackIcon size={11} />
              ) : (
                <PenIcon size={11} />
              )}
              {retouching ? 'Exit retouch' : 'Retouch'}
            </button>
            <ZoomLevels
              photo={photo}
              mode={cropping ? 'crop' : retouching ? 'retouch' : 'develop'}
            />
          </>
        ) : (
          <span className={styles.detail}>No photo selected</span>
        )}
      </footer>
    </main>
  );
}
