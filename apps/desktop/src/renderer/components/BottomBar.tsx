import type { Photo } from '@ee/contracts';
import { useAppStore } from '../store-context';
import { FilmStrip } from './FilmStrip';
import { FiltersStrip } from './FiltersStrip';
import styles from './BottomBar.module.css';

interface BottomBarProps {
  className?: string;
  photos: Photo[];
}

/** Filters above the film strip, with "Finish & next" on the right. */
export function BottomBar({ className, photos }: BottomBarProps) {
  const store = useAppStore();
  return (
    <footer className={`${styles.bar} ${className ?? ''}`}>
      <div className={styles.strips}>
        <FiltersStrip visibleCount={photos.length} />
        <FilmStrip photos={photos} />
      </div>
      <div className={styles.finishWrap}>
        <button className={styles.finish} type="button" onClick={() => void store.finishAndNext()}>
          Finish &amp; next
        </button>
        <span className={styles.hint}>Ctrl/⌘ + Enter</span>
      </div>
    </footer>
  );
}
