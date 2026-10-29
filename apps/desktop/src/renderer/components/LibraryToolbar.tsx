import { LIBRARY_QUICK } from '../library';
import { useAppState, useAppStore } from '../store-context';
import { COLOR_CLASSES, COLOR_CLASS_NAMES } from './PhotoOverlays';
import { Slider } from './ui/Slider';
import { THUMB_SIZE_RANGE } from '../library';
import styles from './LibraryToolbar.module.css';

/** Filters (All, Tagged, Untagged, Not sent, colour class), sort and thumbnail size. */
export function LibraryToolbar({ count, total }: { count: number; total: number }) {
  const store = useAppStore();
  const state = useAppState();
  const { library } = state;
  return (
    <div className={styles.bar} data-testid="library-toolbar">
      <div className={styles.group} role="group" aria-label="Filter">
        {LIBRARY_QUICK.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`${styles.tab} ${library.quick === filter.id ? styles.tabActive : ''}`}
            aria-pressed={library.quick === filter.id}
            onClick={() => store.setLibraryQuick(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className={styles.group} role="group" aria-label="Colour class">
        {COLOR_CLASSES.slice(1).map((color, index) => {
          const colorClass = index + 1;
          const active = library.colorClass === colorClass;
          return (
            <button
              key={colorClass}
              type="button"
              className={`${styles.classButton} ${active ? styles.classActive : ''}`}
              aria-pressed={active}
              aria-label={`Class ${colorClass}`}
              title={`Class ${colorClass} · ${COLOR_CLASS_NAMES[colorClass]}`}
              onClick={() => store.setLibraryColorFilter(active ? undefined : colorClass)}
            >
              <span className={styles.dot} style={{ background: color }} />
            </button>
          );
        })}
      </div>

      <span className={styles.spacer} />

      <span className={`${styles.count} mono`}>
        {count === total ? total : `${count} of ${total}`}
      </span>

      <div className={styles.group} role="group" aria-label="Sort order">
        <span className={styles.label}>Sort</span>
        <button
          type="button"
          className={`${styles.tab} ${state.sort === 'filename' ? styles.tabActive : ''}`}
          onClick={() => store.setSort('filename')}
        >
          Name
        </button>
        <button
          type="button"
          className={`${styles.tab} ${state.sort === 'capture-time' ? styles.tabActive : ''}`}
          onClick={() => store.setSort('capture-time')}
        >
          Time
        </button>
      </div>

      <div className={styles.size}>
        <Slider
          label="Size"
          value={library.thumbSize}
          min={THUMB_SIZE_RANGE.min}
          max={THUMB_SIZE_RANGE.max}
          step={4}
          neutral={THUMB_SIZE_RANGE.min}
          display={library.thumbSize}
          onRange={(value) => store.setThumbSize(value)}
          onNumber={(value) => store.setThumbSize(value ?? THUMB_SIZE_RANGE.default)}
          onReset={() => store.setThumbSize(THUMB_SIZE_RANGE.default)}
        />
      </div>
    </div>
  );
}
