import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  /** Absent: no header row. The tab above a side panel already names it. */
  title?: string;
  className?: string;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}

/** Titled container shared by the side panels. */
export function Panel({ title, className, actions, testId, children }: PanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ''}`} data-testid={testId}>
      {(title !== undefined || actions) && (
        <header className={styles.header}>
          <span>{title}</span>
          {actions}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
