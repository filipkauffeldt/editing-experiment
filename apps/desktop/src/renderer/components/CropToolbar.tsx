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

/** Crop-mode controls: aspect presets, straighten angle and apply/cancel. */
export function CropToolbar({ session }: { session: CropSession }) {
  const store = useAppStore();
  const ratio = cropAspectRatio(session);
  const square = session.aspect === '1:1' || (ratio !== undefined && Math.abs(ratio - 1) < 1e-9);
  return (
    <>
      <div className={styles.cropToolbar} data-testid="crop-toolbar">
        <div className={styles.cropRow}>
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
        </div>
        <div className={styles.cropRow}>
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
        </div>
      </div>
    </>
  );
}
