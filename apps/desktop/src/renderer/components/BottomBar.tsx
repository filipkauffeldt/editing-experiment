import type { Photo } from '@ee/contracts';
import { useAppStore } from '../store-context';
import { FilmStrip } from './FilmStrip';
import { FiltersStrip } from './FiltersStrip';
import styles from './BottomBar.module.css';

interface BottomBarProps {
  className?: string;
  photos: Photo[];
}

/** Filters above the film strip, with the export actions on the right. */
export function BottomBar({ className, photos }: BottomBarProps) {
  const store = useAppStore();
  return (
    <footer className={`${styles.bar} ${className ?? ''}`}>
      <div className={styles.strips}>
        <FiltersStrip visibleCount={photos.length} />
        <FilmStrip photos={photos} />
      </div>
      <div className={styles.finishWrap}>
        <button
          className={styles.secondary}
          type="button"
          onClick={() => store.openExportDialog()}
          data-testid="open-export"
        >
          Export…
        </button>
        <button
          className={styles.finish}
          type="button"
          onClick={() => void store.nextAndSend()}
          data-testid="next-send"
        >
          Next &amp; send
        </button>
        <span className={styles.hint}>⇧⌘↵ send · ⌘↵ next</span>
      </div>
    </footer>
  );
}
