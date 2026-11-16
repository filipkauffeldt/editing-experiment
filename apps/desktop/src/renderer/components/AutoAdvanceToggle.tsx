import { useAppState, useAppStore } from '../store-context';
import styles from './AutoAdvanceToggle.module.css';

/**
 * Tagging, rating or colouring one photo in the loupe or in Develop moves to the next photo.
 * One setting for both, so it sits in the filter row's view slot of both.
 */
export function AutoAdvanceToggle() {
  const store = useAppStore();
  const on = useAppState().settings?.autoAdvance === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`${styles.toggle} ${on ? styles.on : ''}`}
      title="Move to the next photo after tagging, rating or setting a colour on a single photo"
      data-testid="auto-advance"
      onClick={(event) => {
        store.setAutoAdvance(!on);
        // A focused button would take the Space that pans.
        event.currentTarget.blur();
      }}
    >
      <span className={styles.box} aria-hidden="true" />
      Auto-advance
    </button>
  );
}
