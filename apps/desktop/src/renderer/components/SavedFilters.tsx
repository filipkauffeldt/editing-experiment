import { MAX_SAVED_FILTER_NAME, type SavedFilter } from '@ee/contracts';
import { useState } from 'react';
import { isFiltering, toStoredFilter } from '../filters';
import { useAppState, useAppStore } from '../store-context';
import { Menu, MenuHeading } from './ui/Menu';
import styles from './SavedFilters.module.css';

/**
 * The saved filters menu of the filter bar: pick one to replace the filter, rename or delete it,
 * and save the filter on screen under a name. The folder the Library has open is not saved.
 */
export function SavedFilters() {
  const state = useAppState();
  const saved = state.settings?.savedFilters ?? [];
  const current = JSON.stringify(toStoredFilter(state.filter));
  const filtering = isFiltering(state.filter);

  return (
    <Menu
      label="Saved"
      testId="filter-saved"
      badge={saved.length > 0 ? saved.length : undefined}
      closeOnPick
    >
      <MenuHeading>Saved filters</MenuHeading>
      {saved.length === 0 && <p className={styles.none}>Nothing saved yet</p>}
      {saved.map((entry) => (
        <SavedRow key={entry.id} entry={entry} active={JSON.stringify(entry.filter) === current} />
      ))}
      <SaveField disabled={!filtering} />
    </Menu>
  );
}

function SavedRow({ entry, active }: { entry: SavedFilter; active: boolean }) {
  const store = useAppStore();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.name);

  if (renaming) {
    return (
      <div className={styles.row}>
        <NameInput
          value={draft}
          label={`New name for ${entry.name}`}
          onChange={setDraft}
          onCommit={() => {
            void store.renameSavedFilter(entry.id, draft);
            setRenaming(false);
          }}
          onCancel={() => {
            setDraft(entry.name);
            setRenaming(false);
          }}
        />
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <button
        type="button"
        role="menuitem"
        className={`${styles.pick} ${active ? styles.active : ''}`}
        aria-current={active || undefined}
        onClick={() => store.applySavedFilter(entry.id)}
      >
        {entry.name}
      </button>
      <button
        type="button"
        className={styles.small}
        aria-label={`Rename ${entry.name}`}
        title="Rename"
        onClick={() => {
          setDraft(entry.name);
          setRenaming(true);
        }}
      >
        Rename
      </button>
      <button
        type="button"
        className={styles.small}
        aria-label={`Delete ${entry.name}`}
        title="Delete"
        onClick={() => void store.deleteSavedFilter(entry.id)}
      >
        ×
      </button>
    </div>
  );
}

function SaveField({ disabled }: { disabled: boolean }) {
  const store = useAppStore();
  const [name, setName] = useState('');
  const save = (): void => {
    if (disabled || name.trim() === '') return;
    void store.saveFilter(name);
    setName('');
  };
  return (
    <div className={`${styles.row} ${styles.save}`}>
      <NameInput
        value={name}
        label="Name for the current filter"
        placeholder="Save current as…"
        disabled={disabled}
        onChange={setName}
        onCommit={save}
        onCancel={() => setName('')}
      />
      <button
        type="button"
        className={styles.small}
        disabled={disabled || name.trim() === ''}
        title={disabled ? 'Set a filter first' : 'Save the current filter'}
        onClick={save}
      >
        Save
      </button>
    </div>
  );
}

/** A one-line name field. Enter commits, Esc cancels and goes no further, so the menu stays. */
function NameInput({
  value,
  label,
  placeholder,
  disabled,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      type="text"
      className={styles.input}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={MAX_SAVED_FILTER_NAME}
      autoComplete="off"
      spellCheck={false}
      // Rename opens on the field, ready to type over the old name.
      autoFocus={placeholder === undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit();
        } else if (event.key === 'Escape' && value !== '') {
          // Only a typed name is cancelled by Esc; an empty field lets the menu close.
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}
