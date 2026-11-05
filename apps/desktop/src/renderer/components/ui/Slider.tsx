import { useRef, useState } from 'react';
import { clampNumber, parseNumberDraft } from '../../number-draft';
import styles from './Slider.module.css';

export interface SliderProps {
  label: string;
  /** Accessible name when several sliders share a visible label (e.g. one per wheel). */
  ariaLabel?: string;
  /** Position of the thumb on the range, in the range's own units. */
  value: number;
  min: number;
  max: number;
  step: number;
  /** Where the centre tick and the start of the fill sit; the range's middle by default. */
  neutral?: number;
  /** What the typed field shows. Empty with a placeholder means "not set". */
  display: number | '';
  placeholder?: string;
  /** The value is the photo's as-shot setting, so the thumb is drawn muted. */
  asShot?: boolean;
  /** Typed field limits, which differ from the range's when the track is a remapped scale. */
  numberMin?: number;
  numberMax?: number;
  numberStep?: number;
  /** Desaturated gradient behind the track. */
  tone?: 'temperature' | 'tint';
  /** Tighter label and number columns, for sliders under a grading wheel. */
  compact?: boolean;
  disabled?: boolean;
  /**
   * Identity of the value being edited (a photo id). A pending draft belongs to
   * one source: changing it throws the draft away instead of applying it to the
   * new value.
   */
  sourceKey?: string;
  onRange(position: number): void;
  /** `undefined` when the typed field is cleared. */
  onNumber(value: number | undefined): void;
  onReset(): void;
}

const percent = (value: number, min: number, max: number): number =>
  max === min ? 0 : Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

/**
 * Lightroom-style slider: 1 px track with a tick at neutral, a 2 x 11 px bar thumb, a fill from
 * neutral to the value and the typeable value, right-aligned in mono. Double-click resets.
 */
export function Slider({
  label,
  ariaLabel = label,
  value,
  min,
  max,
  step,
  neutral,
  display,
  placeholder,
  asShot,
  numberMin = min,
  numberMax = max,
  numberStep = step,
  tone,
  compact,
  disabled,
  sourceKey,
  onRange,
  onNumber,
  onReset,
}: SliderProps) {
  // A draft belongs to the source it was typed against: `null` means "show the
  // committed value". Outside changes must not overwrite what the user is typing.
  const [draft, setDraft] = useState<{ text: string; source: string | undefined } | null>(null);
  // The same draft as a ref: blur commits what the DOM holds now, even if the last
  // keystroke has not reached a render yet.
  const draftRef = useRef<{ text: string; source: string | undefined } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The value the field showed when it was focused, so Escape can undo a live apply.
  const focused = useRef<{
    source: string | undefined;
    display: number | '';
    asShot: boolean;
  } | null>(null);
  const appliedInEdit = useRef(false);
  // Escape leaves through blur, which must not commit the discarded draft.
  const skipBlurCommit = useRef(false);

  const activeDraft = draft !== null && draft.source === sourceKey ? draft.text : null;
  const neutralAt = percent(neutral ?? (min + max) / 2, min, max);
  const valueAt = percent(value, min, max);
  const classes = [
    styles.slider,
    tone === 'temperature' ? styles.temperature : tone === 'tint' ? styles.tint : '',
    asShot || display === '' ? styles.asShot : '',
    compact ? styles.compact : '',
  ];

  const apply = (next: number): void => {
    appliedInEdit.current = true;
    onNumber(next);
  };

  const commit = (text: string): void => {
    if (text.trim() === '') {
      onNumber(undefined);
      return;
    }
    const parsed = parseNumberDraft(text);
    if (parsed === undefined) return;
    onNumber(clampNumber(parsed, numberMin, numberMax, numberStep));
  };

  /** Undo every live apply of this edit, back to what the field showed on focus. */
  const restore = (): void => {
    const start = focused.current;
    if (!start || start.source !== sourceKey || !appliedInEdit.current) return;
    if (start.asShot || start.display === '') onNumber(undefined);
    else onNumber(start.display);
  };

  /** Arrow keys step from the draft, or from the committed value when it is empty. */
  const stepBy = (direction: 1 | -1): void => {
    const pending = draftRef.current;
    const typed =
      pending !== null && pending.source === sourceKey ? parseNumberDraft(pending.text) : undefined;
    const base =
      typed !== undefined && typed >= numberMin && typed <= numberMax
        ? typed
        : typeof display === 'number'
          ? display
          : numberMin;
    const next = clampNumber(base + direction * numberStep, numberMin, numberMax, numberStep);
    const text = String(next);
    draftRef.current = { text, source: sourceKey };
    setDraft({ text, source: sourceKey });
    apply(next);
  };

  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      onDoubleClick={onReset}
      title="Double-click to reset"
    >
      <span className={styles.label}>{label}</span>
      <input
        ref={inputRef}
        className={`${styles.number} mono`}
        type="text"
        inputMode={Number.isInteger(numberStep) && numberMin >= 0 ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        aria-label={`${ariaLabel} value`}
        value={activeDraft ?? display}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          const text = event.target.value;
          // A change event without focus is programmatic (automation, tests), not an
          // edit session: apply it at once instead of leaving an invisible draft.
          if (document.activeElement !== inputRef.current) {
            if (text.trim() === '') onNumber(undefined);
            else {
              const parsed = parseNumberDraft(text);
              if (parsed !== undefined) onNumber(parsed);
            }
            return;
          }
          setDraft({ text, source: sourceKey });
          draftRef.current = { text, source: sourceKey };
          const parsed = parseNumberDraft(text);
          // Live apply only what the range can hold; a half-typed number such as
          // `5`, `55`, `550` on Temperature or `-` on Exposure waits.
          if (parsed !== undefined && parsed >= numberMin && parsed <= numberMax) apply(parsed);
        }}
        onFocus={() => {
          focused.current = { source: sourceKey, display, asShot: asShot ?? false };
          draftRef.current = null;
          appliedInEdit.current = false;
          skipBlurCommit.current = false;
        }}
        onBlur={() => {
          const pending = draftRef.current;
          const skip = skipBlurCommit.current;
          skipBlurCommit.current = false;
          draftRef.current = null;
          focused.current = null;
          appliedInEdit.current = false;
          setDraft(null);
          if (skip || pending === null || pending.source !== sourceKey) return;
          commit(pending.text);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // The field owns Escape here: it must not cancel crop or leave retouch.
            event.preventDefault();
            event.stopPropagation();
            skipBlurCommit.current = true;
            restore();
            draftRef.current = null;
            focused.current = null;
            appliedInEdit.current = false;
            setDraft(null);
            inputRef.current?.blur();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            // Blur is the one commit path for Enter and clicking away.
            inputRef.current?.blur();
            return;
          }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            stepBy(event.key === 'ArrowUp' ? 1 : -1);
          }
        }}
        // The row's double-click resets; inside the field it selects text instead.
        onDoubleClick={(event) => event.stopPropagation()}
      />
      <div className={styles.track}>
        <span className={styles.rail} />
        <span className={styles.tick} style={{ left: `${neutralAt}%` }} />
        <span
          className={styles.fill}
          style={{
            left: `${Math.min(neutralAt, valueAt)}%`,
            width: `${Math.abs(valueAt - neutralAt)}%`,
          }}
        />
        <input
          className={styles.range}
          type="range"
          aria-label={ariaLabel}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onRange(Number(event.target.value))}
          onDoubleClick={onReset}
        />
      </div>
    </div>
  );
}
