import type { IptcFields } from '@ee/contracts';
import { useState } from 'react';
import type { FieldEdit } from '../library';
import { useAppState, useAppStore } from '../store-context';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { Select, TextArea, TextInput } from './ui/Field';
import styles from './BatchCaptionDialog.module.css';

interface BatchField {
  name: keyof IptcFields;
  label: string;
  multiline?: boolean;
}

const FIELDS: BatchField[] = [
  { name: 'headline', label: 'Headline' },
  { name: 'caption', label: 'Caption', multiline: true },
  { name: 'keywords', label: 'Keywords' },
  { name: 'byline', label: 'Byline' },
  { name: 'credit', label: 'Credit' },
  { name: 'source', label: 'Source' },
  { name: 'copyright', label: 'Copyright' },
  { name: 'city', label: 'City' },
  { name: 'state', label: 'State / province' },
  { name: 'country', label: 'Country' },
  { name: 'location', label: 'Location' },
  { name: 'event', label: 'Event' },
  { name: 'instructions', label: 'Instructions' },
];

interface Row {
  value: string;
  mode: FieldEdit['mode'];
}

/** Caption and IPTC fields for the whole selection: each field is replaced or appended to. */
export function BatchCaptionDialog() {
  const store = useAppStore();
  const state = useAppState();
  const targets =
    state.selection.length > 0 ? state.selection : state.selectedId ? [state.selectedId] : [];
  const [rows, setRows] = useState<Partial<Record<keyof IptcFields, Row>>>({});
  const [busy, setBusy] = useState(false);

  const edits: FieldEdit[] = FIELDS.flatMap((field) => {
    const row = rows[field.name];
    if (!row || row.value.trim() === '') return [];
    const value =
      field.name === 'keywords'
        ? row.value
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean)
        : row.value;
    return [{ field: field.name, value, mode: row.mode }];
  });

  const patch = (name: keyof IptcFields, change: Partial<Row>): void =>
    setRows((current) => ({
      ...current,
      [name]: { value: '', mode: 'replace', ...current[name], ...change },
    }));

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      await store.applyFieldEdits(targets, edits);
      store.toggleBatchCaption(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Caption"
      subtitle={`${targets.length} photo${targets.length === 1 ? '' : 's'}. Only fields you fill in are written; codes and {variables} in the caption are expanded per photo.`}
      onClose={() => store.toggleBatchCaption(false)}
      width={620}
      testId="batch-caption-dialog"
      footer={
        <>
          <Button onClick={() => store.toggleBatchCaption(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || edits.length === 0 || targets.length === 0}
            onClick={() => void apply()}
            data-testid="batch-caption-apply"
          >
            Apply to {targets.length}
          </Button>
        </>
      }
    >
      <div className={styles.rows}>
        {FIELDS.map((field) => {
          const row = rows[field.name];
          return (
            <div key={field.name} className={styles.row}>
              <label className={styles.label} htmlFor={`batch-${field.name}`}>
                {field.label}
              </label>
              <Select
                variant="boxed"
                aria-label={`${field.label} mode`}
                value={row?.mode ?? 'replace'}
                onChange={(event) => patch(field.name, { mode: event.target.value as Row['mode'] })}
              >
                <option value="replace">Replace</option>
                <option value="append">Append</option>
              </Select>
              {field.multiline ? (
                <TextArea
                  id={`batch-${field.name}`}
                  variant="boxed"
                  value={row?.value ?? ''}
                  onChange={(event) => patch(field.name, { value: event.target.value })}
                />
              ) : (
                <TextInput
                  id={`batch-${field.name}`}
                  variant="boxed"
                  placeholder={field.name === 'keywords' ? 'comma, separated' : undefined}
                  value={row?.value ?? ''}
                  onChange={(event) => patch(field.name, { value: event.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
