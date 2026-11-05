import type { ReactNode } from 'react';
import styles from './ActionBar.module.css';

/** The 40 px bottom bar: contextual actions on the right, a summary on the left. */
export function ActionBar({
  left,
  right,
  testId,
}: {
  left?: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <footer className={styles.bar} data-testid={testId}>
      <div className={styles.left}>{left}</div>
      <div className={styles.right}>{right}</div>
    </footer>
  );
}

export const barStyles = styles;
