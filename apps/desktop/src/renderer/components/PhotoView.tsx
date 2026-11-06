import type { Photo } from '@ee/contracts';
import { CROP_HINT, retouchHint } from '../focus-hint';
import { topRetouchVersion } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { FIT_VIEW, ZOOM_LEVELS, zoomPercent } from '../view-transform';
import { setBeforeAfter, toggleBefore, useDevelopViewMode } from '../develop-view';
import { useZoomState, zoomCommands, zoomKey } from '../zoom-view';
import { PhotoCanvas } from './PhotoCanvas';
import { CropIcon, PenIcon, StackIcon, TrashIcon } from './icons';
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

/** Everything the footer knows about the photo, for the tooltip of the one info line. */
function infoDetails(photo: Photo): string {
  return [
    photo.fileName,
    photo.width && photo.height ? `${photo.width} × ${photo.height}` : undefined,
    photo.camera?.model,
    photo.captureTime?.replace('T', ' '),
    photo.camera?.lens,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n');
}

/** Centre view: preview canvas plus one footer line: the photo's details, its tools and the zoom. */
export function PhotoView({ className, photo }: PhotoViewProps) {
  const store = useAppStore();
  const state = useAppState();
  const mode = useDevelopViewMode();
  const retouch =
    photo !== undefined && state.retouch?.photoId === photo.id ? state.retouch : undefined;
  const cropping = photo !== undefined && state.crop?.photoId === photo.id;
  const retouching = retouch !== undefined;
  // Retouch and Crop end with Done, Esc or the Develop tab, so the footer offers no second way out.
  const editing = retouching || cropping;
  const hint = retouch ? retouchHint(retouch.tool, retouch.mode) : cropping ? CROP_HINT : undefined;
  const hasRetouch = photo !== undefined && topRetouchVersion(photo) !== undefined;
  return (
    <main
      className={`${styles.view} ${editing ? styles.editing : ''} ${className ?? ''}`}
      data-testid="photo-view"
    >
      <div className={styles.canvasArea}>
        <PhotoCanvas photo={photo} />
      </div>
      <footer className={styles.footer}>
        {photo ? (
          <>
            {/*
              One line, in the order that gives way last to first: the items that do not fit wrap
              out of the clipped row whole, so nothing is ever half cut. The lens goes first.
            */}
            <span
              className={`${styles.info} ${hint ? '' : styles.infoFill}`}
              title={infoDetails(photo)}
              data-testid="photo-info"
            >
              <span className={styles.fileName}>{photo.fileName}</span>
              <span className={styles.size}>
                {photo.width && photo.height ? `${photo.width} × ${photo.height}` : '—'}
              </span>
              {!editing && (
                <>
                  {photo.camera?.model && <span>{photo.camera.model}</span>}
                  {photo.captureTime && <span>{photo.captureTime.replace('T', ' ')}</span>}
                  {photo.camera?.lens && <span>{photo.camera.lens}</span>}
                </>
              )}
            </span>
            {hint && (
              <span className={styles.hint} title={hint} data-testid="focus-hint">
                {hint}
              </span>
            )}
            <span className={styles.controls}>
              {!editing && (
                <span className={styles.tools}>
                  <button
                    type="button"
                    className={styles.tool}
                    onClick={() => store.toggleCrop()}
                    title="Crop and straighten (C)"
                    data-testid="toggle-crop"
                    disabled={!photo.width || !photo.height}
                  >
                    <CropIcon size={11} /> Crop
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    onClick={() => store.toggleRetouch()}
                    title="Retouch mode (R)"
                    data-testid="toggle-retouch"
                  >
                    {hasRetouch ? <StackIcon size={11} /> : <PenIcon size={11} />}
                    Retouch
                  </button>
                  <button
                    type="button"
                    className={`${styles.tool} ${mode.beforeAfter === 'before' ? styles.toolActive : ''}`}
                    aria-pressed={mode.beforeAfter === 'before'}
                    onClick={(event) => {
                      toggleBefore();
                      // A focused button would take the Space that pans.
                      event.currentTarget.blur();
                    }}
                    title="Show the unedited photo (Y)"
                    data-testid="before-after"
                  >
                    Before
                  </button>
                  <button
                    type="button"
                    className={`${styles.tool} ${mode.beforeAfter === 'split' ? styles.toolActive : ''}`}
                    aria-pressed={mode.beforeAfter === 'split'}
                    onClick={(event) => {
                      setBeforeAfter(mode.beforeAfter === 'split' ? 'off' : 'split');
                      event.currentTarget.blur();
                    }}
                    title="Split view: drag the divider"
                    data-testid="split-view"
                  >
                    Split
                  </button>
                  {hasRetouch && (
                    <button
                      type="button"
                      className={`${styles.tool} ${styles.toolIcon}`}
                      onClick={() => void store.deleteRetouch()}
                      title="Remove the retouch version of this photo"
                      aria-label="Delete retouch…"
                      data-testid="delete-retouch"
                    >
                      <TrashIcon size={11} />
                    </button>
                  )}
                </span>
              )}
              <ZoomLevels
                photo={photo}
                mode={cropping ? 'crop' : retouching ? 'retouch' : 'develop'}
              />
            </span>
          </>
        ) : (
          <span className={styles.detail}>No photo selected</span>
        )}
      </footer>
    </main>
  );
}
