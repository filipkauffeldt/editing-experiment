import type { ReactNode } from 'react';
import styles from './ActionBar.module.css';

/** The 40 px bottom bar: contextual actions on the right, summary and keyboard hints on the left. */
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

/** `[key] label` pairs for the bar's hints. */
export function Hints({ items }: { items: readonly [key: string, label: string][] }) {
  return (
    <span className={styles.hints}>
      {items.map(([key, label]) => (
        <span key={key} className={styles.hint}>
          <span className={styles.key}>{key}</span>
          {label}
        </span>
      ))}
    </span>
  );
}

export const barStyles = styles;
