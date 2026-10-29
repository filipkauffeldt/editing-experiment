import { useState, type ReactNode } from 'react';
import styles from './PanelSection.module.css';

interface PanelSectionProps {
  title: string;
  /** Present: draws the square on/off switch. Absent: the section has no switch. */
  enabled?: boolean;
  onEnabledChange?(enabled: boolean): void;
  /** Extra header controls, right of the title. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** No body padding, for lists that draw their own rows. */
  flush?: boolean;
  testId?: string;
  children: ReactNode;
}

/** Collapsible section with a dim uppercase title and an optional square on/off switch. */
export function PanelSection({
  title,
  enabled,
  onEnabledChange,
  actions,
  defaultOpen = true,
  flush,
  testId,
  children,
}: PanelSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const classes = [
    styles.section,
    open ? styles.open : '',
    enabled === false ? styles.disabled : '',
    flush ? styles.flush : '',
  ];
  return (
    <section className={classes.filter(Boolean).join(' ')} data-testid={testId}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.title}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.caret} aria-hidden />
          {title}
        </button>
        {actions && <span className={styles.actions}>{actions}</span>}
        {enabled !== undefined && (
          <button
            type="button"
            role="switch"
            className={styles.switch}
            aria-checked={enabled}
            aria-label={`${title} on or off`}
            title={enabled ? `Switch ${title} off` : `Switch ${title} on`}
            onClick={() => onEnabledChange?.(!enabled)}
          />
        )}
      </header>
      {open && <div className={styles.body}>{children}</div>}
    </section>
  );
}
