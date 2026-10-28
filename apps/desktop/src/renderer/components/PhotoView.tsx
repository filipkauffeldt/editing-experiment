import type { Photo } from '@ee/contracts';
import { useAppState, useAppStore } from '../store-context';
import { PhotoCanvas } from './PhotoCanvas';
import { CropIcon, PenIcon, StackIcon } from './icons';
import styles from './PhotoView.module.css';

interface PhotoViewProps {
  className?: string;
  photo: Photo | undefined;
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
              disabled={retouching}
            >
              <CropIcon size={11} /> {cropping ? 'Apply crop' : 'Crop'}
            </button>
            <button
              type="button"
              className={`${styles.retouch} ${retouching ? styles.retouchActive : ''}`}
              onClick={() => store.toggleRetouch()}
              title="Retouch mode (R)"
              data-testid="toggle-retouch"
              disabled={cropping}
            >
              {photo.versions.some((version) => version.kind === 'retouch') ? (
                <StackIcon size={11} />
              ) : (
                <PenIcon size={11} />
              )}
              {retouching ? 'Exit' : 'Retouch'}
            </button>
            <span className={styles.zoom}>{retouching ? 'Retouch' : 'Fit'}</span>
          </>
        ) : (
          <span className={styles.detail}>No photo selected</span>
        )}
      </footer>
    </main>
  );
}
