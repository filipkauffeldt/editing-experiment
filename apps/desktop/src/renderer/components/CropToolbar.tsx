import { CROP_ASPECTS, cropAspectRatio, type CropOverlayKind, type CropSession } from '../store';
import { useAppStore } from '../store-context';
import { CheckIcon, CropIcon, CrossIcon } from './icons';
import styles from './PhotoCanvas.module.css';

const OVERLAY_LABELS: Record<CropOverlayKind, string> = {
  thirds: 'Thirds',
  grid: 'Grid',
  golden: 'Golden',
  none: 'None',
};

const TOOL_HINTS: Record<CropSession['tool'], string> = {
  crop: 'Drag inside to move the photo, outside to rotate it, a handle to resize. Enter applies, Esc cancels.',
  draw: 'Drag on the photo to draw a new crop frame.',
  straighten: 'Drag a line along the horizon.',
};

/** Crop-mode controls: aspect presets, straighten angle and apply/cancel. */
export function CropToolbar({ session }: { session: CropSession }) {
  const store = useAppStore();
  const ratio = cropAspectRatio(session);
  const square = session.aspect === '1:1' || (ratio !== undefined && Math.abs(ratio - 1) < 1e-9);
  return (
    <div className={styles.cropToolbar} data-testid="crop-toolbar">
      <div className={styles.aspects}>
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
      <label className={styles.control}>
        <span>Angle {session.crop.angle.toFixed(1)}°</span>
        <input
          type="range"
          min={-45}
          max={45}
          step={0.1}
          value={session.crop.angle}
          aria-label="Straighten angle"
          title="Double-click to reset"
          onChange={(event) => store.setCropAngle(Number(event.target.value))}
          onDoubleClick={() => store.setCropAngle(0)}
        />
      </label>
      <div className={styles.actions}>
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
          className={styles.secondary}
          onClick={() => store.cycleCropOverlay()}
          data-testid="crop-overlay-kind"
          title="Cycle the overlay: thirds, grid, golden ratio, none (O)"
        >
          Overlay: {OVERLAY_LABELS[session.overlay]}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.swapCropOrientation()}
          disabled={square}
          title="Swap portrait / landscape (X)"
        >
          Swap
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => store.resetCrop()}
          title="Reset the crop (Ctrl/⌘+Alt+R)"
        >
          Reset
        </button>
        <button type="button" className={styles.secondary} onClick={() => store.cancelCrop()}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.commit}
          onClick={() => store.applyCrop()}
          data-testid="apply-crop"
        >
          <CheckIcon size={11} /> Apply
        </button>
      </div>
      <div className={styles.toolHint}>
        <CropIcon size={10} /> {TOOL_HINTS[session.tool]}
      </div>
      <button
        type="button"
        className={styles.secondary}
        onClick={() => store.cancelCrop()}
        aria-label="Cancel crop"
        title="Cancel (Esc)"
      >
        <CrossIcon size={11} />
      </button>
    </div>
  );
}
