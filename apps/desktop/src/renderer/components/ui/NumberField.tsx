import { useRef, useState } from 'react';
import { clampNumber, parseNumberDraft } from '../../number-draft';
import styles from './NumberField.module.css';

export interface NumberFieldProps {
  /** Accessible name of the field; the visible label sits next to it in the toolbar. */
  label: string;
  /** The committed value, in the unit the field shows. */
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as the field shows it when it is not being edited. */
  formatValue(value: number): string;
  /** Unit after the field (`px`, `%`, `°`). */
  suffix?: string;
  inputMode?: 'numeric' | 'decimal';
  disabled?: boolean;
  tabIndex?: number;
  /** Called with a parsed, rounded and clamped value on Enter or blur. */
  onCommit(value: number): void;
}

/**
 * A shape's typed value next to its slider, in the toolbar. The draft stays
 * local until Enter or blur: typing `73` must not render (and save) `7` on the
 * way, and a half-typed or cleared field must not move the slider.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  formatValue,
  suffix,
  inputMode = 'numeric',
  disabled,
  tabIndex,
  onCommit,
}: NumberFieldProps) {
  // `null` means "show the committed value"; a string is the user's draft and
  // ignores outside changes until it is committed or thrown away.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (typed: string): void => {
    const parsed = parseNumberDraft(typed);
    if (parsed !== undefined) {
      const next = clampNumber(parsed, min, max, step);
      if (next !== value) onCommit(next);
    }
    setDraft(null);
  };

  return (
    <span className={styles.group}>
      <input
        ref={inputRef}
        className={`${styles.field} mono`}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={draft ?? formatValue(value)}
        disabled={disabled}
        tabIndex={tabIndex}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          // Committing through blur keeps Enter and clicking away on one path.
          inputRef.current?.blur();
        }}
      />
      {suffix && <span className={styles.suffix}>{suffix}</span>}
    </span>
  );
}
