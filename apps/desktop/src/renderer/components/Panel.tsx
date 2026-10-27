import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  title: string;
  className?: string;
  children: ReactNode;
}

/** Titled container shared by the side panels. */
export function Panel({ title, className, children }: PanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ''}`}>
      <header className={styles.header}>{title}</header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
