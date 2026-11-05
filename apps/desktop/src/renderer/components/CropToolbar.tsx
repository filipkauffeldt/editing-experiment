import { MAX_CROP_ANGLE } from '@ee/develop-gl';
import { CROP_ASPECTS, cropAspectRatio, type CropOverlayKind, type CropSession } from '../store';
import { useAppStore } from '../store-context';
import { CheckIcon } from './icons';
import { NumberField } from './ui/NumberField';
import styles from './PhotoCanvas.module.css';

const OVERLAY_LABELS: Record<CropOverlayKind, string> = {
  thirds: 'Thirds',
  grid: 'Grid',
  golden: 'Golden',
  none: 'None',
};

/**
 * Crop-mode controls in one row, in the same order as Retouch: aspect ratios, angle, the tools,
 * then Reset, Cancel and Done at the right.
 */
export function CropToolbar({ session }: { session: CropSession }) {
  const store = useAppStore();
  const ratio = cropAspectRatio(session);
  const square = session.aspect === '1:1' || (ratio !== undefined && Math.abs(ratio - 1) < 1e-9);
  return (
    <div className={styles.toolbar} data-testid="crop-toolbar">
      <div className={styles.aspects} role="group" aria-label="Aspect ratio">
        {CROP_ASPECTS.map((aspect) => (
          <button
            key={aspect.id}
            type="button"
            className={`${styles.tool} ${session.aspect === aspect.id ? styles.toolActive : ''}`}
            onClick={() => store.setCropAspect(aspect.id)}
            data-aspect={aspect.id}
          >
            {aspect.label}
          </button>
        ))}
      </div>
      <div className={styles.control}>
        <span>Angle</span>
        <NumberField
          label="Angle in degrees"
          value={session.crop.angle}
          min={-MAX_CROP_ANGLE}
          max={MAX_CROP_ANGLE}
          step={0.1}
          formatValue={(angle) => angle.toFixed(1)}
          suffix="°"
          inputMode="decimal"
          onCommit={(angle) => store.setCropAngle(angle)}
        />
        <input
          type="range"
          min={-MAX_CROP_ANGLE}
          max={MAX_CROP_ANGLE}
          step={0.1}
          value={session.crop.angle}
          aria-label="Straighten angle"
          title="Double-click to reset"
          onChange={(event) => store.setCropAngle(Number(event.target.value))}
          onDoubleClick={() => store.setCropAngle(0)}
        />
      </div>
      <div className={styles.tools}>
        <button
          type="button"
          className={`${styles.tool} ${session.tool === 'draw' ? styles.toolActive : ''}`}
          onClick={() => store.toggleCropTool('draw')}
          data-tool="draw"
          aria-pressed={session.tool === 'draw'}
          title="Crop frame tool: drag out a new frame (R)"
        >
          Frame
        </button>
        <button
          type="button"
          className={`${styles.tool} ${session.tool === 'straighten' ? styles.toolActive : ''}`}
          onClick={() => store.toggleCropTool('straighten')}
          data-tool="straighten"
          aria-pressed={session.tool === 'straighten'}
          title="Straighten: draw a line along the horizon (A)"
        >
          Straighten
        </button>
        <button
          type="button"
          className={styles.tool}
          onClick={() => store.cycleCropOverlay()}
          data-testid="crop-overlay-kind"
          title="Cycle the overlay: thirds, grid, golden ratio, none (O)"
        >
          Overlay: {OVERLAY_LABELS[session.overlay]}
        </button>
        <button
          type="button"
          className={styles.tool}
          onClick={() => store.swapCropOrientation()}
          disabled={square}
          title="Swap portrait / landscape (X)"
        >
          Swap
        </button>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.resetCrop()}
          title="Reset the crop (Ctrl/⌘+Alt+R)"
        >
          Reset
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.cancelCrop()}
          title="Leave crop mode without applying (Esc)"
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.commit}
          onClick={() => store.applyCrop()}
          title="Apply the crop and leave crop mode (Enter)"
          data-testid="apply-crop"
        >
          <CheckIcon size={11} /> Done
        </button>
      </div>
    </div>
  );
}
