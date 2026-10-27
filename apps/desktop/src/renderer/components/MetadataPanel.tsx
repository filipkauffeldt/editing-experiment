import { IPTC_FIELD_NAMES, type Photo } from '@ee/contracts';
import { Panel } from './Panel';
import styles from './MetadataPanel.module.css';

const SHOWN_FIELDS = ['headline', 'caption', 'keywords', 'byline', 'credit', 'location'] as const;
const LABELS: Record<(typeof SHOWN_FIELDS)[number], string> = {
  headline: 'Headline',
  caption: 'Caption',
  keywords: 'Keywords',
  byline: 'Byline',
  credit: 'Credit',
  location: 'Location',
};

// Keeps the panel in step with the contract: it fails to compile if a shown field is removed.
const known: readonly string[] = IPTC_FIELD_NAMES;

interface MetadataPanelProps {
  className?: string;
  photo: Photo | undefined;
}

/** Placeholder metadata editor; wiring to `metadata:read` / `metadata:write` comes with the metadata workstream. */
export function MetadataPanel({ className, photo }: MetadataPanelProps) {
  return (
    <Panel title="Metadata" className={className}>
      {photo && <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>{photo.fileName}</p>}
      {SHOWN_FIELDS.filter((name) => known.includes(name)).map((name) => (
        <label key={name} className={styles.field}>
          <span className={styles.label}>{LABELS[name]}</span>
          {name === 'caption' ? (
            <textarea className={styles.input} disabled={!photo} />
          ) : (
            <input className={styles.input} disabled={!photo} />
          )}
        </label>
      ))}
    </Panel>
  );
}
