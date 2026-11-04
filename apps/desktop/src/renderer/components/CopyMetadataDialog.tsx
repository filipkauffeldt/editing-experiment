import { useState } from 'react';
import {
  METADATA_FIELD_NAMES,
  METADATA_SECTIONS,
  metadataValue,
  type MetadataFieldName,
} from '../metadata-fields';
import { activePhoto } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import styles from './CopyMetadataDialog.module.css';

/** The field picker for copying metadata; Paste writes only the checked fields. */
export function CopyMetadataDialog() {
  const store = useAppStore();
  const state = useAppState();
  const photo = activePhoto(state);
  const fields = photo ? (state.metadata[photo.id] ?? {}) : {};
  // The last confirmed Copy, or every field when nothing was remembered yet.
  const remembered = state.settings?.copyMetadataFields;
  const [checked, setChecked] = useState<MetadataFieldName[]>(() =>
    remembered === undefined
      ? [...METADATA_FIELD_NAMES]
      : METADATA_FIELD_NAMES.filter((name) => remembered.includes(name)),
  );
  const selected = new Set(checked);
  const targetCount = Math.max(1, state.selection.length);

  const toggle = (name: MetadataFieldName): void =>
    setChecked((current) =>
      current.includes(name)
        ? current.filter((candidate) => candidate !== name)
        : [...current, name],
    );
  const setAll = (all: boolean): void => setChecked(all ? [...METADATA_FIELD_NAMES] : []);

  return (
    <Modal
      title="Copy Metadata"
      subtitle={`Copy from ${photo?.fileName ?? 'the active photo'}, then paste only those fields onto ${targetCount} selected photo${targetCount === 1 ? '' : 's'}.`}
      onClose={() => store.closeMetadataCopy()}
      width={620}
      testId="copy-metadata-dialog"
      footer={
        <>
          <Button
            size="small"
            variant="ghost"
            data-testid="metadata-copy-all"
            onClick={() => setAll(true)}
          >
            All
          </Button>
          <Button
            size="small"
            variant="ghost"
            data-testid="metadata-copy-none"
            onClick={() => setAll(false)}
          >
            None
          </Button>
          <span className={styles.spacer} />
          <Button onClick={() => store.closeMetadataCopy()}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="copy-metadata-confirm"
            disabled={checked.length === 0}
            onClick={() => store.confirmMetadataCopy(checked)}
          >
            Copy
          </Button>
        </>
      }
    >
      <div className={styles.sections}>
        {METADATA_SECTIONS.map((section) => (
          <section key={section.title} className={styles.section} aria-label={section.title}>
            <h3 className={styles.sectionTitle}>{section.title}</h3>
            <div className={styles.fields}>
              {section.fields.map((field) => (
                <label key={field.name} className={styles.field}>
                  <input
                    type="checkbox"
                    data-testid={`metadata-copy-field-${field.name}`}
                    checked={selected.has(field.name)}
                    onChange={() => toggle(field.name)}
                  />
                  <span className={styles.text}>
                    <span className={styles.label}>{field.label}</span>
                    <span className={styles.value}>
                      {metadataValue(fields[field.name]) || 'Empty'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className={styles.note}>
        Paste overwrites only the checked fields and leaves every other field as it is. Raws keep
        their metadata in XMP sidecars; the raw file itself is never written.
      </p>
    </Modal>
  );
}
