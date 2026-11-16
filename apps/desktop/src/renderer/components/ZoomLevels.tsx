import { FIT_VIEW, ZOOM_LEVELS, zoomPercent } from '../view-transform';
import { useZoomState, zoomCommands } from '../zoom-view';
import styles from './ZoomLevels.module.css';

/**
 * Fit and the zoom levels. A level zooms to it and is what `Z` zooms to; `Z` on a zoomed photo
 * goes back to Fit. A zoom between the levels (the wheel, Ctrl/Cmd + and -) shows its percentage.
 */
export function ZoomLevels({ viewKey }: { viewKey: string }) {
  const state = useZoomState();
  const view = state.key === viewKey ? state.view : FIT_VIEW;
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
