import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  title: string;
  className?: string;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}

/** Titled container shared by the side panels. */
export function Panel({ title, className, actions, testId, children }: PanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ''}`} data-testid={testId}>
      <header className={styles.header}>
        <span>{title}</span>
        {actions}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
