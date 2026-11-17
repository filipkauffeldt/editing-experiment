import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Menu.module.css';

/** The space between the button and its list, as in the stylesheet. */
const POPOVER_GAP = 8;

/**
 * A text button that opens a hairline popover of items. Closes on an outside press, on Escape
 * (which goes no further, so it never also clears a selection) and after a pick when
 * `closeOnPick` is set. It opens downwards, and upwards when the list would run past the bottom
 * of the window and there is more room above (the filter bar sits above the film strip in
 * Develop).
 */
export function Menu({
  label,
  badge,
  active,
  closeOnPick,
  align = 'left',
  compact,
  fill,
  ariaLabel,
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
  /** The popover is as wide as its items, for a short list in a narrow panel. */
  compact?: boolean;
  /** Fills the room its parent gives it, like a select: the popover is as wide as the button. */
  fill?: boolean;
  /** Names the button when its label is only a caret. */
  ariaLabel?: string;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  // Measured after every render while open, so a list that grows (a new saved filter) is
  // placed again. The list's own height does not depend on which side it opens on.
  useLayoutEffect(() => {
    if (!open || !root.current || !popover.current) return;
    const place = (): void => {
      if (!root.current || !popover.current) return;
      const box = root.current.getBoundingClientRect();
      const height = popover.current.offsetHeight;
      const below = window.innerHeight - box.bottom - POPOVER_GAP;
      const above = box.top - POPOVER_GAP;
      setUp(height > below && above > below);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });

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
      className={`${styles.root} ${fill ? styles.fill : ''}`}
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
        aria-label={ariaLabel}
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
          ref={popover}
          role="menu"
          data-placement={up ? 'up' : 'down'}
          className={`${styles.popover} ${up ? styles.up : ''} ${align === 'right' ? styles.right : ''} ${compact ? styles.compact : ''}`}
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

/**
 * One entry: a check (several can be on) or a radio (one per group), with an optional count; or an
 * `action`, which does something when chosen and has no state or mark.
 */
export function MenuItem({
  kind,
  checked = false,
  count,
  onSelect,
  children,
}: {
  kind: 'check' | 'radio' | 'action';
  checked?: boolean;
  count?: number;
  onSelect: () => void;
  children: ReactNode;
}) {
  if (kind === 'action') {
    return (
      <button type="button" role="menuitem" className={styles.item} onClick={onSelect}>
        <span className={styles.itemLabel}>{children}</span>
      </button>
    );
  }
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
