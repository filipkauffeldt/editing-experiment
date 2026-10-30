import type { FileTypeFilter, LockFilter, SourceConfig } from '@ee/contracts';
import styles from './SourceFilters.module.css';

export const DEFAULT_FILE_TYPES: FileTypeFilter = 'both';
export const DEFAULT_LOCK_FILTER: LockFilter = 'all';
export const DEFAULT_INCREMENTAL = true;

export interface SourceFilterValues {
  fileTypes: FileTypeFilter;
  lockFilter: LockFilter;
  incremental: boolean;
}

const FILE_TYPES: { id: FileTypeFilter; label: string }[] = [
  { id: 'raw', label: 'RAW' },
  { id: 'jpeg', label: 'JPEG' },
  { id: 'both', label: 'Both' },
];

const LOCK_FILTERS: { id: LockFilter; label: string }[] = [
  { id: 'locked', label: 'Locked' },
  { id: 'unlocked', label: 'Unlocked' },
  { id: 'all', label: 'All' },
];

export function sourceFilterValues(
  source: Extract<SourceConfig, { kind: 'folder' | 'card' }>,
): SourceFilterValues {
  return {
    fileTypes: source.fileTypes ?? DEFAULT_FILE_TYPES,
    lockFilter: source.lockFilter ?? DEFAULT_LOCK_FILTER,
    incremental: source.incremental ?? DEFAULT_INCREMENTAL,
  };
}

/** The compact per-source filter row shared by the ingest screen and source settings. */
export function SourceFilters({
  value,
  onChange,
  name,
  className,
}: {
  value: SourceFilterValues;
  onChange(value: SourceFilterValues): void;
  /** Source name for accessible labels when several rows are on screen. */
  name?: string;
  className?: string;
}) {
  const suffix = name ? ` for ${name}` : '';
  return (
    <div className={`${styles.filters} ${className ?? ''}`} data-testid="source-filters">
      <span className={styles.group} role="group" aria-label={`File types${suffix}`}>
        <span className={styles.legend}>File types</span>
        {FILE_TYPES.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`${styles.option} ${value.fileTypes === option.id ? styles.optionActive : ''}`}
            aria-pressed={value.fileTypes === option.id}
            onClick={() => onChange({ ...value, fileTypes: option.id })}
          >
            {option.label}
          </button>
        ))}
      </span>
      <span className={styles.group} role="group" aria-label={`Lock${suffix}`}>
        <span className={styles.legend}>Lock</span>
        {LOCK_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`${styles.option} ${value.lockFilter === option.id ? styles.optionActive : ''}`}
            aria-pressed={value.lockFilter === option.id}
            onClick={() => onChange({ ...value, lockFilter: option.id })}
          >
            {option.label}
          </button>
        ))}
      </span>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={value.incremental}
          onChange={(event) => onChange({ ...value, incremental: event.target.checked })}
        />
        Incremental
      </label>
    </div>
  );
}
