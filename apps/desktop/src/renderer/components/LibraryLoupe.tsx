import { appUrl, type Photo } from '@ee/contracts';
import { activePhoto } from '../store';
import { useAppState } from '../store-context';
import { FilmStrip } from './FilmStrip';
import styles from './LibraryLoupe.module.css';

/** E: one photo large, with the grid's photos as a strip beneath. */
export function LibraryLoupe({ photos }: { photos: Photo[] }) {
  const state = useAppState();
  const photo = activePhoto(state);
  return (
    <div className={styles.loupe} data-testid="library-loupe">
      <div className={styles.stage}>
        {photo ? (
          <img
            src={appUrl.preview(photo.id, photo.previewRevision)}
            alt={photo.fileName}
            draggable={false}
          />
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
