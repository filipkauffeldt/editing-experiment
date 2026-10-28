import { CROP_ASPECTS, cropAspectRatio, type CropSession } from '../store';
import { useAppStore } from '../store-context';
import { CheckIcon, CropIcon, CrossIcon } from './icons';
import styles from './PhotoCanvas.module.css';

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
          onChange={(event) => store.setCropAngle(Number(event.target.value))}
        />
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.tool} ${session.tool === 'straighten' ? styles.toolActive : ''}`}
          onClick={() => store.setCropTool(session.tool === 'straighten' ? 'crop' : 'straighten')}
          data-tool="straighten"
          title="Draw a line along the horizon"
        >
          Straighten
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
        <button type="button" className={styles.secondary} onClick={() => store.resetCrop()}>
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
        <CropIcon size={10} /> Drag a handle to crop; draw a line to straighten. Esc cancels.
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
