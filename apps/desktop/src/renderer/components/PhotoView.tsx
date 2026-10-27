import { appUrl, type Photo } from '@ee/contracts';
import styles from './PhotoView.module.css';

interface PhotoViewProps {
  className?: string;
  photo: Photo | undefined;
}

/** Center view. Shows the cached preview for now; the WebGL develop canvas replaces the `<img>`. */
export function PhotoView({ className, photo }: PhotoViewProps) {
  return (
    <main className={`${styles.view} ${className ?? ''}`} data-testid="photo-view">
      {photo ? (
        <img className={styles.image} src={appUrl.preview(photo.id)} alt={photo.fileName} />
      ) : (
        <span className={styles.empty}>No photos yet. Start an ingest to fill the film strip.</span>
      )}
    </main>
  );
}
