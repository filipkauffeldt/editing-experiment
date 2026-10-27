import { appUrl, type Photo } from '@ee/contracts';
import styles from './BottomBar.module.css';

const FILTERS = ['All', 'Edited', 'Not uploaded', 'Metadata differs'] as const;

interface BottomBarProps {
  className?: string;
  photos: Photo[];
  selectedId: string | undefined;
  onSelect(photoId: Photo['id']): void;
  onFinish(): void;
}

/** Filters strip above the film strip, with the "Finish & next" action on the right. */
export function BottomBar({ className, photos, selectedId, onSelect, onFinish }: BottomBarProps) {
  return (
    <footer className={`${styles.bar} ${className ?? ''}`}>
      <div className={styles.strips}>
        <div className={styles.filters} data-testid="filters">
          {FILTERS.map((label, index) => (
            <button
              key={label}
              className={`${styles.filter} ${index === 0 ? styles.filterActive : ''}`}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.film} data-testid="film-strip">
          {photos.map((photo) => (
            <button
              key={photo.id}
              type="button"
              title={photo.fileName}
              className={`${styles.thumb} ${photo.id === selectedId ? styles.thumbSelected : ''}`}
              onClick={() => onSelect(photo.id)}
            >
              <img src={appUrl.thumb(photo.id)} alt={photo.fileName} />
              <span className={styles.badges}>
                {photo.status.edited && (
                  <i className={styles.badge} style={{ background: 'var(--accent)' }} />
                )}
                {photo.status.upload === 'done' && (
                  <i className={styles.badge} style={{ background: 'var(--ok)' }} />
                )}
                {photo.status.metadataDiffersFromTemplate && (
                  <i className={styles.badge} style={{ background: 'var(--warn)' }} />
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
      <button className={styles.finish} type="button" onClick={onFinish}>
        Finish &amp; next
      </button>
    </footer>
  );
}
