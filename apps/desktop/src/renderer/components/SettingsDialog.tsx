import {
  asDestinationId,
  asSourceId,
  type CredentialSecret,
  type Destination,
  type FtpSecurity,
  type FileTypeFilter,
  type LockFilter,
  type SourceConfig,
} from '@ee/contracts';
import { useEffect, useRef, useState } from 'react';
import { ee } from '../ee';
import type { DialogTab } from '../store';
import { useAppState, useAppStore } from '../store-context';
import { FolderIcon, PlusIcon, ServerIcon } from './icons';
import { MetadataSettings } from './MetadataSettings';
import { Modal } from './Modal';
import { PresetsSettings } from './PresetsSettings';
import { ProfilesSettings } from './ProfilesSettings';
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_INCREMENTAL,
  DEFAULT_LOCK_FILTER,
  SourceFilters,
  sourceFilterValues,
} from './SourceFilters';
import { TemplateField } from './TemplateField';
import styles from './SettingsDialog.module.css';

const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface SourceFormState {
  id: string;
  kind: SourceConfig['kind'];
  name: string;
  path: string;
  recursive: boolean;
  fileTypes: FileTypeFilter;
  lockFilter: LockFilter;
  incremental: boolean;
  mountPath: string;
  volumeLabel: string;
  /** Kept when a source picked on the Ingest view is edited here, so it stays a picked card. */
  discovered: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  remotePath: string;
  pollIntervalMs: string;
  deleteAfterDownload: boolean;
  security: FtpSecurity;
  hostKeyFingerprint: string;
  credentialRef: string;
}

const sourceForm = (
  source: SourceConfig | undefined,
  kind: SourceConfig['kind'],
): SourceFormState => {
  const base: SourceFormState = {
    id: source?.id ?? newId('source'),
    kind,
    name: source?.name ?? '',
    path: '',
    recursive: true,
    fileTypes: DEFAULT_FILE_TYPES,
    lockFilter: DEFAULT_LOCK_FILTER,
    incremental: DEFAULT_INCREMENTAL,
    mountPath: '',
    volumeLabel: '',
    discovered: false,
    host: '',
    port: '21',
    username: '',
    password: '',
    remotePath: '/',
    pollIntervalMs: '5000',
    deleteAfterDownload: false,
    security: 'none',
    hostKeyFingerprint: '',
    credentialRef: '',
  };
  if (!source) return { ...base, kind };
  if (source.kind === 'folder') {
    return {
      ...base,
      kind: source.kind,
      path: source.path,
      recursive: source.recursive ?? false,
      ...sourceFilterValues(source),
    };
  }
  if (source.kind === 'card') {
    return {
      ...base,
      kind: source.kind,
      mountPath: source.mountPath,
      volumeLabel: source.volumeLabel ?? '',
      discovered: source.discovered ?? false,
      ...sourceFilterValues(source),
    };
  }
  return {
    ...base,
    kind: source.kind,
    host: source.host,
    port: String(source.port),
    username: source.username,
    remotePath: source.remotePath,
    pollIntervalMs: String(source.pollIntervalMs),
    deleteAfterDownload: source.deleteAfterDownload,
    security: source.kind === 'ftp' ? source.security : 'none',
    hostKeyFingerprint: source.kind === 'sftp' ? (source.hostKeyFingerprint ?? '') : '',
    credentialRef: source.credentialRef ?? '',
  };
};

function buildSource(form: SourceFormState): { source: SourceConfig; error?: string } {
  const name = form.name.trim();
  if (!name) return { source: {} as SourceConfig, error: 'Name is required' };
  const id = asSourceId(form.id);
  if (form.kind === 'folder') {
    if (!form.path.trim()) return { source: {} as SourceConfig, error: 'Folder path is required' };
    return {
      source: {
        id,
        kind: 'folder',
        name,
        path: form.path.trim(),
        recursive: form.recursive,
        fileTypes: form.fileTypes,
        lockFilter: form.lockFilter,
        incremental: form.incremental,
      },
    };
  }
  if (form.kind === 'card') {
    if (!form.mountPath.trim()) {
      return { source: {} as SourceConfig, error: 'Mount path is required' };
    }
    return {
      source: {
        id,
        kind: 'card',
        name,
        mountPath: form.mountPath.trim(),
        volumeLabel: form.volumeLabel.trim() || undefined,
        ...(form.discovered ? { discovered: true } : {}),
        fileTypes: form.fileTypes,
        lockFilter: form.lockFilter,
        incremental: form.incremental,
      },
    };
  }
  if (!form.host.trim()) return { source: {} as SourceConfig, error: 'Host is required' };
  if (form.kind !== 'ftp' && !form.username.trim()) {
    return { source: {} as SourceConfig, error: 'Username is required' };
  }
  const remote = {
    id,
    name,
    host: form.host.trim(),
    port: Number(form.port) || 21,
    username: form.username.trim(),
    remotePath: form.remotePath.trim() || '/',
    pollIntervalMs: Number(form.pollIntervalMs) || 5000,
    deleteAfterDownload: form.deleteAfterDownload,
    credentialRef: form.credentialRef,
  };
  if (form.kind === 'ftp') {
    return { source: { ...remote, kind: 'ftp', security: form.security } };
  }
  return {
    source: {
      ...remote,
      kind: 'sftp',
      hostKeyFingerprint: form.hostKeyFingerprint.trim() || undefined,
    },
  };
}

function SecretField({
  value,
  onChange,
  hasStored,
  anonymous,
}: {
  value: string;
  onChange(value: string): void;
  hasStored: boolean;
  anonymous?: boolean;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>Password</span>
      <input
        type="password"
        className={styles.input}
        value={value}
        autoComplete="new-password"
        placeholder={
          hasStored
            ? 'Stored — leave blank to keep'
            : anonymous
              ? 'Anonymous (leave empty)'
              : 'Not set'
        }
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

const SOURCE_KINDS: { kind: SourceConfig['kind']; label: string }[] = [
  { kind: 'folder', label: 'Folder' },
  { kind: 'card', label: 'Card' },
  { kind: 'ftp', label: 'FTP' },
  { kind: 'sftp', label: 'SFTP' },
];

function AddSourceMenu({ onCreate }: { onCreate(kind: SourceConfig['kind']): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Escape closes the menu, not the Settings dialog behind it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div className={styles.addMenu} ref={ref}>
      <button
        type="button"
        className={styles.addButton}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="add-source"
        onClick={() => setOpen((current) => !current)}
      >
        <PlusIcon size={9} /> Add <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Add source">
          {SOURCE_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              data-testid={`add-source-${kind}`}
              onClick={() => {
                setOpen(false);
                onCreate(kind);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SourceList({
  sources,
  selectedId,
  onSelect,
  onCreate,
}: {
  sources: SourceConfig[];
  selectedId: string;
  onSelect(id: string): void;
  onCreate(kind: SourceConfig['kind']): void;
}) {
  return (
    <aside className={styles.listPane}>
      <div className={styles.list}>
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            className={`${styles.listItem} ${source.id === selectedId ? styles.listActive : ''}`}
            onClick={() => onSelect(source.id)}
          >
            <span className={styles.listIcon}>
              {source.kind === 'folder' || source.kind === 'card' ? (
                <FolderIcon size={12} />
              ) : (
                <ServerIcon size={12} />
              )}
            </span>
            <span className={styles.listText}>
              <span className={styles.listName}>{source.name}</span>
              <span className={styles.listKind}>{source.kind.toUpperCase()}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.addRow}>
        <AddSourceMenu onCreate={onCreate} />
      </div>
    </aside>
  );
}

function SourcesSection() {
  const store = useAppStore();
  const state = useAppState();
  const [creating, setCreating] = useState<SourceConfig['kind']>();
  const [selectedId, setSelectedId] = useState(state.sources[0]?.id ?? '');
  const selected = state.sources.find((source) => source.id === selectedId);
  const [form, setForm] = useState<SourceFormState>(() =>
    sourceForm(selected, selected?.kind ?? 'folder'),
  );
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The form mirrors the selected server object; switching selection resets it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm((current) =>
      !creating && selected && current.id === selected.id
        ? current
        : sourceForm(selected, creating ?? selected?.kind ?? 'folder'),
    );
  }, [creating, selected]);

  const select = (id: string): void => {
    setCreating(undefined);
    setSelectedId(id);
    setError(undefined);
    setStatus(undefined);
  };

  const create = (kind: SourceConfig['kind']): void => {
    setCreating(kind);
    setSelectedId('');
    setForm(sourceForm(undefined, kind));
    setError(undefined);
    setStatus(undefined);
  };

  const patch = (patchForm: Partial<SourceFormState>): void =>
    setForm((current) => ({ ...current, ...patchForm }));

  const save = async (): Promise<void> => {
    const { source, error: validation } = buildSource(form);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const secret: CredentialSecret | undefined = form.password
        ? { password: form.password }
        : undefined;
      const saved = await store.saveSource(source, secret);
      setCreating(undefined);
      setSelectedId(saved.id);
      setForm({
        ...sourceForm(saved, saved.kind),
        password: '',
      });
      setStatus('Source saved. Credentials are stored by the main process.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    const { source, error: validation } = buildSource(form);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    try {
      const secret: CredentialSecret | undefined = form.password
        ? { password: form.password }
        : undefined;
      const result = await store.testSource(source, secret);
      setStatus(result.ok ? (result.message ?? 'Connection OK') : (result.message ?? 'Failed'));
      setError(result.ok ? undefined : result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    await store.removeSource(selected.id);
    setSelectedId('');
    setCreating('folder');
  };

  const remote = form.kind === 'ftp' || form.kind === 'sftp';

  return (
    <div className={styles.split}>
      <SourceList
        sources={state.sources}
        selectedId={selectedId}
        onSelect={select}
        onCreate={create}
      />
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className={styles.formHeader}>
          <span>{selected ? selected.name : `New ${form.kind.toUpperCase()} source`}</span>
          <span className={styles.kindPill}>{form.kind.toUpperCase()}</span>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={form.name}
            placeholder="Card A — Z 9"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        {form.kind === 'folder' && (
          <>
            <label className={styles.field}>
              <span className={styles.label}>Folder</span>
              <span className={styles.inputRow}>
                <input
                  className={styles.input}
                  value={form.path}
                  placeholder="/Volumes/CARD/DCIM"
                  onChange={(event) => patch({ path: event.target.value })}
                />
                <button
                  type="button"
                  className={styles.smallButton}
                  onClick={async () => {
                    const [path] = await ee.invoke('dialog:pick', { kind: 'folder' });
                    if (path) patch({ path });
                  }}
                >
                  Browse…
                </button>
              </span>
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={form.recursive}
                onChange={(event) => patch({ recursive: event.target.checked })}
              />
              Include subfolders
            </label>
          </>
        )}

        {form.kind === 'card' && (
          <>
            <label className={styles.field}>
              <span className={styles.label}>Mount path</span>
              <input
                className={styles.input}
                value={form.mountPath}
                placeholder="/run/media/user/NIKON_Z9"
                onChange={(event) => patch({ mountPath: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Volume label</span>
              <input
                className={styles.input}
                value={form.volumeLabel}
                onChange={(event) => patch({ volumeLabel: event.target.value })}
              />
            </label>
          </>
        )}

        {(form.kind === 'folder' || form.kind === 'card') && (
          <SourceFilters
            value={{
              fileTypes: form.fileTypes,
              lockFilter: form.lockFilter,
              incremental: form.incremental,
            }}
            name={form.name.trim() || undefined}
            onChange={(value) => patch(value)}
          />
        )}

        {remote && (
          <>
            <div className={styles.gridTwo}>
              <label className={styles.field}>
                <span className={styles.label}>Host</span>
                <input
                  className={styles.input}
                  value={form.host}
                  placeholder="ftp.sportfotografen.se"
                  onChange={(event) => patch({ host: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Port</span>
                <input
                  className={styles.input}
                  type="number"
                  value={form.port}
                  onChange={(event) => patch({ port: event.target.value })}
                />
              </label>
            </div>
            <div className={styles.gridTwo}>
              <label className={styles.field}>
                <span className={styles.label}>Username</span>
                <input
                  className={styles.input}
                  value={form.username}
                  placeholder={form.kind === 'ftp' ? 'anonymous' : undefined}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </label>
              <SecretField
                value={form.password}
                hasStored={Boolean(form.credentialRef)}
                anonymous={form.kind === 'ftp'}
                onChange={(password) => patch({ password })}
              />
            </div>
            <label className={styles.field}>
              <span className={styles.label}>Remote path</span>
              <input
                className={styles.input}
                value={form.remotePath}
                onChange={(event) => patch({ remotePath: event.target.value })}
              />
            </label>
            <div className={styles.gridTwo}>
              <label className={styles.field}>
                <span className={styles.label}>Poll interval (ms)</span>
                <input
                  className={styles.input}
                  type="number"
                  value={form.pollIntervalMs}
                  onChange={(event) => patch({ pollIntervalMs: event.target.value })}
                />
              </label>
              {form.kind === 'ftp' ? (
                <label className={styles.field}>
                  <span className={styles.label}>Security</span>
                  <select
                    className={styles.input}
                    value={form.security}
                    onChange={(event) => patch({ security: event.target.value as FtpSecurity })}
                  >
                    <option value="none">FTP</option>
                    <option value="explicit-tls">FTPS (explicit)</option>
                    <option value="implicit-tls">FTPS (implicit)</option>
                  </select>
                </label>
              ) : (
                <label className={styles.field}>
                  <span className={styles.label}>Host key fingerprint</span>
                  <input
                    className={styles.input}
                    value={form.hostKeyFingerprint}
                    placeholder="SHA256:…"
                    onChange={(event) => patch({ hostKeyFingerprint: event.target.value })}
                  />
                </label>
              )}
            </div>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={form.deleteAfterDownload}
                onChange={(event) => patch({ deleteAfterDownload: event.target.checked })}
              />
              Delete files on the server after a verified download
            </label>
            {form.deleteAfterDownload && (
              <p className={styles.warning}>
                Destructive: originals are removed from the server once the copy is verified.
              </p>
            )}
          </>
        )}

        {error && <p className={styles.error}>{error}</p>}
        {status && <p className={styles.status}>{status}</p>}

        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => void test()}
            disabled={busy}
          >
            Test
          </button>
          <span className={styles.spacer} />
          {selected && !creating && (
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => void remove()}
              disabled={busy}
            >
              Remove
            </button>
          )}
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? 'Saving…' : 'Save source'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface DestinationFormState {
  id: string;
  kind: Destination['kind'];
  name: string;
  path: string;
  remotePathTemplate: string;
  host: string;
  port: string;
  username: string;
  password: string;
  security: FtpSecurity;
  hostKeyFingerprint: string;
  credentialRef: string;
}

const destinationForm = (
  destination: Destination | undefined,
  kind: Destination['kind'],
): DestinationFormState => {
  const base: DestinationFormState = {
    id: destination?.id ?? newId('destination'),
    kind,
    name: destination?.name ?? '',
    path: '',
    remotePathTemplate: destination?.remotePathTemplate ?? '{date}/{fileName}',
    host: '',
    port: '21',
    username: '',
    password: '',
    security: 'none',
    hostKeyFingerprint: '',
    credentialRef: '',
  };
  if (!destination) return base;
  if (destination.kind === 'folder') {
    return { ...base, kind: destination.kind, path: destination.path };
  }
  return {
    ...base,
    kind: destination.kind,
    host: destination.host,
    port: String(destination.port),
    username: destination.username,
    security: destination.kind === 'ftp' ? destination.security : 'none',
    hostKeyFingerprint: destination.kind === 'sftp' ? (destination.hostKeyFingerprint ?? '') : '',
    credentialRef: destination.credentialRef ?? '',
  };
};

function buildDestination(form: DestinationFormState): {
  destination: Destination;
  error?: string;
} {
  const name = form.name.trim();
  const remotePathTemplate = form.remotePathTemplate.trim();
  if (!name) return { destination: {} as Destination, error: 'Name is required' };
  if (!remotePathTemplate) {
    return { destination: {} as Destination, error: 'Remote path template is required' };
  }
  const id = asDestinationId(form.id);
  if (form.kind === 'folder') {
    if (!form.path.trim()) return { destination: {} as Destination, error: 'Folder is required' };
    return {
      destination: { id, kind: 'folder', name, path: form.path.trim(), remotePathTemplate },
    };
  }
  if (!form.host.trim()) {
    return { destination: {} as Destination, error: 'Host is required' };
  }
  if (form.kind !== 'ftp' && !form.username.trim()) {
    return { destination: {} as Destination, error: 'Username is required' };
  }
  const remote = {
    id,
    name,
    host: form.host.trim(),
    port: Number(form.port) || 21,
    username: form.username.trim(),
    credentialRef: form.credentialRef,
    remotePathTemplate,
  };
  if (form.kind === 'ftp') {
    return { destination: { ...remote, kind: 'ftp', security: form.security } };
  }
  return {
    destination: {
      ...remote,
      kind: 'sftp',
      hostKeyFingerprint: form.hostKeyFingerprint.trim() || undefined,
    },
  };
}

function DestinationsSection() {
  const store = useAppStore();
  const state = useAppState();
  const [selectedId, setSelectedId] = useState(state.destinations[0]?.id ?? '');
  const [creating, setCreating] = useState<Destination['kind']>();
  const selected = state.destinations.find((destination) => destination.id === selectedId);
  const [form, setForm] = useState<DestinationFormState>(() =>
    destinationForm(selected, selected?.kind ?? 'folder'),
  );
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The form mirrors the selected server object; switching selection resets it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm((current) =>
      !creating && selected && current.id === selected.id
        ? current
        : destinationForm(selected, creating ?? selected?.kind ?? 'folder'),
    );
  }, [creating, selected]);

  const patch = (patchForm: Partial<DestinationFormState>): void =>
    setForm((current) => ({ ...current, ...patchForm }));

  const create = (kind: Destination['kind']): void => {
    setCreating(kind);
    setSelectedId('');
    setForm(destinationForm(undefined, kind));
    setError(undefined);
    setStatus(undefined);
  };

  const save = async (): Promise<void> => {
    const { destination, error: validation } = buildDestination(form);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const secret: CredentialSecret | undefined = form.password
        ? { password: form.password }
        : undefined;
      const saved = await store.saveDestination(destination, secret);
      setCreating(undefined);
      setSelectedId(saved.id);
      setForm({ ...destinationForm(saved, saved.kind), password: '' });
      setStatus('Destination saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    const { destination, error: validation } = buildDestination(form);
    if (validation) {
      setError(validation);
      return;
    }
    try {
      const secret: CredentialSecret | undefined = form.password
        ? { password: form.password }
        : undefined;
      const result = await store.testDestination(destination, secret);
      setStatus(result.message ?? (result.ok ? 'Connection OK' : 'Connection failed'));
      setError(result.ok ? undefined : result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={styles.split}>
      <aside className={styles.listPane}>
        <div className={styles.list}>
          {state.destinations.map((destination) => (
            <button
              key={destination.id}
              type="button"
              className={`${styles.listItem} ${
                destination.id === selectedId ? styles.listActive : ''
              }`}
              onClick={() => {
                setCreating(undefined);
                setSelectedId(destination.id);
                setError(undefined);
                setStatus(undefined);
              }}
            >
              <span className={styles.listIcon}>
                {destination.kind === 'folder' ? (
                  <FolderIcon size={12} />
                ) : (
                  <ServerIcon size={12} />
                )}
              </span>
              <span className={styles.listText}>
                <span className={styles.listName}>{destination.name}</span>
                <span className={styles.listKind}>{destination.kind.toUpperCase()}</span>
              </span>
            </button>
          ))}
        </div>
        <div className={styles.addRow}>
          <button type="button" className={styles.addButton} onClick={() => create('folder')}>
            <PlusIcon size={9} /> Folder
          </button>
          <button type="button" className={styles.addButton} onClick={() => create('ftp')}>
            <PlusIcon size={9} /> FTP
          </button>
          <button type="button" className={styles.addButton} onClick={() => create('sftp')}>
            <PlusIcon size={9} /> SFTP
          </button>
        </div>
      </aside>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className={styles.formHeader}>
          <span>{selected ? selected.name : `New ${form.kind.toUpperCase()} destination`}</span>
          <span className={styles.kindPill}>{form.kind.toUpperCase()}</span>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.input}
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        {form.kind === 'folder' ? (
          <label className={styles.field}>
            <span className={styles.label}>Folder</span>
            <input
              className={styles.input}
              value={form.path}
              onChange={(event) => patch({ path: event.target.value })}
            />
          </label>
        ) : (
          <>
            <div className={styles.gridTwo}>
              <label className={styles.field}>
                <span className={styles.label}>Host</span>
                <input
                  className={styles.input}
                  value={form.host}
                  onChange={(event) => patch({ host: event.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Port</span>
                <input
                  className={styles.input}
                  type="number"
                  value={form.port}
                  onChange={(event) => patch({ port: event.target.value })}
                />
              </label>
            </div>
            <div className={styles.gridTwo}>
              <label className={styles.field}>
                <span className={styles.label}>Username</span>
                <input
                  className={styles.input}
                  value={form.username}
                  placeholder={form.kind === 'ftp' ? 'anonymous' : undefined}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </label>
              <SecretField
                value={form.password}
                hasStored={Boolean(form.credentialRef)}
                anonymous={form.kind === 'ftp'}
                onChange={(password) => patch({ password })}
              />
            </div>
            {form.kind === 'ftp' && (
              <label className={styles.field}>
                <span className={styles.label}>Security</span>
                <select
                  className={styles.input}
                  value={form.security}
                  onChange={(event) => patch({ security: event.target.value as FtpSecurity })}
                >
                  <option value="none">FTP</option>
                  <option value="explicit-tls">FTPS (explicit)</option>
                  <option value="implicit-tls">FTPS (implicit)</option>
                </select>
              </label>
            )}
          </>
        )}

        <TemplateField
          label="Remote path template"
          context="destination"
          value={form.remotePathTemplate}
          placeholder="/incoming/{event}/{fileName}"
          testId="destination-remote-path-template"
          onChange={(remotePathTemplate) => patch({ remotePathTemplate })}
        />

        {error && <p className={styles.error}>{error}</p>}
        {status && <p className={styles.status}>{status}</p>}

        <div className={styles.formActions}>
          <button type="button" className={styles.button} onClick={() => void test()}>
            Test
          </button>
          <span className={styles.spacer} />
          {selected && !creating && (
            <button
              type="button"
              className={styles.dangerButton}
              onClick={async () => {
                await store.removeDestination(selected.id);
                setSelectedId('');
                setCreating('folder');
              }}
            >
              Remove
            </button>
          )}
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? 'Saving…' : 'Save destination'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Settings modal: sources, destinations, metadata, profiles and presets. Ingest and Export have their own views. */
export function SettingsDialog() {
  const store = useAppStore();
  const state = useAppState();
  const tab: DialogTab = state.dialog ?? 'sources';
  const tabs: { id: DialogTab; label: string }[] = [
    { id: 'sources', label: 'Sources' },
    { id: 'destinations', label: 'Destinations' },
    { id: 'metadata', label: 'Metadata' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'presets', label: 'Presets' },
  ];

  return (
    <Modal
      title="Settings"
      onClose={() => store.closeDialog()}
      width={820}
      testId="settings-dialog"
      footer={
        <button type="button" className={styles.button} onClick={() => store.closeDialog()}>
          Close
        </button>
      }
    >
      <div className={styles.tabs} role="tablist" aria-label="Settings sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => store.openDialog(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.tabBody}>
        {tab === 'sources' && <SourcesSection />}
        {tab === 'destinations' && <DestinationsSection />}
        {tab === 'metadata' && <MetadataSettings />}
        {tab === 'profiles' && <ProfilesSettings />}
        {tab === 'presets' && <PresetsSettings />}
      </div>
    </Modal>
  );
}
