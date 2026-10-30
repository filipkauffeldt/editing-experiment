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
  /** What the typed field shows. Empty with a placeholder means "not set" (e.g. as shot). */
  display: number | '';
  placeholder?: string;
  /** Typed field limits, which differ from the range's when the track is a remapped scale. */
  numberMin?: number;
  numberMax?: number;
  numberStep?: number;
  /** Desaturated gradient behind the track. */
  tone?: 'temperature' | 'tint';
  /** Tighter label and number columns, for sliders under a grading wheel. */
  compact?: boolean;
  disabled?: boolean;
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
  numberMin = min,
  numberMax = max,
  numberStep = step,
  tone,
  compact,
  disabled,
  onRange,
  onNumber,
  onReset,
}: SliderProps) {
  const neutralAt = percent(neutral ?? (min + max) / 2, min, max);
  const valueAt = percent(value, min, max);
  const classes = [
    styles.slider,
    tone === 'temperature' ? styles.temperature : tone === 'tint' ? styles.tint : '',
    display === '' ? styles.asShot : '',
    compact ? styles.compact : '',
  ];
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      onDoubleClick={onReset}
      title="Double-click to reset"
    >
      <span className={styles.label}>{label}</span>
      <input
        className={`${styles.number} mono`}
        type="number"
        aria-label={`${ariaLabel} value`}
        min={numberMin}
        max={numberMax}
        step={numberStep}
        value={display}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            onNumber(undefined);
            return;
          }
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onNumber(parsed);
        }}
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
