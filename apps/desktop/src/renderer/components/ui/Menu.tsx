import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './Menu.module.css';

/**
 * A text button that opens a hairline popover of items. Closes on an outside press, on Escape
 * (which goes no further, so it never also clears a selection) and after a pick when
 * `closeOnPick` is set.
 */
export function Menu({
  label,
  badge,
  active,
  closeOnPick,
  align = 'left',
  testId,
  children,
}: {
  label: ReactNode;
  /** A short summary after the label, e.g. how many entries are ticked. */
  badge?: ReactNode;
  /** The menu holds something that changes the list (drawn like the active tab). */
  active?: boolean;
  closeOnPick?: boolean;
  align?: 'left' | 'right';
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div
      className={styles.root}
      ref={root}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className={`${styles.button} ${active ? styles.active : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        {badge !== undefined && <span className={`${styles.badge} mono`}>{badge}</span>}
        <span className={styles.caret} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          className={`${styles.popover} ${align === 'right' ? styles.right : ''}`}
          onClick={(event) => {
            if (closeOnPick && (event.target as HTMLElement).closest('[role^="menuitem"]'))
              setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className={styles.heading} role="presentation">
      {children}
    </div>
  );
}

/** One entry: a check (several can be on) or a radio (one per group), with an optional count. */
export function MenuItem({
  kind,
  checked,
  count,
  onSelect,
  children,
}: {
  kind: 'check' | 'radio';
  checked: boolean;
  count?: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={kind === 'check' ? 'menuitemcheckbox' : 'menuitemradio'}
      aria-checked={checked}
      className={`${styles.item} ${checked ? styles.checked : ''}`}
      onClick={onSelect}
    >
      <span
        className={`${styles.mark} ${kind === 'radio' ? styles.round : ''}`}
        aria-hidden="true"
      />
      <span className={styles.itemLabel}>{children}</span>
      {count !== undefined && <span className={`${styles.itemCount} mono`}>{count}</span>}
    </button>
  );
}
